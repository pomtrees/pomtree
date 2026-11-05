// Runtime wiring of registry values that used to be compiled constants or were never injected (config registry Phase 1b).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONFIG_DEFAULTS,
  CONFIG_REGISTRY,
  CONTAINER_CONFIG_ENV,
  CONTAINER_CONFIG_MAX_BYTES,
  type ContainerConfigValues,
  containerContract,
  containerParamDefs,
  containerReadSpec,
  readContainerDoc,
  type WorkflowDef,
} from "@pomtree/core";
import { FakeJournal, FakeRegistry } from "@pomtree/testing";
import { DEFAULT_MAX_SESSION_MS } from "./daemon.ts";
import { loadDaemonConfig } from "./daemon-config.ts";
import { DEFAULT_CONTAINER_CONFIG, SANDBOX_LIFECYCLE_KIND } from "./daemon-util.ts";
import { agent, req } from "./capture/test-harness.ts";
import type { FetchFn } from "./ext-gateway.ts";
import { MODEL_KEY_TTL_SLACK_MS, ProxyCredentialGateway, decodeGatewayCredential, modelKeyTtlMs } from "./gateway.ts";
import { hostPacer } from "./host-pacer.ts";
import { testBroker, withRobots } from "./test-capture.ts";
import { setup, spawnSpec } from "./test-setup.ts";
import { buildRunOps, type WorkflowCapabilityServices } from "./workflow-capabilities.ts";
import { WorkflowHost } from "./workflows.ts";

const done = async (c: { api: (m: string, p: string, b?: unknown) => Promise<unknown> }) =>
  void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } }));

const SENTINEL = "sk-wiring-sentinel-5d1e";

// The resolved delivered subset, through the real loader (env overrides as an operator would set them).
function resolvedContainerConfig(env: Record<string, string>): ContainerConfigValues {
  const dir = mkdtempSync(join(tmpdir(), "pomtreed-wiring-"));
  try {
    const keyFile = join(dir, "upstream.key");
    writeFileSync(keyFile, `${SENTINEL}\n`, { mode: 0o600 });
    const r = loadDaemonConfig({
      env: { POMTREED_MODEL_BASE_URL: "http://127.0.0.1:1", POMTREED_MODEL_UPSTREAM_KEY_FILE: keyFile, POMTREED_PI_PROVIDER: "x", ...env },
      args: { set: [] },
      readFile: (p) => readFileSync(p, "utf8"),
      defaultStateDir: join(dir, "state"),
      scanExtensions: () => ({ extensions: [], errors: [] }),
    });
    assert.ok(r.ok, JSON.stringify(r));
    return r.containerConfig;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const read = (env: Readonly<Record<string, string>>) => readContainerDoc(env[CONTAINER_CONFIG_ENV], containerReadSpec(CONFIG_REGISTRY), { required: true });
const delivered = containerParamDefs(CONFIG_REGISTRY).map((p) => p.path);

test("every container gets the config document: it validates with core's reader and holds the delivered keys at defaults", async () => {
  const t = setup(done);
  await t.spawn();
  await t.orchestrator.idle();
  const env = t.fakes.hooks.raw.sandbox.started[0]!.env;
  const values = read(env);
  assert.deepEqual(Object.keys(values).sort(), [...delivered].sort());
  for (const k of delivered) assert.equal(values[k], (CONFIG_DEFAULTS as Record<string, unknown>)[k], k);
  assert.deepEqual(values, { ...DEFAULT_CONTAINER_CONFIG });
  // wait.yieldMs travels in the document now; the old env var is gone.
  assert.equal("POMTREED_WAIT_YIELD_MS" in env, false);
});

test("an operator override set through the loader reaches the container document", async () => {
  const containerConfig = resolvedContainerConfig({ POMTREED_BROWSER_CAPTURE_TEXT_MAX_BYTES: "4096", POMTREED_WAIT_YIELD_MS: "7000" });
  assert.equal(containerConfig["browser.capture.textMaxBytes"], 4096);
  const t = setup(done, { containerConfig });
  await t.spawn();
  await t.orchestrator.idle();
  const values = read(t.fakes.hooks.raw.sandbox.started[0]!.env);
  assert.equal(values["browser.capture.textMaxBytes"], 4096);
  assert.equal(values["wait.yieldMs"], 7000);
});

test("a caller-supplied PTREE_CONFIG_JSON (terminal env) is overwritten by the controller's document", async () => {
  const forged = JSON.stringify({ contract: "0".repeat(16), values: { "browser.capture.textMaxBytes": 1 << 30 } });
  const t = setup(done, {
    terminal: { size: { cols: 80, rows: 24 }, sinkFile: "sink.jsonl", env: { [CONTAINER_CONFIG_ENV]: forged, PTREE_BROWSER: "1", KEEP: "x" } },
  });
  await t.spawn();
  await t.orchestrator.idle();
  const env = t.fakes.hooks.raw.sandbox.started[0]!.env;
  assert.notEqual(env[CONTAINER_CONFIG_ENV], forged);
  assert.deepEqual(read(env), { ...DEFAULT_CONTAINER_CONFIG });
  assert.equal(env.PTREE_BROWSER, undefined, "the browser keys stay controller-only");
  assert.equal(env.KEEP, "x", "other terminal env still passes");
});

test("the sandbox started entry records the delivered subset: contract and values, no secret, within the document cap", async () => {
  const t = setup(done);
  const a = await t.spawn();
  await t.orchestrator.idle();
  const rows = (await t.journal.read({ agent: a.id }))
    .map((e) => e.payload as unknown as Record<string, unknown>)
    .filter((p) => p.kind === SANDBOX_LIFECYCLE_KIND);
  const started = rows.find((p) => p.phase === "started")!;
  const cc = started.containerConfig as { contract: string; values: Record<string, unknown> };
  assert.equal(cc.contract, containerContract(CONFIG_REGISTRY));
  assert.deepEqual(cc.values, { ...DEFAULT_CONTAINER_CONFIG });
  assert.ok(Buffer.byteLength(JSON.stringify(cc)) <= CONTAINER_CONFIG_MAX_BYTES);
  const json = JSON.stringify(started);
  assert.ok(!json.includes('POMTREE_TOKEN":"'), "no token value");
  assert.ok(!json.includes(SENTINEL));
  assert.equal("containerConfig" in rows.find((p) => p.phase === "exited")!, false);
});

test("result saves pass push.maxBytes to Sandbox.resultWork", async () => {
  const t = setup(done, { pushMaxBytes: 12_345 });
  await t.spawn();
  await t.orchestrator.idle();
  assert.ok(t.sandbox.resultWorkCalls.length > 0);
  for (const c of t.sandbox.resultWorkCalls) assert.equal(c.opts?.maxBytes, 12_345);
  const bare = setup(done);
  await bare.spawn();
  await bare.orchestrator.idle();
  for (const c of bare.sandbox.resultWorkCalls) assert.equal(c.opts?.maxBytes, CONFIG_DEFAULTS["push.maxBytes"]);
});

test("capacity.containerMemoryBytes is the real container memory limit when the spec names none", async () => {
  const t = setup(done, { containerMemoryBytes: 1024 ** 3 });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal(t.fakes.hooks.raw.sandbox.started[0]!.resources?.memoryBytes, 1024 ** 3);
  // Without the option (tests, embedders) the sandbox's own default stands: no resources are invented.
  const bare = setup(done);
  await bare.spawn();
  await bare.orchestrator.idle();
  assert.equal(bare.fakes.hooks.raw.sandbox.started[0]!.resources?.memoryBytes, undefined);
});

test("a model-proxy key issued at container start outlives the longest session", async () => {
  const now = 1_000;
  const registry = new FakeRegistry(() => now);
  await registry.create({
    id: "a1",
    parent: null,
    name: "a",
    task: "t",
    host: "h",
    budgetMicros: 10,
    idempotencyKey: "a1",
    spec: spawnSpec,
  });
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(() => now),
    registry,
    secret: "controller-secret",
    proxyBaseUrl: "http://model-relay.internal/v1",
    tokenTtlMs: 3_600_000,
    sessionMaxMs: DEFAULT_MAX_SESSION_MS,
    now: () => now,
  });
  const { key } = await gateway.issueKey("a1", 10, "start");
  assert.ok(decodeGatewayCredential("controller-secret", key, now + DEFAULT_MAX_SESSION_MS), "still valid at the session deadline");
  assert.equal(decodeGatewayCredential("controller-secret", key, now + DEFAULT_MAX_SESSION_MS + MODEL_KEY_TTL_SLACK_MS), null, "and bounded");
  assert.equal(modelKeyTtlMs(3_600_000), 3_600_000, "no session bound: the configured TTL");
  assert.equal(modelKeyTtlMs(10 * 3_600_000, 60_000), 10 * 3_600_000, "a longer configured TTL is kept");
});

// D1: the commit check uses the resolved ceiling (WorkflowHostOptions.reportCeilingBytes), not a compiled 256 KiB.
const ceilingHost = (reportCeilingBytes?: number) =>
  new WorkflowHost({
    registry: () => assert.fail("not read at commit") as never,
    reviewed: () => true,
    startDeterministic: async () => assert.fail("not started") as never,
    ...(reportCeilingBytes !== undefined && { reportCeilingBytes }),
  });
const flow = (maxBytes: number): WorkflowDef => ({
  name: "flow",
  capabilities: { fetch: { hosts: ["news.example.org"], maxRequests: 1, maxBytes, timeoutMs: 1000 }, reports: { maxBytes } },
  validate: (input) => ({ ok: true, value: input }),
  run: async () => {},
});

test("a lowered report.workflowMaxBytes refuses a 262144 declaration at commit; a raised one admits it", () => {
  assert.throws(() => ceilingHost(128 * 1024).commit("ext", [flow(262_144)]), /exceeds the report ceiling 131072/);
  assert.doesNotThrow(() => ceilingHost(1 << 20).commit("ext", [flow(1 << 20)]));
  // Absent (tests, embedders) = the registry default, which admits exactly 256 KiB.
  assert.doesNotThrow(() => ceilingHost().commit("ext", [flow(262_144)]));
  assert.throws(() => ceilingHost().commit("ext", [flow(262_145)]), /exceeds the report ceiling 262144/);
});

// main.ts is the only shell with process access: after loadDaemonConfig it must read no registered key from the env. The one
// allowed env read is the POMTREED_MESSAGING_SENDERS allowlist, which core config/exclusions.ts keeps out of the registry.
test("main.ts reads configuration only through loadDaemonConfig", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  assert.deepEqual(source.match(/process\.env\.[A-Z_]+/g), ["process.env.POMTREED_MESSAGING_SENDERS"]);
  assert.doesNotMatch(source, /(?<!process\.)\benv\.POMTREED_|\benv\[/);
  assert.match(source, /loadDaemonConfig\(\{\s*env: process\.env,/);
});

// The real loader over an operator env (the required model keys supplied), for keys main.ts passes straight into a service.
function loadEnv(env: Record<string, string>): ReturnType<typeof loadDaemonConfig> {
  const dir = mkdtempSync(join(tmpdir(), "pomtreed-wiring-"));
  try {
    const keyFile = join(dir, "upstream.key");
    writeFileSync(keyFile, `${SENTINEL}\n`, { mode: 0o600 });
    return loadDaemonConfig({
      env: { POMTREED_MODEL_BASE_URL: "http://127.0.0.1:1", POMTREED_MODEL_UPSTREAM_KEY_FILE: keyFile, POMTREED_PI_PROVIDER: "x", ...env },
      args: { set: [] },
      readFile: (q) => readFileSync(q, "utf8"),
      defaultStateDir: join(dir, "state"),
      scanExtensions: () => ({ extensions: [], errors: [] }),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// main.ts passes the resolved cfg["workflow.fetch.userAgent"] (never blank) as the capture broker's User-Agent;
// this drives the same value from the derived env name through a workflow fetch (a broker client) to the transport.
async function fetchHeaders(env: Record<string, string>): Promise<(Record<string, string> | undefined)[]> {
  const r = loadEnv(env);
  assert.ok(r.ok, JSON.stringify(r));
  const seen: (Record<string, string> | undefined)[] = [];
  const fetch: FetchFn = async (url, init) => {
    if (new URL(url).pathname === "/robots.txt") return { status: 404, headers: { get: () => null }, body: null };
    seen.push(init.headers);
    return url.endsWith("/a")
      ? { status: 302, headers: { get: (n) => (n === "location" ? "/b" : null) }, body: null }
      : { status: 200, headers: { get: () => "text/plain" }, body: (async function* () {})() };
  };
  const ua = r.config["workflow.fetch.userAgent"];
  const services = {
    agent: async () => ({ state: "running", generation: 1 }),
    now: () => 0,
    redactText: (t: string) => t,
    recordRoot: async () => null, // the fetch audit row (workflow-capabilities.test.ts covers its shape)
    capture: testBroker({ fetch, resolveDns: async () => [{ address: "93.184.216.34", family: 4 }], userAgent: ua }).broker,
  } as unknown as WorkflowCapabilityServices;
  const ops = buildRunOps({
    workflow: "ext/flow",
    caps: { fetch: { hosts: ["data.example.org"], maxRequests: 2, maxBytes: 100, timeoutMs: 1000 } }, // two hops, two requests
    ctx: { agent: "t1", generation: 1, host: "h", input: {}, signal: new AbortController().signal, deadlineAt: null } as never,
    getServices: () => services,
  });
  assert.equal((await ops.fetch("https://data.example.org/a")).url, "https://data.example.org/b");
  return seen;
}

test("POMTREED_WORKFLOW_FETCH_USER_AGENT reaches every hop of a workflow fetch; unset or blank, every hop carries the default product token", async () => {
  assert.equal(CONFIG_REGISTRY.envOf.get("workflow.fetch.userAgent"), "POMTREED_WORKFLOW_FETCH_USER_AGENT");
  const ua = "pomtree-example ops@example.org";
  assert.deepEqual(await fetchHeaders({ POMTREED_WORKFLOW_FETCH_USER_AGENT: ua }), [{ "user-agent": ua }, { "user-agent": ua }]);
  assert.equal(CONFIG_DEFAULTS["workflow.fetch.userAgent"], "pomtree");
  const dflt = [{ "user-agent": "pomtree" }, { "user-agent": "pomtree" }];
  assert.deepEqual(await fetchHeaders({}), dflt, "unset");
  assert.deepEqual(await fetchHeaders({ POMTREED_WORKFLOW_FETCH_USER_AGENT: "" }), dflt, "blank");
});

// main.ts passes the same resolved value as DaemonDeps.fetchUserAgent; a browser worker receives it as PTREE_BROWSER_USER_AGENT,
// which browser-capture.ts appends to Chromium's own User-Agent.
async function browserUserAgentEnv(env: Record<string, string>): Promise<string | undefined> {
  const r = loadEnv(env);
  assert.ok(r.ok, JSON.stringify(r));
  const t = setup(done, { fetchUserAgent: r.config["workflow.fetch.userAgent"] });
  t.fakes.hooks.raw.templates.templates.set("web", { id: "web", egress: { kind: "audited-public" }, browser: { maxSteps: 2, maxMs: 2000 } });
  await t.spawn("b1", { template: "web" });
  await t.orchestrator.idle();
  assert.equal(t.sandbox.started.length, 1);
  return t.sandbox.started[0]!.env.PTREE_BROWSER_USER_AGENT;
}

test("POMTREED_WORKFLOW_FETCH_USER_AGENT reaches a browser worker as PTREE_BROWSER_USER_AGENT; unset or blank, the default product token", async () => {
  const ua = "pomtree-example ops@example.org";
  assert.equal(await browserUserAgentEnv({ POMTREED_WORKFLOW_FETCH_USER_AGENT: ua }), ua);
  assert.equal(await browserUserAgentEnv({}), "pomtree", "unset");
  assert.equal(await browserUserAgentEnv({ POMTREED_WORKFLOW_FETCH_USER_AGENT: "" }), "pomtree", "blank");
});

test("robots.txt is evaluated for the resolved product token: a disallow for the default token blocks, an operator token is not blocked by it", async () => {
  const robots = async function* () {
    yield new TextEncoder().encode("User-agent: pomtree\nDisallow: /\n");
  };
  const run = async (env: Record<string, string>): Promise<number> => {
    const r = loadEnv(env);
    assert.ok(r.ok, JSON.stringify(r));
    let pages = 0;
    const fetch: FetchFn = async (url) => {
      if (new URL(url).pathname === "/robots.txt") return { status: 200, headers: { get: () => "text/plain" }, body: robots() };
      pages++;
      return { status: 200, headers: { get: () => "text/plain" }, body: (async function* () {})() };
    };
    const tb = testBroker({ fetch, resolveDns: async () => [{ address: "93.184.216.34", family: 4 }], userAgent: r.config["workflow.fetch.userAgent"] });
    await tb.broker.request(agent(), req("https://data.example.org/x"), "k");
    return pages;
  };
  assert.equal(await run({}), 0, "the default token is disallowed, nothing is fetched");
  assert.equal(await run({ POMTREED_WORKFLOW_FETCH_USER_AGENT: "acme-research" }), 1, "another token is allowed");
});

// main.ts passes hostPacer(cfg["workflow.fetch.minIntervalMs"]) as the capture broker's one pacer (every fetch path); this drives the
// same value from the derived env name through a two-hop workflow fetch and returns the gap between the two sends.
async function fetchGapMs(env: Record<string, string>): Promise<number> {
  const r = loadEnv(env);
  assert.ok(r.ok, JSON.stringify(r));
  // The pacer's clock and sleep are injected: the send times are the scheduled ones, so event-loop lag cannot shrink the gap.
  let clock = 1_000_000;
  const sentAt: number[] = [];
  const fetch: FetchFn = async (url) => {
    sentAt.push(clock);
    return url.endsWith("/a")
      ? { status: 302, headers: { get: (n) => (n === "location" ? "/b" : null) }, body: null }
      : { status: 200, headers: { get: () => "text/plain" }, body: (async function* () {})() };
  };
  const pace = hostPacer(r.config["workflow.fetch.minIntervalMs"], {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const services = {
    agent: async () => ({ state: "running", generation: 1 }),
    now: () => 0,
    redactText: (t: string) => t,
    recordRoot: async () => null, // the fetch audit row (workflow-capabilities.test.ts covers its shape)
    capture: testBroker({ fetch: withRobots(fetch), resolveDns: async () => [{ address: "93.184.216.34", family: 4 }], ...(pace && { pace }) }).broker,
  } as unknown as WorkflowCapabilityServices;
  const ops = buildRunOps({
    workflow: "ext/flow",
    caps: { fetch: { hosts: ["data.example.org"], maxRequests: 2, maxBytes: 100, timeoutMs: 5000 } },
    ctx: { agent: "t1", generation: 1, host: "h", input: {}, signal: new AbortController().signal, deadlineAt: null } as never,
    getServices: () => services,
  });
  assert.equal((await ops.fetch("https://data.example.org/a")).url, "https://data.example.org/b");
  assert.equal(sentAt.length, 2);
  return sentAt[1]! - sentAt[0]!;
}

test("POMTREED_WORKFLOW_FETCH_MIN_INTERVAL_MS spaces a workflow fetch's sends to one host (redirect hops included); default 0 is unpaced", async () => {
  assert.equal(CONFIG_REGISTRY.envOf.get("workflow.fetch.minIntervalMs"), "POMTREED_WORKFLOW_FETCH_MIN_INTERVAL_MS");
  assert.equal(CONFIG_DEFAULTS["workflow.fetch.minIntervalMs"], 0);
  assert.equal(hostPacer(CONFIG_DEFAULTS["workflow.fetch.minIntervalMs"]), undefined);
  assert.equal(await fetchGapMs({ POMTREED_WORKFLOW_FETCH_MIN_INTERVAL_MS: "300" }), 300, "the redirect hop waited out the interval");
  assert.equal(await fetchGapMs({}), 0, "unpaced by default");
  assert.equal(loadEnv({ POMTREED_WORKFLOW_FETCH_MIN_INTERVAL_MS: "-1" }).ok, false);
});

test("an invalid workflow.fetch.userAgent is refused at config load with the cause and the fix", () => {
  const refused = (value: string): string => {
    const r = loadEnv({ POMTREED_WORKFLOW_FETCH_USER_AGENT: value });
    assert.equal(r.ok, false, JSON.stringify(value));
    const errors = (r as { errors: string[] }).errors;
    assert.equal(errors.length, 1, errors.join("; "));
    assert.match(errors[0]!, /^workflow\.fetch\.userAgent=/);
    return errors[0]!;
  };
  for (const v of ["app ops@example.org\r\nX-Injected: 1", "app\nops", "app\tops", "app\u0000", "app \u00e9", "app\u007f"])
    assert.match(refused(v), /must be printable ASCII .*control characters such as CR, LF and tab.*Set it to a product token such as "pomtree"/);
  assert.match(refused("x".repeat(257)), /is 257 characters; a User-Agent is at most 256\. Shorten it/);
  assert.match(refused(" app ops@example.org"), /leading or trailing whitespace/);
  // Decision C4: free-form, but it must start with a product token; a contact is optional.
  assert.match(refused("ops@example.org"), /must start with a product token/);
  assert.ok(loadEnv({ POMTREED_WORKFLOW_FETCH_USER_AGENT: "pomtree-research" }).ok, "no contact needed");
  const ok = loadEnv({ POMTREED_WORKFLOW_FETCH_USER_AGENT: `${"x".repeat(240)} ops@example.org` });
  assert.ok(ok.ok, "256 characters is the bound, inclusive");
  assert.ok(loadEnv({ POMTREED_WORKFLOW_FETCH_USER_AGENT: "pomtree/1.0 (+https://example.org/bot)" }).ok, "a URL is a contact too");
});
