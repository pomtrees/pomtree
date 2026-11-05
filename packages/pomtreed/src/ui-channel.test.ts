import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import type { AgentRecord, JournalEntry } from "@pomtree/core";
import { issueToken, issueUiCookie } from "./auth.ts";
import type { MessageReceipt } from "./daemon-types.ts";
import { MAX_SSE_STREAMS, makeServer } from "./server.ts";
import { SECRET, op, setup, spawnSpec } from "./test-setup.ts";

type T = ReturnType<typeof setup>;
const both = { messagingChannels: ["discord"], escalationChannels: ["ui", "discord"] };
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
  return reg.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
};
const ask = async (t: T, key = "k", question = "go?") => {
  const a = await running(t, `a-${key}`);
  const { escalation } = await t.daemon.ask(a.id, { question, generation: a.generation, idempotencyKey: key });
  return { a, escalation };
};
const approval = async (t: T, a: AgentRecord, key = "ap") => {
  const rec = await t.daemon.deps.approvals!.create(
    {
      id: `ap-${key}`,
      requester: { id: a.id, rank: "agent", generation: a.generation },
      action: { kind: "x", target: "tgt‮" },
      host: "h1",
      deadlineAt: Date.now() + 60_000,
      rungs: ["operator"],
    },
    key,
  );
  await t.daemon.notifyApprovalAsk(rec);
  return rec;
};
const uiReply = (t: T, b: unknown) => t.operator("POST", "/v1/ui/reply", b);
const receipt = (r: { body: unknown }) => r.body as MessageReceipt;
const answers = async (t: T) => (await t.journal.read({})).filter((e: JournalEntry) => e.payload.kind === "escalation_answered");

test("fan-out: one sanitized message_sent per channel in list order, keyed per channel, replay adds nothing", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  const { escalation } = await ask(t, "k", "ping @everyone");
  const ui = await t.daemon.outbox({ channel: "ui" });
  const dc = await t.daemon.outbox({ channel: "discord" });
  assert.equal(ui.length, 1);
  assert.equal(dc.length, 1);
  assert.ok(ui[0]!.seq < dc[0]!.seq, "list order");
  assert.deepEqual({ ...ui[0]!.payload, channel: "" }, { ...dc[0]!.payload, channel: "" });
  assert.equal((ui[0]!.payload as { replyTo?: string }).replyTo, escalation.id);
  assert.ok(!(ui[0]!.payload as { subject: string }).subject.includes("@everyone"));
  // replay: the same keyed sends via the ask path again add no entry
  const a = (await t.daemon.deps.registry.list({})).find((r) => r.name === "a-k")!;
  await t.daemon.ask(a.id, { question: "ping @everyone", generation: a.generation, idempotencyKey: "k" });
  assert.equal((await t.daemon.outbox({ channel: "ui" })).length, 1);
  assert.equal((await t.daemon.outbox({ channel: "discord" })).length, 1);
  assert.ok(escalation.id);
});

test("one configured channel behaves as before; none configured sends nothing", async () => {
  const one = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  await ask(one);
  assert.equal((await one.daemon.outbox({ channel: "discord" })).length, 1);
  const none = setup(async (c) => void (await c.stopped), {});
  const { a } = await ask(none);
  assert.equal((await none.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "message_sent").length, 0);
});

test("receiveMessage accepts a replyTo from any listed channel and rejects an unlisted one", async () => {
  const t = setup(async (c) => void (await c.stopped), { ...both, messagingChannels: ["discord", "slack"] });
  const { escalation } = await ask(t);
  const slack = await t.daemon.receiveMessage({
    channel: "slack",
    sender: { channel: "slack", sender: "u" },
    body: "x",
    replyTo: escalation.id,
    idempotencyKey: "s1",
  });
  assert.equal(slack.kind, "rejected");
  const dc = await t.daemon.receiveMessage({
    channel: "discord",
    sender: { channel: "discord", sender: "u" },
    body: "yes",
    replyTo: escalation.id,
    idempotencyKey: "d1",
  });
  assert.equal(dc.kind, "answered");
});

test("second answer from the other channel is an 'already answered' receipt with no second human_answer", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  const { escalation } = await ask(t);
  const first = await t.daemon.receiveMessage({
    channel: "discord",
    sender: { channel: "discord", sender: "u" },
    body: "yes",
    replyTo: escalation.id,
    idempotencyKey: "d1",
  });
  assert.equal(first.kind, "answered");
  const second = await uiReply(t, { replyTo: escalation.id, body: "no", idempotencyKey: "u1" });
  assert.equal(second.status, 201);
  assert.deepEqual(receipt(second), { kind: "rejected", reason: "already answered" });
  assert.equal((await answers(t)).length, 1);
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.answer, "yes");
});

test("a racing second answer that passes the pre-check still loses with 'already answered'", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  const { escalation } = await ask(t);
  const [x, y] = await Promise.all([
    t.daemon.receiveMessage({ channel: "discord", sender: { channel: "discord", sender: "u" }, body: "yes", replyTo: escalation.id, idempotencyKey: "d1" }),
    t.daemon.receiveMessage({ channel: "ui", sender: { channel: "ui", sender: "operator" }, body: "no", replyTo: escalation.id, idempotencyKey: "u1" }),
  ]);
  assert.deepEqual([x.kind, y.kind].sort(), ["answered", "rejected"]);
  assert.equal((await answers(t)).length, 1);
});

test("/v1/ui/reply: answer, idempotent replay, validation, operator-only", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  const { escalation } = await ask(t);
  const r1 = await uiReply(t, { replyTo: escalation.id, body: "go ahead", idempotencyKey: "u1" });
  assert.deepEqual(receipt(r1), { kind: "answered", escalation: escalation.id });
  const got = (await t.daemon.deps.escalations.get(escalation.id))!;
  assert.deepEqual(got.answeredBy, { channel: "ui", sender: "operator" });
  const r2 = await uiReply(t, { replyTo: escalation.id, body: "go ahead", idempotencyKey: "u1" });
  assert.deepEqual(receipt(r2), { kind: "answered", escalation: escalation.id });
  assert.equal((await answers(t)).length, 1);
  const audit = (await t.journal.read({})).filter((e) => e.payload.kind === "message_received");
  assert.equal(audit.length, 1);
  assert.equal((await uiReply(t, { replyTo: escalation.id, idempotencyKey: "u2" })).status, 400);
  assert.equal((await uiReply(t, { body: "x", idempotencyKey: "u3" })).status, 400);
  assert.equal(receipt(await uiReply(t, { replyTo: "nope", body: "x", idempotencyKey: "u4" })).kind, "rejected");
  const agentTok = t.daemon.agentToken("nobody");
  const { handle } = await import("./api.ts");
  assert.equal(
    (await handle(t.daemon, { method: "POST", url: "/v1/ui/reply", token: agentTok, body: { replyTo: escalation.id, body: "x", idempotencyKey: "u6" } }))
      .status,
    403,
  );
});

test("/v1/ui/reply: ui is not configured as a channel -> rejected", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const { escalation } = await ask(t);
  assert.equal(receipt(await uiReply(t, { replyTo: escalation.id, body: "x", idempotencyKey: "u1" })).kind, "rejected");
});

test("/v1/ui/reply: pass on an ask hands it up a rung (and 'already answered' once answered)", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  const parent = await running(t, "mid");
  const kid = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: parent.id,
    name: "kid",
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: "kid",
  });
  const kidRun = await t.daemon.deps.registry.transition(kid.id, kid.generation, "running", { idempotencyKey: "kid-run" });
  const { escalation } = await t.daemon.ask(kidRun.id, { question: "q?", generation: kidRun.generation, idempotencyKey: "kq" });
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.holder, parent.id);
  const r = await uiReply(t, { replyTo: escalation.id, decision: "pass", idempotencyKey: "p1" });
  assert.equal(receipt(r).kind, "answered");
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.holder, null);
  assert.equal((await answers(t)).length, 0, "a pass is not an answer");
  await uiReply(t, { replyTo: escalation.id, body: "yes", idempotencyKey: "p2" });
  assert.deepEqual(receipt(await uiReply(t, { replyTo: escalation.id, decision: "pass", idempotencyKey: "p3" })), {
    kind: "rejected",
    reason: "already answered",
  });
});

test("/v1/ui/reply: approve, deny and pass on approvals; a late decision is 'already decided'", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  t.daemon.deps.approvals = t.fakes.approvals;
  const a = await running(t, "r");
  const ap1 = await approval(t, a, "1");
  const ap2 = await approval(t, a, "2");
  const ap3 = await approval(t, a, "3");
  assert.deepEqual(receipt(await uiReply(t, { replyTo: ap1.id, decision: "approve", idempotencyKey: "u1" })), { kind: "answered", escalation: ap1.id });
  assert.equal((await t.fakes.approvals.get(ap1.id))!.state, "approved");
  assert.equal(receipt(await uiReply(t, { replyTo: ap2.id, decision: "deny", idempotencyKey: "u2" })).kind, "answered");
  assert.equal((await t.fakes.approvals.get(ap2.id))!.state, "denied");
  assert.equal(receipt(await uiReply(t, { replyTo: ap3.id, decision: "pass", idempotencyKey: "u3" })).kind, "answered");
  assert.equal((await t.fakes.approvals.get(ap3.id))!.journal.at(-1)!.decision, "abstain");
  assert.deepEqual(receipt(await uiReply(t, { replyTo: ap1.id, decision: "deny", idempotencyKey: "u4" })), { kind: "rejected", reason: "already decided" });
  assert.equal((await t.fakes.approvals.get(ap1.id))!.state, "approved");
  assert.ok((await t.journal.read({})).some((e) => e.payload.kind === "message_received" && e.payload.body === "pass"));
});

test("GET /v1/approvals lists pending approvals with sanitized summaries; operator-only; state validated", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  t.daemon.deps.approvals = t.fakes.approvals;
  const a = await running(t, "r");
  const ap = await approval(t, a, "1");
  const done = await approval(t, a, "2");
  await t.fakes.approvals.decide(done.id, { who: "op", rank: "operator", decision: "approve", why: "" }, "d");
  const res = await t.operator("GET", "/v1/approvals?state=pending");
  assert.equal(res.status, 200);
  const rows = res.body as { id: string; requester: string; summary: string; rung: string; atOperator: boolean; deadlineAt: number }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, ap.id);
  assert.equal(rows[0]!.requester, a.id);
  assert.equal(rows[0]!.rung, "operator");
  assert.equal(rows[0]!.atOperator, true);
  assert.equal(rows[0]!.summary, "x tgt", "bidi stripped");
  assert.equal(typeof rows[0]!.deadlineAt, "number");
  assert.equal((await t.operator("GET", "/v1/approvals?state=bogus")).status, 400);
  const { handle } = await import("./api.ts");
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/approvals", token: t.daemon.agentToken(a.id) })).status, 403);
});

test("POST /v1/messages refuses the in-daemon ui channel", async () => {
  const t = setup(async () => {}, both);
  const { handle } = await import("./api.ts");
  const tok = issueToken(SECRET, { scope: "host", channel: "ui" });
  const r = await handle(t.daemon, {
    method: "POST",
    url: "/v1/messages",
    token: tok,
    body: { channel: "ui", sender: "operator", body: "x", replyTo: "e", idempotencyKey: "k" },
  });
  assert.equal(r.status, 403);
});

// --- HTTP: CSRF on the write route, and the /live/messages SSE stream ---

const cookie = () => issueUiCookie(SECRET, 60_000);
const listen0 = async (t: T, heartbeatMs = 20) => {
  const server = makeServer(t.daemon, false, { heartbeatMs, maxConnections: 200 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port };
};
const post = (port: number, headers: Record<string, string>, body: unknown) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/v1/ui/reply", method: "POST", headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => resolve({ status: res.statusCode!, body: s }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });

test("/v1/ui/reply over HTTP: cookie needs X-Pomtree-UI: 1 and a same-origin Origin; idempotent replay", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  const { escalation } = await ask(t);
  const { server, port } = await listen0(t);
  const body = { replyTo: escalation.id, body: "ok", idempotencyKey: "u1" };
  const host = `127.0.0.1:${port}`;
  try {
    assert.equal((await post(port, { cookie: cookie() }, body)).status, 403, "no X-Pomtree-UI");
    assert.equal((await post(port, { cookie: cookie(), "x-pomtree-ui": "0" }, body)).status, 403);
    assert.equal((await post(port, { cookie: cookie(), "x-pomtree-ui": "1", origin: "http://evil.example" }, body)).status, 403, "foreign Origin");
    assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.state, "open");
    const ok1 = await post(port, { cookie: cookie(), "x-pomtree-ui": "1", origin: `http://${host}` }, body);
    assert.equal(ok1.status, 201);
    assert.equal(JSON.parse(ok1.body).kind, "answered");
    const ok2 = await post(port, { cookie: cookie(), "x-pomtree-ui": "1" }, body);
    assert.equal(JSON.parse(ok2.body).kind, "answered");
    assert.equal((await answers(t)).length, 1);
    // the operator token is accepted too, still behind the header
    assert.equal((await post(port, { authorization: `Bearer ${op}` }, body)).status, 403);
    assert.equal((await post(port, { authorization: `Bearer ${op}`, "x-pomtree-ui": "1" }, body)).status, 201);
    assert.equal((await post(port, { "x-pomtree-ui": "1" }, body)).status, 401);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("/v1/ui/reply {to, body}: human_message through receiveMessage to a running agent; replay is idempotent; one audit entry", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  const a = await running(t, "m1");
  const r1 = await uiReply(t, { to: a.id, body: "hello there", idempotencyKey: "um1" });
  assert.equal(r1.status, 201);
  assert.deepEqual(receipt(r1), { kind: "signaled", to: a.id });
  const sig = (await t.daemon.deps.mailbox.peek(a.id)).filter((s) => s.kind === "human_message");
  assert.deepEqual(
    sig.map((s) => ({ from: (s as { from: unknown }).from, body: (s as { body: string }).body })),
    [{ from: { channel: "ui", sender: "operator" }, body: "hello there" }],
  );
  assert.deepEqual(receipt(await uiReply(t, { to: a.id, body: "hello there", idempotencyKey: "um1" })), { kind: "signaled", to: a.id });
  assert.equal((await t.daemon.deps.mailbox.peek(a.id)).filter((s) => s.kind === "human_message").length, 1);
  assert.equal((await t.journal.read({})).filter((e) => e.payload.kind === "message_received").length, 1);
});

test("/v1/ui/reply {to, body}: wakes a yielded agent waiting on a message", async () => {
  let woke = "";
  let id = "";
  const t = setup(async (c) => {
    if (c.wake) {
      woke = c.wake;
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok" } }));
    }
    id = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  }, both);
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await t.daemon.get(id))?.state, "yielded");
  assert.equal(receipt(await uiReply(t, { to: id, body: "wake up", idempotencyKey: "um2" })).kind, "signaled");
  await t.orchestrator.idle();
  assert.ok(woke.includes("wake up"), woke);
  assert.equal((await t.daemon.get(id))!.exit, "succeeded");
});

test("/v1/ui/reply {to, body}: unknown 404, reaped 409, oversize 400, shape combos 400, ui channel unconfigured rejected", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  assert.equal((await uiReply(t, { to: "nope", body: "x", idempotencyKey: "e1" })).status, 404);
  const a = await running(t, "gone");
  const reg = t.daemon.deps.registry;
  const ex = await reg.transition(a.id, a.generation, "exited", { idempotencyKey: "gone-x", exit: "succeeded" } as never);
  await reg.transition(a.id, ex.generation, "reaped", { idempotencyKey: "gone-r" });
  assert.equal((await uiReply(t, { to: a.id, body: "x", idempotencyKey: "e2" })).status, 409);
  const b = await running(t, "live");
  assert.equal((await uiReply(t, { to: b.id, body: "x".repeat(4001), idempotencyKey: "e3" })).status, 400);
  assert.equal((await uiReply(t, { to: b.id, idempotencyKey: "e4" })).status, 400, "to without body");
  assert.equal((await uiReply(t, { to: b.id, body: "x", replyTo: "r", idempotencyKey: "e5" })).status, 400, "to + replyTo");
  assert.equal((await uiReply(t, { to: b.id, decision: "approve", idempotencyKey: "e6" })).status, 400, "to + decision");
  assert.equal((await uiReply(t, { body: "x", idempotencyKey: "e7" })).status, 400, "neither");
  const noUi = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const c = await running(noUi, "c");
  assert.equal(receipt(await uiReply(noUi, { to: c.id, body: "x", idempotencyKey: "e8" })).kind, "rejected");
});

test("/v1/ui/reply {to, body}: ui (operator rank) is never gated by the sender allowlist while discord is", async () => {
  const t = setup(async (c) => void (await c.stopped), { ...both, authorizeInbound: async (m) => m.channel !== "discord" });
  const a = await running(t, "z");
  assert.deepEqual(receipt(await uiReply(t, { to: a.id, body: "x", idempotencyKey: "z1" })), { kind: "signaled", to: a.id });
  const d = await t.daemon.receiveMessage({ channel: "discord", sender: { channel: "discord", sender: "u" }, to: a.id, body: "hi", idempotencyKey: "z2" });
  assert.match((d as { reason: string }).reason, /not authorized/);
  assert.deepEqual(receipt(await uiReply(t, { to: a.id, body: "y", idempotencyKey: "z3" })), { kind: "signaled", to: a.id });
});

test("/v1/ui/reply {to, body} over HTTP still needs X-Pomtree-UI: 1", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  const a = await running(t, "h");
  const { server, port } = await listen0(t);
  const body = { to: a.id, body: "ok", idempotencyKey: "h1" };
  try {
    assert.equal((await post(port, { cookie: cookie() }, body)).status, 403);
    assert.equal((await t.daemon.deps.mailbox.peek(a.id)).length, 0);
    const ok1 = await post(port, { cookie: cookie(), "x-pomtree-ui": "1" }, body);
    assert.equal(ok1.status, 201);
    assert.equal(JSON.parse(ok1.body).kind, "signaled");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

// Opens /live/messages; resolves the frames text once `until(text)` holds, then closes.
const sse = (port: number, path: string, headers: Record<string, string>, done: (s: string) => boolean) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let s = "";
      if (res.statusCode !== 200) {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode!, text: "" }));
        return;
      }
      res.on("data", (d) => {
        s += d;
        if (done(s)) {
          req.destroy();
          resolve({ status: 200, text: s });
        }
      });
    });
    req.on("error", () => {});
    setTimeout(() => reject(new Error("sse timeout")), 2000);
    req.end();
  });
const frames = (text: string) =>
  text
    .split("\n\n")
    .filter((f) => f.includes("data: "))
    .map((f) => ({ id: Number(/^id: (\d+)$/m.exec(f)![1]), data: JSON.parse(/^data: (.*)$/m.exec(f)![1]!) }));

test("GET /live/messages: ui frames only, id=seq, replay from seq, Last-Event-ID resume, live follow, heartbeat", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  const first = await ask(t, "k1", "one?");
  const { server, port } = await listen0(t);
  try {
    const auth = { cookie: cookie() };
    const r1 = await sse(port, "/live/messages", auth, (s) => frames(s).length >= 1 && s.includes(": hb"));
    const f1 = frames(r1.text);
    assert.equal(f1.length, 1, "discord entries are not framed");
    assert.equal(f1[0]!.data.channel, "ui");
    assert.equal(f1[0]!.data.subject, "one?");
    assert.equal(f1[0]!.data.purpose, "ask");
    assert.equal(f1[0]!.data.agent, first.a.id);
    assert.equal(f1[0]!.data.seq, f1[0]!.id);
    assert.equal(typeof f1[0]!.data.createdAt, "number");
    const seq1 = f1[0]!.id;
    // from past the first frame: nothing replayed; a new ask streams live
    const live = sse(port, `/live/messages?from=${seq1 + 1}`, auth, (s) => frames(s).length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    const second = await ask(t, "k2", "two?");
    const f2 = frames((await live).text);
    assert.equal(f2.length, 1);
    assert.equal(f2[0]!.data.subject, "two?");
    assert.equal(f2[0]!.data.replyTo, second.escalation.id);
    // Last-Event-ID resumes after the given id even when ?from= is older
    const r3 = await sse(port, "/live/messages?from=0", { ...auth, "last-event-id": String(seq1) }, (s) => frames(s).length >= 1);
    assert.deepEqual(
      frames(r3.text).map((f) => f.data.subject),
      ["two?"],
    );
    // operator token works too
    assert.equal((await sse(port, "/live/messages", { authorization: `Bearer ${op}` }, (s) => frames(s).length >= 1)).status, 200);
    // auth required; agent scope refused
    assert.equal((await sse(port, "/live/messages", {}, () => false)).status, 401);
    assert.equal((await sse(port, "/live/messages", { authorization: `Bearer ${t.daemon.agentToken(first.a.id)}` }, () => false)).status, 403);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("GET /live/messages counts against the SSE cap", async () => {
  const t = setup(async () => {});
  const { server, port } = await listen0(t, 5_000);
  const open: ReturnType<typeof request>[] = [];
  try {
    for (let i = 0; i < MAX_SSE_STREAMS; i++) {
      await new Promise<void>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/live/messages", headers: { cookie: cookie() } }, (res) => {
          assert.equal(res.statusCode, 200);
          res.resume();
          resolve();
        });
        req.on("error", () => {});
        setTimeout(() => reject(new Error("open timeout")), 2000);
        open.push(req);
        req.end();
      });
    }
    assert.equal((await sse(port, "/live/messages", { cookie: cookie() }, () => false)).status, 503);
  } finally {
    for (const r of open) r.destroy();
    server.close();
    server.closeAllConnections();
  }
});
