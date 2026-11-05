// Named workflow launch (TODO(flow-launch)): the one launch action through the action core, the chat gates (default deny, sender
// allowlist, messagingAllowSpawn, approval) and the operator route. The host callback is a stub; no model, network or sandbox.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { handle } from "./api.ts";
import { issueToken } from "./auth.ts";
import { LifecycleError } from "./lifecycle.ts";
import { SECRET, setup } from "./test-setup.ts";

type Req = { workflow: string; input: unknown; idempotencyKey: string; budgetMicros?: number; deadlineMs?: number };
const host = issueToken(SECRET, { scope: "host", channel: "discord" });
const CHAT = { messagingChannels: ["discord"], messagingAllowSpawn: true };

// A stub host callback with the host's keyed contract: an exact replay (same key, workflow and input) returns the same record,
// a different workflow or input under a used key is a 409 conflict. Records each call; the action core reads only `id`.
function stub(impl?: (req: Req) => Promise<void> | void) {
  const calls: { requester: string; req: Req }[] = [];
  const byKey = new Map<string, { id: string; workflow: string; input: string }>();
  const launchWorkflow = async (requester: string, req: Req) => {
    calls.push({ requester, req });
    await impl?.(req);
    const input = JSON.stringify(req.input);
    const prior = byKey.get(req.idempotencyKey);
    if (prior) {
      if (prior.workflow !== req.workflow || prior.input !== input) throw new LifecycleError(409, "idempotency key reused for a different launch");
      return { id: prior.id } as unknown as AgentRecord;
    }
    const id = `wf-${byKey.size + 1}`;
    byKey.set(req.idempotencyKey, { id, workflow: req.workflow, input });
    return { id } as unknown as AgentRecord;
  };
  return { calls, launchWorkflow: launchWorkflow as never };
}

const chat = (over: Record<string, unknown>) => ({
  channel: "discord",
  sender: { channel: "discord", sender: "alice" },
  body: "",
  intent: "launch" as const,
  workflow: "hn/digest",
  idempotencyKey: "m1",
  ...over,
});

test("chat launch is default-deny: no allowChatWorkflow means no callback", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), { ...CHAT, launchWorkflow: s.launchWorkflow });
  const r = await t.daemon.receiveMessage(chat({}));
  assert.equal(r.kind, "rejected");
  assert.match((r as { reason: string }).reason, /not launchable from discord/);
  assert.equal(s.calls.length, 0);
});

test("chat launch is refused when the sender is not authorized, and the route is launch", async () => {
  const s = stub();
  const routes: string[] = [];
  const t = setup(async (c) => void (await c.stopped), {
    ...CHAT,
    launchWorkflow: s.launchWorkflow,
    allowChatWorkflow: () => true,
    authorizeInbound: (_msg, route) => {
      routes.push(route);
      return false;
    },
  });
  const r = await t.daemon.receiveMessage(chat({}));
  assert.equal(r.kind, "rejected");
  assert.match((r as { reason: string }).reason, /not authorized to launch/);
  assert.deepEqual(routes, ["launch"]);
  assert.equal(s.calls.length, 0);
});

test("chat launch needs messagingAllowSpawn, like chat spawn", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), {
    messagingChannels: ["discord"],
    launchWorkflow: s.launchWorkflow,
    allowChatWorkflow: () => true,
  });
  const r = await t.daemon.receiveMessage(chat({}));
  assert.equal(r.kind, "rejected");
  assert.equal((r as { reason: string }).reason, "spawn intent is not allowed");
  assert.equal(s.calls.length, 0);
});

test("an allowed chat launch calls back once as root with the action key, and a replay returns the same receipt", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), { ...CHAT, launchWorkflow: s.launchWorkflow, allowChatWorkflow: () => true });
  const root = await t.daemon.root();
  const r1 = await t.daemon.receiveMessage(chat({ body: "run it" }));
  assert.deepEqual(r1, { kind: "launched", agent: "wf-1" });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.requester, root.id);
  assert.equal(s.calls[0]!.req.workflow, "hn/digest");
  assert.deepEqual(s.calls[0]!.req.input, {}, "an absent chat input defaults to {}");
  assert.equal(s.calls[0]!.req.idempotencyKey, "msg:discord:m1");
  // A launch is never replayed from the receipt cache: the exact retry reaches the host, which returns the same record.
  const r2 = await t.daemon.receiveMessage(chat({ body: "run it" }));
  assert.deepEqual(r2, r1);
  assert.equal(s.calls.length, 2, "the exact retry calls the host again, and the host is the replay");
  assert.equal(s.calls[1]!.req.idempotencyKey, "msg:discord:m1");
});

test("the chat allowlist receives the channel and the sender, and only allowed workflows launch", async () => {
  const s = stub();
  const seen: unknown[] = [];
  const t = setup(async (c) => void (await c.stopped), {
    ...CHAT,
    launchWorkflow: s.launchWorkflow,
    allowChatWorkflow: (actor, workflow) => {
      seen.push([actor.channel, actor.sender.sender, workflow]);
      return workflow === "hn/digest";
    },
  });
  assert.equal((await t.daemon.receiveMessage(chat({ workflow: "x/other", idempotencyKey: "m2" }))).kind, "rejected");
  assert.equal((await t.daemon.receiveMessage(chat({}))).kind, "launched");
  assert.deepEqual(seen, [
    ["discord", "alice", "x/other"],
    ["discord", "alice", "hn/digest"],
  ]);
  assert.equal(s.calls.length, 1);
});

test("a chat launch waits on a durable approval: pending is retryable, approval then launches once", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), {
    ...CHAT,
    launchWorkflow: s.launchWorkflow,
    allowChatWorkflow: () => true,
    chatApproval: () => true,
    approvalWaitMs: 5,
  });
  t.daemon.deps.approvals = t.fakes.approvals;
  const pending = await t.daemon.receiveMessage(chat({ idempotencyKey: "m3" }));
  assert.equal(pending.kind, "rejected");
  assert.match((pending as { reason: string }).reason, /approval pending/);
  assert.equal(s.calls.length, 0, "no launch before the approval");
  const [ap] = await t.fakes.approvals.list({ state: "pending" });
  assert.ok(ap, "a chat_launch approval is pending");
  await t.fakes.approvals.decide(ap.id, { who: "cli:operator", rank: "operator", decision: "approve", why: "" }, "d1");
  const after = await t.daemon.receiveMessage(chat({ idempotencyKey: "m3" }));
  assert.deepEqual(after, { kind: "launched", agent: "wf-1" });
  assert.equal(s.calls.length, 1);
});

test("a retry after the decision launches even when the approval wait bound is already spent", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), {
    ...CHAT,
    launchWorkflow: s.launchWorkflow,
    allowChatWorkflow: () => true,
    chatApproval: () => true,
    approvalWaitMs: 0,
  });
  t.daemon.deps.approvals = t.fakes.approvals;
  const pending = await t.daemon.receiveMessage(chat({ idempotencyKey: "m3b" }));
  assert.match((pending as { reason: string }).reason, /approval pending/);
  const [ap] = await t.fakes.approvals.list({ state: "pending" });
  assert.ok(ap, "a chat_launch approval is pending");
  await t.fakes.approvals.decide(ap.id, { who: "cli:operator", rank: "operator", decision: "approve", why: "" }, "d1");
  assert.deepEqual(await t.daemon.receiveMessage(chat({ idempotencyKey: "m3b" })), { kind: "launched", agent: "wf-1" });
  assert.equal(s.calls.length, 1);
});

test("the chat launch input is validated before any callback: name, JSON shape and size", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), { ...CHAT, launchWorkflow: s.launchWorkflow, allowChatWorkflow: () => true });
  for (const [workflow, input, idempotencyKey] of [
    ["Bad/Name", {}, "v1"],
    ["noslash", {}, "v2"],
    ["hn/digest", { x: Number.NaN }, "v3"],
    ["hn/digest", { big: "x".repeat(70 * 1024) }, "v4"],
  ] as const) {
    const r = await t.daemon.receiveMessage(chat({ workflow, input, idempotencyKey }));
    assert.equal(r.kind, "rejected", `${workflow} rejected`);
  }
  assert.equal(s.calls.length, 0);
});

test("the launch input cap counts UTF-8 bytes: multibyte input over 64 KiB is 400 before any callback", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), { ...CHAT, launchWorkflow: s.launchWorkflow, allowChatWorkflow: () => true });
  // 30k CJK chars: 30720 UTF-16 units (under 64 KiB) but 92160 UTF-8 bytes (over 64 KiB).
  const r = await t.daemon.performAction(
    { channel: "discord", sender: "alice" },
    { kind: "launch", workflow: "hn/digest", input: { big: "中".repeat(30 * 1024) } },
    "mb1",
  );
  assert.deepEqual(r, { kind: "rejected", reason: "input must be JSON no larger than 65536 bytes", status: 400 });
  assert.equal(s.calls.length, 0);
});

test("a chat launch cannot use operator-only deadline zero", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), { ...CHAT, launchWorkflow: s.launchWorkflow, allowChatWorkflow: () => true });
  const r = await t.daemon.performAction({ channel: "discord", sender: "alice" }, { kind: "launch", workflow: "hn/digest", input: {}, deadlineMs: 0 }, "dl1");
  assert.deepEqual(r, { kind: "rejected", reason: "an unlimited deadline requires operator scope", status: 403 });
  assert.equal(s.calls.length, 0);
});

test("a missing launch callback is 503 (non-raw rejected, raw error)", async () => {
  const t = setup(async (c) => void (await c.stopped), { ...CHAT, allowChatWorkflow: () => true });
  const r = await t.daemon.performAction({ channel: "discord", sender: "alice" }, { kind: "launch", workflow: "hn/digest", input: {} }, "n1");
  assert.deepEqual(r, { kind: "rejected", reason: "workflow launch is not configured", status: 503 });
  const raw = await t.operator("POST", "/v1/workflows/launch", { workflow: "hn/digest", idempotencyKey: "n2" });
  assert.equal(raw.status, 503);
});

test("callback refusals keep their status and message; unknown errors are generic", async () => {
  const busy = stub(() => {
    throw new LifecycleError(409, "workflow busy: hn/digest");
  });
  const t = setup(async (c) => void (await c.stopped), { ...CHAT, launchWorkflow: busy.launchWorkflow, allowChatWorkflow: () => true });
  const r = await t.daemon.performAction({ channel: "discord", sender: "alice" }, { kind: "launch", workflow: "hn/digest", input: {} }, "e1");
  assert.deepEqual(r, { kind: "rejected", reason: "workflow busy: hn/digest", status: 409 });

  const leaky = stub(() => {
    throw new Error("token=sk-secret at /home/x");
  });
  const t2 = setup(async (c) => void (await c.stopped), { ...CHAT, launchWorkflow: leaky.launchWorkflow, allowChatWorkflow: () => true });
  const r2 = await t2.daemon.performAction({ channel: "discord", sender: "alice" }, { kind: "launch", workflow: "hn/digest", input: {} }, "e2");
  assert.deepEqual(r2, { kind: "rejected", reason: "workflow launch failed", status: 500 });
});

test("operator POST /v1/workflows/launch: 201 receipt, root requester, key and defaults", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), { launchWorkflow: s.launchWorkflow });
  const root = await t.daemon.root();
  const res = await t.operator("POST", "/v1/workflows/launch", { workflow: "hn/digest", idempotencyKey: "o1", budgetMicros: 5000, deadlineMs: 0 });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { kind: "launched", agent: "wf-1" });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.requester, root.id);
  assert.equal(s.calls[0]!.req.idempotencyKey, "o1");
  assert.deepEqual(s.calls[0]!.req.input, {}, "an absent input defaults to {}");
  assert.equal(s.calls[0]!.req.budgetMicros, 5000);
  assert.equal(s.calls[0]!.req.deadlineMs, 0, "operator may request an unlimited deadline");
});

test("operator launch errors: host status and message pass through, unknown errors are generic, validation is 400", async () => {
  const notFound = stub(() => {
    throw new LifecycleError(404, "no such workflow: hn/nope");
  });
  const t = setup(async (c) => void (await c.stopped), { launchWorkflow: notFound.launchWorkflow });
  const r = await t.operator("POST", "/v1/workflows/launch", { workflow: "hn/nope", idempotencyKey: "o2" });
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: "no such workflow: hn/nope" });

  const boom = stub(() => {
    throw new Error("EACCES /private/key");
  });
  const t2 = setup(async (c) => void (await c.stopped), { launchWorkflow: boom.launchWorkflow });
  const r2 = await t2.operator("POST", "/v1/workflows/launch", { workflow: "hn/digest", idempotencyKey: "o3" });
  assert.equal(r2.status, 500);
  assert.deepEqual(r2.body, { error: "workflow launch failed" });

  const bad = await t.operator("POST", "/v1/workflows/launch", { workflow: "Bad", idempotencyKey: "o4" });
  assert.equal(bad.status, 400);
  assert.equal((await t.operator("POST", "/v1/workflows/launch", { idempotencyKey: "o5" })).status, 400, "workflow is required");
  assert.equal((await t.operator("POST", "/v1/workflows/launch", { workflow: "hn/digest", input: [], budgetMicros: 0, idempotencyKey: "o6" })).status, 400);
  assert.equal(notFound.calls.length, 1, "validation failures never reach the callback");
});

test("operator launch is operator scope only: a host token is 403, and no workflow route is 404 for other methods", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), { launchWorkflow: s.launchWorkflow });
  const body = { workflow: "hn/digest", idempotencyKey: "o7" };
  const viaHost = await handle(t.daemon, { method: "POST", url: "/v1/workflows/launch", body, token: host });
  assert.equal(viaHost.status, 403);
  assert.equal((await t.operator("GET", "/v1/workflows/launch")).status, 404);
  assert.equal(s.calls.length, 0);
});

test("host POST /v1/messages intent launch: channel token, input default, and the receipt", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), { ...CHAT, launchWorkflow: s.launchWorkflow, allowChatWorkflow: () => true });
  const sent = await handle(t.daemon, {
    method: "POST",
    url: "/v1/messages",
    body: { channel: "discord", sender: "alice", intent: "launch", workflow: "hn/digest", idempotencyKey: "h1" },
    token: host,
  });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.body, { kind: "launched", agent: "wf-1" });
  assert.deepEqual(s.calls[0]!.req.input, {});

  const noWorkflow = await handle(t.daemon, {
    method: "POST",
    url: "/v1/messages",
    body: { channel: "discord", sender: "alice", intent: "launch", idempotencyKey: "h2" },
    token: host,
  });
  assert.equal(noWorkflow.status, 400);

  const withTo = await handle(t.daemon, {
    method: "POST",
    url: "/v1/messages",
    body: { channel: "discord", sender: "alice", intent: "launch", workflow: "hn/digest", to: "x", idempotencyKey: "h3" },
    token: host,
  });
  assert.equal(withTo.status, 201);
  assert.equal((withTo.body as { kind: string }).kind, "rejected");
  assert.equal(s.calls.length, 1);
});

test("a launch key reused with a different workflow or input is a 409, never the cached launched receipt", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), { ...CHAT, launchWorkflow: s.launchWorkflow, allowChatWorkflow: () => true });
  const actor = { channel: "discord", sender: "alice" } as const;
  const first = await t.daemon.performAction(actor, { kind: "launch", workflow: "hn/digest", input: { n: 1 } }, "c1");
  assert.deepEqual(first.kind === "ok" && first.receipt, { kind: "launched", agent: "wf-1" });
  const diffInput = await t.daemon.performAction(actor, { kind: "launch", workflow: "hn/digest", input: { n: 2 } }, "c1");
  assert.deepEqual(diffInput, { kind: "rejected", reason: "idempotency key reused for a different launch", status: 409 });
  const diffWorkflow = await t.daemon.performAction(actor, { kind: "launch", workflow: "hn/other", input: { n: 1 } }, "c1");
  assert.deepEqual(diffWorkflow, { kind: "rejected", reason: "idempotency key reused for a different launch", status: 409 });
  assert.equal(s.calls.length, 3, "the host saw both conflicting attempts and decided");
});

test("an exact launch retry calls the host again and returns the same agent id", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), { ...CHAT, launchWorkflow: s.launchWorkflow, allowChatWorkflow: () => true });
  const actor = { channel: "discord", sender: "alice" } as const;
  const first = await t.daemon.performAction(actor, { kind: "launch", workflow: "hn/digest", input: { n: 1 } }, "x1");
  const again = await t.daemon.performAction(actor, { kind: "launch", workflow: "hn/digest", input: { n: 1 } }, "x1");
  assert.deepEqual(first.kind === "ok" && first.receipt, { kind: "launched", agent: "wf-1" });
  assert.deepEqual(again, first);
  assert.equal(s.calls.length, 2);
  assert.equal(new Set(s.calls.map((c) => c.req.idempotencyKey)).size, 1);
});

test("a sender denied on replay is denied even with a key that launched for someone else", async () => {
  const s = stub();
  const t = setup(async (c) => void (await c.stopped), {
    ...CHAT,
    launchWorkflow: s.launchWorkflow,
    allowChatWorkflow: () => true,
    authorizeInbound: (msg) => msg.sender.sender === "alice",
  });
  const ok = await t.daemon.performAction({ channel: "discord", sender: "alice" }, { kind: "launch", workflow: "hn/digest", input: {} }, "s1");
  assert.deepEqual(ok.kind === "ok" && ok.receipt, { kind: "launched", agent: "wf-1" });
  const denied = await t.daemon.performAction({ channel: "discord", sender: "bob" }, { kind: "launch", workflow: "hn/digest", input: {} }, "s1");
  assert.deepEqual(denied, { kind: "rejected", reason: "sender discord:bob is not authorized to launch", status: 403 });
  assert.equal(s.calls.length, 1, "the denied sender never reaches the host");
});
