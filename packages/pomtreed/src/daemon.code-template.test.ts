import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_TEMPLATE, templateDigest } from "@pomtree/core";
import type { AgentRecord, SandboxSpec, SpawnSpec, Template } from "@pomtree/core";

const containerSpecOf = (r: AgentRecord): SpawnSpec => {
  if (r.executor !== "container") throw new Error("not a container");
  return r.spec;
};
import { TEST_MODEL } from "@pomtree/testing";
import { setup, until } from "./test-setup.ts";

const finish = async (c: { api: (m: string, u: string, b?: unknown) => Promise<unknown> }) =>
  void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } }));
// The spawn-side shape the sandbox adapter is handed: mounts are named, never paths, except the daemon-authored binds.
const startShape = (s: SandboxSpec) => ({ image: s.image, mounts: s.mounts, resources: s.resources, runtime: s.runtime });
const DEFAULT_DIGEST = "48f5bd83c4f0020ea06f07f3cb9f7fd420b8e798a9d86a679786a18468893d77"; // templateDigest({ ...CODE_TEMPLATE, image: "img@sha256:x" })

test("snapshot: an untemplated spawn records the code template and starts the sandbox with named mounts", async () => {
  const t = setup(finish);
  const a = await t.spawn();
  await t.orchestrator.idle();
  const rec = (await t.daemon.get(a.id)) as AgentRecord;
  assert.deepEqual(rec.spec, {
    wrapupMs: 30_000,
    image: "img@sha256:x",
    envManifestHash: null,
    extensions: [],
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    systemPrompt: null,
    egress: { kind: "registry" },
    template: "code",
    templateDigest: DEFAULT_DIGEST,
    resume: "session",
  });
  assert.equal(templateDigest({ ...CODE_TEMPLATE, image: "img@sha256:x" }), DEFAULT_DIGEST);
  const started = t.fakes.hooks.raw.sandbox.started[0]!;
  assert.deepEqual(startShape(started), {
    image: "img@sha256:x",
    mounts: [
      { kind: "workspace", workspace: (started.mounts[0] as { workspace: string }).workspace, containerPath: "/workspace", generation: rec.generation },
      { kind: "bind", hostPath: "/host/pomtreed.sock", containerPath: "/run/pomtreed.sock" },
      { kind: "session", agent: a.id, containerPath: "/workspace/.pi-session", generation: rec.generation },
    ],
    resources: undefined,
    runtime: undefined,
  });
});

test("snapshot: template `code` without a store entry resolves to the built-in and matches the untemplated spec", async () => {
  const t = setup(finish);
  const plain = await t.spawn("k1");
  const named = await t.spawn("k2", { template: "code" });
  await t.orchestrator.idle();
  const a = ((await t.daemon.get(plain.id)) as AgentRecord).spec;
  const b = ((await t.daemon.get(named.id)) as AgentRecord).spec;
  assert.deepEqual(b, a);
});

test("snapshot: a store entry named `code` wins over the built-in and retains resources and runtime", async () => {
  const t = setup(finish);
  const stored: Template = {
    id: "code",
    image: "img@sha256:store",
    resume: "task",
    shmBytes: 1 << 20,
    cpus: 2,
    memoryBytes: 4096,
    diskBytes: 8192,
    runtime: { shape: { init: true } },
  };
  t.fakes.hooks.raw.templates.templates.set("code", stored);
  const a = await t.spawn("k1", { template: "code" });
  await t.orchestrator.idle();
  const rec = (await t.daemon.get(a.id)) as AgentRecord;
  assert.deepEqual(rec.spec, {
    wrapupMs: 30_000,
    image: "img@sha256:store",
    envManifestHash: null,
    extensions: [],
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    systemPrompt: null,
    egress: { kind: "registry" },
    memoryBytes: 4096,
    cpus: 2,
    shmBytes: 1 << 20,
    diskBytes: 8192,
    template: "code",
    templateDigest: templateDigest(stored),
    resume: "task",
    runtime: { shape: { init: true } },
  });
  assert.notEqual(rec.spec.templateDigest, DEFAULT_DIGEST);
  const started = t.fakes.hooks.raw.sandbox.started[0]!;
  assert.deepEqual(started.resources, { cpus: 2, memoryBytes: 4096, shmBytes: 1 << 20, diskBytes: 8192 });
  assert.deepEqual(started.runtime, { shape: { init: true } });
});

test("the checkpoint written on yield carries template, digest and resume level, and the resumed segment starts with the same ones", async () => {
  let aId = "";
  const t = setup(async (c) => {
    if (c.wake) return void (await finish(c));
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  const stored: Template = { id: "code", resume: "task", shmBytes: 777, runtime: { init: true } };
  t.fakes.hooks.raw.templates.templates.set("code", stored);
  await t.spawn("k1", { template: "code" });
  await t.orchestrator.idle();
  assert.equal(((await t.daemon.get(aId)) as AgentRecord).state, "yielded");
  const cp = (await t.daemon.deps.checkpoints.latest(aId))!;
  assert.equal(cp.template, "code");
  assert.equal(cp.templateDigest, templateDigest(stored));
  assert.equal(cp.resumeLevel, "task");
  const first = startShape(t.fakes.hooks.raw.sandbox.started[0]!);

  const root = await t.daemon.root();
  await t.daemon.sendMessage(root.id, aId, "go", root.generation, "m1");
  await t.orchestrator.idle();
  const rec = (await t.daemon.get(aId)) as AgentRecord;
  assert.equal(containerSpecOf(rec).templateDigest, cp.templateDigest, "the persisted spec is unchanged across the resume");
  const second = startShape(t.fakes.hooks.raw.sandbox.started[1]!);
  assert.deepEqual(second.runtime, first.runtime);
  assert.deepEqual(second.resources, first.resources);
  assert.deepEqual(
    second.mounts.map((m) => m.kind),
    first.mounts.map((m) => m.kind),
  );
});

test("an untemplated agent's checkpoint records the code template digest", async () => {
  let aId = "";
  const t = setup(async (c) => {
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await t.orchestrator.idle();
  const cp = (await t.daemon.deps.checkpoints.latest(aId))!;
  assert.deepEqual([cp.template, cp.templateDigest, cp.resumeLevel], ["code", DEFAULT_DIGEST, "session"]);
});
