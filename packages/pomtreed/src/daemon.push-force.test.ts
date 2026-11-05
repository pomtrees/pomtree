// `pomtree push --force` is operator-only: an agent's force must not erase a controller-written merge commit from the mirror,
// and an operator's force is allowed but recorded (journal row + host log) with the tip it overwrote.
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { fakeBundle } from "@pomtree/testing";
import { LifecycleError } from "./lifecycle.ts";
import { makeServer } from "./server.ts";
import { setup, spawnSpec } from "./test-setup.ts";

type T = ReturnType<typeof setup>;

const running = async (t: T, key: string): Promise<AgentRecord> => {
  const reg = t.daemon.deps.registry;
  const a = await reg.create({
    spec: spawnSpec,
    parent: (await t.daemon.root()).id,
    name: key,
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: key,
  });
  const r = await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
  await t.daemon.deps.workspace.create(r.id, {});
  return r;
};
const bundleOf = (a: AgentRecord, commit: string, parent?: string) =>
  (async function* () {
    yield fakeBundle([{ name: `agent/${a.id}`, commit, ...(parent !== undefined && { parent }) }]);
  })();
const push = (t: T, a: AgentRecord, key: string, commit: string, opts?: { force?: boolean; operator?: boolean }, parent?: string) =>
  t.daemon.push(a.id, a.generation, key, bundleOf(a, commit, parent), 1 << 20, opts);
// c1 is ingested; the next push of c2 (no parent chain through c1) is a non-fast-forward.
const withTip = async (t: T) => {
  const a = await running(t, "a");
  const first = await push(t, a, "k1", "c1");
  assert.ok(first.ok);
  return a;
};
const tip = async (t: T, a: AgentRecord) => (await t.daemon.deps.workspace.ingested(a.id))?.commit;

test("an agent's push --force is refused with 403 and the mirror ref does not move", async () => {
  const t = setup(async () => {});
  const a = await withTip(t);
  await assert.rejects(
    push(t, a, "k2", "c2", { force: true }),
    (e: unknown) => e instanceof LifecycleError && e.status === 403 && e.message.includes("--force is operator-only"),
  );
  assert.equal(await tip(t, a), "c1", "the pre-push commit is still the tip");
  assert.equal((await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "ingested").length, 1, "nothing new was journaled");
});

test("negative control: without force the same non-fast-forward is refused by the workspace, not the role check", async () => {
  const t = setup(async () => {});
  const a = await withTip(t);
  const out = await push(t, a, "k2", "c2");
  assert.ok(!out.ok && out.code === "non_fast_forward");
  assert.equal(await tip(t, a), "c1");
});

test("over the agent route, force=1 is a 403 operator-only error (not a 500 or a hang) and the ref does not move", async () => {
  const t = setup(async () => {});
  const a = await withTip(t);
  const server = makeServer(t.daemon, false);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  try {
    const body = fakeBundle([{ name: `agent/${a.id}`, commit: "c2" }]);
    const r = await new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/v1/agents/self/push?key=k2&force=1",
          method: "POST",
          headers: {
            authorization: `Bearer ${t.daemon.agentToken(a.id, a.generation)}`,
            "content-type": "application/octet-stream",
            "content-length": String(body.byteLength),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (d: Buffer) => chunks.push(d));
          res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    assert.equal(r.status, 403);
    assert.match(String(r.json.error), /operator-only/);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
    server.closeAllConnections?.();
  }
  assert.equal(await tip(t, a), "c1");
});

test("an operator's force is allowed and recorded: forcedFrom names the overwritten tip, the journal row and the host log carry it", async (tt) => {
  const warned: string[] = [];
  tt.mock.method(console, "warn", (...x: unknown[]) => void warned.push(x.map(String).join(" ")));
  const t = setup(async () => {});
  const a = await withTip(t);
  const ref = `refs/agents/${a.id}/heads/agent/${a.id}`;
  const out = await push(t, a, "k2", "c2", { force: true, operator: true });
  assert.ok(out.ok && out.forced);
  assert.deepEqual(out.forcedFrom[0], { ref, from: "c1", to: "c2" });
  assert.equal(await tip(t, a), "c2");
  const rows = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "ingested");
  assert.equal(rows.length, 2);
  const p = rows[1]!.payload as { forced?: boolean; forcedFrom?: unknown };
  assert.equal(p.forced, true);
  assert.deepEqual(p.forcedFrom, out.forcedFrom);
  assert.equal(warned.length, 1);
  assert.ok(warned[0]!.includes("c1") && warned[0]!.includes("c2"), "the warning names the old and new tip");
  assert.equal((rows[0]!.payload as { forced?: boolean }).forced, undefined, "the ordinary first push is not marked forced");
});

test("an operator's force that is a fast-forward is not marked forced and does not warn", async (tt) => {
  const warned: string[] = [];
  tt.mock.method(console, "warn", (...x: unknown[]) => void warned.push(x.map(String).join(" ")));
  const t = setup(async () => {});
  const a = await withTip(t);
  const out = await push(t, a, "k2", "c2", { force: true, operator: true }, "c1");
  assert.ok(out.ok && !out.forced);
  assert.equal(warned.length, 0);
});
