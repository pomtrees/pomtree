import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, Signal } from "@pomtree/core";
import { get, setup, until } from "./test-setup.ts";

const post = (c: { api: (m: string, u: string, b?: unknown) => Promise<{ status: number; body: unknown }> }, body: unknown) =>
  c.api("POST", "/v1/agents/self/result", body);

test("a succeeded result without a (non-blank) summary is rejected 400 and the agent keeps running", async () => {
  const seen: Array<{ status: number; error?: string }> = [];
  const t = setup(async (c) => {
    for (const result of [null, undefined, "done", {}, { summary: "   " }, { summary: 5 }, { summary: "x".repeat(9000) }]) {
      const r = await post(c, { status: "succeeded", result });
      seen.push({ status: r.status, error: (r.body as { error?: string }).error });
    }
    assert.equal((await t.daemon.get(c.agent))!.state, "running");
    seen.push({ status: (await post(c, { result: { summary: "built it; see out/", files: ["out/a.txt"] } })).status });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.deepEqual(
    seen.slice(0, 6).map((s) => s.status),
    [400, 400, 400, 400, 400, 400],
  );
  assert.match(seen[0]!.error!, /A handoff is required: pass --summary/);
  assert.equal(seen[6]!.status, 400);
  assert.equal(seen[7]!.status, 200);
  const r = await get(t, a.id);
  assert.equal(r.exit, "succeeded");
  assert.deepEqual(r.result, { summary: "built it; see out/", files: ["out/a.txt"] });
});

test("a failed result without a summary is accepted with a synthesized one", async () => {
  const t = setup(async (c) => void (await post(c, { status: "failed", result: null })));
  const a = await t.spawn();
  await t.orchestrator.idle();
  const r = await get(t, a.id);
  assert.equal(r.exit, "failed");
  assert.deepEqual(r.result, { summary: "failed without a handoff", synthesized: true });
});

test("a non-completing exit gets a synthesized handoff (over_budget, cancelled)", async () => {
  const t = setup(async (c) => {
    c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 5_000 });
    await c.stopped;
  });
  const a = await t.spawn("k", { budgetMicros: 100 });
  await t.orchestrator.idle();
  const r = await get(t, a.id);
  assert.equal(r.exit, "over_budget");
  const h = r.result as { summary: string; synthesized: boolean };
  assert.equal(h.synthesized, true);
  assert.match(
    h.summary,
    new RegExp(
      `^Child ${a.id} ended over_budget .*after \\$0\\.01 of \\$0\\.00; no handoff was written; its workspace folder is kept \\(not merged\\); only work it pushed is on branch agent/${a.id}\\.$`,
    ),
  );

  const t2 = setup(async (c) => void (await c.stopped));
  const b = await t2.spawn("c");
  await until(async () => (await get(t2, b.id)).state === "running");
  await t2.operator("POST", `/v1/agents/${b.id}/cancel`, {});
  await t2.orchestrator.idle();
  const rb = await get(t2, b.id);
  assert.equal(rb.exit, "cancelled");
  assert.match((rb.result as { summary: string }).summary, /ended cancelled/);
});

test("child_exited carries handoff, branch and spend; the resume text and reap response include them", async () => {
  let got: Signal[] = [];
  let reap: { merge?: { status: string; detail: string } } = {};
  let kidId = "";
  const t = setup(async (c) => {
    if (c.prompt === "kid") return void (await post(c, { result: { summary: "wrote the thing\nsecond line", files: ["a.txt"] } }));
    const kid = (await c.api("POST", "/v1/agents", { task: "kid", idempotencyKey: "k1" })).body as AgentRecord;
    kidId = kid.id;
    got = (await c.api("GET", "/v1/agents/self/inbox?waitMs=2000")).body as Signal[];
    await until(async () => (await t.daemon.get(kid.id))!.state === "exited");
    got = (await c.api("GET", "/v1/agents/self/inbox")).body as Signal[];
    reap = (await c.api("POST", `/v1/agents/${kid.id}/reap`)).body as typeof reap;
    await post(c, { result: { summary: "parent done" } });
  });
  await t.spawn();
  await t.orchestrator.idle();
  const s = got.find((s) => s.kind === "child_exited") as Extract<Signal, { kind: "child_exited" }>;
  assert.equal(s.kind, "child_exited");
  assert.equal(s.handoff, "wrote the thing\nsecond line");
  assert.equal(s.branch, `agent/${kidId}`);
  assert.deepEqual(s.files, ["a.txt"]);
  assert.equal(typeof s.spentMicros, "number");
  assert.equal(typeof s.budgetMicros, "number");
  assert.equal(reap.merge, undefined, "reap no longer merges");
});

test("reap reports no merge outcome for a failed child or a succeeded one", async () => {
  const out: Record<string, { merge?: { status: string; detail: string } }> = {};
  const t = setup(async (c) => {
    if (c.prompt === "bad") return void (await post(c, { status: "failed", result: { summary: "broke" } }));
    if (c.prompt === "conf") return void (await post(c, { result: { summary: "ok" } }));
    const br = await c.api("POST", "/v1/agents", { task: "bad", idempotencyKey: "b", budgetMicros: 1000 });
    const bad = br.body as AgentRecord;
    const cr = await c.api("POST", "/v1/agents", { task: "conf", idempotencyKey: "c", budgetMicros: 1000 });
    const conf = cr.body as AgentRecord;
    await until(async () => (await t.daemon.get(bad.id))!.state === "exited" && (await t.daemon.get(conf.id))!.state === "exited");
    out.bad = (await c.api("POST", `/v1/agents/${bad.id}/reap`)).body as never;
    out.conf = (await c.api("POST", `/v1/agents/${conf.id}/reap`)).body as never;
    await post(c, { result: { summary: "p" } });
  });
  await t.spawn("p", { task: "parent", budgetMicros: 200_000 });
  await t.orchestrator.idle();
  assert.equal(out.bad!.merge, undefined);
  assert.equal(out.conf!.merge, undefined);
});

test("journalRow exposes the handoff of a child_exited signal row for the UI card", async () => {
  const { journalRow } = await import("./daemon-util.ts");
  const row = journalRow({
    seq: 1,
    ts: 1,
    agent: "p",
    payload: { kind: "signal", signal: { kind: "child_exited", child: "k", exit: "succeeded", handoff: "did it", branch: "agent/k" } },
  } as never);
  assert.deepEqual(row.handoff, { child: "k", exit: "succeeded", text: "did it", branch: "agent/k" });
});
