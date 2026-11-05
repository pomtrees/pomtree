// The one registry of tunable parameters: the seed below, plus params-daemon.ts (everything pomtreed reads from env) and
// params-client.ts (the pomtree client). Defaults live here and nowhere else; consumers read them through CONFIG_DEFAULTS or the resolved
// config. Naming: see CONFIG_ENV_PREFIXES (env-name.ts).
//
// Core references no extension key: an example's keys (examples/hn-digest/params.mts) are declared in its manifest and
// compose under ext.<segment>.* (extend.ts), and any relation to a core key is declared by the extension. Keys marked `container: true` reach agent containers in PTREE_CONFIG_JSON (container.ts).
//
// Deliberately NOT parameters (fixed policy or contract, never overridable through the registry): the browser tool allowlist
// (BROWSER_TOOLS), the audited-public egress requirement for browser workers, the openrouter upstream-origin pin, the private-IP
// class lists, the messaging sender and agent allowlists (access control, configured by their own owners), image facts such as
// NODE_BIN and CHROMIUM_BIN (and those in image-facts.ts), closed enums, schema ids and evidence markers, and the digest's
// story-result and analysis-shape bounds (schema constants covered by its measured worst-case tests). Env names that are not
// parameters: exclusions.ts.
import { CLIENT_PARAMS } from "./params-client.ts";
import { DAEMON_PARAMS } from "./params-daemon.ts";
import type { ConfigValues, ParamDef } from "./registry.ts";
import { defineRegistry } from "./registry.ts";

const POMTREED = "@pomtree/pomtreed";
const AGENT_IMAGE = "@pomtree/agent-image";
const SANDBOX_DOCKER = "@pomtree/sandbox-docker";
const HN_DIGEST = "examples/hn-digest";

export const SEED_PARAMS = [
  {
    path: "report.maxBytes",
    kind: "bytes",
    default: 8 * 1024 * 1024,
    min: 1,
    doc: "Cap on one agent report body (POST /v1/agents/self/reports).",
    scope: "operator",
    consumers: [POMTREED, HN_DIGEST],
  },
  {
    path: "report.workflowMaxBytes",
    kind: "bytes",
    default: 256 * 1024,
    min: 1,
    doc: "Ceiling on one workflow-capability report and fetch.",
    scope: "operator",
    consumers: [POMTREED, HN_DIGEST],
    relations: [{ op: "lte", key: "report.maxBytes" }],
  },
  {
    // pomtreed main.ts reads cfg["push.maxBytes"] and passes it to Sandbox.resultWork as maxBytes.
    path: "push.maxBytes",
    kind: "bytes",
    default: 256 * 1024 * 1024,
    min: 1,
    doc: "Cap on one agent push body (POST /v1/agents/:id/push) and on one result-save bundle.",
    scope: "operator",
    consumers: [POMTREED, SANDBOX_DOCKER],
  },
  {
    // The registry is the only source: pomtreed main.ts reads cfg["budget.rootMicros"] (the old main.ts literal is deleted)
    path: "budget.rootMicros",
    kind: "micros",
    default: 10_000_000,
    doc: "The root budget pool that top-level agents are carved from.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    // The registry is the only source: pomtreed main.ts reads cfg["budget.topLevelMicros"] (the old main.ts literal is deleted)
    path: "budget.topLevelMicros",
    kind: "micros",
    default: 5_000_000,
    min: 1,
    doc: "Budget carved for a top-level (operator) spawn that names none.",
    scope: "run",
    consumers: [POMTREED],
    ceiling: "budget.rootMicros",
  },
  {
    // Supplied only through POMTREED_MODEL_UPSTREAM_KEY_FILE (sensitive key); pomtreed reads it via the registry
    path: "model.upstreamKey",
    kind: "string",
    default: "",
    sensitive: true,
    doc: "The model proxy's upstream API key.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "browser.capture.maxBytesCeiling",
    kind: "bytes",
    default: 1024 * 1024,
    min: 1,
    doc: "Ceiling on the maxBytes a browser_capture call may request (raw body and rendered DOM).",
    scope: "operator",
    consumers: [AGENT_IMAGE, HN_DIGEST],
    container: true,
    relations: [
      { op: "lte", key: "browser.capture.rawAllocationMaxBytes" },
      { op: "lte", key: "report.maxBytes" },
    ],
  },
  {
    path: "browser.capture.rawAllocationMaxBytes",
    kind: "bytes",
    default: 8 * 1024 * 1024,
    min: 1,
    doc: "Largest declared main response a capture buffers at all (Playwright reads the whole entity); beyond it nothing is read.",
    scope: "operator",
    consumers: [AGENT_IMAGE],
    container: true,
    relations: [{ op: "lte", key: "capacity.containerMemoryBytes" }],
  },
  {
    path: "browser.capture.textMaxBytes",
    kind: "bytes",
    default: 1024 * 1024,
    min: 1,
    doc: "UTF-8 bytes of mechanical page text a capture stores whole as one retained report (the digest's analyst reads it in pages); text beyond it is clipped and marked truncated.",
    scope: "operator",
    consumers: [AGENT_IMAGE, HN_DIGEST],
    container: true,
    relations: [{ op: "lte", key: "report.maxBytes" }],
  },
  {
    path: "browser.capture.screenshotMaxBytes",
    kind: "bytes",
    default: 1024 * 1024,
    min: 1,
    doc: "Largest capture screenshot PNG; a larger one is retaken smaller, never truncated.",
    scope: "operator",
    consumers: [AGENT_IMAGE, HN_DIGEST],
    container: true,
    relations: [{ op: "lte", key: "report.maxBytes" }],
  },
  {
    path: "browser.capture.deadlineMinMs",
    kind: "ms",
    default: 1000,
    min: 1,
    doc: "Smallest deadline a browser_capture call may request.",
    scope: "operator",
    consumers: [AGENT_IMAGE, HN_DIGEST],
    container: true,
    relations: [{ op: "lt", key: "browser.capture.deadlineMaxMs" }],
  },
  {
    path: "browser.capture.deadlineMaxMs",
    kind: "ms",
    default: 120_000,
    min: 1,
    doc: "Largest deadline a browser_capture call may request.",
    scope: "operator",
    consumers: [AGENT_IMAGE, HN_DIGEST],
    container: true,
  },
] as const satisfies readonly ParamDef[];

export const CONFIG_REGISTRY = defineRegistry([...SEED_PARAMS, ...DAEMON_PARAMS, ...CLIENT_PARAMS]);

export type ConfigParams = (typeof CONFIG_REGISTRY)["params"];

// Every key's registry default, typed and frozen: the single source for in-code fallbacks and for embedders (the digest host,
// tests) that need the defaults without resolving.
export const CONFIG_DEFAULTS: ConfigValues<ConfigParams> = Object.freeze(
  Object.fromEntries(CONFIG_REGISTRY.params.map((p) => [p.path, p.default])),
) as ConfigValues<ConfigParams>;
