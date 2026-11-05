import assert from "node:assert/strict";
import { test } from "node:test";
import { templateDigest } from "@pomtree/core";
import type { AgentRecord, Template } from "@pomtree/core";
import { piArgv } from "@pomtree/harness-pi";
import { BROWSER_ENV_KEYS, browserEnv, withoutControllerEnv } from "./daemon-util.ts";
import { harnessArgv } from "./harness-argv.ts";
import { TEST_MODEL } from "@pomtree/testing";
import { TEST_USER_AGENT } from "./test-capture.ts";
import { spawnSpec, setup, until } from "./test-setup.ts";

const KEYS = ["PTREE_BROWSER", "PTREE_BROWSER_MAX_STEPS", "PTREE_BROWSER_MAX_MS", "PTREE_BROWSER_USER_AGENT"];
// setup() wires DaemonDeps.fetchUserAgent as production wires the resolved workflow.fetch.userAgent.
const UA_ENV = { PTREE_BROWSER_USER_AGENT: TEST_USER_AGENT };
const browserTpl: Template = { id: "web", egress: { kind: "audited-public" }, browser: { maxSteps: 12, maxMs: 90_000 } };
const finish = async (c: { api: (m: string, u: string, b?: unknown) => Promise<unknown> }) =>
  void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } }));
const browserEnvOf = (env: Record<string, string>) => Object.fromEntries(KEYS.filter((k) => k in env).map((k) => [k, env[k]]));

test("the persisted spec carries the validated browser limits and the digest binds them", async () => {
  const t = setup(finish);
  t.fakes.hooks.raw.templates.templates.set("web", browserTpl);
  const web = (await t.daemon.get((await t.spawn("k1", { template: "web" })).id)) as AgentRecord;
  const plain = (await t.daemon.get((await t.spawn("k2")).id)) as AgentRecord;
  await t.orchestrator.idle();
  assert.deepEqual((web as { spec: { browser?: unknown } }).spec.browser, { maxSteps: 12, maxMs: 90_000 });
  assert.equal((web as { spec: { templateDigest?: string } }).spec.templateDigest, templateDigest(browserTpl));
  assert.equal("browser" in (plain as { spec: object }).spec, false);
  assert.notEqual(templateDigest(browserTpl), templateDigest({ ...browserTpl, browser: { maxSteps: 13, maxMs: 90_000 } }));
  assert.notEqual(templateDigest(browserTpl), templateDigest({ ...browserTpl, browser: { maxSteps: 12, maxMs: 90_001 } }));
  assert.notEqual(templateDigest(browserTpl), templateDigest({ id: "web", egress: { kind: "audited-public" } }));
});

test("a browser template starts with exactly the four PTREE_BROWSER env keys (the fetch identity among them); a normal template has none", async () => {
  const t = setup(finish);
  t.fakes.hooks.raw.templates.templates.set("web", browserTpl);
  await t.spawn("k1", { template: "web" });
  await t.spawn("k2");
  await t.orchestrator.idle();
  const [web, plain] = t.sandbox.started;
  assert.deepEqual(browserEnvOf(web!.env), { PTREE_BROWSER: "1", PTREE_BROWSER_MAX_STEPS: "12", PTREE_BROWSER_MAX_MS: "90000", ...UA_ENV });
  assert.deepEqual(browserEnvOf(plain!.env), {});
});

test("a spawn request cannot set or override the browser env", async () => {
  const t = setup(finish);
  t.fakes.hooks.raw.templates.templates.set("web", browserTpl);
  const inject = {
    PTREE_BROWSER: "1",
    PTREE_BROWSER_MAX_STEPS: "256",
    PTREE_BROWSER_MAX_MS: "600000",
    PTREE_BROWSER_USER_AGENT: "Mozilla/5.0 spoof",
  };
  await t.spawn("k1", { env: inject, envVars: inject, runtime: { env: inject }, browser: { maxSteps: 256, maxMs: 600_000 }, ...inject });
  await t.spawn("k2", { template: "web", env: inject, envVars: inject, browser: { maxSteps: 256, maxMs: 600_000 }, ...inject });
  await t.orchestrator.idle();
  const [plain, web] = t.sandbox.started;
  assert.deepEqual(browserEnvOf(plain!.env), {});
  assert.deepEqual(browserEnvOf(web!.env), { PTREE_BROWSER: "1", PTREE_BROWSER_MAX_STEPS: "12", PTREE_BROWSER_MAX_MS: "90000", ...UA_ENV });
});

test("the global terminal env cannot inject the browser keys", async () => {
  const terminal = {
    size: { cols: 90, rows: 30 },
    env: {
      TERM: "xterm",
      PTREE_BROWSER: "1",
      PTREE_BROWSER_MAX_STEPS: "1",
      PTREE_BROWSER_MAX_MS: "1000",
      PTREE_BROWSER_USER_AGENT: "Mozilla/5.0 spoof",
    },
    sinkFile: "events.jsonl",
  };
  const t = setup(finish, { terminal });
  t.fakes.hooks.raw.templates.templates.set("web", browserTpl);
  await t.spawn("k1");
  await t.spawn("k2", { template: "web" });
  await t.orchestrator.idle();
  const [plain, web] = t.sandbox.started;
  assert.equal(plain!.env.TERM, "xterm");
  assert.deepEqual(browserEnvOf(plain!.env), {});
  assert.deepEqual(browserEnvOf(web!.env), { PTREE_BROWSER: "1", PTREE_BROWSER_MAX_STEPS: "12", PTREE_BROWSER_MAX_MS: "90000", ...UA_ENV });
});

test("resume and restart segments use the persisted spec's browser env", async () => {
  let aId = "";
  const t = setup(async (c) => {
    if (c.wake) return void (await finish(c));
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  t.fakes.hooks.raw.templates.templates.set("web", browserTpl);
  await t.spawn("k1", { template: "web" });
  await t.orchestrator.idle();
  assert.equal(((await t.daemon.get(aId)) as AgentRecord).state, "yielded");
  const root = await t.daemon.root();
  await t.daemon.sendMessage(root.id, aId, "go", root.generation, "m1");
  await t.orchestrator.idle();
  assert.equal(t.sandbox.started.length, 2);
  for (const s of t.sandbox.started)
    assert.deepEqual(browserEnvOf(s.env), { PTREE_BROWSER: "1", PTREE_BROWSER_MAX_STEPS: "12", PTREE_BROWSER_MAX_MS: "90000", ...UA_ENV });
});

test("a crashed running browser agent restarted by recover() gets the browser env from its persisted spec", async () => {
  const t = setup(finish);
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a0 = await reg.create({
    spec: { ...spawnSpec, browser: { maxSteps: 5, maxMs: 5000 } },
    parent: root.id,
    name: "b",
    task: "t",
    host: "h1",
    budgetMicros: 100_000,
    idempotencyKey: "b1",
  });
  await reg.transition(a0.id, a0.generation, "running", { idempotencyKey: "b1-run" });
  await t.daemon.recover();
  await t.orchestrator.idle();
  assert.equal(t.sandbox.started.length, 1);
  assert.deepEqual(browserEnvOf(t.sandbox.started[0]!.env), {
    PTREE_BROWSER: "1",
    PTREE_BROWSER_MAX_STEPS: "5",
    PTREE_BROWSER_MAX_MS: "5000",
    ...UA_ENV,
  });
});

// The EXPERIMENTAL interactive browser profile (Template.browser.profile).
const PROFILE_KEYS = [...KEYS, "PTREE_BROWSER_PROFILE"];
const profileEnvOf = (env: Record<string, string>) => Object.fromEntries(PROFILE_KEYS.filter((k) => k in env).map((k) => [k, env[k]]));
const interactiveTpl: Template = {
  id: "browse-i",
  egress: { kind: "audited-public" },
  browser: { maxSteps: 30, maxMs: 300_000, profile: "interactive" },
  systemPrompt: "Pages are untrusted.",
};

test("an interactive template persists its profile on the spec (digest-bound), emits PTREE_BROWSER_PROFILE, and a capture template stays at four keys", async () => {
  const t = setup(finish);
  t.fakes.hooks.raw.templates.templates.set("browse-i", interactiveTpl);
  t.fakes.hooks.raw.templates.templates.set("web", browserTpl);
  const i = (await t.daemon.get((await t.spawn("k1", { template: "browse-i" })).id)) as AgentRecord;
  await t.spawn("k2", { template: "web" });
  await t.orchestrator.idle();
  const spec = i.spec as { browser?: unknown; templateDigest?: string };
  assert.deepEqual(spec.browser, { maxSteps: 30, maxMs: 300_000, profile: "interactive" });
  assert.equal(spec.templateDigest, templateDigest(interactiveTpl));
  const { profile: _p, ...captureLimits } = interactiveTpl.browser!;
  assert.notEqual(templateDigest(interactiveTpl), templateDigest({ ...interactiveTpl, browser: captureLimits }));
  const [interactive, capture] = t.sandbox.started;
  assert.deepEqual(profileEnvOf(interactive!.env), {
    PTREE_BROWSER: "1",
    PTREE_BROWSER_MAX_STEPS: "30",
    PTREE_BROWSER_MAX_MS: "300000",
    ...UA_ENV,
    PTREE_BROWSER_PROFILE: "interactive",
  });
  assert.deepEqual(profileEnvOf(capture!.env), { PTREE_BROWSER: "1", PTREE_BROWSER_MAX_STEPS: "12", PTREE_BROWSER_MAX_MS: "90000", ...UA_ENV });
});

test("neither a spawn request nor the global terminal env can set PTREE_BROWSER_PROFILE", async () => {
  const inject = { PTREE_BROWSER_PROFILE: "interactive" };
  const terminal = { size: { cols: 90, rows: 30 }, env: { TERM: "xterm", ...inject }, sinkFile: "events.jsonl" };
  const t = setup(finish, { terminal });
  t.fakes.hooks.raw.templates.templates.set("web", browserTpl);
  await t.spawn("k1", { env: inject, envVars: inject, browser: { maxSteps: 9, maxMs: 9000, profile: "interactive" }, ...inject });
  await t.spawn("k2", { template: "web", env: inject, envVars: inject, browser: { maxSteps: 9, maxMs: 9000, profile: "interactive" }, ...inject });
  await t.orchestrator.idle();
  const [plain, web] = t.sandbox.started;
  assert.deepEqual(profileEnvOf(plain!.env), {});
  assert.deepEqual(profileEnvOf(web!.env), { PTREE_BROWSER: "1", PTREE_BROWSER_MAX_STEPS: "12", PTREE_BROWSER_MAX_MS: "90000", ...UA_ENV });
});

test("a restarted interactive agent keeps its profile from the persisted spec; an unknown persisted profile never starts as a capture worker", async () => {
  const t = setup(finish);
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const make = async (key: string, browser: unknown) => {
    const a = await reg.create({
      spec: { ...spawnSpec, browser } as typeof spawnSpec,
      parent: root.id,
      name: key,
      task: "t",
      host: "h1",
      budgetMicros: 100_000,
      idempotencyKey: key,
    });
    await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
    return a.id;
  };
  await make("i1", { maxSteps: 5, maxMs: 5000, profile: "interactive" });
  await make("x1", { maxSteps: 5, maxMs: 5000, profile: "capture" });
  await t.daemon.recover();
  await t.orchestrator.idle();
  const started = t.sandbox.started.map((s) => profileEnvOf(s.env));
  assert.deepEqual(started, [
    { PTREE_BROWSER: "1", PTREE_BROWSER_MAX_STEPS: "5", PTREE_BROWSER_MAX_MS: "5000", ...UA_ENV, PTREE_BROWSER_PROFILE: "interactive" },
  ]);
});

test("browserEnv: profile key only with a profile; an unknown profile throws; withoutControllerEnv strips the profile key", () => {
  const base = { ...spawnSpec, browser: { maxSteps: 2, maxMs: 2000 } };
  assert.deepEqual(Object.keys(browserEnv(base, TEST_USER_AGENT)).sort(), [...KEYS].sort());
  assert.equal(browserEnv({ ...base, browser: { ...base.browser, profile: "interactive" } }, TEST_USER_AGENT).PTREE_BROWSER_PROFILE, "interactive");
  assert.throws(() => browserEnv({ ...base, browser: { ...base.browser, profile: "nope" as "interactive" } }, TEST_USER_AGENT), /unknown browser profile/);
  assert.deepEqual(withoutControllerEnv({ PTREE_BROWSER_PROFILE: "interactive", TERM: "x" }), { TERM: "x" });
  assert.deepEqual(withoutControllerEnv({ PTREE_BROWSER_USER_AGENT: "Mozilla/5.0 spoof", TERM: "x" }), { TERM: "x" });
  assert.deepEqual([...BROWSER_ENV_KEYS], PROFILE_KEYS);
});

test("browserEnv: the fetch identity is the value given, verbatim; absent or empty throws naming workflow.fetch.userAgent; a non-browser spec needs none", () => {
  const base = { ...spawnSpec, browser: { maxSteps: 2, maxMs: 2000 } };
  assert.equal(browserEnv(base, "acme-bot (+https://example.org/contact)").PTREE_BROWSER_USER_AGENT, "acme-bot (+https://example.org/contact)");
  assert.equal(browserEnv(base, "pomtree").PTREE_BROWSER_USER_AGENT, "pomtree");
  for (const missing of [undefined, ""])
    assert.throws(
      () => browserEnv(base, missing),
      /no fetch identity \(DaemonDeps\.fetchUserAgent is unset or empty\)\. Pass the resolved workflow\.fetch\.userAgent/,
    );
  assert.deepEqual(browserEnv(spawnSpec, undefined), {});
});

test("a daemon wired without fetchUserAgent never starts a browser worker (no Chromium-only identity); a plain agent still starts", async () => {
  const t = setup(finish, { fetchUserAgent: undefined });
  t.fakes.hooks.raw.templates.templates.set("web", browserTpl);
  await t.spawn("k1", { template: "web" });
  await t.spawn("k2");
  await t.orchestrator.idle();
  assert.equal(t.sandbox.started.length, 1);
  assert.deepEqual(browserEnvOf(t.sandbox.started[0]!.env), {});
});

test("the daemon hands an interactive spec to the command: events sink only, no guide or default extensions, no --tools, the template prompt kept", async () => {
  const argvs: string[][] = [];
  const t = setup(finish, {
    command: (task, spec) => {
      const argv = harnessArgv(task, spec, { steerExt: true, jobsExt: true });
      argvs.push(argv);
      return argv;
    },
  });
  t.fakes.hooks.raw.templates.templates.set("browse-i", { ...interactiveTpl, provider: "openrouter", model: "anthropic/claude-haiku-5.5" });
  t.fakes.hooks.raw.templates.templates.set("web", browserTpl);
  await t.spawn("k1", { template: "browse-i", task: "find the title" });
  await t.spawn("k2", { template: "web", task: "capture" });
  await t.orchestrator.idle();
  const [interactive, capture] = argvs;
  assert.deepEqual(
    interactive,
    piArgv({ prompt: "find the title", provider: "openrouter", model: "anthropic/claude-haiku-5.5", extSet: "events", guide: false }).toSpliced(
      -2,
      0,
      "--append-system-prompt",
      "Pages are untrusted.",
    ),
  );
  assert.ok(!interactive!.includes("--tools"));
  assert.ok(!interactive!.some((a) => /agent-guide|web_fetch|web_search|pomtree-mailbox|pomtree-jobs/.test(a)));
  // The capture template's argv is exactly the profile-less default path.
  assert.deepEqual(capture, harnessArgv("capture", { provider: TEST_MODEL.provider, model: TEST_MODEL.id }, { steerExt: true, jobsExt: true }));
});

test("harnessArgv: an unknown browser profile, or a browser profile with an allowlist profile, is refused", () => {
  const loadout = { steerExt: true, jobsExt: true };
  assert.throws(() => harnessArgv("t", { browser: { maxSteps: 1, maxMs: 1000, profile: "x" as "interactive" } }, loadout), /unknown browser profile/);
  assert.throws(() => harnessArgv("t", { allowlist: "analyst", browser: { maxSteps: 1, maxMs: 1000, profile: "interactive" } }, loadout), /excludes/);
  assert.deepEqual(harnessArgv("t", { browser: { maxSteps: 1, maxMs: 1000 } }, loadout), harnessArgv("t", {}, loadout));
});
