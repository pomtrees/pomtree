import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, AgentId, WorkflowDef } from "@pomtree/core";
import { agentIdFor, LifecycleError } from "./lifecycle.ts";
import { WorkflowHost } from "./workflows.ts";

// Offline host regressions for launch errors and one active run per instance. Fake registry and start; no daemon, no network.

const rows: AgentRecord[] = [];
const registry = {
  get: async (id: AgentId) => rows.find((r) => r.id === id) ?? null,
  list: async (o?: { state?: string }) => rows.filter((r) => !o?.state || r.state === o.state),
};
const DEF: WorkflowDef = {
  name: "digest",
  capabilities: { state: true },
  validate: (i) => ({ ok: true, value: i }),
  run: async () => {},
};

function host() {
  const started: string[] = [];
  const h = new WorkflowHost({
    registry: () => registry as never,
    reviewed: () => true,
    startDeterministic: async (requester, req) => {
      const id = `${requester}-${req.idempotencyKey}` as AgentId;
      started.push(id);
      const row = { id, state: "running", executor: "deterministic", spec: req.spec, generation: 1, host: "h" } as unknown as AgentRecord;
      rows.push(row);
      return row;
    },
  });
  h.commit("ext", [DEF]);
  return { h, started };
}

test("launch: unknown workflow is 404; invalid instance is 400; missing key is 400", async () => {
  rows.length = 0;
  const { h, started } = host();
  await assert.rejects(
    h.launch("root", { workflow: "ext/nope", input: {}, idempotencyKey: "k" }),
    (e: unknown) => e instanceof LifecycleError && e.status === 404,
  );
  await assert.rejects(
    h.launch("root", { workflow: "ext/digest", input: { instance: "Bad Name" }, idempotencyKey: "k" }),
    (e: unknown) => e instanceof LifecycleError && e.status === 400,
  );
  await assert.rejects(
    h.launch("root", { workflow: "ext/digest", input: { instance: "a" }, idempotencyKey: "" }),
    (e: unknown) => e instanceof LifecycleError && e.status === 400,
  );
  assert.equal(started.length, 0);
});

test("one active run per workflow + instance: a second launch returns the active row; other instances start normally", async () => {
  rows.length = 0;
  const { h, started } = host();
  const first = await h.launch("root", { workflow: "ext/digest", input: { instance: "a" }, idempotencyKey: "k1" });
  const second = await h.launch("root", { workflow: "ext/digest", input: { instance: "a" }, idempotencyKey: "k2" });
  assert.equal(second.id, first.id, "the active run is returned, not a second task");
  assert.equal(started.length, 1);
  const other = await h.launch("root", { workflow: "ext/digest", input: { instance: "b" }, idempotencyKey: "k3" });
  assert.notEqual(other.id, first.id);
  assert.equal(started.length, 2);
});

// Public launch errors are fixed per class. Raw text from a validator, the registry, the start path or a LifecycleError never reaches
// the caller; the internal start keeps its detailed message for operators.
const LEAK = "/private/token-secret instance malformed JSON";
const isErr = (status: number, message?: string) => (e: unknown) =>
  e instanceof LifecycleError && e.status === status && (message === undefined || e.message === message) && !/private|token|secret/.test(e.message);

test("public launch: raw start/validator/registry text is a generic 500, never echoed", async () => {
  rows.length = 0;
  const throwing = (over: Partial<WorkflowDef>) => {
    const h = new WorkflowHost({
      registry: () => registry as never,
      reviewed: () => true,
      startDeterministic: async () => {
        throw new Error(LEAK);
      },
    });
    h.commit("ext", [{ ...DEF, ...over }]);
    return h;
  };
  // validator throws with leaking text
  const v = throwing({
    validate: () => {
      throw new Error(LEAK);
    },
  });
  await assert.rejects(v.launch("root", { workflow: "ext/digest", input: { instance: "a" }, idempotencyKey: "v1" }), isErr(500, "workflow start failed"));
  // start path throws a plain Error carrying a 'malformed'/'instance'/'JSON' substring: still a 500, not a 400
  const s = throwing({});
  await assert.rejects(s.launch("root", { workflow: "ext/digest", input: { instance: "a" }, idempotencyKey: "s1" }), isErr(500, "workflow start failed"));
  // a LifecycleError with a leaking message and an unlisted status is a generic 500
  const l = new WorkflowHost({
    registry: () => registry as never,
    reviewed: () => true,
    startDeterministic: async () => {
      throw new LifecycleError(500, LEAK);
    },
  });
  l.commit("ext", [DEF]);
  await assert.rejects(l.launch("root", { workflow: "ext/digest", input: { instance: "a" }, idempotencyKey: "l1" }), isErr(500, "workflow start failed"));
  // an allowlisted status keeps its class with a fixed message
  const c = new WorkflowHost({
    registry: () => registry as never,
    reviewed: () => true,
    startDeterministic: async () => {
      throw new LifecycleError(409, LEAK);
    },
  });
  c.commit("ext", [DEF]);
  await assert.rejects(c.launch("root", { workflow: "ext/digest", input: { instance: "a" }, idempotencyKey: "c1" }), isErr(409, "workflow conflict"));
});

test("public launch: invalid input is a generic 400; keyed conflicts (container or other workflow) are 409, not 400", async () => {
  rows.length = 0;
  const { h } = host();
  const bad = new WorkflowHost({
    registry: () => registry as never,
    reviewed: () => true,
    startDeterministic: async () => {
      throw new Error("unreachable");
    },
  });
  bad.commit("ext", [{ ...DEF, validate: () => ({ ok: false, error: "needs a field" }) }]);
  await assert.rejects(bad.launch("root", { workflow: "ext/digest", input: {}, idempotencyKey: "i1" }), isErr(400, "invalid workflow input"));
  // a container row already holds the key: conflict, generic message
  rows.push({ id: agentIdFor("root", "kc"), state: "running", executor: "container", spec: {}, generation: 1, host: "h" } as unknown as AgentRecord);
  await assert.rejects(
    h.launch("root", { workflow: "ext/digest", input: { instance: "z" }, idempotencyKey: "kc" }),
    isErr(409, "idempotency key is already bound"),
  );
  rows.length = 0;
});

test("public launch: a workflow withdrawn during admission is 404 and no task starts", async () => {
  let h!: WorkflowHost;
  let started = 0;
  const reg = {
    get: async () => {
      h.withdraw("ext");
      return null;
    },
    list: async () => [],
  };
  h = new WorkflowHost({
    registry: () => reg as never,
    reviewed: () => true,
    startDeterministic: async () => {
      started++;
      throw new Error("unreachable");
    },
  });
  h.commit("ext", [DEF]);
  await assert.rejects(
    h.launch("root", { workflow: "ext/digest", input: { instance: "a" }, idempotencyKey: "w1" }),
    isErr(404, "unknown or unavailable workflow"),
  );
  assert.equal(started, 0);
});

// Child admission (guardOps): a deterministic child is re-checked against the commit after its awaits, and one active run per
// stateful instance is enforced for a different task (a conflict, never a foreign child id). Driven through the public executor view.
const PARENT: WorkflowDef = {
  name: "parent",
  validate: (i) => ({ ok: true, value: i }),
  run: async (ctx) => {
    await (ctx.ops as unknown as { spawn: (c: unknown) => Promise<unknown> }).spawn({
      executor: "deterministic",
      name: "c",
      task: "t",
      idempotencyKey: "ck",
      spec: { driver: "ext/digest", input: { instance: "a" } },
    });
  },
};
const rawOps = (counter: { n: number }) => ({
  spawn: async () => {
    counter.n++;
    return "x" as AgentId;
  },
  peek: async () => [],
  ack: async () => {},
  message: async () => {},
  reap: async () => {},
  submitResult: async () => {},
});
const runCtx = (ops: unknown) =>
  ({ agent: "root" as AgentId, generation: 1, host: "h", input: {}, signal: new AbortController().signal, deadlineAt: null, ops }) as never;

test("child admission: a withdraw during admission (after the replay read) spawns nothing", async () => {
  rows.length = 0;
  const counter = { n: 0 };
  let h!: WorkflowHost;
  const reg = {
    get: async () => {
      h.withdraw("ext");
      return null;
    },
    list: async () => [],
  };
  h = new WorkflowHost({
    registry: () => reg as never,
    reviewed: () => true,
    startDeterministic: async () => {
      throw new Error("unreachable");
    },
  });
  h.commit("ext", [DEF, PARENT]);
  await assert.rejects(
    h.executors.get("ext/parent")!.run(runCtx(rawOps(counter))),
    (e: unknown) => e instanceof Error && /unknown or unavailable/.test(e.message),
  );
  assert.equal(counter.n, 0);
});

test("child admission: a different active task on the same stateful instance is a conflict, not its child id", async () => {
  rows.length = 0;
  const counter = { n: 0 };
  const h = new WorkflowHost({
    registry: () => registry as never,
    reviewed: () => true,
    startDeterministic: async () => {
      throw new Error("unreachable");
    },
  });
  h.commit("ext", [DEF, PARENT]);
  rows.push({
    id: "other-task",
    state: "running",
    executor: "deterministic",
    spec: { driver: "ext/digest", input: { instance: "a" } },
    generation: 1,
    host: "h",
  } as unknown as AgentRecord);
  await assert.rejects(
    h.executors.get("ext/parent")!.run(runCtx(rawOps(counter))),
    (e: unknown) => e instanceof Error && /already has an active run/.test(e.message),
  );
  assert.equal(counter.n, 0);
  rows.length = 0;
});
