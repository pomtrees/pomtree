import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentId, NewJournalEntry } from "@pomtree/core";
import { buildSpans, parseTraceparent } from "@pomtree/observe";
import { createFakes } from "@pomtree/testing";
import { openDaemonStore } from "./daemon-store.ts";
import { setup, spawnSpec, until } from "./test-setup.ts";
import { tracedJournal, traceContext } from "./trace-context.ts";

async function tree() {
  const f = createFakes();
  const mk = (name: string, parent: AgentId | null) =>
    f.registry.create({ spec: spawnSpec, parent, name, task: "t", host: "h1", budgetMicros: 10, idempotencyKey: name });
  const root = await mk("root", null);
  const task = await mk("workflow-task", root.id);
  const specialist = await mk("specialist", task.id);
  const helper = await mk("helper", specialist.id);
  const lookups: AgentId[] = [];
  const get = (id: AgentId) => {
    lookups.push(id);
    return f.registry.get(id);
  };
  return { f, root, task, specialist, helper, get, lookups };
}

const entry = (agent: AgentId, kind: string, key: string): NewJournalEntry =>
  ({ agent, host: "h1", generation: 0, payload: { kind }, idempotencyKey: key }) as unknown as NewJournalEntry;

test("journal entries carry trace context: one trace per run under the root, spans nest through observe", async () => {
  const t = await tree();
  const journal = tracedJournal(t.f.journal, t.get);
  for (const [i, a] of [t.root, t.task, t.specialist, t.helper].entries()) {
    await journal.append(entry(a.id, "spawned", `s${i}`));
    await journal.append(entry(a.id, "started", `r${i}`));
  }
  const rows = await journal.read({});
  const tpOf = (id: AgentId) => [...new Set(rows.filter((e) => e.agent === id).map((e) => e.traceparent))];
  // The root and a root-level run start traces of their own; deeper agents carry their parent's span.
  assert.deepEqual(tpOf(t.root.id), [undefined]);
  assert.deepEqual(tpOf(t.task.id), [undefined]);
  // The producer-to-consumer round trip: observe's span builder nests the run's tree in one trace.
  const spans = new Map(buildSpans(rows).map((s) => [s.agent, s]));
  const task = spans.get(t.task.id)!;
  const specialist = spans.get(t.specialist.id)!;
  const helper = spans.get(t.helper.id)!;
  assert.equal(specialist.traceId, task.traceId);
  assert.equal(specialist.parentSpanId, task.spanId);
  assert.equal(helper.traceId, task.traceId);
  assert.equal(helper.parentSpanId, specialist.spanId);
  assert.equal(task.parentSpanId, null);
  assert.notEqual(spans.get(t.root.id)!.traceId, task.traceId, "the long-lived root does not swallow the run's trace");
  assert.equal(parseTraceparent(tpOf(t.helper.id)[0])!.traceId, task.traceId);
});

test("traced journal: memoized lookups, call order kept, an explicit traceparent and a failed lookup pass through", async () => {
  const t = await tree();
  const journal = tracedJournal(t.f.journal, t.get);
  // Concurrent appends issued in order land in order, even though the first needs registry lookups and later ones may not.
  await Promise.all([
    journal.append(entry(t.specialist.id, "a", "k1")),
    journal.append(entry(t.root.id, "b", "k2")),
    journal.append(entry(t.specialist.id, "c", "k3")),
  ]);
  assert.deepEqual(
    (await journal.read({})).map((e) => (e.payload as { kind: string }).kind),
    ["a", "b", "c"],
  );
  const before = t.lookups.length;
  await journal.append(entry(t.specialist.id, "d", "k4"));
  assert.equal(t.lookups.length, before, "a known agent's context is memoized");
  const explicit = await journal.append({ ...entry(t.helper.id, "e", "k5"), traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01` });
  assert.equal(explicit.traceparent, `00-${"1".repeat(32)}-${"2".repeat(16)}-01`);
  const broken = tracedJournal(t.f.journal, async () => {
    throw new Error("registry down");
  });
  const e = await broken.append(entry(t.helper.id, "f", "k6"));
  assert.equal(e.traceparent, undefined, "a failed lookup journals the entry without context");
  // An agent the registry does not know has no context and is not memoized.
  const ctx = traceContext(t.get);
  assert.equal(await ctx.of("nobody"), undefined);
  assert.equal(ctx.peek("nobody"), undefined);
});

test("a Daemon built over a bare journal stamps trace context: no entry point can skip the wrapper", async () => {
  // test-setup builds the Daemon the way the live example runtimes do: its own deps, the fakes' untraced journal.
  const t = setup(async () => {
    await new Promise(() => {}); // stay running
  });
  const run = await t.spawn("run");
  await until(async () => (await t.daemon.get(run.id))?.state === "running");
  const specialist = await t.daemon.spawn(run.id, { name: "specialist", task: "t", idempotencyKey: "sp" });
  await until(async () => (await t.journal.read({ agent: specialist.id })).length > 0);
  const tps = [...new Set((await t.journal.read({ agent: specialist.id })).map((e) => e.traceparent))];
  assert.equal(tps.length, 1);
  assert.equal(parseTraceparent(tps[0])?.traceId !== undefined, true, "the depth-2 agent's entries carry a traceparent");
  assert.equal(tps[0], await traceContext((id) => t.fakes.registry.get(id)).of(specialist.id));
  // The run itself is a trace root: no context, as in main.ts.
  assert.deepEqual([...new Set((await t.journal.read({ agent: run.id })).map((e) => e.traceparent))], [undefined]);
  await t.daemon.kill(run.id, "k").catch(() => {});
});

test("openDaemonStore: the store's journal is traced for every writer, and wrapping again is a no-op", async () => {
  const store = openDaemonStore(":memory:");
  try {
    const mk = (name: string, parent: AgentId | null) =>
      store.registry.create({ spec: spawnSpec, parent, name, task: "t", host: "h1", budgetMicros: 10, idempotencyKey: name });
    const root = await mk("root", null);
    const task = await mk("task", root.id);
    const specialist = await mk("specialist", task.id);
    assert.equal(
      tracedJournal(store.journal, () => Promise.reject(new Error("never asked"))),
      store.journal,
      "already traced",
    );
    const e = await store.journal.append(entry(specialist.id, "spawned", "s"));
    assert.equal(e.traceparent, await traceContext((id) => store.registry.get(id)).of(specialist.id));
    assert.ok(e.traceparent, "a depth-2 agent's row carries a traceparent");
    assert.equal((await store.journal.read({ agent: specialist.id }))[0]?.traceparent, e.traceparent, "persisted, not only returned");
  } finally {
    store.close();
  }
});
