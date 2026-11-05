import assert from "node:assert/strict";
import { test } from "node:test";
import { handle, issueToken } from "@pomtree/pomtreed";
import { keyed } from "@pomtree/testing";
import { SECRET, rig, until } from "./harness.ts";

const op = issueToken(SECRET, { scope: "operator" });

const call = (r: ReturnType<typeof rig>, method: string, url: string, body?: unknown, token = op) =>
  handle(r.daemon, { method, url, body: keyed(method, body), token });

// Two concurrent mutating calls with the same idempotency key must apply once: one registry row, one
// `spawned` journal entry, and both callers resolve to the same agent id. The daemon serializes spawns
// through its internal chain, so this exercises the real store's idempotency (registry + journal) under
// a same-key retry storm, not just the route's happy path.
test("two concurrent spawns with the same idempotency key create exactly one agent", async () => {
  const r = rig();
  try {
    const root = await r.daemon.root();
    const [a, b] = await Promise.all([
      call(r, "POST", "/v1/agents", { name: "w", task: "t", idempotencyKey: "dup" }),
      call(r, "POST", "/v1/agents", { name: "w", task: "t", idempotencyKey: "dup" }),
    ]);
    assert.equal(a.status, 201, `a: ${JSON.stringify(a.body)}`);
    assert.equal(b.status, 201, `b: ${JSON.stringify(b.body)}`);
    const id = (a.body as { id: string }).id;
    assert.equal((b.body as { id: string }).id, id, "the same key resolves to the same agent");
    await r.orchestrator.idle();

    const kids = await r.daemon.list({ parent: root.id });
    assert.equal(kids.filter((k) => k.id === id).length, 1, "exactly one registry row");
    const spawned = (await r.daemon.events({ agent: id })).filter((e) => e.payload.kind === "spawned");
    assert.equal(spawned.length, 1, "exactly one `spawned` journal entry");
  } finally {
    r.store.close();
  }
});

// A cancel racing a self-reported result must settle to exactly one terminal state with no lost update:
// one `exited` transition, a single `exited` journal entry whose exit matches the registry, and neither
// a stranded `running` agent nor a second terminal write. The cancel releases the held session (so the
// settle path runs); the result either wins the race or is a late 409, never a silent overwrite.
test("a simultaneous cancel and self-reported result settle to exactly one terminal state", async () => {
  const r = rig({ play: () => ({ hold: new Promise(() => {}) }) });
  try {
    const root = await r.daemon.root();
    const a = await r.daemon.spawn(root.id, { name: "w", task: "t", idempotencyKey: "w" });
    await until(async () => (await r.daemon.get(a.id))?.state === "running", "agent running");

    const token = r.daemon.agentToken(a.id, (await r.daemon.get(a.id))!.generation);
    const [cancelRes, resultRes] = await Promise.all([
      call(r, "POST", `/v1/agents/${a.id}/cancel`, {}),
      call(r, "POST", `/v1/agents/${a.id}/result`, { status: "succeeded", result: { summary: "done" } }, token),
    ]);
    await r.orchestrator.idle();

    const rec = (await r.daemon.get(a.id))!;
    assert.ok(rec.state === "reaped" || rec.state === "exited", `terminal state, got ${rec.state}`);
    assert.ok(rec.exit === "succeeded" || rec.exit === "cancelled", `exactly one exit, got ${rec.exit}`);
    const exited = (await r.daemon.events({ agent: a.id })).filter((e) => e.payload.kind === "exited");
    assert.equal(exited.length, 1, "exactly one `exited` journal entry");
    assert.equal((exited[0]!.payload as { exit: string }).exit, rec.exit, "journal exit matches the registry");

    // The cancel always releases the session and is accepted; the result is applied or a late conflict.
    assert.equal(cancelRes.status, 202, `cancel: ${JSON.stringify(cancelRes.body)}`);
    assert.ok(resultRes.status === 200 || resultRes.status === 409, `result: ${resultRes.status}`);
  } finally {
    r.store.close();
  }
});
