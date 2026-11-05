// The one place the model proxy's option set is decided, shared by the daemon (main.ts) and the live composition
// (e2e live-model.ts) so the two cannot drift. Pure: no fs, sockets or Docker; the env map, catalog, store handles and
// provider are explicit inputs.
import { createPrice, createRequestEstimate, createSettleEstimate } from "./model-proxy/price.ts";
import type { RatesSource } from "./model-proxy/rates.ts";
import { DEFAULT_UPSTREAM_TIMEOUT_MS, type ModelProxyOptions } from "./model-proxy/service.ts";
import { reclaimStaleReservations } from "./gateway.ts";
import { allowedPathsUnion, settlementSink } from "./model-settlement.ts";
import { type DaemonConfig, envName } from "./daemon-config.ts";
import { checkModelBaseUrl } from "./model-proxy/upstream.ts";

type Env = Record<string, string | undefined>;

export const DEFAULT_PROXY_TOKEN_TTL_MS = 3_600_000;
export const DEFAULT_MAX_REQUEST_MICROS = 50_000;
export const RECLAIM_INTERVAL_MS = 60_000;

// A finite, non-negative number or an error naming the variable (NaN would silently open limits/timeouts).
function optNum(env: Env, k: string): number | undefined {
  if (env[k] === undefined) return undefined;
  const v = env[k]?.trim() === "" ? Number.NaN : Number(env[k]);
  if (!(Number.isFinite(v) && v >= 0)) throw new Error(`invalid ${k}=${JSON.stringify(env[k])}: expected a non-negative number`);
  return v;
}

function positiveMs(env: Env, k: string, fallback: number): number {
  const raw = env[k];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${k}=${JSON.stringify(raw)}: expected a positive integer milliseconds`);
  return value;
}

// The resolved model-proxy scalars (registry keys model.upstreamTimeoutMs, model.proxy.ttlMs, model.proxy.maxRequestMicros and
// model.proxy.extraPaths, the last added to DEFAULT_ALLOWED_PATHS).
export interface ModelProxySettings {
  upstreamTimeoutMs: number;
  tokenTtlMs: number;
  maximumRequestMicros: number;
  allowedPaths: string[];
}

export function modelProxySettings(
  c: Pick<DaemonConfig, "model.upstreamTimeoutMs" | "model.proxy.ttlMs" | "model.proxy.maxRequestMicros" | "model.proxy.extraPaths">,
): ModelProxySettings {
  return {
    upstreamTimeoutMs: c["model.upstreamTimeoutMs"],
    tokenTtlMs: c["model.proxy.ttlMs"],
    maximumRequestMicros: c["model.proxy.maxRequestMicros"],
    allowedPaths: allowedPathsUnion(c["model.proxy.extraPaths"].join(",")),
  };
}

// TODO(config-registry): the env-map reader below serves only packages/e2e (live-model.ts through `env`, and the
// config-registry-drift test); pomtreed passes `settings` from the resolved config. Delete it once e2e resolves the registry.
// The env-derived scalars. Defaults: POMTREED_MODEL_UPSTREAM_TIMEOUT_MS 120000, POMTREED_MODEL_PROXY_TTL_MS 3600000,
// POMTREED_MODEL_PROXY_MAX_REQUEST_MICROS 50000, POMTREED_MODEL_PROXY_EXTRA_PATHS none (added to DEFAULT_ALLOWED_PATHS).
export function modelProxyEnv(env: Env): ModelProxySettings {
  return {
    upstreamTimeoutMs: positiveMs(env, "POMTREED_MODEL_UPSTREAM_TIMEOUT_MS", DEFAULT_UPSTREAM_TIMEOUT_MS),
    tokenTtlMs: optNum(env, "POMTREED_MODEL_PROXY_TTL_MS") ?? DEFAULT_PROXY_TOKEN_TTL_MS,
    maximumRequestMicros: optNum(env, "POMTREED_MODEL_PROXY_MAX_REQUEST_MICROS") ?? DEFAULT_MAX_REQUEST_MICROS,
    allowedPaths: allowedPathsUnion(env.POMTREED_MODEL_PROXY_EXTRA_PATHS),
  };
}

export interface ModelProxyInputs {
  settings?: ModelProxySettings; // pomtreed: modelProxySettings(config)
  env?: Env; // TODO(config-registry): e2e live-model.ts only; read through modelProxyEnv when `settings` is absent
  provider: string;
  upstream: { baseUrl: string; key: string };
  catalog: { found: boolean; rates: RatesSource };
  debits: ModelProxyOptions["budget"] & Parameters<typeof settlementSink>[0]["debits"];
  registry: Parameters<typeof settlementSink>[0]["registry"];
  journal: Parameters<typeof settlementSink>[0]["journal"];
  host?: string; // journal host for settlement entries; absent: each agent record's own host
  fetch?: ModelProxyOptions["fetch"];
  onBudgetStall?: ModelProxyOptions["onBudgetStall"]; // pomtreed: the daemon's budgetStalled (escalates an agent the proxy can no longer serve)
  onSettlement?: ModelProxyOptions["onSettlement"]; // override of the default settlement sink (tests/negative controls only)
  // Operator log lines: the resolved upstream once here, and the proxy's warnings (first 404 per route). Default stderr.
  log?: (message: string) => void;
}

// Pi appends /chat/completions, /responses or /v1/messages to the staged baseUrl for every supported provider (deepseek,
// openai, anthropic, openrouter), all in the default allowlist; POMTREED_MODEL_PROXY_EXTRA_PATHS adds more. maximumRequestMicros
// is not a per-request ceiling: it is the floor reserved (and charged when cost cannot be read) for a model missing from the
// catalog. Every settlement is journaled and recorded on the debit ledger row, so cost joins to the call.
// authStyle: Anthropic is addressed with both x-api-key and Bearer; every other provider is Bearer-only. Without a catalog
// no model has rates, so estimateSettle is absent and an unreported-usage 2xx keeps the full-reservation charge.
// The resolved upstream (scheme://host/basePath, never the key) is logged once, here; an invalid base URL throws the
// message naming POMTREED_MODEL_BASE_URL (daemon-config.ts refuses it earlier at config resolve).
export function buildModelProxyOptions(i: ModelProxyInputs): { proxy: ModelProxyOptions; tokenTtlMs: number; upstreamTimeoutMs: number } {
  const e = i.settings ?? modelProxyEnv(i.env ?? {});
  const log = i.log ?? ((m: string) => console.error(m));
  const baseUrlName = envName("model.baseUrl");
  const base = checkModelBaseUrl(i.upstream.baseUrl, baseUrlName);
  if (!base.ok) throw new Error(base.error);
  log(`pomtreed: model upstream ${base.display} (provider ${i.provider})`);
  const proxy: ModelProxyOptions = {
    upstream: i.upstream,
    budget: i.debits,
    maximumRequestMicros: e.maximumRequestMicros,
    price: createPrice(i.catalog.rates, i.provider),
    estimate: createRequestEstimate(i.catalog.rates, i.provider),
    upstreamTimeoutMs: e.upstreamTimeoutMs,
    authStyle: i.provider === "anthropic" ? "both" : "bearer",
    allowedPaths: e.allowedPaths,
    ...(i.catalog.found && { estimateSettle: createSettleEstimate(i.catalog.rates, i.provider) }),
    ...(i.fetch && { fetch: i.fetch }),
    baseUrlName,
    warn: log,
    ...(i.onBudgetStall && { onBudgetStall: i.onBudgetStall }),
    onSettlement:
      i.onSettlement ?? settlementSink({ debits: i.debits, registry: i.registry, journal: i.journal, ...(i.host !== undefined && { host: i.host }) }),
  };
  return { proxy, tokenTtlMs: e.tokenTtlMs, upstreamTimeoutMs: e.upstreamTimeoutMs };
}

// Releases reservations stranded by a crash/hang now and every RECLAIM_INTERVAL_MS; returns the (unref'd) timer to clear.
export function startReservationReclaim(
  debits: Parameters<typeof reclaimStaleReservations>[0],
  upstreamTimeoutMs: number,
  log: (message: string) => void,
): ReturnType<typeof setInterval> {
  const reclaim = (): void => {
    try {
      const n = reclaimStaleReservations(debits, upstreamTimeoutMs);
      if (n > 0) log(`pomtreed: released ${n} stale model reservation(s)`);
    } catch (e) {
      log(`pomtreed: model reservation reclaim failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  reclaim();
  const timer = setInterval(reclaim, RECLAIM_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
