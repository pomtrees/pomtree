import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSAGE_FAILED_SUBJECT_MAX, MESSAGING_API_VERSION } from "@pomtree/core";
import type { InboundMessage, MessageFailedBody, MessageReceipt, OutboxEntry } from "@pomtree/core";
import { FakeOrigin } from "./fake-origin.ts";

// The adapter-agnostic messaging wire contract: what any adapter (Discord, stdio, a third party's) must do against pomtreed's
// host-scope routes. core types the bodies (packages/core/src/messaging.ts); this suite pins the behavior around them. It
// imports only @pomtree/core, so it cannot start pomtreed itself: the caller supplies a `MessagingWireDaemon` that starts
// the REAL daemon (packages/e2e does), and an adapter supplies a `MessagingWireClient` over its own HTTP code.

export interface MessagingWireClient {
  outbox(from: number): Promise<OutboxEntry[]>; // GET /v1/messages?channel=&from=
  postMessage(body: InboundMessage): Promise<MessageReceipt<string, string, unknown>>; // POST /v1/messages: 201 -> receipt, any other status throws
  messageFailed(body: MessageFailedBody): Promise<void>; // POST /v1/messages/failed: 201, else throws
  hostRead?(path: string, sender: string): Promise<{ status: number; body: unknown }>; // GET /v1/host<path>?sender=; optional
}

export interface MessagingWireAdapter {
  name: string;
  channel: string;
  connect(baseUrl: string, token: string): MessagingWireClient;
}

export interface MessagingWireFixture {
  baseUrl: string;
  token(kind: "host" | "operator" | "agent" | "garbage", channel?: string): string;
  agent: string; // a running agent
  ask(question: string, idempotencyKey: string): Promise<string>; // opens an escalation, returns its id
  failedCount(): Promise<number>; // message_failed journal rows on the root
  close(): Promise<void>;
}

export interface MessagingWireDaemon {
  // Starts the real daemon with `channel` as messaging and escalation channel and `senders` ("channel:sender") as the allowlist.
  start(o: { channel: string; senders: readonly string[] }): Promise<MessagingWireFixture>;
  // pomtreed's boot-time allowlist check for these channels and senders: null = would start, string = the refusal message.
  bootError(o: { channels: readonly string[]; senders: readonly string[] }): string | null;
}

export type MessagingWireClauseId =
  | "version-handshake"
  | "host-token-scope"
  | "outbox-cursor"
  | "post-idempotent"
  | "sender-allowlist-boot"
  | "unknown-sender"
  | "outbox-redelivery"
  | "host-read";

// Core does not export the header name; pomtreed's api.ts and messaging-discord's client.ts each declare the same literal.
// TODO(seam-header-const): core should export MESSAGING_API_HEADER; current behavior: each side declares the literal
const MESSAGING_API_HEADER = "x-pomtree-messaging-api";

type Check = (adapter: MessagingWireAdapter, daemon: MessagingWireDaemon) => Promise<void>;
interface Clause {
  title: string;
  fix: string; // what an adapter author does when the clause fails
  check: Check;
}

const ALLOWED = "u1";
const UNKNOWN = "u2";

const inbound = (adapter: MessagingWireAdapter, sender: string, o: Partial<InboundMessage> & { idempotencyKey: string }): InboundMessage => ({
  channel: adapter.channel,
  sender: { channel: adapter.channel, sender, name: sender },
  body: "!cmd", // pomtreed rejects an empty body (launch and pass excepted)
  ...o,
});

async function withFixture(adapter: MessagingWireAdapter, daemon: MessagingWireDaemon, fn: (fx: MessagingWireFixture) => Promise<void>): Promise<void> {
  const fx = await daemon.start({ channel: adapter.channel, senders: [`${adapter.channel}:${ALLOWED}`] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

const hostClient = (adapter: MessagingWireAdapter, fx: MessagingWireFixture) => adapter.connect(fx.baseUrl, fx.token("host", adapter.channel));

// The adapter half of version-handshake, against a scripted origin that stands in for a pomtreed of another version.
export async function checkAdapterVersionHeader(adapter: MessagingWireAdapter): Promise<void> {
  const origin = await FakeOrigin.start();
  try {
    const answer = (headers: Record<string, string>) =>
      origin.route("127.0.0.1", "/v1/messages", { status: 200, headers: { "content-type": "application/json", ...headers }, body: "[]" });
    const client = adapter.connect(`http://127.0.0.1:${origin.port}`, "t");
    answer({ [MESSAGING_API_HEADER]: String(MESSAGING_API_VERSION) });
    assert.deepEqual(await client.outbox(0), [], "a 200 carrying the pinned version must be accepted");
    answer({ [MESSAGING_API_HEADER]: String(MESSAGING_API_VERSION + 1) });
    await assert.rejects(client.outbox(0), "a 200 carrying another messaging API version must be refused");
    answer({});
    await assert.rejects(client.outbox(0), "a 2xx with no messaging API header must be refused");
  } finally {
    await origin.close();
  }
}

// A refusal must reject AND carry its HTTP status in the error text, so a crash or a network error does not pass as a refusal.
async function mustReject(attempt: Promise<unknown>, status: RegExp, what: string): Promise<void> {
  try {
    await attempt;
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    assert.ok(status.test(text), `${what}: the error must name an HTTP status matching ${status}, got: ${text}`);
    return;
  }
  assert.fail(`${what}: it resolved`);
}

const CLAUSES: Record<MessagingWireClauseId, Clause> = {
  "version-handshake": {
    title: "every messaging response names the API version and the adapter refuses another one",
    fix: "compare the x-pomtree-messaging-api response header with the MESSAGING_API_VERSION you pin and refuse a mismatch on any status and a missing header on a 2xx",
    check: async (adapter, daemon) => {
      await withFixture(adapter, daemon, async (fx) => {
        const get = (token: string) => fetch(`${fx.baseUrl}/v1/messages?channel=${adapter.channel}&from=0`, { headers: { authorization: `Bearer ${token}` } });
        const ok = await get(fx.token("host", adapter.channel));
        assert.equal(ok.status, 200);
        assert.equal(ok.headers.get(MESSAGING_API_HEADER), String(MESSAGING_API_VERSION), "pomtreed names the version on a 200");
        const refused = await get(fx.token("host", "other")); // a host token for a channel pomtreed does not serve: a handler 403
        assert.equal(refused.status, 403);
        assert.equal(refused.headers.get(MESSAGING_API_HEADER), String(MESSAGING_API_VERSION), "pomtreed names the version on a handler error");
      });
      await checkAdapterVersionHeader(adapter);
    },
  },
  "host-token-scope": {
    title: "only the channel's host token works; other scopes, channels and garbage are refused, not parsed as success",
    fix: "throw on any status other than 200 (outbox) or 201 (post) instead of returning the error body, and send the token as an `authorization: Bearer` header",
    check: async (adapter, daemon) => {
      await withFixture(adapter, daemon, async (fx) => {
        const status = inbound(adapter, ALLOWED, { to: fx.agent, intent: "status", idempotencyKey: "scope-1" });
        for (const [what, token] of [
          ["operator", fx.token("operator")],
          ["agent", fx.token("agent")],
          ["garbage", fx.token("garbage")],
          ["another channel's host", fx.token("host", "other")],
        ] as const) {
          const c = adapter.connect(fx.baseUrl, token);
          await mustReject(c.outbox(0), /\b40[0-3]\b/, `outbox must reject a ${what} token`);
          await mustReject(c.postMessage(status), /\b40[0-3]\b/, `postMessage must reject a ${what} token`);
          const read = c.hostRead && (await c.hostRead("/agents", ALLOWED));
          if (read) assert.ok(read.status === 401 || read.status === 403, `hostRead with a ${what} token must be 401 or 403, got ${read.status}`);
          if (read && what === "garbage") assert.equal(read.status, 401, "a garbage token is unauthenticated (401)");
        }
        const good = hostClient(adapter, fx);
        assert.ok(Array.isArray(await good.outbox(0)), "the channel's host token reads the outbox");
        assert.equal((await good.postMessage(status)).kind, "status");
      });
    },
  },
  "outbox-cursor": {
    title: "the outbox lists an ask with its journal seq and honours the from cursor",
    fix: "send `channel` and `from=<cursor>` as query parameters and return the JSON array unchanged; the entry with seq >= from is returned, so advance your cursor to seq + 1",
    check: async (adapter, daemon) => {
      await withFixture(adapter, daemon, async (fx) => {
        const escalation = await fx.ask("ok?", "cursor-ask");
        const c = hostClient(adapter, fx);
        const ask = (await c.outbox(0)).find((e) => e.payload.replyTo === escalation);
        assert.ok(ask, `the ask ${escalation} is in the ${adapter.channel} outbox`);
        assert.equal(ask.payload.kind, "message_sent");
        assert.equal(ask.payload.channel, adapter.channel);
        assert.equal(typeof ask.seq, "number");
        assert.equal(typeof ask.ts, "number");
        assert.equal(typeof ask.agent, "string");
        assert.ok(
          (await c.outbox(ask.seq)).some((e) => e.seq === ask.seq),
          "from=seq still includes the entry",
        );
        assert.ok(!(await c.outbox(ask.seq + 1)).some((e) => e.seq === ask.seq), "from=seq+1 excludes the entry");
        assert.deepEqual(await c.outbox(ask.seq + 1000), [], "a cursor past the end is empty");
      });
    },
  },
  "post-idempotent": {
    title: "posts return typed receipts; a replay with the same key returns the same receipt; refusals are rejected receipts",
    fix: "send the caller's idempotencyKey unchanged on every attempt, return the receipt body of a 201 as is, and treat a `rejected` receipt as a result, not an exception",
    check: async (adapter, daemon) => {
      await withFixture(adapter, daemon, async (fx) => {
        const c = hostClient(adapter, fx);
        const escalation = await fx.ask("ok?", "idem-ask");
        assert.deepEqual(await c.postMessage(inbound(adapter, ALLOWED, { to: fx.agent, intent: "status", idempotencyKey: "s1" })), {
          kind: "status",
          agent: fx.agent,
          state: "running",
        });
        const answer = inbound(adapter, ALLOWED, { body: "yes", replyTo: escalation, idempotencyKey: "a1" });
        const first = await c.postMessage(answer);
        assert.deepEqual(first, { kind: "answered", escalation });
        assert.deepEqual(await c.postMessage(answer), first, "the same body and key replays the first receipt"); // does not discriminate: pomtreed's answer state replays it too
        // This one discriminates. pomtreed remembers a receipt by key alone, so a retry that changed anything but the key still gets the first receipt: an
        // adapter that issues a fresh key per attempt gets "already answered" here instead.
        assert.deepEqual(await c.postMessage({ ...answer, body: "retry" }), first, "a replayed key returns the remembered receipt");
        const late = await c.postMessage(inbound(adapter, ALLOWED, { body: "no", replyTo: escalation, idempotencyKey: "a2" }));
        assert.equal(late.kind, "rejected", "a different key after the escalation was answered is rejected");
        const spawn = await c.postMessage(inbound(adapter, ALLOWED, { body: "go", intent: "spawn", idempotencyKey: "sp1" }));
        assert.equal(spawn.kind, "rejected", "spawn is off by default: a rejected receipt, not an HTTP error");
      });
    },
  },
  "sender-allowlist-boot": {
    title: "pomtreed's boot check refuses a chat channel without a well-formed sender allowlist (daemon wiring; the adapter cannot affect it)",
    fix: "document POMTREED_MESSAGING_SENDERS=<channel>:<sender> for your adapter's operators; the check is pomtreed's, so a failure here is in the test daemon's wiring (it must use pomtreed's messagingSendersError)",
    check: async (adapter, daemon) => {
      const channels = [adapter.channel];
      const empty = daemon.bootError({ channels, senders: [] });
      assert.equal(typeof empty, "string", "an empty allowlist must refuse to boot");
      assert.ok(empty?.includes("POMTREED_MESSAGING_SENDERS") && empty.includes(adapter.channel), `the refusal names the variable and the channel: ${empty}`);
      assert.equal(daemon.bootError({ channels, senders: [`${adapter.channel}:${ALLOWED}`] }), null, "a channel:sender entry boots");
      assert.equal(typeof daemon.bootError({ channels, senders: ["nocolon"] }), "string", "an entry without channel: must refuse to boot");
    },
  },
  "unknown-sender": {
    title: "an inbound message from a sender off the allowlist is rejected and does not poison the escalation",
    fix: "pass the real chat sender id through as sender.sender (never a fixed or mapped identity) so pomtreed can apply its allowlist, and treat the rejected receipt as the answer",
    check: async (adapter, daemon) => {
      await withFixture(adapter, daemon, async (fx) => {
        const c = hostClient(adapter, fx);
        const escalation = await fx.ask("ok?", "unk-ask");
        const intruder = inbound(adapter, UNKNOWN, { body: "yes", replyTo: escalation, idempotencyKey: "u2-1" });
        const rejected = await c.postMessage(intruder);
        assert.equal(rejected.kind, "rejected", "a sender off the allowlist must get a rejected receipt");
        assert.ok(
          rejected.kind === "rejected" && rejected.reason.includes(`${adapter.channel}:${UNKNOWN}`),
          `the reason names the sender: ${JSON.stringify(rejected)}`,
        );
        assert.equal((await c.postMessage(intruder)).kind, "rejected", "the rejection is not cached as a success");
        assert.deepEqual(await c.postMessage(inbound(adapter, ALLOWED, { body: "yes", replyTo: escalation, idempotencyKey: "u1-1" })), {
          kind: "answered",
          escalation,
        });
      });
    },
  },
  "outbox-redelivery": {
    title: "re-polling a cursor returns the same entries and a dead-letter report is journaled once per key",
    fix: "return the outbox entries unchanged for the cursor you send; reuse the same idempotencyKey when you re-send a dead-letter report, send a purpose of ask, alert, status or report, and keep subject and reason within the MESSAGE_FAILED_* limits",
    check: async (adapter, daemon) => {
      await withFixture(adapter, daemon, async (fx) => {
        const c = hostClient(adapter, fx);
        await fx.ask("ok?", "redeliver-ask");
        const a = await c.outbox(0);
        assert.ok(a.length > 0, "the ask is in the outbox");
        assert.deepEqual(await c.outbox(0), a, "polling the same cursor again returns the same entries");
        const before = await fx.failedCount();
        const failed: MessageFailedBody = { channel: adapter.channel, purpose: "alert", subject: "s", reason: "dead", attempts: 3, idempotencyKey: "f1" };
        await c.messageFailed(failed);
        await c.messageFailed(failed);
        assert.equal((await fx.failedCount()) - before, 1, "the same key is journaled once");
        await mustReject(
          c.messageFailed({ ...failed, purpose: "bogus" as never, idempotencyKey: "f2" }),
          /\b400\b/,
          "an unknown purpose must be refused with 400",
        );
        await mustReject(
          c.messageFailed({ ...failed, subject: "x".repeat(MESSAGE_FAILED_SUBJECT_MAX + 1), idempotencyKey: "f3" }),
          /\b400\b/,
          "a subject over MESSAGE_FAILED_SUBJECT_MAX must be refused with 400",
        );
      });
    },
  },
  "host-read": {
    title: "host reads take the chat sender and return pomtreed's agent projection",
    fix: "send `sender=<chat sender id>` as a query parameter and return {status, body} as pomtreed sent them, for any status",
    check: async (adapter, daemon) => {
      await withFixture(adapter, daemon, async (fx) => {
        const hostRead = hostClient(adapter, fx).hostRead;
        assert.ok(hostRead, "the client has no hostRead");
        const agents = await hostRead("/agents", ALLOWED);
        assert.equal(agents.status, 200, "a hostRead with a sender is served");
        assert.ok(
          (agents.body as { agents: { id: string }[] }).agents.some((a) => a.id === fx.agent),
          "the running agent is listed",
        );
        assert.equal((await hostRead("/agents", "")).status, 400, "a read without a sender is refused");
        assert.equal((await hostRead("/agents/nope/budget", ALLOWED)).status, 404, "an unknown agent is a 404");
      });
    },
  },
};

export const MESSAGING_WIRE_CLAUSES: readonly { id: MessagingWireClauseId; title: string; fix: string }[] = (
  Object.keys(CLAUSES) as MessagingWireClauseId[]
).map((id) => ({
  id,
  title: CLAUSES[id].title,
  fix: CLAUSES[id].fix,
}));

export async function runMessagingWireClause(id: MessagingWireClauseId, adapter: MessagingWireAdapter, daemon: MessagingWireDaemon): Promise<void> {
  const clause = CLAUSES[id];
  try {
    await clause.check(adapter, daemon);
  } catch (cause) {
    const inner = (cause instanceof Error ? cause.message : String(cause)).trimEnd();
    throw new Error(`messaging wire contract [${id}] violated by ${adapter.name}: ${inner}${inner.endsWith(".") ? "" : "."} Fix: ${clause.fix}`, { cause });
  }
}

// Registers one node:test test per clause. host-read is skipped for a client without hostRead.
export function messagingWireSuite(adapter: MessagingWireAdapter, daemon: MessagingWireDaemon): void {
  const hasHostRead = adapter.connect("http://127.0.0.1:0", "").hostRead !== undefined;
  for (const { id, title } of MESSAGING_WIRE_CLAUSES) {
    const skip = id === "host-read" && !hasHostRead ? `${adapter.name} has no hostRead` : false;
    test(`messaging wire contract [${id}] ${adapter.name}: ${title}`, { skip }, () => runMessagingWireClause(id, adapter, daemon));
  }
}
