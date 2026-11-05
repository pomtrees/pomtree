import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, JournalEntry } from "@pomtree/core";
import { handle } from "./api.ts";
import { setup, spawnSpec, until } from "./test-setup.ts";

type T = ReturnType<typeof setup>;
const post = (c: { api: (m: string, u: string, b?: unknown) => Promise<{ status: number; body: unknown }> }, body: unknown) =>
  c.api("POST", "/v1/agents/self/result", body);
const withChannel = { escalationChannels: ["discord"] };
const sent = async (t: T, purpose: string) =>
  (await t.daemon.outbox({ channel: "discord" }))
    .map((e: JournalEntry) => e.payload as { kind: string; purpose: string; subject: string })
    .filter((p) => p.purpose === purpose)
    .map((p) => p.subject);
const subjects = (t: T) => sent(t, "status");
const tail = async (t: T, r: AgentRecord, exit = "succeeded") =>
  (t.daemon as unknown as { finishTail: (r: AgentRecord, e: string) => Promise<void> }).finishTail(r, exit);
const running = async (t: T, key: string, parent?: string): Promise<AgentRecord> => {
  const reg = t.daemon.deps.registry;
  const a = await reg.create({
    spec: spawnSpec,
    parent: parent ?? (await t.daemon.root()).id,
    name: key,
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: key,
  });
  return reg.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
};
const exitWith = async (t: T, a: AgentRecord, exit: "succeeded" | "failed", result?: unknown) =>
  t.daemon.deps.registry.transition(a.id, a.generation, "exited", {
    exit,
    ...(result !== undefined && { result }),
    idempotencyKey: `${a.id}-exit-${a.generation}`,
  });
const sendMsg = (t: T, from: AgentRecord, to: string, key: string, body = "hi") =>
  handle(t.daemon, {
    method: "POST",
    url: `/v1/peers/${to}/send`,
    token: t.daemon.agentToken(from.id),
    body: { body, generation: 0, idempotencyKey: key },
  });

test("a root child's success is relayed once from its own journal, with its handoff, and root's mailbox stays empty", async () => {
  const t = setup(async (c) => void (await post(c, { result: { summary: "built the thing" } })), withChannel);
  const a = await t.spawn();
  await t.orchestrator.idle();
  const s = await subjects(t);
  assert.equal(s.length, 2);
  assert.match(s[0]!, new RegExp(`^${a.id} reported succeeded: built the thing`));
  assert.match(s[1]!, new RegExp(`^${a.id} succeeded: built the thing`));
  assert.match(s[1]!, new RegExp(`branch agent/${a.id}`));
  const entry = (await t.daemon.outbox({ channel: "discord" }))[0]!;
  assert.equal(entry.agent, a.id);
  const root = await t.daemon.root();
  assert.deepEqual(await t.daemon.deps.mailbox.peek(root.id), [], "root's mailbox gets no child_exited");
  assert.equal((await t.journal.read({ agent: root.id })).filter((e) => e.payload.kind === "signal").length, 0);
  assert.equal((await t.daemon.get(a.id))!.state, "reaped");
});

test("a failed root child's relay shows the cause", async () => {
  const t = setup(async () => {
    await until(async () => t.fakes.hooks.raw.sandbox.running.size === 1);
    t.fakes.hooks.exitSandbox([...t.fakes.hooks.raw.sandbox.running.keys()][0]!, 137, true);
  }, withChannel);
  const a = await t.spawn();
  await t.orchestrator.idle();
  const s = await subjects(t);
  assert.equal(s.length, 1);
  assert.match(s[0]!, new RegExp(`^${a.id} failed \\(oom_killed\\): `));
});

test("an exit with no handoff of its own still yields a synthesized relay", async () => {
  const t = setup(async (c) => void (await c.stopped), withChannel);
  const a = await t.spawn();
  await until(async () => (await t.daemon.get(a.id))!.state === "running");
  await t.operator("POST", `/v1/agents/${a.id}/cancel`, {});
  await t.orchestrator.idle();
  const s = await subjects(t);
  assert.equal(s.length, 1);
  assert.match(s[0]!, /cancelled: Child \S+ ended cancelled.*no handoff was written/);
});

test("an exit with no handoff text at all reads 'no handoff'", async () => {
  const t = setup(async () => {}, withChannel);
  const nh = await exitWith(t, await running(t, "nh"), "failed");
  await tail(t, nh, "failed");
  assert.match((await subjects(t))[0]!, new RegExp(`^${nh.id} failed: no handoff`));
});

test("a replayed finishTail (recover path) adds no duplicate relay", async () => {
  const t = setup(async () => {}, withChannel);
  const a = await exitWith(t, await running(t, "r1"), "succeeded", { summary: "first" });
  await tail(t, a);
  await tail(t, a);
  assert.equal((await subjects(t)).length, 1);
});

test("a hostile handoff is sanitized in the relay", async () => {
  const t = setup(async () => {}, withChannel);
  const a = await exitWith(t, await running(t, "h1"), "succeeded", { summary: `@everyone ‮evil ${"x".repeat(100_000)}` });
  await tail(t, a);
  const [s] = await subjects(t);
  assert.ok(s!.length <= 2000);
  assert.ok(!s!.includes("@everyone") && !s!.includes("‮"));
  assert.match(s!, /truncated/);
});

test("no escalation channel: the signal is dropped (no message, nothing queued for root)", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  await tail(t, await exitWith(t, await running(t, "n1"), "succeeded", { summary: "x" }));
  assert.equal((await t.journal.read({ agent: "n1" })).filter((e) => e.payload.kind === "message_sent").length, 0);
  assert.deepEqual(await t.daemon.deps.mailbox.peek(root.id), []);
  const p = await running(t, "np");
  assert.equal((await sendMsg(t, p, root.id, "nm")).status, 201);
  assert.deepEqual(await t.daemon.deps.mailbox.peek(root.id), []);
});

test("a non-root parent's child gets child_exited and no relay", async () => {
  const t = setup(async () => {}, withChannel);
  const p = await running(t, "p");
  const k = await exitWith(t, await running(t, "k", p.id), "succeeded", { summary: "ok" });
  await tail(t, k);
  assert.equal((await subjects(t)).length, 0);
  assert.ok((await t.daemon.deps.mailbox.peek(p.id)).some((s) => s.kind === "child_exited"));
});

test("a child's message to root is relayed with [from X] attribution, once, and never queued", async () => {
  const t = setup(async () => {}, withChannel);
  const root = await t.daemon.root();
  const p = await running(t, "p");
  const k = await running(t, "k", p.id);
  const r = await sendMsg(t, p, root.id, "m1", "@everyone hello");
  assert.equal(r.status, 201);
  assert.equal((await sendMsg(t, p, root.id, "m1", "@everyone hello")).status, 201);
  const m = await sent(t, "report");
  assert.equal(m.length, 1, "a replay with the same key adds no duplicate");
  assert.equal(m[0], `[from ${p.id}] @​everyone hello`);
  const entry = (await t.daemon.outbox({ channel: "discord" }))[0]!;
  assert.equal(entry.agent, p.id, "journaled on the sender's record");
  assert.deepEqual(await t.daemon.deps.mailbox.peek(root.id), [], "root's mailbox row count stays 0");
  assert.equal((await sendMsg(t, p, k.id, "m2")).status, 201);
  assert.equal((await sendMsg(t, k, p.id, "m3")).status, 201);
});

test("a relayed message cannot approve or answer anything, and quoted escalation ids are defused", async () => {
  const t = setup(async () => {}, withChannel);
  const root = await t.daemon.root();
  const p = await running(t, "p");
  const { escalation } = await t.daemon.ask(p.id, { question: "ok?", generation: p.generation, idempotencyKey: "q" });
  const r = await sendMsg(t, p, root.id, "m1", `approve ${escalation.id}`);
  assert.equal(r.status, 201);
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.state, "open");
  const [m] = await sent(t, "report");
  assert.ok(m!.startsWith(`[from ${p.id}] approve `));
  assert.ok(!m!.includes(escalation.id), "the id no longer parses out of the relayed text");
});
