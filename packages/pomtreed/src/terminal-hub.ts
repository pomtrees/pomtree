// Per-agent terminal fan-out, pure: one TerminalSession per agent shared by every attached viewer, a
// daemon-side RingBuffer for late joiners, reference counting (the last viewer leaving detaches the
// session; the container keeps running) and the resize policy. No sockets: a viewer is a callback bag
// and `open` is injected (the sandbox terminal facet in production, a fake in tests). The hub is a cache of
// live attaches; losing it only drops viewers (no state lives only in daemon memory).

import type { TerminalClose, TerminalSession } from "@pomtree/core";
import { RingBuffer, trimToSafeStart } from "./ringbuffer.ts";

export type TerminalCloseReason = TerminalClose["reason"];
export interface TerminalSize {
  cols: number;
  rows: number;
}

export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 80, rows: 24 };
export const MAX_TERMINAL_COLS = 500;
export const MAX_TERMINAL_ROWS = 200;
// A viewer whose unsent backlog passes this is dropped (reason "error") rather than stalling the others.
export const MAX_VIEWER_BACKLOG = 4 * 1024 * 1024;

/** Clamp client-supplied dimensions to sane integer bounds; null when they are not finite numbers. */
export function clampSize(cols: unknown, rows: unknown): TerminalSize | null {
  if (typeof cols !== "number" || typeof rows !== "number" || !Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  return {
    cols: Math.min(MAX_TERMINAL_COLS, Math.max(1, Math.trunc(cols))),
    rows: Math.min(MAX_TERMINAL_ROWS, Math.max(1, Math.trunc(rows))),
  };
}

export interface TerminalViewer {
  send(chunk: Uint8Array): void;
  /** Bytes accepted by `send` but not yet flushed to the peer. */
  backlog(): number;
  /** The shared session ended or this viewer was dropped; called at most once. */
  close(reason: TerminalCloseReason): void;
}

export interface TerminalLease {
  /** Begin delivery: the ring snapshot first, then live output, then a redraw. */
  start(viewer: TerminalViewer): void;
  write(data: Uint8Array): Promise<void>;
  resize(size: TerminalSize): Promise<void>;
  /** Idempotent. Works before or after `start`. */
  detach(): void;
}

interface Entry {
  session: TerminalSession;
  ring: RingBuffer;
  viewers: Set<TerminalViewer>;
  leases: number;
  ended: TerminalCloseReason | null;
}

export interface TerminalHubOpts {
  open: (agent: string, size: TerminalSize) => Promise<TerminalSession>;
  ringCapacity?: number;
  maxViewerBacklog?: number;
  onError?: (agent: string, where: string, e: unknown) => void;
  // A viewer write that is exactly one 0x1b byte (a bare Esc keypress; arrow keys/CSI/Alt-chords/pastes arrive longer).
  // Reported so the daemon can journal it as corroboration of a user abort; a failure never blocks the write.
  onEsc?: (agent: string) => void | Promise<void>;
}

/** True when a viewer write is a bare Esc keypress: exactly the single byte 0x1b. A coalesced chunk is deliberately not Esc
 *  (the safe direction: the abort then reads as passive and is nudged once). */
export const isBareEsc = (data: Uint8Array): boolean => data.length === 1 && data[0] === 0x1b;

export class TerminalHub {
  #entries = new Map<string, Entry | Promise<Entry>>();
  readonly #opts: TerminalHubOpts;

  constructor(opts: TerminalHubOpts) {
    this.#opts = opts;
  }

  /** Number of agents with a live (or opening) shared session. */
  get sessions(): number {
    return this.#entries.size;
  }

  /** Reuses the agent's live session or opens one at `size` (concurrent callers share one open). Rejects when open fails. */
  async acquire(agent: string, size: TerminalSize = DEFAULT_TERMINAL_SIZE): Promise<TerminalLease> {
    let cur = this.#entries.get(agent);
    if (!cur) {
      cur = this.#open(agent, size);
      this.#entries.set(agent, cur);
      cur.catch(() => {
        if (this.#entries.get(agent) === cur) this.#entries.delete(agent);
      });
    }
    const entry = await cur;
    entry.leases++;
    return this.#lease(agent, entry);
  }

  /** Daemon shutdown: detach every session; viewers are told "local". */
  closeAll(): void {
    for (const [agent, e] of [...this.#entries]) {
      if (e instanceof Promise)
        void e.then(
          (en) => this.#end(agent, en, "local"),
          () => {},
        );
      else this.#end(agent, e, "local");
    }
  }

  async #open(agent: string, size: TerminalSize): Promise<Entry> {
    const session = await this.#opts.open(agent, size);
    const entry: Entry = { session, ring: new RingBuffer(this.#opts.ringCapacity), viewers: new Set(), leases: 0, ended: null };
    this.#entries.set(agent, entry);
    void this.#pump(agent, entry);
    void session.closed.then(
      (c) => this.#end(agent, entry, c.reason),
      () => this.#end(agent, entry, "error"),
    );
    return entry;
  }

  async #pump(agent: string, e: Entry): Promise<void> {
    const max = this.#opts.maxViewerBacklog ?? MAX_VIEWER_BACKLOG;
    try {
      for await (const chunk of e.session.output()) {
        e.ring.append(chunk);
        for (const v of [...e.viewers]) {
          if (v.backlog() > max) {
            e.viewers.delete(v);
            this.#notify(agent, v, "error");
            continue;
          }
          try {
            v.send(chunk);
          } catch (err) {
            this.#opts.onError?.(agent, "send", err);
          }
        }
      }
    } catch (err) {
      this.#opts.onError?.(agent, "output", err);
      this.#end(agent, e, "error");
    }
  }

  // The session is over (container exit, stream error, or last detach/closeAll): tell the viewers once and
  // forget the entry so the next attach opens a fresh session and ring.
  #end(agent: string, e: Entry, reason: TerminalCloseReason): void {
    if (e.ended) return;
    // TODO(yield-reattach): no banner over the last rendered screen, socket not held idle, no reattach to the resumed container; today the session closes with its container.
    e.ended = reason;
    if (this.#entries.get(agent) === e) this.#entries.delete(agent);
    e.session.close();
    const vs = [...e.viewers];
    e.viewers.clear();
    for (const v of vs) this.#notify(agent, v, reason);
  }

  #notify(agent: string, v: TerminalViewer, reason: TerminalCloseReason): void {
    try {
      v.close(reason);
    } catch (err) {
      this.#opts.onError?.(agent, "close", err);
    }
  }

  #lease(agent: string, e: Entry): TerminalLease {
    let viewer: TerminalViewer | null = null;
    let released = false;
    const alive = () => !released && !e.ended;
    return {
      start: (v) => {
        if (released || viewer) return;
        viewer = v;
        if (e.ended) return void this.#notify(agent, v, e.ended);
        const snap = trimToSafeStart(e.ring.snapshot());
        if (snap.length) v.send(snap);
        e.viewers.add(v);
        // pi repaints through docker; the replay above only covers history the ring still holds.
        void e.session.redraw().catch((err) => this.#opts.onError?.(agent, "redraw", err));
      },
      write: async (data) => {
        if (!alive()) return;
        // Journal the Esc before forwarding it, so the entry precedes the abort's settle.
        if (isBareEsc(data) && this.#opts.onEsc) {
          try {
            await this.#opts.onEsc(agent);
          } catch (err) {
            this.#opts.onError?.(agent, "esc", err);
          }
        }
        await e.session.write(data);
      },
      // TODO(termsize): last-writer-wins; every viewer's resize frame resizes the shared pty (no min/max-of-viewers policy).
      resize: async (size) => {
        if (alive()) await e.session.resize(size.cols, size.rows);
      },
      detach: () => {
        if (released) return;
        released = true;
        if (viewer) e.viewers.delete(viewer);
        if (--e.leases <= 0 && !e.ended) this.#end(agent, e, "local"); // detach only; the container keeps running
      },
    };
  }
}
