import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentId } from "@pomtree/core";
import { fakeBundle } from "@pomtree/testing";
import { setup, spawnSpec } from "./test-setup.ts";
import type { Ctx } from "./test-setup.ts";

// The cleanup sweep (sweepCleanup) prunes reaped root branches whose tips are merged into the
// root's target and then GCs the agent's reports; it never prunes before the work is merged.
async function reapedRootChild(t: ReturnType<typeof setup>, key: string) {
  const reg = t.fakes.hooks.raw.registry;
  const root = await t.daemon.root();
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: key, task: "t", host: "h1", budgetMicros: 1, idempotencyKey: key });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
  await reg.transition(a.id, a.generation, "exited", { exit: "succeeded", idempotencyKey: `${key}-exit` });
  await reg.transition(a.id, a.generation, "reaped", { idempotencyKey: `${key}-reap` });
  return a;
}

// The fake mirror holds refs/agents/<id>/heads/*; an agent "has a branch" once it ingested something.
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
const hasRefs = (t: ReturnType<typeof setup>, agent: AgentId) =>
  [...t.fakes.hooks.raw.workspace.refs.keys()].some((r) => r.startsWith(`refs/agents/${agent}/heads/`));

async function rootBranch(t: ReturnType<typeof setup>) {
  const root = await t.daemon.root();
  await ingestFor(t, root.id);
  return root.id;
}

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

test("cleanup prunes a merged reaped root child and GCs its reports", async () => {
  const t = setup(async (c: Ctx) => void (await c.stopped));
  const rootId = await rootBranch(t);
  const a = await reapedRootChild(t, "k1");
  await ingestFor(t, a.id);
  await addReport(t, a.id, "r1");
  t.fakes.hooks.raw.workspace.merged.add(a.id);

  assert.deepEqual(await t.daemon.sweepCleanup(), [a.id]);
  assert.equal(hasRefs(t, a.id), false);
  assert.equal(hasRefs(t, rootId), true);
  assert.equal((await t.fakes.hooks.raw.reportStore.list(a.id)).length, 0);
});

test("cleanup leaves an unmerged reaped root child and its reports alone", async () => {
  const t = setup(async (c: Ctx) => void (await c.stopped));
  await rootBranch(t);
  const a = await reapedRootChild(t, "k2");
  await ingestFor(t, a.id);
  await addReport(t, a.id, "r2");
  // not added to workspace.merged: the branch tip is not merged into the root

  assert.deepEqual(await t.daemon.sweepCleanup(), []);
  assert.equal(hasRefs(t, a.id), true);
  assert.equal((await t.fakes.hooks.raw.reportStore.list(a.id)).length, 1);
});

test("cleanup skips running and exited (unreaped) root children", async () => {
  const t = setup(async (c: Ctx) => void (await c.stopped));
  await rootBranch(t);
  const reg = t.fakes.hooks.raw.registry;
  const root = await t.daemon.root();
  const running = await reg.create({ spec: spawnSpec, parent: root.id, name: "running", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "running" });
  await reg.transition(running.id, running.generation, "running", { idempotencyKey: "running-run" });
  const exited = await reg.create({ spec: spawnSpec, parent: root.id, name: "exited", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "exited" });
  await reg.transition(exited.id, exited.generation, "running", { idempotencyKey: "exited-run" });
  await reg.transition(exited.id, exited.generation, "exited", { exit: "succeeded", idempotencyKey: "exited-exit" });
  for (const a of [running, exited]) {
    await ingestFor(t, a.id);
    await addReport(t, a.id, a.name);
    t.fakes.hooks.raw.workspace.merged.add(a.id);
  }

  assert.deepEqual(await t.daemon.sweepCleanup(), []);
  assert.equal(hasRefs(t, running.id), true);
  assert.equal(hasRefs(t, exited.id), true);
  assert.equal((await t.fakes.hooks.raw.reportStore.list(running.id)).length, 1);
  assert.equal((await t.fakes.hooks.raw.reportStore.list(exited.id)).length, 1);
});
