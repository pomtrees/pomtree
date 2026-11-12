// Worker-side carrier for reach-back from a hosted sandbox. The worker program inside the sandbox owns the
// byte-stream pair the provider's exec call gives it (its stdio), runs a mux over it, and carries each local connection the agent
// makes (egress proxy, daemon API) over one named mux channel to the daemon. Pure over injected duplex streams: no sockets,
// timers or fs. Wiring a real loopback listener to `serve` is the worker program's job.

import type { Duplex } from "node:stream";
import { type Mux, type MuxConnection, MuxError, type MuxOptions, type MuxPair, type MuxWaitOptions, createMux } from "./mux.ts";

// A bidirectional byte stream: a mux connection, a local socket wrapped by `fromNodeDuplex`, or a test double.
// `reset` aborts both directions at once; without it `close` (a graceful half-close) is all there is.
export interface ByteDuplex {
  write(data: Uint8Array): Promise<void>;
  output(): AsyncIterable<Uint8Array>;
  close(): void;
  reset?(reason: string): void;
}

// Wraps a node stream (a net.Socket) so the carrier code never touches the socket API.
export function fromNodeDuplex(d: Duplex): ByteDuplex {
  return {
    write: (data) =>
      new Promise<void>((resolve, reject) => {
        d.write(data, (error) => (error ? reject(error) : resolve()));
      }),
    async *output() {
      for await (const chunk of d) yield chunk as Uint8Array;
    },
    close: () => {
      d.end();
    },
    reset: (reason) => {
      d.destroy(new Error(reason));
    },
  };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Copies both directions until both ends finish. Each side is half-closed when the other's input ends; the first failure aborts
// both sides (reset when the stream has one) and is rethrown, so a broken link never reads as a clean finish.
// `aInput` continues an iterator the caller already started on `a` (the terminator has read the CONNECT header from it).
export async function relay(a: ByteDuplex, b: ByteDuplex, opts: { aInput?: AsyncIterator<Uint8Array> } = {}): Promise<void> {
  const ai = opts.aInput ?? a.output()[Symbol.asyncIterator]();
  const bi = b.output()[Symbol.asyncIterator]();
  let failure: { error: unknown } | undefined;
  const abort = (error: unknown) => {
    failure ??= { error };
    const why = `relay failed: ${describe(error)}`;
    for (const side of [a, b]) {
      try {
        if (side.reset) side.reset(why);
        else side.close();
      } catch {
        // The side is already gone; the first error is the one reported.
      }
    }
  };
  const pump = async (src: AsyncIterator<Uint8Array>, dst: ByteDuplex) => {
    try {
      for (;;) {
        const r = await src.next();
        if (r.done) break;
        await dst.write(r.value);
      }
      dst.close();
    } catch (e) {
      abort(e);
    }
  };
  await Promise.all([pump(ai, b), pump(bi, a)]);
  if (failure) throw failure.error;
}

export interface WorkerStreamOptions {
  // The worker's stdio pair (or any provider exec stream).
  pair: MuxPair;
  // Which end opens odd channel ids. The worker is the initiator by default: it opens a channel per local connection.
  role?: MuxOptions["role"];
  // Channel names the daemon may open toward the worker. Default none.
  accept?: readonly string[];
  // Required, with no default: pass the same shared bridge cap the terminator gets, so the two cannot diverge.
  maxConnections: number;
  onProtocolError?: MuxOptions["onProtocolError"];
}

export class WorkerStream {
  readonly mux: Mux;

  constructor(opts: WorkerStreamOptions) {
    if (!Number.isInteger(opts.maxConnections) || opts.maxConnections < 1) {
      throw new Error(`maxConnections must be a positive integer, got ${opts.maxConnections}; pass the shared bridge cap`);
    }
    const muxOpts: MuxOptions = { role: opts.role ?? "initiator", maxConnections: opts.maxConnections };
    if (opts.accept) muxOpts.accept = opts.accept;
    if (opts.onProtocolError) muxOpts.onProtocolError = opts.onProtocolError;
    this.mux = createMux(opts.pair, muxOpts);
  }

  get closed(): Mux["closed"] {
    return this.mux.closed;
  }

  open(name: string, opts?: MuxWaitOptions): Promise<MuxConnection> {
    return this.mux.open(name, opts);
  }

  accept(opts?: MuxWaitOptions): AsyncGenerator<MuxConnection> {
    return this.mux.incoming(opts);
  }

  // Carries one local connection over a new channel `name` until both directions finish. When the channel cannot be opened (the
  // stream is lost, the daemon refused the name, the connection cap is reached) the local connection is closed at once and the
  // mux error, which names the cause and the action, is rethrown: a worker whose stream is gone fails new connections fast.
  async bridge(local: ByteDuplex, name: string, opts?: MuxWaitOptions): Promise<void> {
    let conn: MuxConnection;
    try {
      conn = await this.mux.open(name, opts);
    } catch (e) {
      local.close();
      throw e;
    }
    // A channel whose input ends without the peer's close (the stream died) must not read as a clean end to the agent: this
    // wrapper turns that end into an error, so `relay` resets the local connection instead of half-closing it.
    const remote: ByteDuplex = {
      write: (data) => conn.write(data),
      close: () => conn.close(),
      reset: (reason) => conn.reset(reason),
      output: async function* () {
        yield* conn.output();
        if (!conn.remoteClosedFlag) {
          throw new MuxError("transport-ended", `the stream to the daemon ended while channel "${name}" was open; retry once the worker is reattached`);
        }
      },
    };
    await relay(local, remote);
  }

  // Bridges every connection from a local listener's accept stream. A failed bridge closes only its own connection and is passed
  // to `onError`; the loop ends when the source does.
  async serve(source: AsyncIterable<ByteDuplex>, name: string, onError: (error: unknown) => void, opts?: MuxWaitOptions): Promise<void> {
    const running = new Set<Promise<void>>();
    for await (const local of source) {
      const p = this.bridge(local, name, opts).catch(onError);
      running.add(p);
      void p.finally(() => running.delete(p));
    }
    await Promise.all(running);
  }

  close(): void {
    this.mux.close();
  }
}

export function createWorkerStream(opts: WorkerStreamOptions): WorkerStream {
  return new WorkerStream(opts);
}
