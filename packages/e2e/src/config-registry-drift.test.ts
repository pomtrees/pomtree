import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONFIG_ENV_EXCLUSIONS,
  CONFIG_FILE_ENV,
  CONFIG_REGISTRY,
  DEFAULT_DENIED_PATHS,
  EXT_ENV_PREFIX,
  type ExtParamDecl,
  extendRegistry,
  isExcludedEnv,
} from "@pomtree/core";
import { DEFAULT_WATCHDOG } from "@pomtree/sched";
import { digestComposedRegistry } from "./digest-registry.ts";
import { scanNames } from "./env-scan.ts";
import { CONTAINER_DEFAULTS as POMTREE_CONTAINER_DEFAULTS } from "../../pomtree/src/container-contract.gen.ts";
import { AGENT_TOKEN_TTL_MS } from "../../pomtreed/src/auth.ts";
import { DEFAULT_BUDGET_RAISE_MS, DEFAULT_BUDGET_RAISE_PCT } from "../../pomtreed/src/budget-raise.ts";
import { publishScanEnabled } from "../../pomtreed/src/config.ts";
import { DEFAULT_MAX_SESSION_MS, DEFAULT_SESSION_MS } from "../../pomtreed/src/daemon.ts";
import { parseJournalRetentionEnv } from "../../pomtreed/src/daemon-util.ts";
import { DEFAULT_CONTAINER_MEMORY_BYTES } from "../../pomtreed/src/host-guards.ts";
import { DEFAULT_LIMITS } from "../../pomtreed/src/lifecycle.ts";
import { DEFAULT_MAX_REQUEST_MICROS, DEFAULT_PROXY_TOKEN_TTL_MS, modelProxyEnv } from "../../pomtreed/src/model-proxy-options.ts";
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "../../pomtreed/src/model-proxy/service.ts";

// Guard for the config registry. Every POMTREED_*/POMTREE_*/PTREE_* name in non-test source must be a live registry name or
// covered by the one exclusion list (CONFIG_ENV_EXCLUSIONS in packages/core/src/config/exclusions.ts). A new env read that is none of these fails here.

export type Verdict = "live" | "excluded" | "family" | "unknown";

// How a name found in source is accounted for. A family reference (trailing `_`) is fine when it is the extension family prefix
// (POMTREED_EXT_: every name under it is declared by an extension's manifest, never in source), an excluded prefix or the shared
// prefix of at least one live name. A concrete POMTREED_EXT_<NAME>_<KEY> in source is unknown: it belongs in a manifest.
export function classifyName(name: string, live: ReadonlySet<string>): Verdict {
  if (live.has(name) || name === CONFIG_FILE_ENV) return "live";
  if (isExcludedEnv(name)) return "excluded";
  if (
    name.endsWith("_") &&
    (name === EXT_ENV_PREFIX || CONFIG_ENV_EXCLUSIONS.some((e) => e.prefix && e.name.startsWith(name)) || [...live].some((n) => n.startsWith(name)))
  )
    return "family";
  return "unknown";
}

test("classifyName: live, excluded and family names pass; anything else is unknown (negative variants included)", () => {
  const live = new Set(["POMTREED_JOURNAL_RETENTION_MS"]);
  assert.equal(classifyName("POMTREED_JOURNAL_RETENTION_MS", live), "live");
  assert.equal(classifyName("POMTREE_TOKEN", live), "excluded");
  assert.equal(classifyName("POMTREED_EXT_GITHUB_TOKEN", live), "unknown", "extension names come from manifests, not source");
  assert.equal(classifyName("POMTREED_JOURNAL_", live), "family");
  assert.equal(classifyName("POMTREED_EXT_", live), "family");
  assert.equal(isExcludedEnv("POMTREED_EXT_"), undefined, "the extension family is composed from manifests, not excluded");
  assert.equal(classifyName("POMTREED_NEW_KNOB", live), "unknown");
  assert.equal(classifyName("POMTREED_NOPE_", live), "unknown");
  assert.equal(classifyName("POMTREED_JOURNAL_RETENTION", live), "unknown", "a bare stem of a live name is not a family reference");
});

test("every env name in non-test source is a registry name or a documented exclusion", () => {
  const found = scanNames();
  assert.ok(found.size > 50, `the scan found env names (${found.size})`);
  // The digest's names live in its manifest, not in core: judge against core composed with the real hn-digest manifest.
  const composed = digestComposedRegistry();
  const unknown = [...found].filter(([n]) => classifyName(n, composed.envNames) === "unknown").map(([n, f]) => `${n} (${f})`);
  assert.deepEqual(unknown, [], "register it in packages/core/src/config or add it to CONFIG_ENV_EXCLUSIONS with a reason");
});

test("every exclusion is still referenced somewhere, so the list cannot rot", () => {
  const found = [...scanNames().keys()];
  const stale = CONFIG_ENV_EXCLUSIONS.filter((e) => !found.some((n) => (e.prefix ? n.startsWith(e.name) : n === e.name))).map((e) => e.name);
  assert.deepEqual(stale, [], "drop exclusions nothing in source names any more");
});

test("the registry composed with the real hn-digest manifest: the moved keys are ext keys, the old POMTREED_ARTICLE_* names are not live names, and core names no ext key", () => {
  const composed = digestComposedRegistry();
  const moved: [string, string, string][] = [
    ["POMTREED_ARTICLE_CAPTURE_BYTES", "ext.hnDigest.articleCaptureBytes", "POMTREED_EXT_HN_DIGEST_ARTICLE_CAPTURE_BYTES"],
    ["POMTREED_ARTICLE_AUDIT_BODY_MAX_BYTES", "ext.hnDigest.articleAuditBodyMaxBytes", "POMTREED_EXT_HN_DIGEST_ARTICLE_AUDIT_BODY_MAX_BYTES"],
    ["POMTREED_ARTICLE_TEXT_MAX_BYTES", "ext.hnDigest.articleTextMaxBytes", "POMTREED_EXT_HN_DIGEST_ARTICLE_TEXT_MAX_BYTES"],
    ["POMTREED_ARTICLE_PAGE_MAX_BYTES", "ext.hnDigest.articlePageMaxBytes", "POMTREED_EXT_HN_DIGEST_ARTICLE_PAGE_MAX_BYTES"],
    ["POMTREED_ARTICLE_ANALYST_READ_MAX_BYTES", "ext.hnDigest.articleAnalystReadMaxBytes", "POMTREED_EXT_HN_DIGEST_ARTICLE_ANALYST_READ_MAX_BYTES"],
    [
      "POMTREED_ARTICLE_BROWSER_CAPTURE_DEADLINE_MS",
      "ext.hnDigest.articleBrowserCaptureDeadlineMs",
      "POMTREED_EXT_HN_DIGEST_ARTICLE_BROWSER_CAPTURE_DEADLINE_MS",
    ],
    ["POMTREED_DIGEST_REPORT_MAX_BYTES", "ext.hnDigest.reportMaxBytes", "POMTREED_EXT_HN_DIGEST_REPORT_MAX_BYTES"],
  ];
  for (const [old, path, env] of moved) {
    assert.equal(composed.envOf.get(path), env, path);
    assert.ok(!composed.envNames.has(old), `${old} is not a live name`);
    assert.ok(!CONFIG_REGISTRY.byPath.has(path) && !CONFIG_REGISTRY.envNames.has(env), "core does not carry the moved key");
  }
  const names = [...composed.envOf.values()];
  assert.equal(new Set(names).size, names.length);
  for (const p of CONFIG_REGISTRY.params)
    for (const r of "relations" in p && p.relations ? p.relations : []) assert.ok(!r.key.startsWith("ext."), `${p.path} references ext key ${r.key}`);
});

test("the registry composed with a fixture extension (keys, credentials) also derives unique env names", () => {
  const k = (key: string, extra: object = {}) => ({ key, kind: "count", doc: "d", default: 1, ...extra }) as ExtParamDecl;
  const composed = extendRegistry(CONFIG_REGISTRY, [
    { name: "hn-digest", credentials: ["api_token"], params: [k("maxCount"), k("otherCount")] },
    { name: "github", credentials: ["token"], params: [k("maxCount")] },
  ]);
  const names = [...composed.envOf.values()];
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(
    names.filter((n) => n.startsWith(EXT_ENV_PREFIX)),
    ["POMTREED_EXT_HN_DIGEST_MAX_COUNT", "POMTREED_EXT_HN_DIGEST_OTHER_COUNT", "POMTREED_EXT_GITHUB_MAX_COUNT"],
  );
  for (const live of [...composed.envOf.values(), "POMTREED_EXT_HN_DIGEST_API_TOKEN", "POMTREED_EXT_GITHUB_TOKEN"])
    assert.ok(composed.envNames.has(live), live);
});

// Phase 1a interim: each daemon default equals the importable source default still holding it. Covered here: session.defaultMs,
// session.maxMs, agent.tokenTtlMs, agent.maxDepth, agent.maxChildren, agent.zombieMs, watchdog.sweepMs/blockedMs/
// intensityWindowMs/stableMs/stallMs, cron.tickMs, cleanup.sweepMs, capacity.containerMemoryBytes, wait.yieldMs (the pomtree
// client's generated no-document fallback), budget.raiseMs, budget.raisePct, model.upstreamTimeoutMs, model.proxy.ttlMs, model.proxy.maxRequestMicros,
// model.proxy.extraPaths, journal.keepPerAgent, publish.scan, merge.deny and publish.deny. The remaining keys have no old symbol left
// to compare: pomtreed main.ts reads them from the registry (pomtreed config-wiring.test.ts covers the wired defaults).
const defaults: Readonly<Record<string, unknown>> = Object.fromEntries(CONFIG_REGISTRY.params.map((p) => [p.path, p.default]));

test("each daemon registry default equals the source default it replaces", () => {
  const proxy = modelProxyEnv({});
  const OLD: ReadonlyArray<readonly [path: string, symbol: string, value: unknown]> = [
    ["session.defaultMs", "DEFAULT_SESSION_MS", DEFAULT_SESSION_MS],
    ["session.maxMs", "DEFAULT_MAX_SESSION_MS", DEFAULT_MAX_SESSION_MS],
    ["agent.tokenTtlMs", "AGENT_TOKEN_TTL_MS", AGENT_TOKEN_TTL_MS],
    ["agent.maxDepth", "DEFAULT_LIMITS.maxDepth", DEFAULT_LIMITS.maxDepth],
    ["agent.maxChildren", "DEFAULT_LIMITS.maxChildren", DEFAULT_LIMITS.maxChildren],
    ["agent.zombieMs", "DEFAULT_LIMITS.zombieMs", DEFAULT_LIMITS.zombieMs],
    ["agent.zombieSweepMs", "DEFAULT_LIMITS.zombieSweepMs", DEFAULT_LIMITS.zombieSweepMs],
    ["watchdog.sweepMs", "DEFAULT_LIMITS.watchdogSweepMs", DEFAULT_LIMITS.watchdogSweepMs],
    ["watchdog.blockedMs", "DEFAULT_LIMITS.watchdogBlockedMs", DEFAULT_LIMITS.watchdogBlockedMs],
    ["watchdog.intensityWindowMs", "DEFAULT_LIMITS.watchdogIntensityWindowMs", DEFAULT_LIMITS.watchdogIntensityWindowMs],
    ["watchdog.stableMs", "DEFAULT_LIMITS.watchdogStableMs", DEFAULT_LIMITS.watchdogStableMs],
    ["watchdog.stallMs", "DEFAULT_WATCHDOG.stallMs", DEFAULT_WATCHDOG.stallMs],
    ["cron.tickMs", "DEFAULT_LIMITS.cronTickMs", DEFAULT_LIMITS.cronTickMs],
    ["cleanup.sweepMs", "DEFAULT_LIMITS.cleanupSweepMs", DEFAULT_LIMITS.cleanupSweepMs],
    ["capacity.containerMemoryBytes", "DEFAULT_CONTAINER_MEMORY_BYTES", DEFAULT_CONTAINER_MEMORY_BYTES],
    ["wait.yieldMs", "CONTAINER_DEFAULTS (pomtree container-contract.gen.ts, the no-document fallback)", POMTREE_CONTAINER_DEFAULTS["wait.yieldMs"]],
    ["budget.raiseMs", "DEFAULT_BUDGET_RAISE_MS", DEFAULT_BUDGET_RAISE_MS],
    ["budget.raisePct", "DEFAULT_BUDGET_RAISE_PCT", DEFAULT_BUDGET_RAISE_PCT],
    ["model.upstreamTimeoutMs", "DEFAULT_UPSTREAM_TIMEOUT_MS", DEFAULT_UPSTREAM_TIMEOUT_MS],
    ["model.upstreamTimeoutMs", "modelProxyEnv({}).upstreamTimeoutMs", proxy.upstreamTimeoutMs],
    ["model.proxy.ttlMs", "DEFAULT_PROXY_TOKEN_TTL_MS", DEFAULT_PROXY_TOKEN_TTL_MS],
    ["model.proxy.ttlMs", "modelProxyEnv({}).tokenTtlMs", proxy.tokenTtlMs],
    ["model.proxy.maxRequestMicros", "DEFAULT_MAX_REQUEST_MICROS", DEFAULT_MAX_REQUEST_MICROS],
    ["model.proxy.maxRequestMicros", "modelProxyEnv({}).maximumRequestMicros", proxy.maximumRequestMicros],
    ["journal.keepPerAgent", "parseJournalRetentionEnv keep default", parseJournalRetentionEnv({ POMTREED_JOURNAL_RETENTION_MS: "1" })?.keepPerAgent],
    ["publish.scan", "publishScanEnabled({})", publishScanEnabled({})],
    ["merge.deny", "DEFAULT_DENIED_PATHS", [...DEFAULT_DENIED_PATHS]],
    ["publish.deny", "DEFAULT_DENIED_PATHS", [...DEFAULT_DENIED_PATHS]],
  ];
  for (const [path, symbol, value] of OLD) {
    assert.ok(CONFIG_REGISTRY.byPath.has(path), `${path} is registered`);
    assert.deepEqual(defaults[path], value, `${path} default vs ${symbol}`);
  }
  assert.equal(parseJournalRetentionEnv({}), null, "journal.retentionMs default 0 = no pruning matches unset");
  assert.deepEqual(
    modelProxyEnv({}).allowedPaths,
    modelProxyEnv({ POMTREED_MODEL_PROXY_EXTRA_PATHS: "" }).allowedPaths,
    "model.proxy.extraPaths default [] adds nothing",
  );
});
