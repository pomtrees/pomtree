import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { SandboxCapabilityError, templateDigest } from "@pomtree/core";
import type { AgentRecord, SpawnSpec, Template } from "@pomtree/core";
import { handle } from "./api.ts";
import { setup } from "./test-setup.ts";

const tpl = (id: string, over: Partial<Template> = {}): Template => ({ id, ...over });

test("operator spawn with a template persists the resolved SpawnSpec", async () => {
  const t = setup(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  const researcher = tpl("researcher", {
    image: "img@sha256:researcher",
    env: { FOO: "bar" },
    extensions: ["pomtree-gate"],
    provider: "p",
    model: "m",
    budgetMicros: 500,
    memoryBytes: 123,
    cpus: 2,
    systemPrompt: "you research",
    egress: { kind: "allowlist", hosts: ["a.example"] },
  });
  t.fakes.hooks.raw.templates.templates.set("researcher", researcher);
  const a = await t.spawn("k1", { template: "researcher" });
  const rec = (await t.daemon.get(a.id))!;
  assert.equal(rec.budgetMicros, 500);
  assert.deepEqual(rec.spec, {
    wrapupMs: 30_000,
    image: "img@sha256:researcher",
    envManifestHash: createHash("sha256").update('{"FOO":"bar"}').digest("hex"),
    extensions: ["pomtree-gate"],
    provider: "p",
    model: "m",
    systemPrompt: "you research",
    egress: { kind: "allowlist", hosts: ["a.example"] },
    memoryBytes: 123,
    cpus: 2,
    template: "researcher",
    templateDigest: templateDigest(researcher),
    resume: "session",
  });
  await t.orchestrator.idle();
});

test("a template without a field falls back to daemon defaults", async () => {
  const t = setup(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  t.fakes.hooks.raw.templates.templates.set("plain", tpl("plain", { provider: "p", model: "m" }));
  const a = await t.spawn("k2", { template: "plain" });
  const rec = (await t.daemon.get(a.id))!;
  assert.equal(rec.executor, "container");
  const spec = rec.spec as SpawnSpec;
  assert.equal(spec.image, "img@sha256:x"); // daemon default image
  assert.equal(spec.envManifestHash, null);
  assert.deepEqual(spec.extensions, []);
  assert.equal(spec.provider, "p");
  assert.equal(spec.model, "m");
  assert.equal(spec.systemPrompt, null);
  assert.deepEqual(spec.egress, { kind: "registry" });
  await t.orchestrator.idle();
});

test("an unknown template is a 404", async () => {
  const t = setup(async () => {});
  const res = await t.operator("POST", "/v1/agents", { name: "w", task: "do it", idempotencyKey: "k3", template: "nope" });
  assert.equal(res.status, 404);
});

test("agents are default-deny for templates", async () => {
  const t = setup(async () => {});
  const child = await t.spawn("child");
  t.fakes.hooks.raw.templates.templates.set("researcher", tpl("researcher"));
  await assert.rejects(t.daemon.spawn(child.id, { name: "x", task: "y", idempotencyKey: "deny", template: "researcher" }), /not permitted/);
  // an operator (root) spawn with the same template is allowed
  const ok = await t.spawn("k4", { template: "researcher" });
  assert.ok(ok.id);
  await t.orchestrator.idle();
});

test("mayUseTemplate can grant an agent a template", async () => {
  const t = setup(async () => {}, {
    mayUseTemplate: (caller) => caller === "the-agent",
  });
  const agent = await t.daemon.deps.registry.create({
    id: "the-agent",
    parent: null,
    name: "a",
    task: "t",
    host: "h1",
    budgetMicros: 100,
    idempotencyKey: "create-agent",
    spec: { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "registry" } },
  });
  t.fakes.hooks.raw.templates.templates.set("researcher", tpl("researcher"));
  const spawned = await t.daemon.spawn(agent.id, { name: "x", task: "y", idempotencyKey: "grant", template: "researcher" });
  assert.ok(spawned.id);
  await t.orchestrator.idle();
});

test("GET /v1/templates is operator-only and resolves by name", async () => {
  const t = setup(async () => {});
  t.fakes.hooks.raw.templates.templates.set("researcher", tpl("researcher", { image: "i" }));
  const list = await t.operator("GET", "/v1/templates");
  assert.equal(list.status, 200);
  assert.deepEqual(
    (list.body as Template[]).map((x) => x.id),
    ["researcher"],
  );
  const one = await t.operator("GET", "/v1/templates/researcher");
  assert.equal(one.status, 200);
  assert.equal((one.body as Template).image, "i");
  assert.equal((await t.operator("GET", "/v1/templates/missing")).status, 404);

  const child = await t.spawn("child2");
  const agentToken = t.daemon.agentToken(child.id);
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/templates", token: agentToken })).status, 403);
  await t.orchestrator.idle();
});

test("the resolved spec flows to the sandbox start", async () => {
  const t = setup(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  t.fakes.hooks.raw.templates.templates.set(
    "big",
    tpl("big", {
      image: "img@sha256:big",
      memoryBytes: 777,
      cpus: 3,
      egress: { kind: "allowlist", hosts: ["h.example"] },
    }),
  );
  await t.spawn("k5", { template: "big" });
  await t.orchestrator.idle();
  const started = t.fakes.hooks.raw.sandbox.started[0]!;
  assert.equal(started.image, "img@sha256:big");
  assert.deepEqual(started.resources, { cpus: 3, memoryBytes: 777 });
  // The daemon resolves the persisted template policy into an explicit sandbox allowlist.
  assert.deepEqual(started.egress, {
    allow: [
      { host: "h.example", port: 443 },
      { host: "m", port: 80 },
    ],
    relay: [{ host: "m", port: 80 }],
  });
});

test("registry default always builds the default-deny allowlist in drive()", async () => {
  const t = setup(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  await t.spawn("k7");
  await t.orchestrator.idle();
  const started = t.fakes.hooks.raw.sandbox.started[0]!;
  // Empty manifest, no agentApiUrl (socket mode), model baseUrl "http://m" -> host m:80.
  assert.deepEqual(started.egress, { allow: [{ host: "m", port: 80 }], relay: [{ host: "m", port: 80 }] });
});

test("the model provider is reached through the proxy: no provider host reaches the sandbox allowlist", async () => {
  const t = setup(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  t.fakes.hooks.raw.templates.templates.set("gem", tpl("gem", { provider: "google", model: "gemini-2.5-flash" }));
  await t.spawn("kg1", { template: "gem" });
  await t.orchestrator.idle();
  const allow = t.fakes.hooks.raw.sandbox.started[0]!.egress?.allow.map((x) => x.host) ?? [];
  assert.ok(!allow.includes("generativelanguage.googleapis.com"));
});

test("staged provider credentials grant no raw provider host, and a none template gets an empty allowlist", async () => {
  const t = setup(
    async (c) => {
      await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
    },
    { credentials: { stage: () => [], unstage: () => {}, providerIds: () => ["baseten", "google", "bogus"] } },
  );
  t.fakes.hooks.raw.templates.templates.set("np", tpl("np", {}));
  t.fakes.hooks.raw.templates.templates.set("np-none", tpl("np-none", { egress: { kind: "none" } }));
  await t.spawn("kp1", { template: "np" });
  await t.spawn("kp2", { template: "np-none" });
  await t.orchestrator.idle();
  const allows = t.fakes.hooks.raw.sandbox.started.map((s) => s.egress?.allow.map((x) => x.host));
  assert.ok(allows.every((a) => !a?.includes("inference.baseten.co") && !a?.includes("generativelanguage.googleapis.com")));
  assert.ok(allows.some((a) => a?.length === 0));
});

test("the spec image is recorded in a yield checkpoint", async () => {
  let aId = "";
  const t = setup(async (c) => {
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  t.fakes.hooks.raw.templates.templates.set("timg", tpl("timg", { image: "img@sha256:timg" }));
  await t.spawn("k6", { template: "timg" });
  await t.orchestrator.idle();
  const rec = (await t.daemon.get(aId))!;
  assert.equal(rec.state, "yielded");
  const cp = (await t.daemon.deps.checkpoints.latest(aId))!;
  assert.equal(cp.imageDigest, "img@sha256:timg@sha256:fake");
});

test("a containerd-store identity (index digest, no config digest) checkpoints the engine-local id", async () => {
  let aId = "";
  const t = setup(async (c) => {
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  const index = `sha256:${"b".repeat(64)}`;
  t.fakes.hooks.raw.sandbox.imageIdentity = async () => ({ engineLocalId: index, configDigest: null, revision: null });
  t.fakes.hooks.raw.templates.templates.set("timg", tpl("timg", { image: "img:tag" }));
  await t.spawn("k7", { template: "timg" });
  await t.orchestrator.idle();
  assert.equal((await t.daemon.get(aId))!.state, "yielded");
  assert.equal((await t.daemon.deps.checkpoints.latest(aId))!.imageDigest, index);
});

test("a classic-store identity (config digest equals the engine-local id) checkpoints the same pin", async () => {
  let aId = "";
  const t = setup(async (c) => {
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  const id = `sha256:${"c".repeat(64)}`;
  t.fakes.hooks.raw.sandbox.imageIdentity = async () => ({ engineLocalId: id, configDigest: id, revision: null });
  t.fakes.hooks.raw.templates.templates.set("timg", tpl("timg", { image: "img:tag" }));
  await t.spawn("k9", { template: "timg" });
  await t.orchestrator.idle();
  assert.equal((await t.daemon.deps.checkpoints.latest(aId))!.imageDigest, id);
});

test("an imageIdentity failure, including image.digestAttest, fails the checkpoint", async () => {
  let aId = "";
  const t = setup(async (c) => {
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  t.fakes.hooks.raw.sandbox.imageIdentity = async () => {
    throw new SandboxCapabilityError("docker", "image.digestAttest", "this backend cannot attest image identity");
  };
  t.fakes.hooks.raw.templates.templates.set("timg", tpl("timg", { image: "img:tag" }));
  await t.spawn("k8", { template: "timg" });
  await t.orchestrator.idle();
  assert.equal(await t.daemon.deps.checkpoints.latest(aId), null, "no checkpoint is written when the identity lookup fails");
});
