import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentId, JsonValue, MountSpec } from "@pomtree/core";

export type BindMount = Extract<MountSpec, { kind: "bind" }>;

// A per-agent, metadata-only model entry for the staged models.json (Pi `models` array, matched by id). It carries no
// baseUrl, headers, auth or code: the controller proxy route stays the only transport. compat is JSON data only.
export interface ProxyModelOverride {
  id: string;
  name?: string;
  api?: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, JsonValue>;
}

export interface StagedModelCredential {
  key: string; // short-lived signed per-agent token, never the operator's real key
  baseUrl: string; // the controller proxy base URL
}

export interface PiCredentials {
  // The credential is scoped to the issued token + proxy base URL; the operator's real auth.json is
  // never copied, and staging fails closed without a issued key.
  stage(id: AgentId, model: StagedModelCredential): BindMount[];
  unstage(id: AgentId): void;
  // Provider ids (key NAMES only, never values) the staged credentials are written for.
  providerIds?(): readonly string[];
}

export const agentPiDir = (stateDir: string, id: AgentId) => join(stateDir, "agents", id, "pi");
export const agentAuthPath = (stateDir: string, id: AgentId) => join(agentPiDir(stateDir, id), "auth.json");

// Pi takes a proper-lockfile style lock (mkdir auth.json.lock) next to auth.json even to READ credentials, so
// the directory holding it must be writable by the image user (uid 1000). A single-file bind mount into the
// tmpfs /home/node left the parent dir root-owned 0755 (EACCES). We therefore mount a per-agent directory
// (the scoped auth.json, models.json and settings.json) read-write as Pi's config dir; the operator's real
// file is never read or copied.
// TODO(auth-perms): on a host uid == 1000 the dir is 0700/files 0600. On any other uid we cannot chown
// without root, so the leaf dir is 0777 and files 0666; the parent agents/<id> dir stays 0700 so only the
// host user can reach it (other local users cannot traverse), but the container uid can write.
// TODO(pi-trust): settings.json is mounted read-only over the dir so the agent cannot loosen project trust.
// Copies are fresh per agent and removed at settle; failures propagate so the agent start fails loudly.
// Retry ladder (TODO(retry-ladder) decision): pomtreed's is the ONE ladder; Pi's own is off. Pi 1.1.0 retries transient failures by
// default (retry.enabled true, 3 attempts, 2s/4s/8s; retry.provider.maxRetries 0 per Pi docs/settings.md), but every failed attempt
// still ends a message with stopReason "error", which the harness journals as a provider_error and pomtreed answers with a timer yield,
// so the two ladders raced (and Pi's retry wait can mark the settle aborted, TODO(no-passive-settle)). pomtreed's ladder is kept
// because it is the one that is durable (a timer wait survives a daemon restart), journaled with idempotency keys, shared across
// agents through the provider breaker, bounded by maxProviderRetries, and frees the placement slot during a long outage. Cost: a
// transient 429 costs a stop/resume instead of an in-container sleep. Reopen if that cost shows up in real runs: the alternative is
// Pi retries in-container and the harness journals only auto_retry_end{success:false} as the provider_error.
// cacheWarming off: Pi defaults it to "idle", which sends provider requests between runs to keep prompt caches warm; an idle agent must send none.
export const PI_SETTINGS = '{"defaultProjectTrust":"never","cacheWarming":"off","retry":{"enabled":false,"provider":{"maxRetries":0}}}\n';

// Creates the per-agent writable Pi config dir, writes the given scoped auth.json plus the read-only settings.json and a models.json, and
// returns the bind mounts. The operator's real file is never touched; failures propagate so the agent
// start fails loudly.
function stageAuthDir(stateDir: string, id: AgentId, containerAuthPath: string, authJson: string | Uint8Array, modelsJson?: string): BindMount[] {
  const containerDir = dirname(containerAuthPath);
  const dir = agentPiDir(stateDir, id);
  const agentRoot = dirname(dir);
  const own = typeof process.getuid !== "function" || process.getuid() === 1000;
  rmSync(agentRoot, { recursive: true, force: true });
  mkdirSync(agentRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: own ? 0o700 : 0o777 });
  const fmode = own ? 0o600 : 0o666;
  if (!own) chmodSync(dir, 0o777); // mkdir mode is masked by umask
  writeFileSync(join(dir, "auth.json"), authJson, { mode: fmode });
  if (modelsJson !== undefined) writeFileSync(join(dir, "models.json"), modelsJson, { mode: fmode });
  writeFileSync(join(dir, "settings.json"), PI_SETTINGS, { mode: 0o444 });
  if (!own) chmodSync(join(dir, "auth.json"), fmode);
  const real = realpathSync(dir);
  return [
    { kind: "bind", hostPath: real, containerPath: containerDir },
    { kind: "bind", hostPath: join(real, "settings.json"), containerPath: `${containerDir}/settings.json`, readOnly: true },
  ];
}

// Verified against the pinned Pi: Pi ignores an auth.json `env` base URL for the
// deepseek provider (its openai-completions client takes `baseUrl` from the catalog, not from
// OPENAI_BASE_URL/DEEPSEEK_BASE_URL), but it honors a `models.json` `{providers:{<id>:{baseUrl}}}`
// override for a built-in provider. The proxy also requires a unique idempotency key on every request
// (the durable debit store keys reserve/settle on it) and Pi sends none by itself, so the staged
// models.json injects it as a header whose value is a per-request `!command` (Pi evaluates command-
// valued header fields at request time and does not cache them).
export const PROXY_REQUEST_ID_HEADER = "x-pomtree-request-id";
export const PROXY_REQUEST_ID_COMMAND = "!cat /proc/sys/kernel/random/uuid";

// A scoped per-agent auth.json: `{ [provider]: { type: "api_key", key: <signed token> } }`. The token
// is the controller-proxy credential, never the operator's real key; the proxy base URL and request-id
// header live in the staged models.json (see proxyModelsJson), the mechanism Pi honors.
export function proxyAuthJson(provider: string, key: string): string {
  return `${JSON.stringify({ [provider]: { type: "api_key", key } }, null, 2)}\n`;
}

const MODEL_OVERRIDE_MAX = 16;
const MODEL_OVERRIDE_FIELDS = new Set(["id", "name", "api", "reasoning", "input", "contextWindow", "maxTokens", "cost", "compat"]);
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const MODEL_NUMBER_BOUND = 10_000_000;
// Transport and credential keys never travel inside compat; compat is inert JSON metadata only.
const COMPAT_FORBIDDEN = new Set(["baseUrl", "headers", "apiKey", "auth", "api", "env"]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function isJsonData(v: unknown, depth = 0): v is JsonValue {
  if (depth > 32) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonData(x, depth + 1));
  if (isPlainObject(v)) return Object.values(v).every((x) => isJsonData(x, depth + 1));
  return false;
}

const boundedInt = (v: unknown, where: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MODEL_NUMBER_BOUND)
    throw new Error(`${where} must be an integer from 1 to ${MODEL_NUMBER_BOUND}`);
  return v;
};

// Fail-closed validation and deep snapshot of per-agent model overrides. Returns fresh objects that share nothing with the input,
// so later mutation of the caller's array or objects cannot change what is staged.
export function snapshotModelOverrides(overrides: readonly ProxyModelOverride[] | undefined): ProxyModelOverride[] | undefined {
  if (overrides === undefined) return undefined;
  if (!Array.isArray(overrides) || overrides.length < 1 || overrides.length > MODEL_OVERRIDE_MAX)
    throw new Error(`modelOverrides must be a nonempty array of at most ${MODEL_OVERRIDE_MAX} models`);
  const ids = new Set<string>();
  const snapshot = overrides.map((m: unknown, i) => {
    const where = `modelOverrides[${i}]`;
    if (!isPlainObject(m)) throw new Error(`${where} must be an object`);
    for (const k of Object.keys(m)) if (!MODEL_OVERRIDE_FIELDS.has(k)) throw new Error(`${where} has unknown field ${k}`);
    const { id, name, api, reasoning, input, contextWindow, maxTokens, cost, compat } = m;
    if (typeof id !== "string" || id.trim() === "") throw new Error(`${where}.id must be a nonempty string`);
    if (ids.has(id)) throw new Error(`${where}.id ${id} is duplicated`);
    ids.add(id);
    if (name !== undefined && (typeof name !== "string" || name.trim() === "")) throw new Error(`${where}.name must be a nonempty string`);
    if (api !== undefined && (typeof api !== "string" || api.trim() === "")) throw new Error(`${where}.api must be a nonempty string`);
    if (typeof reasoning !== "boolean") throw new Error(`${where}.reasoning must be a boolean`);
    if (!Array.isArray(input) || input.length < 1 || new Set(input).size !== input.length || !input.every((x) => x === "text" || x === "image"))
      throw new Error(`${where}.input must be a nonempty unique list of "text" and "image"`);
    if (!isPlainObject(cost) || Object.keys(cost).length !== COST_FIELDS.length)
      throw new Error(`${where}.cost must have input, output, cacheRead and cacheWrite`);
    const costOf = (f: (typeof COST_FIELDS)[number]): number => {
      const x = cost[f];
      if (typeof x !== "number" || !Number.isFinite(x) || x < 0) throw new Error(`${where}.cost.${f} must be a finite non-negative number`);
      return x;
    };
    let compatCopy: Record<string, JsonValue> | undefined;
    if (compat !== undefined) {
      if (!isPlainObject(compat)) throw new Error(`${where}.compat must be an object`);
      for (const k of Object.keys(compat)) if (COMPAT_FORBIDDEN.has(k)) throw new Error(`${where}.compat may not set ${k}`);
      if (!isJsonData(compat)) throw new Error(`${where}.compat must be JSON data`);
      compatCopy = JSON.parse(JSON.stringify(compat)) as Record<string, JsonValue>;
    }
    return {
      id,
      ...(name !== undefined && { name }),
      ...(api !== undefined && { api }),
      reasoning,
      input: [...input] as ("text" | "image")[],
      contextWindow: boundedInt(contextWindow, `${where}.contextWindow`),
      maxTokens: boundedInt(maxTokens, `${where}.maxTokens`),
      cost: { input: costOf("input"), output: costOf("output"), cacheRead: costOf("cacheRead"), cacheWrite: costOf("cacheWrite") },
      ...(compatCopy !== undefined && { compat: compatCopy }),
    };
  });
  if (new Set(snapshot.map((m) => m.api).filter((a) => a !== undefined)).size > 1) throw new Error("modelOverrides name conflicting api values");
  return snapshot;
}

// A staged models.json that routes the built-in provider through the controller proxy and injects the
// idempotency header the proxy requires. The `baseUrl` override plus `headers` preserves the provider's
// built-in models (custom-provider.md); the `!command` header value is evaluated per request, so every
// call carries a fresh idempotency key. Optional modelOverrides add metadata-only `models` entries (matched by id);
// without them the output is unchanged. Provider `api` is copied only when every override names the same api.
export function proxyModelsJson(provider: string, baseUrl: string, modelOverrides?: readonly ProxyModelOverride[]): string {
  const models = snapshotModelOverrides(modelOverrides);
  const entry: Record<string, unknown> = { baseUrl, headers: { [PROXY_REQUEST_ID_HEADER]: PROXY_REQUEST_ID_COMMAND } };
  if (models) {
    // Copied to the provider only when every override names the same api (conflicts were rejected by the snapshot).
    const apis = new Set(models.map((m) => m.api));
    const [only] = apis.size === 1 ? apis : [];
    if (only !== undefined) entry.api = only;
    entry.models = models;
  }
  return `${JSON.stringify({ providers: { [provider]: entry } }, null, 2)}\n`;
}

export interface ProxyPiCredentialsOptions {
  stateDir: string;
  containerAuthPath: string;
  provider: string;
  modelOverrides?: readonly ProxyModelOverride[];
}

// Scoped credential staging for the controller-side model proxy. `stage(id, model)` requires the
// freshly issued per-agent token and proxy base URL (what the proxy gateway returns); it writes an
// auth.json scoped to that token plus a models.json that routes the provider through the proxy,
// instead of copying the operator's whole auth.json.
export function proxyPiCredentials(options: ProxyPiCredentialsOptions): PiCredentials {
  if (!options.provider) throw new Error("proxyPiCredentials: provider is required");
  // Snapshotted (and validated) once at construction: later mutation of the caller's options cannot change staging.
  const modelOverrides = snapshotModelOverrides(options.modelOverrides);
  return {
    stage(id, model) {
      if (!model.key || !model.baseUrl) throw new Error(`proxy credential for ${id} is missing its issued key or base URL`);
      return stageAuthDir(
        options.stateDir,
        id,
        options.containerAuthPath,
        proxyAuthJson(options.provider, model.key),
        proxyModelsJson(options.provider, model.baseUrl, modelOverrides),
      );
    },
    providerIds() {
      return [options.provider];
    },
    // TODO(auth-stage-leak): remove leftover auth.json files for non-running agents at startup. Current behavior: unstage runs
    // on the yield, exit and settle paths only; after a crash the files remain, and reconcileWorktrees does not scan them.
    unstage(id) {
      rmSync(join(options.stateDir, "agents", id), { recursive: true, force: true });
    },
  };
}
