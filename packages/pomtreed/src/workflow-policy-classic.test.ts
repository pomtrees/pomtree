import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRecord } from "@pomtree/core";
import type { Ctx } from "./test-setup.ts";
import { get, setup, until } from "./test-setup.ts";
import { WorkflowRuntimePolicy } from "./workflow-policy.ts";

const terminal = (row: AgentRecord) => row.state === "exited" || row.state === "reaped";

// The actual production-equivalent callback: root may select templates, registered reviewed workflows need exact grants,
// and classic container callers receive no new named-template authority. An optional legacy grant models an already
// authorized non-public template in library compositions; it is not a production default.
function rig(legacyGrant: (template: string) => boolean = () => false) {
  const policy = new WorkflowRuntimePolicy();
  let t!: ReturnType<typeof setup>;
  const script = async (ctx: Ctx) => {
    if (ctx.prompt === "parent") return void (await ctx.stopped);
    if (ctx.wake) {
      await ctx.api("POST", "/v1/agents/self/result", { result: { summary: "resumed child" } });
      return;
    }
    await ctx.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "park" });
  };
  t = setup(script, {
    mayUseTemplate: async (caller, template) =>
      caller === (await t.daemon.root()).id || policy.allows(await t.daemon.deps.registry.get(caller), template.id, []) || legacyGrant(template.id),
  });
  return t;
}

async function parent(t: ReturnType<typeof setup>, template?: string) {
  const row = await t.spawn("parent", { task: "parent", budgetMicros: 1000, ...(template !== undefined && { template }) });
  await until(async () => (await get(t, row.id)).state === "running");
  await until(() => t.fakes.hooks.raw.sandbox.started.some((spec) => spec.agent === row.id));
  return row;
}

async function parkedOrTerminal(t: ReturnType<typeof setup>, id: string) {
  await until(async () => {
    const row = await get(t, id);
    return row.state === "yielded" || terminal(row);
  });
  return get(t, id);
}

test("production workflow policy preserves classic container default-child start and resume", { timeout: 10000 }, async () => {
  const t = rig();
  const p = await parent(t);
  try {
    const child = await t.daemon.spawn(p.id, { name: "child", task: "child", budgetMicros: 100, idempotencyKey: "child" });
    const parked = await parkedOrTerminal(t, child.id);
    assert.equal(parked.state, "yielded", "classic untemplated code/registry child must start, not fail a late workflow grant");
    assert.equal(parked.executor, "container");
    if (parked.executor !== "container") throw new Error("expected container");
    assert.equal(parked.spec.template, "code");
    assert.deepEqual(parked.spec.egress, { kind: "registry" });
    await t.daemon.sendMessage(p.id, child.id, "resume", p.generation, "wake-child");
    await until(async () => terminal(await get(t, child.id)));
    assert.equal((await get(t, child.id)).exit, "succeeded");
    assert.equal((await get(t, child.id)).generation, parked.generation + 1);
    assert.equal(t.fakes.hooks.raw.sandbox.started.filter((spec) => spec.agent === child.id).length, 2);
  } finally {
    await t.daemon.cancel(p.id);
    await t.orchestrator.idle();
  }
});

test("classic callers gain no arbitrary named or public templates; denials precede child effects", { timeout: 10000 }, async () => {
  const t = rig();
  const p = await parent(t);
  try {
    for (const [id, kind] of [
      ["limited", "none"],
      ["public", "audited-public"],
      ["code", "registry"],
    ] as const) {
      t.fakes.hooks.raw.templates.templates.set(id, { id, egress: { kind } });
      const calls = t.fakes.calls.length;
      await assert.rejects(t.daemon.spawn(p.id, { name: id, task: id, budgetMicros: 100, template: id, idempotencyKey: id }), /not permitted/);
      assert.equal((await t.daemon.list({ parent: p.id })).length, 0);
      const effects = t.fakes.calls.slice(calls).filter((call) => call.port === "Workspace" || call.port === "Sandbox");
      assert.deepEqual(effects, [], "authority denial precedes workspace/sandbox effects");
    }
    assert.equal((await get(t, p.id)).budgetMicros, 1000);
  } finally {
    await t.daemon.cancel(p.id);
    await t.orchestrator.idle();
  }
});

test("ungranted workflow default-template admission is denied before effects even without an executor fence", async () => {
  const t = rig();
  const root = await t.daemon.root();
  const workflow = await t.daemon.deps.registry.create({
    parent: root.id,
    name: "workflow",
    task: "workflow",
    host: root.host,
    budgetMicros: 500,
    executor: "deterministic",
    spec: { driver: "ungranted/workflow", input: null },
    idempotencyKey: "workflow",
  });
  await t.daemon.deps.registry.transition(workflow.id, workflow.generation, "running", { idempotencyKey: "workflow-running" });
  const calls = t.fakes.calls.length;
  await assert.rejects(t.daemon.spawn(workflow.id, { name: "child", task: "child", budgetMicros: 100, idempotencyKey: "child" }), /not permitted/);
  assert.equal((await t.daemon.list({ parent: workflow.id })).length, 0);
  assert.deepEqual(
    t.fakes.calls.slice(calls).filter((call) => call.port === "Workspace" || call.port === "Sandbox"),
    [],
  );
  assert.equal((await get(t, workflow.id)).budgetMicros, 500);
});

test("an already-authorized classic non-public template keeps its prior resume behavior", { timeout: 10000 }, async () => {
  let granted = true;
  const t = rig((template) => template === "limited" && granted);
  t.fakes.hooks.raw.templates.templates.set("limited", { id: "limited", egress: { kind: "allowlist", hosts: ["example.test"] } });
  // The parent runs the same template: delegation only narrows, so a child's allowlist must be within its parent's egress.
  const p = await parent(t, "limited");
  try {
    const child = await t.daemon.spawn(p.id, { name: "child", task: "child", budgetMicros: 100, template: "limited", idempotencyKey: "child" });
    const parked = await parkedOrTerminal(t, child.id);
    assert.equal(parked.state, "yielded");
    granted = false;
    await t.daemon.sendMessage(p.id, child.id, "resume", p.generation, "wake-child");
    await until(async () => terminal(await get(t, child.id)));
    assert.equal((await get(t, child.id)).exit, "succeeded", "workflow/public reauthorization must not retroactively redefine classic non-public resume");
  } finally {
    await t.daemon.cancel(p.id);
    await t.orchestrator.idle();
  }
});
