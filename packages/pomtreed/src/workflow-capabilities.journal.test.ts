import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, DeterministicRunContext, ExtensionJournalPayload, JsonValue } from "@pomtree/core";
import { openStore } from "@pomtree/store-sqlite";
import { buildRunOps, canonicalJson, type WorkflowCapabilityServices } from "./workflow-capabilities.ts";

// Real SQLite journal: the store's per-key idempotency (one transaction, scope+key) decides concurrent writers.
async function world() {
  const store = openStore(":memory:");
  const root = await store.registry.create({
    parent: null,
    name: "root",
    task: "t",
    host: "h",
    budgetMicros: 0,
    idempotencyKey: "root",
    spec: { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" } },
  });
  const agent = { id: "task-1", state: "running", generation: 1 } as unknown as AgentRecord;
  const svc = {
    root: async () => root,
    agent: async () => agent,
    readRoot: (from: number, limit: number) => store.journal.read({ from, agent: root.id, limit }),
    recordRoot: (payload: ExtensionJournalPayload, key: string) =>
      store.journal.append({ agent: root.id, host: "h", generation: root.generation, payload, idempotencyKey: key } as never),
    redactText: (t: string) => t,
    now: () => 1,
  } as unknown as WorkflowCapabilityServices;
  const ctx = {
    agent: "task-1",
    generation: 1,
    host: "h",
    input: { instance: "daily" },
    signal: new AbortController().signal,
    deadlineAt: null,
    ops: {} as never,
  } as DeterministicRunContext;
  const ops = () => buildRunOps({ workflow: "ext/digest", caps: { state: true }, ctx, getServices: () => svc });
  const rows = async () => (await store.journal.read({ from: 0, agent: root.id, limit: 100 })).length;
  return { ops, rows };
}

test("concurrent same-key different-value setState: one row, one winner, loser 409, stable latest", async () => {
  const w = await world();
  const [a, b] = [w.ops(), w.ops()];
  const res = await Promise.allSettled([a.setState({ v: "A" }, "k"), b.setState({ v: "B" }, "k")]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
  const lost = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.match(String(lost.reason), /different value/);
  assert.equal(await w.rows(), 1);
  const won = res[0]?.status === "fulfilled" ? { v: "A" } : { v: "B" };
  assert.deepEqual(await w.ops().getState(), won);
  assert.deepEqual(await w.ops().getState(), won);
});

test("own __proto__ key round-trips through the journal as data", async () => {
  const w = await world();
  const v = JSON.parse('{"__proto__":{"x":1},"a":2}') as JsonValue;
  await w.ops().setState(v, "p");
  const back = await w.ops().getState();
  assert.equal(canonicalJson(back), canonicalJson(v));
  await w.ops().setState(v, "p"); // replay is idempotent
  assert.equal(await w.rows(), 1);
});
