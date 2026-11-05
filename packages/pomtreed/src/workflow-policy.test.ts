import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AgentRecord, WorkflowDef } from "@pomtree/core";
import { setup, until } from "./test-setup.ts";
import { WorkflowHost } from "./workflows.ts";
import { WorkflowRuntimePolicy } from "./workflow-policy.ts";

const route = { provider: "offline", id: "model" };

test("operator workflow configuration defaults deny and rejects malformed/wildcard/unreviewed grants", async () => {
  assert.equal(new WorkflowRuntimePolicy().reviewed("content"), false);
  for (const [owners, grants] of [
    ["*", "{}"],
    ["a,a", "{}"],
    ["a", "[]"],
    ["a", "null"],
    ["a", "bad"],
    ["a", '{"a/*":["x"]}'],
    ["a", '{"b/w":["x"]}'],
    ["a", '{"a/w":["*"]}'],
  ])
    assert.throws(() => new WorkflowRuntimePolicy(owners, grants));
  const p = new WorkflowRuntimePolicy("a", '{"a/w":["capture"]}');
  await assert.rejects(
    p.validate([], async () => ({})),
    /unregistered/,
  );
  await assert.rejects(
    p.validate(["a/w"], async () => null),
    /unknown template/,
  );
});

// Same composition callbacks as main, but transports/gateway/workspaces are shared offline fakes.
async function runtime(policy: WorkflowRuntimePolicy, pick = route, declare = true) {
  let t!: ReturnType<typeof setup>;
  const failures: string[] = [];
  const gateway = { issued: [] as string[] };
  const host = new WorkflowHost({
    registry: () => t.daemon.deps.registry,
    reviewed: (owner) => policy.reviewed(owner),
    startDeterministic: (parent, req) => t.daemon.startDeterministic(parent, req),
  });
  const def: WorkflowDef = {
    name: "pipeline",
    ...(declare && { capabilities: { modelChildren: { maxBudgetMicros: 200 } } }),
    validate: (input) => ({ ok: true, value: input }),
    async run(ctx) {
      try {
        const child = await ctx.ops.spawn({ name: "capture", task: "capture", template: "capture", model: pick, budgetMicros: 100, idempotencyKey: "capture" });
        await until(async () => ["exited", "reaped"].includes((await t.daemon.get(child))!.state));
        await ctx.ops.reap(child, "capture-receipt");
      } catch (error) {
        failures.push((error as Error).message);
      }
      await ctx.ops.submitResult({ summary: "complete" }, "done");
    },
  };
  host.commit("content", [def]);
  t = setup(
    async (ctx) => {
      await ctx.api("POST", "/v1/agents/self/result", { result: { summary: "captured" } });
    },
    {
      deterministicExecutors: host.executors,
      provider: "offline",
      models: { list: async () => ({ source: "pi", models: [route], default: route }) },
      mayUseTemplate: async (caller, template) =>
        caller === (await t.daemon.root()).id || policy.allows(await t.daemon.deps.registry.get(caller), template.id, host.qualifiedNames()),
    },
  );
  const issue = t.daemon.deps.gateway.issueKey.bind(t.daemon.deps.gateway);
  t.daemon.deps.gateway.issueKey = async (...args) => {
    gateway.issued.push(args[0]);
    return issue(...args);
  };
  t.fakes.hooks.raw.templates.templates.set("capture", { id: "capture", provider: "offline", egress: { kind: "audited-public" } });
  return { t, host, failures, gateway };
}

const launch = async (h: Awaited<ReturnType<typeof runtime>>) => {
  const r = await h.host.start((await h.t.daemon.root()).id, {
    workflow: "content/pipeline",
    name: "p",
    task: "pipeline",
    input: null,
    budgetMicros: 500,
    idempotencyKey: "run",
  });
  await until(async () => ["exited", "reaped"].includes((await h.t.daemon.get(r.id))!.state));
  return r;
};

test("configured reviewed driver and exact template grant admit an explicit offline model; missing grant has zero worker effects", async () => {
  const positive = await runtime(new WorkflowRuntimePolicy("content", '{"content/pipeline":["capture"]}'));
  const parent = await launch(positive);
  assert.deepEqual(positive.failures, []);
  const [worker] = await positive.t.daemon.list({ parent: parent.id });
  assert.equal(worker!.executor, "container");
  if (worker!.executor !== "container") throw new Error("expected container worker");
  assert.equal(worker!.spec.provider, route.provider);
  assert.equal((worker as Extract<AgentRecord, { executor: "container" }>).spec.model, route.id);
  assert.equal(positive.t.fakes.hooks.raw.sandbox.started.length, 1);
  assert.deepEqual(positive.t.fakes.hooks.raw.sandbox.started[0]!.egress!.auditedPublic, { host: worker!.host, generation: worker!.generation });
  const missing = await runtime(new WorkflowRuntimePolicy("content"));
  const denied = await launch(missing);
  assert.match(missing.failures[0]!, /not permitted/);
  assert.equal((await missing.t.daemon.list({ parent: denied.id })).length, 0);
  assert.equal(missing.t.fakes.hooks.raw.sandbox.started.length, 0);
  assert.equal(missing.gateway.issued.length, 0);
  const disabled = await runtime(new WorkflowRuntimePolicy());
  assert.equal(disabled.host.qualifiedNames().length, 0);
});

test("explicit model mismatch is refused before any child carve/gateway/workspace/sandbox effect", async () => {
  for (const pick of [
    { provider: "wrong", id: "model" },
    { provider: "offline", id: "missing" },
  ]) {
    const h = await runtime(new WorkflowRuntimePolicy("content", '{"content/pipeline":["capture"]}'), pick);
    const parent = await launch(h);
    assert.match(h.failures[0]!, /provider|catalog/);
    assert.equal((await h.t.daemon.list({ parent: parent.id })).length, 0);
    assert.equal(h.t.fakes.hooks.raw.sandbox.started.length, 0);
    assert.equal(h.gateway.issued.length, 0);
    assert.equal((await h.t.daemon.get(parent.id))!.budgetMicros, 500);
  }
});

test("a workflow without a capabilities block is refused a container child: absent declares no modelChildren", async () => {
  const h = await runtime(new WorkflowRuntimePolicy("content", '{"content/pipeline":["capture"]}'), route, false);
  const parent = await launch(h);
  assert.match(h.failures[0]!, /workflow capability not declared: modelChildren/);
  assert.equal((await h.t.daemon.list({ parent: parent.id })).length, 0);
  assert.equal(h.t.fakes.hooks.raw.sandbox.started.length, 0);
  assert.equal(h.gateway.issued.length, 0);
});

test("main composes operator opt-ins and commits reviewed drivers before recovery", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  assert.match(source, /const workflowPolicy = loaded\.workflowPolicy;/); // built by loadDaemonConfig from the resolved registry keys
  assert.match(source, /reviewed: \(owner\) => workflowPolicy\.reviewed\(owner\)/);
  assert.match(source, /mayUseTemplate: async/);
  assert.ok(source.indexOf("await extensions.startAll()") < source.indexOf("await daemon.recover()"));
});
