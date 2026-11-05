import assert from "node:assert/strict";
import { test } from "node:test";
import type { InboundBody, MessageFailedBody, OutboxEntry } from "@pomtree/core";
import type { StdioClient } from "./client.ts";
import { runStdio } from "./run.ts";

const entry = (seq: number, subject = "s"): OutboxEntry => ({
  seq,
  ts: 1,
  agent: "ag-1",
  payload: { kind: "message_sent", channel: "stdio", purpose: "alert", subject },
});

// A scripted client: records every call; `post` and `outbox` script the answers.
function scripted(o: { post?: (b: InboundBody, n: number) => unknown; outbox?: (from: number) => OutboxEntry[] } = {}) {
  const calls = { posts: [] as InboundBody[], outbox: [] as number[], failed: [] as MessageFailedBody[] };
  const client: StdioClient = {
    async outbox(from) {
      calls.outbox.push(from);
      return o.outbox?.(from) ?? [];
    },
    async postMessage(b) {
      calls.posts.push(b);
      return (o.post?.(b, calls.posts.length) ?? { kind: "status", agent: "ag-1", state: "running" }) as never;
    },
    async messageFailed(b) {
      calls.failed.push(b);
    },
  };
  return { client, calls };
}

async function* lines(...ls: string[]) {
  yield* ls;
}

// An input that yields one blank line only once `ready` settles, so a test waits for the timed polls it needs, not for wall time.
async function* after(ready: Promise<unknown>) {
  await ready;
  yield "";
}

// A promise and the function that resolves it.
function signal() {
  let fire!: () => void;
  const fired = new Promise<void>((r) => (fire = r));
  return { fire, fired };
}

const base = { channel: "stdio", sender: "me", pollMs: 60_000, sessionId: "s1", retryMs: 1 };

test("posts each line with a session/line key, prints receipts and rejected reasons, skips blanks", async () => {
  const { client, calls } = scripted({ post: (_b, n) => (n === 2 ? { kind: "rejected", reason: "sender stdio:me is not authorized" } : undefined) });
  const out: string[] = [];
  await runStdio({ ...base, client, input: lines("!status ag-1", "", "!cancel ag-1", "garbage"), write: (s) => out.push(s) });
  assert.deepEqual(
    calls.posts.map((p) => p.idempotencyKey),
    ["stdio:s1:1", "stdio:s1:3"],
  );
  assert.deepEqual(out.slice(0, 2), ['{"kind":"status","agent":"ag-1","state":"running"}', "rejected: sender stdio:me is not authorized"]);
  assert.match(out[2] as string, /^error: cannot parse "garbage"; #<escalation>/);
});

test("a transport failure is retried with the same key, then reported with the action", async () => {
  const { client, calls } = scripted({
    post: (_b, n) => {
      if (n < 3) throw new Error("ECONNREFUSED");
    },
  });
  const out: string[] = [];
  await runStdio({ ...base, client, input: lines("!status ag-1"), write: (s) => out.push(s) });
  assert.equal(calls.posts.length, 3);
  assert.equal(new Set(calls.posts.map((p) => p.idempotencyKey)).size, 1);
  assert.equal(out.length, 1, "the third attempt succeeded");

  const down = scripted({
    post: () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const out2: string[] = [];
  await runStdio({ ...base, client: down.client, input: lines("!status ag-1"), write: (s) => out2.push(s) });
  assert.equal(down.calls.posts.length, 3);
  assert.equal(out2.length, 1);
  assert.match(out2[0] as string, /^error: could not deliver line 1 to pomtreed: ECONNREFUSED; check POMTREED_URL and the host token, then retype the line$/);
});

test("the final poll starts at the cursor and advances it past each written entry", async () => {
  const { client, calls } = scripted({ outbox: (from) => [entry(5), entry(6)].filter((e) => e.seq >= from) });
  const out: string[] = [];
  await runStdio({ ...base, client, from: 5, input: lines(), write: (s) => out.push(s) });
  assert.deepEqual(out, ["[alert] ag-1: s", "[alert] ag-1: s"]);
  assert.deepEqual(calls.outbox, [5]);
});

test("a write that throws dead-letters the entry once with a clipped subject, and the cursor still advances", async () => {
  const subjects = ["x".repeat(600), "ok"];
  const { client, calls } = scripted({ outbox: (from) => [entry(1, subjects[0]), entry(2, subjects[1])].filter((e) => e.seq >= from) });
  const out: string[] = [];
  let n = 0;
  await runStdio({
    ...base,
    client,
    input: lines(),
    write: (s) => {
      if (n++ === 0) throw new Error("EPIPE");
      out.push(s);
    },
  });
  assert.equal(calls.failed.length, 1);
  assert.deepEqual(
    { ...calls.failed[0], subject: calls.failed[0]?.subject.length },
    { channel: "stdio", purpose: "alert", subject: 500, reason: "EPIPE", attempts: 1, idempotencyKey: "stdio:dead:1" },
  );
  assert.deepEqual(out, ["[alert] ag-1: ok"], "the next entry is still written");
});

test("an abort ends the run while the input is idle", async () => {
  const { client } = scripted();
  const ac = new AbortController();
  const idle: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  const done = runStdio({ ...base, client, input: idle, write: () => {}, signal: ac.signal });
  ac.abort();
  await done;
});

test("the timed poll re-reads from the cursor only after the entry was written, so an entry prints once", async () => {
  const third = signal();
  const { client, calls } = scripted({
    outbox: (from) => {
      if (calls.outbox.length === 3) third.fire(); // two timed re-reads after the first: the input ends only then
      return [entry(1)].filter((e) => e.seq >= from);
    },
  });
  const out: string[] = [];
  await runStdio({ ...base, pollMs: 5, client, input: after(third.fired), write: (s) => out.push(s) });
  assert.equal(out.length, 1);
  assert.equal(calls.outbox[0], 0);
  assert.ok(calls.outbox.length > 2 && calls.outbox.slice(1).every((f) => f === 2), JSON.stringify(calls.outbox));
});

test("a 4xx is not retried and is reported once with the action; a 5xx is retried", async () => {
  const refused = scripted({
    post: () => {
      throw new Error('pomtreed post HTTP 403: {"error":"nope"}');
    },
  });
  const out: string[] = [];
  await runStdio({ ...base, client: refused.client, input: lines("!status ag-1"), write: (s) => out.push(s) });
  assert.equal(refused.calls.posts.length, 1);
  assert.deepEqual(out, ['error: pomtreed refused line 1: pomtreed post HTTP 403: {"error":"nope"}; fix the line and retype it']);

  const flaky = scripted({
    post: (_b, n) =>
      void (
        n < 3 &&
        (() => {
          throw new Error("pomtreed post HTTP 503: down");
        })()
      ),
  });
  await runStdio({ ...base, client: flaky.client, input: lines("!status ag-1"), write: () => {} });
  assert.equal(flaky.calls.posts.length, 3);
});

test("an outbox error is printed once until it changes, and a recovery prints reconnected once", async () => {
  let n = 0;
  const recovered = signal();
  const { client } = scripted({
    outbox: () => {
      n++;
      if (n <= 3) throw new Error("ECONNREFUSED");
      recovered.fire(); // the input ends only after three failed timed polls and one that succeeds
      return [];
    },
  });
  const out: string[] = [];
  await runStdio({ ...base, pollMs: 5, client, input: after(recovered.fired), write: (s) => out.push(s) });
  assert.deepEqual(out, ["error: could not read the outbox: ECONNREFUSED; check POMTREED_URL and the host token", "outbox: reconnected"]);
});

test("an abort during the retry sleep ends the retries at once", async () => {
  const ac = new AbortController();
  const { client, calls } = scripted({
    post: () => {
      setImmediate(() => ac.abort()); // runs after this failure's microtasks, so the 60 s retry sleep has started
      throw new Error("ECONNREFUSED");
    },
  });
  const started = Date.now();
  const done = runStdio({ ...base, retryMs: 60_000, client, input: lines("!status ag-1"), write: () => {}, signal: ac.signal });
  await done;
  assert.ok(Date.now() - started < 5_000);
  assert.equal(calls.posts.length, 1);
});
