// Reconnect policy for the reach-back link. The daemon keeps no in-memory state, so after a dropped
// stream it re-attaches, builds a fresh mux, reopens the named channels, and lets in-flight calls retry. A call that was sent
// may or may not have been applied, so a retry resends under the ORIGINAL idempotency key and the server applies it once; a call
// whose response never arrived completely is never reported as a success. Pure: the connect function, sleep, clock and random
// source are injected, so tests run with no real time.

import { type Mux, MuxError, type MuxErrorCode, type MuxPair, type MuxOptions, createMux } from "./mux.ts";
import type { MuxConnection } from "./mux.ts";

export interface BackoffPolicy {
  // Connection attempts per outage, the first included. Default 5.
  maxAttempts?: number;
  // Wait before attempt n+1: baseMs * 2^(n-1) plus up to 25% jitter, then capped at maxMs. Defaults 500 and 30000.
  baseMs?: number;
  maxMs?: number;
  // A session that was lost sooner than this after it was established counts as flapping: the first attempt of the next outage
  // waits baseMs instead of starting at once. Default 10000.
  stableMs?: number;
}

export type ReconnectEvent =
  | { kind: "connected"; attempt: number }
  | { kind: "attempt-failed"; attempt: number; error: unknown }
  | { kind: "lost"; cause: string }
  | { kind: "gave-up"; error: Error };

export interface ReconnectOptions {
  // Establishes a fresh byte-stream pair (the daemon re-attaches and starts the worker's exec stream again). A rejection counts
  // as a failed attempt.
  connect: (attempt: number) => Promise<MuxPair>;
  // Channel names held open on every session; `channel(name)` returns the current connection for one.
  channels: readonly string[];
  mux: Pick<MuxOptions, "role" | "accept" | "maxConnections" | "maxFrameBytes" | "onProtocolError">;
  backoff?: BackoffPolicy;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  random: () => number;
  // Bound on each channel open during a (re)connect. Default none; the mux has no timer of its own.
  openTimeoutMs?: number;
  onEvent?: (event: ReconnectEvent) => void;
}

export interface MutatingCall<T> {
  channel: string;
  // The idempotency key. It is chosen once by the caller and sent on every attempt, so the server applies the call once.
  key: string;
  // Sends the call on `conn` under `key` and resolves with the COMPLETE response. It must throw LinkDroppedError (or a link
  // MuxError) when the stream ends before the response is whole, and any other error for an answer it did receive.
  exchange: (conn: MuxConnection, key: string) => Promise<T>;
  // Total sends including the first. Default 3.
  maxAttempts?: number;
}

// Thrown by an exchange when the stream ended or failed before a whole response arrived.
export class LinkDroppedError extends Error {
  constructor(what: string) {
    super(`the link dropped before a complete response arrived (${what}); the call may or may not have been applied`);
    this.name = "LinkDroppedError";
  }
}

// The call was sent but no complete response ever arrived, so whether it was applied is unknown.
export class CallOutcomeUnknownError extends Error {
  readonly key: string;
  constructor(key: string, attempts: number, cause: unknown) {
    super(
      `the call under idempotency key ${key} was sent ${attempts} time(s) but no complete response arrived (${cause instanceof Error ? cause.message : String(cause)}); it may have been applied once: look it up by that key, and repeat it only under the same key`,
      { cause },
    );
    this.name = "CallOutcomeUnknownError";
    this.key = key;
  }
}

export class ReconnectError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ReconnectError";
  }
}

const LINK_CODES: ReadonlySet<MuxErrorCode> = new Set([
  "transport-ended",
  "transport-failed",
  "truncated-frame",
  "reset-by-peer",
  "closed",
  "sequence",
  "protocol",
  "outbound-overflow",
]);

// A failure of the link rather than an answer from the peer: worth a retry on a fresh session.
export function isLinkFailure(error: unknown): boolean {
  return error instanceof LinkDroppedError || (error instanceof MuxError && LINK_CODES.has(error.code));
}

interface Session {
  mux: Mux;
  channels: Map<string, MuxConnection>;
  establishedAt: number;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class Reconnector {
  #opts: ReconnectOptions;
  #current: Promise<Session> | undefined;
  #session: Session | undefined;
  #stopped = false;
  #abort = new AbortController();
  // Bumped by start() and close(): an establish loop that sees a different value than it began with has been superseded.
  #epoch = 0;
  #flapping = false;

  constructor(opts: ReconnectOptions) {
    this.#opts = opts;
  }

  // Connects and opens the channels. Rejects with ReconnectError when every attempt failed; calling it again starts a new outage
  // cycle. Calling it on a running reconnector closes the current session first (its channels are replaced by the new ones) and
  // supersedes any connect still in progress, and it works again after close().
  start(): Promise<void> {
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#epoch++;
    this.#stopped = false;
    const old = this.#session;
    this.#session = undefined;
    old?.mux.close();
    return this.#begin().then(() => undefined);
  }

  // The current connection for a held channel name; throws when there is no live session (use `call`, which waits for one).
  channel(name: string): MuxConnection {
    const conn = this.#session?.channels.get(name);
    if (!conn)
      throw new ReconnectError(
        `channel "${name}" is not open: the link is down or the name is not in the reconnector's channel list; wait for the reconnect or add the name`,
      );
    return conn;
  }

  // Runs one keyed call, resending under the same key after link failures until a complete response arrives or the attempts run
  // out. Once the call has been sent, any later failure to get an answer (including losing the link for good) is reported as
  // CallOutcomeUnknownError with the key, because the call may have been applied; a failure before the first send is thrown as is.
  async call<T>(call: MutatingCall<T>): Promise<T> {
    const max = call.maxAttempts ?? 3;
    let sent = 0;
    let last: unknown;
    for (let attempt = 1; attempt <= max; attempt++) {
      let session: Session;
      try {
        if (this.#stopped) throw new ReconnectError("the reconnector is closed, so the call was not sent; start it again");
        session = await (this.#current ?? this.#begin());
      } catch (e) {
        if (sent === 0) throw e;
        throw new CallOutcomeUnknownError(call.key, sent, e);
      }
      const conn = session.channels.get(call.channel);
      if (!conn) throw new ReconnectError(`channel "${call.channel}" is not in the reconnector's channel list; add it to \`channels\``);
      sent++;
      try {
        return await call.exchange(conn, call.key);
      } catch (e) {
        if (!isLinkFailure(e)) throw e;
        last = e;
        this.#lose(session, describe(e));
      }
    }
    throw new CallOutcomeUnknownError(call.key, sent, last);
  }

  close(): void {
    this.#stopped = true;
    this.#epoch++;
    this.#abort.abort();
    const s = this.#session;
    this.#session = undefined;
    s?.mux.close();
  }

  #begin(): Promise<Session> {
    const p = this.#establish();
    p.catch(() => {});
    this.#current = p;
    return p;
  }

  #lose(session: Session, cause: string): void {
    if (this.#session !== session) return;
    this.#session = undefined;
    this.#flapping = this.#opts.now() - session.establishedAt < (this.#opts.backoff?.stableMs ?? 10_000);
    session.mux.close();
    if (this.#stopped) return;
    this.#opts.onEvent?.({ kind: "lost", cause });
    this.#begin();
  }

  #delay(failures: number): number {
    const b = this.#opts.backoff ?? {};
    const base = b.baseMs ?? 500;
    const wait = base * 2 ** Math.max(0, failures - 1);
    return Math.min(b.maxMs ?? 30_000, Math.floor(wait * (1 + 0.25 * this.#opts.random())));
  }

  async #establish(): Promise<Session> {
    const max = this.#opts.backoff?.maxAttempts ?? 5;
    let failures = 0;
    let last: unknown;
    const flapping = this.#flapping;
    this.#flapping = false;
    const epoch = this.#epoch;
    const signal = this.#abort.signal;
    const superseded = () =>
      new ReconnectError("the reconnector was closed or restarted while connecting, so this connect was abandoned; call start() to connect again");
    for (let attempt = 1; attempt <= max; attempt++) {
      if (this.#epoch !== epoch) throw superseded();
      try {
        if (failures > 0 || (attempt === 1 && flapping)) {
          await this.#opts.sleep(this.#delay(Math.max(1, failures)), signal);
          if (this.#epoch !== epoch) throw superseded();
        }
        const pair = await this.#opts.connect(attempt);
        const mux = createMux(pair, this.#opts.mux);
        const channels = new Map<string, MuxConnection>();
        try {
          for (const name of this.#opts.channels) {
            channels.set(name, await mux.open(name, this.#opts.openTimeoutMs === undefined ? {} : { timeoutMs: this.#opts.openTimeoutMs }));
          }
        } catch (e) {
          mux.close();
          throw e;
        }
        const session: Session = { mux, channels, establishedAt: this.#opts.now() };
        if (this.#epoch !== epoch) {
          mux.close();
          throw superseded();
        }
        this.#session = session;
        this.#opts.onEvent?.({ kind: "connected", attempt });
        void mux.closed.then(() => this.#lose(session, "the stream ended"));
        return session;
      } catch (e) {
        // An abort of the backoff sleep (close() or start()) is a typed supersede, never the raw abort reason.
        if (this.#epoch !== epoch) throw e instanceof ReconnectError ? e : superseded();
        last = e;
        failures++;
        this.#opts.onEvent?.({ kind: "attempt-failed", attempt, error: e });
      }
    }
    const error = new ReconnectError(
      `could not re-establish the link after ${max} attempt(s) (last error: ${describe(last)}); check the sandbox is still running, then start the reconnector again`,
      last,
    );
    this.#opts.onEvent?.({ kind: "gave-up", error });
    throw error;
  }
}

export function createReconnector(opts: ReconnectOptions): Reconnector {
  return new Reconnector(opts);
}
