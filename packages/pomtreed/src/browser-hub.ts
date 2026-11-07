// Per-agent browser-view fan-out, pure: one CdpRelay per agent shared by every attached viewer (read-only),
// the latest status and frame kept for late joiners, a per-viewer latest-frame-wins send, the viewer limit,
// and teardown (stop the relay and release its streams on the last leave, on agent exit, on daemon shutdown).
// No sockets: a viewer is a callback bag, the relay and the liveness probe are injected. Mirrors TerminalHub.
//
// The hub's latest frame is viewer-only memory: it is a cache of what the stream last showed, it mutates
// nothing, and losing it only blanks a viewer until the next frame (SPEC.md, no state in daemon memory).

import type { CdpRelay, RelayListener, RelayStatus, RelayTimers } from "./cdp-relay.ts";

export type BrowserCloseReason = "ended" | "local" | "error";

export const MAX_BROWSER_VIEWERS = 8;
// A frame is written to a viewer only while its unsent backlog is below this; otherwise the newest frame waits for drain.
export const FRAME_BACKLOG_LIMIT = 1024 * 1024;

export interface BrowserViewer {
  status(s: RelayStatus): void;
  /** One complete, already-validated JPEG. Shared between viewers: never mutate it. */
  frame(jpeg: Uint8Array): void;
  /** Bytes accepted by `status`/`frame` but not yet flushed to the peer (socket.writableLength). */
  backlog(): number;
  /** The stream ended or the viewer was dropped; called at most once. */
  close(reason: BrowserCloseReason): void;
}

export interface BrowserLease {
  /** Begin delivery: the latest status and frame first, then live updates. Once only. */
  start(viewer: BrowserViewer): void;
  /** The viewer's socket drained: send the newest frame withheld while it was backed up. */
  drained(): void;
  /** Idempotent. Works before or after `start`. */
  detach(): void;
}

export interface BrowserHubOpts {
  /** Start a relay for the agent. Production: createCdpRelay over the sandbox loopback facet. */
  relay: (agent: string, listener: RelayListener) => CdpRelay;
  /** False once the agent is no longer running with a sandbox; the hub then ends its viewers with "ended". */
  alive?: (agent: string) => Promise<boolean>;
  aliveMs?: number; // default 2 s
  timers?: RelayTimers;
  maxViewers?: number; // default MAX_BROWSER_VIEWERS
  frameBacklogLimit?: number; // default FRAME_BACKLOG_LIMIT
  onError?: (agent: string, where: string, e: unknown) => void;
}

interface Slot {
  viewer: BrowserViewer;
  pending: Uint8Array | null;
}

interface Entry {
  relay: CdpRelay | null;
  slots: Map<BrowserViewer, Slot>;
  leases: number;
  status: RelayStatus | null;
  frame: Uint8Array | null;
  ended: BrowserCloseReason | null;
  aliveTimer: unknown;
}

const realTimers: RelayTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

// TODO(browser-controller-role): the hub shares one stream among up to MAX_BROWSER_VIEWERS read-only viewers; there is no writer role. Trigger: after browser-input-relay; one controller at a time, the others view-only, released when the agent ends.
export class BrowserHub {
  #entries = new Map<string, Entry>();
  readonly #opts: BrowserHubOpts;

  constructor(opts: BrowserHubOpts) {
    this.#opts = opts;
  }

  /** Number of agents with a live relay. */
  get streams(): number {
    return this.#entries.size;
  }

  /** Attached (acquired, not yet detached) viewers for the agent. */
  viewers(agent: string): number {
    return this.#entries.get(agent)?.leases ?? 0;
  }

  /** Reuses the agent's relay or starts one. Returns null when the agent already has the maximum number of viewers. */
  acquire(agent: string): BrowserLease | null {
    let e = this.#entries.get(agent);
    if (!e) {
      e = { relay: null, slots: new Map(), leases: 0, status: null, frame: null, ended: null, aliveTimer: undefined };
      const entry = e;
      this.#entries.set(agent, entry);
      // The relay reports its first status synchronously, so the entry must be registered before it starts.
      entry.relay = this.#opts.relay(agent, {
        status: (s) => {
          entry.status = s;
          for (const slot of [...entry.slots.values()]) this.#safe(agent, "status", () => slot.viewer.status(s));
        },
        frame: (f) => {
          entry.frame = f;
          for (const slot of [...entry.slots.values()]) this.#deliver(agent, slot, f);
        },
      });
      this.#watchAlive(agent, entry);
    }
    if (e.leases >= (this.#opts.maxViewers ?? MAX_BROWSER_VIEWERS)) {
      return null;
    }
    e.leases++;
    return this.#lease(agent, e);
  }

  /** Daemon shutdown: every viewer is told "local" and every relay stops. */
  closeAll(): void {
    for (const [agent, e] of [...this.#entries]) this.#end(agent, e, "local");
  }

  /** The agent stopped (or was found not running): viewers are told "ended". */
  end(agent: string, reason: BrowserCloseReason = "ended"): void {
    const e = this.#entries.get(agent);
    if (e) this.#end(agent, e, reason);
  }

  #safe(agent: string, where: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#opts.onError?.(agent, where, err);
    }
  }

  // Latest-frame-wins per viewer: write when the viewer's socket has room, otherwise keep only the newest frame.
  #deliver(agent: string, slot: Slot, frame: Uint8Array): void {
    const limit = this.#opts.frameBacklogLimit ?? FRAME_BACKLOG_LIMIT;
    let room: boolean;
    try {
      room = slot.viewer.backlog() < limit;
    } catch (err) {
      this.#opts.onError?.(agent, "backlog", err);
      room = false;
    }
    if (!room) {
      slot.pending = frame;
      return;
    }
    slot.pending = null;
    this.#safe(agent, "frame", () => slot.viewer.frame(frame));
  }

  #watchAlive(agent: string, e: Entry): void {
    const alive = this.#opts.alive;
    if (!alive) return;
    const timers = this.#opts.timers ?? realTimers;
    const check = () => {
      e.aliveTimer = undefined;
      if (e.ended) return;
      alive(agent).then(
        (ok) => {
          if (e.ended) return;
          if (!ok) return this.#end(agent, e, "ended");
          e.aliveTimer = timers.setTimeout(check, this.#opts.aliveMs ?? 2000);
        },
        (err) => {
          // A failed probe is not evidence the agent stopped; log and look again.
          this.#opts.onError?.(agent, "alive", err);
          if (!e.ended) e.aliveTimer = timers.setTimeout(check, this.#opts.aliveMs ?? 2000);
        },
      );
    };
    e.aliveTimer = timers.setTimeout(check, this.#opts.aliveMs ?? 2000);
  }

  #end(agent: string, e: Entry, reason: BrowserCloseReason): void {
    if (e.ended) return;
    e.ended = reason;
    if (this.#entries.get(agent) === e) this.#entries.delete(agent);
    (this.#opts.timers ?? realTimers).clearTimeout(e.aliveTimer);
    e.aliveTimer = undefined;
    this.#safe(agent, "stop", () => e.relay?.stop());
    const slots = [...e.slots.values()];
    e.slots.clear();
    e.frame = null;
    for (const s of slots) this.#safe(agent, "close", () => s.viewer.close(reason));
  }

  #lease(agent: string, e: Entry): BrowserLease {
    let slot: Slot | null = null;
    let released = false;
    return {
      start: (viewer) => {
        if (released || slot) return;
        slot = { viewer, pending: null };
        if (e.ended) return void this.#safe(agent, "close", () => viewer.close(e.ended!));
        e.slots.set(viewer, slot);
        const s = slot;
        if (e.status) {
          const st = e.status;
          this.#safe(agent, "status", () => viewer.status(st));
        }
        if (e.frame) this.#deliver(agent, s, e.frame);
      },
      drained: () => {
        if (!slot?.pending || e.ended) return;
        const f = slot.pending;
        this.#deliver(agent, slot, f);
      },
      detach: () => {
        if (released) return;
        released = true;
        if (slot) e.slots.delete(slot.viewer);
        if (--e.leases <= 0 && !e.ended) this.#end(agent, e, "local"); // stop the relay; the agent keeps running
      },
    };
  }
}
