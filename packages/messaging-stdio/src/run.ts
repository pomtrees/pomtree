import type { MESSAGE_FAILED_SUBJECT_MAX } from "@pomtree/core";
import type { StdioClient } from "./client.ts";
import { parseLine, renderEntry } from "./lines.ts";

// Core's limit, declared here because a type-only import cannot read the value; typed so a core change fails the typecheck.
const SUBJECT_MAX: typeof MESSAGE_FAILED_SUBJECT_MAX = 500;
const POST_ATTEMPTS = 3;
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
// A 4xx is the caller's to fix and never retried; a 5xx or a failure with no HTTP status (a transport error) may succeed on retry.
const retriable = (cause: string) => /HTTP 5\d\d:/.test(cause) || !/HTTP \d{3}:/.test(cause);

// Resolves after `ms`, or at once on abort.
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

export interface StdioRun {
  client: StdioClient;
  channel: string;
  sender: string;
  input: AsyncIterable<string>;
  write: (s: string) => void;
  pollMs: number;
  sessionId: string;
  from?: number;
  retryMs?: number;
  signal?: AbortSignal;
}

// Reads lines until the input ends or the signal aborts, posting each and printing the outbox. The outbox cursor is in memory and
// advances only after an entry is written (at-least-once, the adapter owns the cursor).
export async function runStdio(o: StdioRun): Promise<void> {
  let cursor = o.from ?? 0;
  const sender = { channel: o.channel, sender: o.sender };
  const poll = async () => {
    for (const e of await o.client.outbox(cursor)) {
      try {
        o.write(renderEntry(e));
      } catch (err) {
        const reason = msg(err);
        await o.client.messageFailed({
          channel: o.channel,
          purpose: e.payload.purpose,
          subject: e.payload.subject.slice(0, SUBJECT_MAX),
          reason,
          attempts: 1,
          idempotencyKey: `stdio:dead:${e.seq}`,
        });
      }
      cursor = e.seq + 1;
    }
  };
  // One poll at a time: an overlapping poll would read the same cursor and write an entry twice.
  let inflight: Promise<void> | undefined;
  let pollError: string | undefined; // the last poll error shown: a repeat is not printed again
  const safePoll = () =>
    (inflight ??= poll()
      .then(() => {
        if (pollError !== undefined) o.write("outbox: reconnected");
        pollError = undefined;
      })
      .catch((err: unknown) => {
        if (msg(err) === pollError) return;
        pollError = msg(err);
        o.write(`error: could not read the outbox: ${pollError}; check POMTREED_URL and the host token`);
      })
      .finally(() => (inflight = undefined)));
  const timer = setInterval(() => void safePoll(), o.pollMs);
  let lineNo = 0;
  try {
    const lines = o.input[Symbol.asyncIterator]();
    const aborted = new Promise<null>((r) => (o.signal?.aborted ? r(null) : o.signal?.addEventListener("abort", () => r(null), { once: true })));
    for (let next = await Promise.race([lines.next(), aborted]); next && !next.done; next = await Promise.race([lines.next(), aborted])) {
      lineNo++;
      const body = parseLine(next.value, sender, `stdio:${o.sessionId}:${lineNo}`);
      if (!body) continue;
      if ("error" in body) {
        o.write(`error: ${body.error}`);
        continue;
      }
      let cause = "";
      for (let n = 1; n <= POST_ATTEMPTS; n++) {
        try {
          const r = await o.client.postMessage(body); // the same key every attempt: a replay is one message
          o.write(r.kind === "rejected" ? `rejected: ${r.reason}` : JSON.stringify(r));
          cause = "";
          break;
        } catch (err) {
          cause = msg(err);
          if (!retriable(cause) || o.signal?.aborted) break;
          if (n < POST_ATTEMPTS) await sleep(o.retryMs ?? 200, o.signal);
          if (o.signal?.aborted) break;
        }
      }
      if (cause)
        o.write(
          retriable(cause)
            ? `error: could not deliver line ${lineNo} to pomtreed: ${cause}; check POMTREED_URL and the host token, then retype the line`
            : `error: pomtreed refused line ${lineNo}: ${cause}; fix the line and retype it`,
        );
    }
    await inflight;
    await safePoll();
  } finally {
    clearInterval(timer);
  }
}
