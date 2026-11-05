import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mailbox } from "@pomtree/core";
import { handle } from "./api.ts";
import { Daemon } from "./daemon.ts";
import { op, setup, spawnSpec } from "./test-setup.ts";

const mk = async (t: ReturnType<typeof setup>, id: string, name = id, parent: string | null = null) => {
  const r = await t.daemon.deps.registry.create({ spec: spawnSpec, id, parent, name, task: "t", host: "h1", budgetMicros: 1, idempotencyKey: `mk-${id}` });
  await t.daemon.deps.registry.transition(id, r.generation, "running", { idempotencyKey: `mk-${id}-run` });
};

test("peers lists self, parent and children as id/name/state, and scopes out strangers", async () => {
  const t = setup(async () => {});
  await mk(t, "alice");
  await mk(t, "bob", "bob", "alice");
  await mk(t, "carol");
  const r = await handle(t.daemon, { method: "GET", url: "/v1/peers", token: t.daemon.agentToken("alice") });
  assert.equal(r.status, 200);
  const peers = r.body as { id: string; name: string; state: string }[];
  assert.deepEqual(peers.map((p) => p.id).sort(), ["alice", "bob"]);
  const bob = peers.find((p) => p.id === "bob")!;
  assert.deepEqual(bob, { id: "bob", name: "bob", state: "running" });
  // no full-record leak: task/budget/sandbox are not exposed
  for (const p of peers) assert.deepEqual(Object.keys(p).sort(), ["id", "name", "state"]);
  // operator and anonymous callers are refused (the operator lists via /v1/agents)
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/peers", token: op })).status, 403);
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/peers" })).status, 401);
});

test("send delivers a message to a child's mailbox, fenced by the sender's generation", async () => {
  const t = setup(async () => {});
  await mk(t, "alice");
  await mk(t, "bob", "bob", "alice");
  const r = await handle(t.daemon, {
    method: "POST",
    url: "/v1/peers/bob/send",
    token: t.daemon.agentToken("alice"),
    body: { body: "hello", generation: 0, idempotencyKey: "m1" },
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { kind: "message", from: "alice", body: "hello" });
  assert.deepEqual(await t.daemon.inbox("bob", {}), [{ kind: "message", from: "alice", body: "hello", id: "alice:bob:m1" }]);
  // The caller supplies the generation; the key is sender- and recipient-scoped.
  const call = t.fakes.calls.find((c) => c.port === "Mailbox" && c.method === "send" && c.args[0] === "bob")!;
  assert.equal(call.args[3], 0); // alice's generation, from the body
  assert.equal(call.args[2], "alice:bob:m1"); // recipient-scoped idempotency key
  // a stranger is not addressable: 404 without revealing the peer exists
  await mk(t, "carol");
  const stranger = await handle(t.daemon, {
    method: "POST",
    url: "/v1/peers/carol/send",
    token: t.daemon.agentToken("alice"),
    body: { body: "x", generation: 0, idempotencyKey: "m2" },
  });
  assert.equal(stranger.status, 404);
  // an unknown peer id is a clear error, not a silent no-op
  const nf = await handle(t.daemon, {
    method: "POST",
    url: "/v1/peers/ghost/send",
    token: t.daemon.agentToken("alice"),
    body: { body: "x", generation: 0, idempotencyKey: "m3" },
  });
  assert.equal(nf.status, 404);
  assert.match((nf.body as { error: string }).error, /no such peer: ghost/);
});

test("send rejects a stale sender generation raised by a concurrent resume", async () => {
  const t = setup(async () => {});
  await mk(t, "alice");
  await mk(t, "bob", "bob", "alice");
  const raw = t.fakes.hooks.raw;
  const base = raw.mailbox;
  // Simulate the resume-elsewhere race: between the daemon reading alice's generation and delivering,
  // alice resumes and her generation bumps, so the message must be fenced off by the mailbox.
  const racing: Mailbox = {
    send: async (to, signal, key, senderGeneration) => {
      await raw.registry.bumpGeneration("alice", "h2", "race");
      return base.send(to, signal, key, senderGeneration);
    },
    receive: (agent, key, o) => base.receive(agent, key, o),
    peek: (agent) => base.peek(agent),
    ack: (agent, ids, key) => base.ack(agent, ids, key),
  };
  const d = new Daemon({ ...t.daemon.deps, mailbox: racing });
  const r = await handle(d, {
    method: "POST",
    url: "/v1/peers/bob/send",
    token: d.agentToken("alice"),
    body: { body: "hi", generation: 0, idempotencyKey: "m" },
  });
  assert.equal(r.status, 409);
  assert.match((r.body as { error: string }).error, /stale generation for alice/);
  assert.equal((await raw.mailbox.peek("bob")).length, 0);
});

test("send requires a generation and rejects a missing or non-integer one", async () => {
  const t = setup(async () => {});
  await mk(t, "alice");
  await mk(t, "bob", "bob", "alice");
  const call = (body: unknown) => handle(t.daemon, { method: "POST", url: "/v1/peers/bob/send", token: t.daemon.agentToken("alice"), body });
  assert.equal((await call({ body: "hi", idempotencyKey: "m" })).status, 400);
  assert.equal((await call({ body: "hi", generation: 1.5, idempotencyKey: "m" })).status, 400);
  assert.equal((await call({ body: "hi", generation: -1, idempotencyKey: "m" })).status, 400);
  assert.equal((await call({ body: "hi", generation: 0, idempotencyKey: "m" })).status, 201);
});

test("two senders using the same key do not collide (keys are sender-scoped)", async () => {
  const t = setup(async () => {});
  await mk(t, "carol");
  await mk(t, "alice", "alice", "carol");
  await mk(t, "bob", "bob", "carol");
  const send = (from: string) =>
    handle(t.daemon, {
      method: "POST",
      url: "/v1/peers/carol/send",
      token: t.daemon.agentToken(from),
      body: { body: "hi", generation: 0, idempotencyKey: "same" },
    });
  assert.equal((await send("alice")).status, 201);
  assert.equal((await send("bob")).status, 201);
  assert.equal((await t.daemon.inbox("carol", {})).length, 2);
});

test("the same body to two peers is delivered to both (recipient is in the key)", async () => {
  const t = setup(async () => {});
  await mk(t, "alice");
  await mk(t, "bob", "bob", "alice");
  await mk(t, "carol", "carol", "alice");
  const send = (to: string) =>
    handle(t.daemon, {
      method: "POST",
      url: `/v1/peers/${to}/send`,
      token: t.daemon.agentToken("alice"),
      body: { body: "same body", generation: 0, idempotencyKey: "dup" },
    });
  assert.equal((await send("bob")).status, 201);
  assert.equal((await send("carol")).status, 201);
  assert.deepEqual(await t.daemon.inbox("bob", {}), [{ kind: "message", from: "alice", body: "same body", id: "alice:bob:dup" }]);
  assert.deepEqual(await t.daemon.inbox("carol", {}), [{ kind: "message", from: "alice", body: "same body", id: "alice:carol:dup" }]);
});

test("agent-scoped routes require the agent to be running", async () => {
  const t = setup(async () => {});
  await mk(t, "alice");
  await mk(t, "bob", "bob", "alice");
  await t.daemon.deps.registry.transition("bob", 0, "exited", { exit: "failed", idempotencyKey: "bob-exit" });
  const tok = t.daemon.agentToken("bob");
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/agents/self/inbox", token: tok })).status, 409);
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/agents/self/budget", token: tok })).status, 409);
  assert.equal(
    (await handle(t.daemon, { method: "POST", url: "/v1/agents/self/ask", token: tok, body: { question: "q?", generation: 0, idempotencyKey: "k" } })).status,
    409,
  );
  assert.equal(
    (await handle(t.daemon, { method: "POST", url: "/v1/peers/bob/send", token: tok, body: { body: "x", generation: 0, idempotencyKey: "m" } })).status,
    409,
  );
});

test("inbox ack removes signals by id (order-free), own agent only, keyed-idempotent; GET only peeks", async () => {
  const t = setup(async () => {});
  await mk(t, "alice");
  await mk(t, "bob");
  const s1 = { kind: "human_message", from: { channel: "x", id: "u" }, body: "one" } as never;
  const s2 = { kind: "human_message", from: { channel: "x", id: "u" }, body: "two" } as never;
  await t.daemon.deps.mailbox.send("alice", s1, "a1");
  await t.daemon.deps.mailbox.send("alice", s2, "a2");
  const tok = t.daemon.agentToken("alice");
  const ack = (token: string, url: string, ids: unknown[], idempotencyKey = "k1") =>
    handle(t.daemon, { method: "POST", url, token, body: { ids, idempotencyKey } });
  // authz: other agent, operator, anonymous
  assert.equal((await ack(t.daemon.agentToken("bob"), "/v1/agents/alice/inbox/ack", ["a1"])).status, 403);
  assert.equal((await ack(op, "/v1/agents/alice/inbox/ack", ["a1"])).status, 403);
  assert.equal((await handle(t.daemon, { method: "POST", url: "/v1/agents/self/inbox/ack", body: { ids: ["a1"], idempotencyKey: "k" } })).status, 401);
  assert.equal(
    (await handle(t.daemon, { method: "POST", url: "/v1/agents/self/inbox/ack", token: tok, body: { signals: [], idempotencyKey: "k" } })).status,
    400,
  );
  // GET peeks: every read returns the same signals, each with its id
  const get = async () => (await handle(t.daemon, { method: "GET", url: "/v1/agents/self/inbox", token: tok })).body;
  assert.deepEqual(await get(), [
    { ...(s1 as object), id: "a1" },
    { ...(s2 as object), id: "a2" },
  ]);
  assert.deepEqual(await get(), [
    { ...(s1 as object), id: "a1" },
    { ...(s2 as object), id: "a2" },
  ]);
  // acking a non-head id removes only it; an unknown id is a no-op; a replayed key is a no-op
  assert.deepEqual((await ack(tok, "/v1/agents/self/inbox/ack", ["a2", "nope"])).body, { acked: 1 });
  assert.deepEqual((await ack(tok, "/v1/agents/self/inbox/ack", ["a2", "nope"])).body, { acked: 1 });
  assert.deepEqual(await t.daemon.inbox("alice", {}), [{ ...(s1 as object), id: "a1" }]);
  assert.deepEqual((await ack(tok, "/v1/agents/self/inbox/ack", ["a2"], "k2")).body, { acked: 0 });
  assert.deepEqual((await ack(tok, "/v1/agents/self/inbox/ack", ["a1"], "k3")).body, { acked: 1 });
  assert.deepEqual(await t.daemon.inbox("alice", {}), []);
  // stale generation token is fenced
  await t.daemon.deps.registry.transition("alice", 0, "exited", { exit: "failed", idempotencyKey: "alice-exit" });
  assert.equal((await ack(tok, "/v1/agents/self/inbox/ack", ["a2"], "k4")).status, 409);
});

// A message to a reaped agent is a 409 naming the cause and the action, on every delivery path; a live or merely exited recipient is unchanged.
const settle = async (t: ReturnType<typeof setup>, id: string, state: "running" | "exited" | "failed" | "cancelled" | "reaped") => {
  const reg = t.daemon.deps.registry;
  if (state === "running") return;
  const exit = state === "exited" ? "succeeded" : state === "reaped" ? "succeeded" : state;
  const r = await reg.transition(id, (await reg.get(id))!.generation, "exited", { exit, idempotencyKey: `x-${id}` });
  if (state === "reaped") await reg.transition(id, r.generation, "reaped", { idempotencyKey: `r-${id}` });
};
const paths = (t: ReturnType<typeof setup>) => [
  {
    name: "peers/send",
    call: () =>
      handle(t.daemon, {
        method: "POST",
        url: "/v1/peers/bob/send",
        token: t.daemon.agentToken("alice"),
        body: { body: "hi", generation: 0, idempotencyKey: "pm" },
      }),
  },
  {
    name: "operator message",
    call: () => handle(t.daemon, { method: "POST", url: "/v1/agents/bob/message", token: op, body: { body: "hi", idempotencyKey: "om" } }),
  },
];
for (const state of ["reaped", "exited", "failed", "cancelled", "running"] as const) {
  test(`a message to a ${state} agent is ${state === "reaped" ? "refused 409 with cause and action" : "accepted as before"}, on every path`, async () => {
    const t = setup(async () => {});
    await mk(t, "alice");
    await mk(t, "bob", "bob", "alice");
    await settle(t, "bob", state);
    for (const p of paths(t)) {
      const r = await p.call();
      if (state === "reaped") {
        assert.equal(r.status, 409, `${p.name}: ${JSON.stringify(r.body)}`);
        assert.match((r.body as { error: string }).error, /agent bob is reaped; it cannot receive messages/, p.name);
        assert.deepEqual(await t.daemon.inbox("bob", {}), [], `${p.name}: nothing queued`);
      } else assert.equal(r.status, 201, `${p.name}: ${JSON.stringify(r.body)}`);
    }
  });
}

test("a chat-channel signal to a reaped agent is rejected with the cause rather than throwing; a live agent still gets it", async () => {
  const t = setup(async () => {});
  await mk(t, "alice");
  await mk(t, "bob", "bob", "alice");
  const actor = { channel: "cli", sender: "operator" };
  const live = await t.daemon.performAction(actor, { kind: "signal", to: "bob", body: "hi" }, "c1");
  assert.equal(live.kind, "ok", JSON.stringify(live));
  await settle(t, "bob", "reaped");
  const out = await t.daemon.performAction(actor, { kind: "signal", to: "bob", body: "again" }, "c2");
  assert.equal(out.kind, "rejected");
  assert.match((out as { reason: string }).reason, /agent bob is reaped; it cannot receive messages/);
});
