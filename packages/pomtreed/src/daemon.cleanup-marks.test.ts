import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentId, JournalPayload } from "@pomtree/core";
import { fakeBundle } from "@pomtree/testing";
import { openStore } from "@pomtree/store-sqlite";
import { setup, spawnSpec } from "./test-setup.ts";
import type { Ctx } from "./test-setup.ts";

// The cleanup sweep marks each reaped root child once its prune and report GC succeed (DaemonDeps.workspaceCleanup), so later
// sweeps skip it instead of re-running workspace.prune for every reaped child forever.
async function reapedRootChild(t: ReturnType<typeof setup>, key: string) {
  const reg = t.fakes.hooks.raw.registry;
  const root = await t.daemon.root();
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: key, task: "t", host: "h1", budgetMicros: 1, idempotencyKey: key });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
  await reg.transition(a.id, a.generation, "exited", { exit: "succeeded", idempotencyKey: `${key}-exit` });
  await reg.transition(a.id, a.generation, "reaped", { idempotencyKey: `${key}-reap` });
  return a;
}

async function ingestFor(t: ReturnType<typeof setup>, agent: AgentId) {
  await t.daemon.deps.workspace.create(agent, {});
  const out = await t.daemon.deps.workspace.ingest(
    agent,
    (async function* () {
      yield fakeBundle([{ name: `agent/${agent}`, commit: `c-${agent}` }]);
    })(),
    { maxBytes: 1 << 20 },
  );
  assert.equal(out.ok, true);
}

const prunes = (t: ReturnType<typeof setup>) => t.fakes.calls.filter((c) => c.port === "Workspace" && c.method === "prune").length;

function marks() {
  return openStore().workspaceCleanup;
}

async function rootWithReaped(t: ReturnType<typeof setup>, n: number): Promise<AgentId[]> {
  const root = await t.daemon.root();
  await ingestFor(t, root.id);
  const ids: AgentId[] = [];
  for (let i = 0; i < n; i++) {
    const a = await reapedRootChild(t, `m${i}`);
    await ingestFor(t, a.id);
    t.fakes.hooks.raw.workspace.merged.add(a.id);
    ids.push(a.id);
  }
  return ids;
}

test("N merged reaped root children: the first sweep prunes each once and marks it; later sweeps do not prune them again", async () => {
  const m = marks();
  const t = setup(async (c: Ctx) => void (await c.stopped), { workspaceCleanup: m });
  const ids = await rootWithReaped(t, 3);

  assert.deepEqual((await t.daemon.sweepCleanup()).sort(), [...ids].sort());
  assert.equal(prunes(t), 3);
  assert.deepEqual([...m.cleanedAgents()].sort(), [...ids].sort());

  await t.daemon.sweepCleanup();
  await t.daemon.sweepCleanup();
  assert.equal(prunes(t), 3, "marked agents are skipped on later sweeps");
});

test("a failed prune is not marked and is retried by the next sweep until it succeeds", async () => {
  const m = marks();
  const t = setup(async (c: Ctx) => void (await c.stopped), { workspaceCleanup: m });
  const [a] = await rootWithReaped(t, 1);
  const raw = t.fakes.hooks.raw.workspace;
  const real = raw.prune.bind(raw);
  let failures = 1;
  raw.prune = async (agent, opts) => {
    if (failures-- > 0) throw new Error("transient prune failure");
    return real(agent, opts);
  };

  await assert.rejects(t.daemon.sweepCleanup(), /transient prune failure/);
  assert.equal(m.cleanedAgents().has(a!), false, "a failed cleanup must not set the marker");

  assert.deepEqual(await t.daemon.sweepCleanup(), [a]);
  assert.equal(m.cleanedAgents().has(a!), true);
  await t.daemon.sweepCleanup();
  assert.equal(prunes(t), 2, "one failed attempt, one success, then no further prunes");
});

test("without a marker (no workspaceCleanup supplied) every sweep still re-checks the merged reaped child", async () => {
  const t = setup(async (c: Ctx) => void (await c.stopped));
  const [a] = await rootWithReaped(t, 1);
  assert.deepEqual(await t.daemon.sweepCleanup(), [a]);
  assert.deepEqual(await t.daemon.sweepCleanup(), [], "the refs are gone, so the prune reads nothing: not reported, and the (idempotent) GC re-runs");
  assert.equal(prunes(t), 2, "the check still runs each sweep when there is no marker");
});

async function addReport(t: ReturnType<typeof setup>, agent: AgentId, key: string) {
  const content = new TextEncoder().encode("x");
  await t.fakes.hooks.raw.reportStore.write(
    {
      id: `rep-${agent}-${key}`,
      agent,
      generation: 0,
      host: "h1",
      name: `${key}.md`,
      mediaType: "text/markdown",
      sizeBytes: content.length,
      sha256: "aa",
      content,
    },
    key,
  );
}

// Prune succeeds (refs deleted) but the report GC throws once: the next sweep must still finish the GC, without another prune.
test("a report GC that throws after a successful prune is finished by the next sweep (the prune is not repeated)", async () => {
  const m = marks();
  const t = setup(async (c: Ctx) => void (await c.stopped), { workspaceCleanup: m });
  const [a] = await rootWithReaped(t, 1);
  await addReport(t, a!, "r1");
  const reports = t.fakes.hooks.raw.reportStore;
  const realRemove = reports.remove.bind(reports);
  let failures = 1;
  reports.remove = async (agent, id) => {
    if (failures-- > 0) throw new Error("transient report failure");
    return realRemove(agent, id);
  };

  await assert.rejects(t.daemon.sweepCleanup(), /transient report failure/);
  assert.equal(m.cleanedAgents().has(a!), false);
  assert.equal((await reports.list(a!)).length, 1, "the report is still there after the failed GC");

  assert.deepEqual(await t.daemon.sweepCleanup(), [a]);
  assert.equal((await reports.list(a!)).length, 0, "the next sweep finished the report GC");
  assert.equal(m.cleanedAgents().has(a!), true);
  assert.equal(prunes(t), 1, "the successful prune is not repeated");
});

// Prune and report GC both succeed, but the final mark throws: the next sweep must mark it without re-pruning or losing anything.
test("a marker write that throws after the prune and GC is retried safely and then marks the agent", async () => {
  const m = marks();
  let failures = 1;
  const flaky = {
    markPruned: (agent: AgentId, at: number) => m.markPruned(agent, at),
    markCleaned: (agent: AgentId, at: number) => {
      if (failures-- > 0) throw new Error("transient marker failure");
      m.markCleaned(agent, at);
    },
    prunedAgents: () => m.prunedAgents(),
    cleanedAgents: () => m.cleanedAgents(),
  };
  const t = setup(async (c: Ctx) => void (await c.stopped), { workspaceCleanup: flaky });
  const [a] = await rootWithReaped(t, 1);

  await assert.rejects(t.daemon.sweepCleanup(), /transient marker failure/);
  assert.equal(prunes(t), 1);

  assert.deepEqual(await t.daemon.sweepCleanup(), [a]);
  assert.equal(m.cleanedAgents().has(a!), true);
  assert.equal(prunes(t), 1, "the retry does not prune again");
  assert.deepEqual(await t.daemon.sweepCleanup(), [], "a marked agent is then skipped");
});

// One agent's failing report GC must not starve the other reaped children in the same sweep; the error still surfaces.
test("a failing report GC for one reaped child does not stop the others in the same sweep, and the sweep still rejects", async () => {
  const m = marks();
  const t = setup(async (c: Ctx) => void (await c.stopped), { workspaceCleanup: m });
  const ids = await rootWithReaped(t, 3);
  for (const id of ids) await addReport(t, id, "r");
  const reports = t.fakes.hooks.raw.reportStore;
  const realRemove = reports.remove.bind(reports);
  let failures = 1;
  reports.remove = async (agent, id) => {
    if (agent === ids[0] && failures-- > 0) throw new Error("transient report failure");
    return realRemove(agent, id);
  };

  await assert.rejects(t.daemon.sweepCleanup(), /transient report failure/);
  assert.deepEqual([...m.cleanedAgents()].sort(), [ids[1], ids[2]].sort(), "the other two were pruned and marked in the same sweep");
  assert.equal((await reports.list(ids[1]!)).length, 0);
  assert.equal((await reports.list(ids[2]!)).length, 0);

  assert.deepEqual(await t.daemon.sweepCleanup(), [ids[0]], "the first agent is retried on the next sweep");
  assert.deepEqual([...m.cleanedAgents()].sort(), [...ids].sort());
  assert.equal(prunes(t), 3, "each prune ran once; the retry only finished the GC");
});

// A markPruned throw right after a successful prune (the same shape as a crash between them): the refs are gone, so the next
// sweep's prune reads "nothing", which is also marked and owes the GC, so the reports are not stranded.
test("markPruned throwing after a successful prune is replayed as nothing: the next sweep GCs the reports and marks the agent", async () => {
  const m = marks();
  let failures = 1;
  const flaky = {
    markPruned: (agent: AgentId, at: number) => {
      if (failures-- > 0) throw new Error("transient markPruned failure");
      m.markPruned(agent, at);
    },
    markCleaned: (agent: AgentId, at: number) => m.markCleaned(agent, at),
    prunedAgents: () => m.prunedAgents(),
    cleanedAgents: () => m.cleanedAgents(),
  };
  const t = setup(async (c: Ctx) => void (await c.stopped), { workspaceCleanup: flaky });
  const [a] = await rootWithReaped(t, 1);
  await addReport(t, a!, "r1");
  // The child pushed: Daemon.ingest journaled its refs, which is what tells a "nothing" prune apart from a never-pushed child.
  await t.daemon.deps.journal.append({
    agent: a!,
    host: "h1",
    generation: 0,
    payload: { kind: "ingested", key: "k", refs: [{ ref: `agent/${a}`, commit: `c-${a}` }] } as JournalPayload,
    idempotencyKey: `${a}:ingested`,
  });

  await assert.rejects(t.daemon.sweepCleanup(), /transient markPruned failure/);
  assert.equal(prunes(t), 1);
  assert.equal((await t.fakes.hooks.raw.reportStore.list(a!)).length, 1, "the GC did not run");
  assert.equal(await t.daemon.deps.workspace.ingested(a!), null, "the refs are already gone");

  assert.deepEqual(await t.daemon.sweepCleanup(), [], "the replay's prune reads nothing, so it is not reported as pruned");
  assert.equal(prunes(t), 2, "the replay prunes once more and reads nothing");
  assert.equal((await t.fakes.hooks.raw.reportStore.list(a!)).length, 0, "the reports are no longer stranded");
  assert.equal(m.cleanedAgents().has(a!), true);
  assert.deepEqual(await t.daemon.sweepCleanup(), [], "a marked agent is then skipped");
  assert.equal(prunes(t), 2);
});

test("a child that never pushed (nothing to prune, no ingested entry) is marked cleaned and not pruned again, but its reports are kept", async () => {
  const m = marks();
  const t = setup(async (c: Ctx) => void (await c.stopped), { workspaceCleanup: m });
  const root = await t.daemon.root();
  await ingestFor(t, root.id);
  const a = await reapedRootChild(t, "never");
  await addReport(t, a.id, "r1");

  assert.deepEqual(await t.daemon.sweepCleanup(), [], "nothing was pruned, so none is reported");
  assert.equal(m.cleanedAgents().has(a.id), true);
  assert.equal(m.prunedAgents().has(a.id), false, "not recorded as pruned");
  assert.equal((await t.fakes.hooks.raw.reportStore.list(a.id)).length, 1, "the operator's only copy of the reports is kept");
  await t.daemon.sweepCleanup();
  assert.equal(prunes(t), 1, "marked, so not re-pruned");
});

test("a reaped root child that never pushed keeps both reports across three sweeps; prune runs once and the agent is marked cleaned", async () => {
  const m = marks();
  const t = setup(async (c: Ctx) => void (await c.stopped), { workspaceCleanup: m });
  const root = await t.daemon.root();
  await ingestFor(t, root.id);
  const a = await reapedRootChild(t, "never2");
  await addReport(t, a.id, "r1");
  await addReport(t, a.id, "r2");

  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await t.daemon.sweepCleanup(), []);
    assert.equal((await t.fakes.hooks.raw.reportStore.list(a.id)).length, 2, `sweep ${i + 1}`);
  }
  assert.equal(prunes(t), 1);
  assert.equal(m.cleanedAgents().has(a.id), true);
});

test("a refused prune (tip not merged) is neither marked nor GC'd, is retried every sweep, and is cleaned once merged", async () => {
  const m = marks();
  const t = setup(async (c: Ctx) => void (await c.stopped), { workspaceCleanup: m });
  const [a] = await rootWithReaped(t, 1);
  const raw = t.fakes.hooks.raw.workspace;
  raw.merged.delete(a!);
  await addReport(t, a!, "r1");

  assert.deepEqual(await t.daemon.sweepCleanup(), []);
  assert.deepEqual(await t.daemon.sweepCleanup(), []);
  assert.equal(prunes(t), 2, "retried each sweep");
  assert.equal(m.cleanedAgents().has(a!), false);
  assert.equal(m.prunedAgents().has(a!), false);
  assert.equal((await t.fakes.hooks.raw.reportStore.list(a!)).length, 1, "reports stay until the work is merged");
  assert.notEqual(await t.daemon.deps.workspace.ingested(a!), null, "the unmerged work is untouched");

  raw.merged.add(a!);
  assert.deepEqual(await t.daemon.sweepCleanup(), [a]);
  assert.equal(m.cleanedAgents().has(a!), true);
  assert.equal((await t.fakes.hooks.raw.reportStore.list(a!)).length, 0);
});
