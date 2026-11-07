import assert from "node:assert/strict";
import { test } from "node:test";
import type { CdpRelay, RelayListener, RelayStatus } from "./cdp-relay.ts";
import { BrowserHub, FRAME_BACKLOG_LIMIT, MAX_BROWSER_VIEWERS, type BrowserCloseReason, type BrowserHubOpts, type BrowserViewer } from "./browser-hub.ts";

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
};

class ManualTimers {
  #seq = 0;
  #pending = new Map<number, () => void>();
  setTimeout = (fn: () => void): unknown => {
    const id = ++this.#seq;
    this.#pending.set(id, fn);
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.#pending.delete(h as number);
  };
  get pending(): number {
    return this.#pending.size;
  }
  async fire(): Promise<void> {
    const fns = [...this.#pending.values()];
    this.#pending.clear();
    for (const f of fns) f();
    await flush();
  }
}

class FakeRelay implements CdpRelay {
  stops = 0;
  listener!: RelayListener;
  stop(): void {
    this.stops++;
  }
}

class FakeViewer implements BrowserViewer {
  log: string[] = [];
  frames: Uint8Array[] = [];
  statuses: RelayStatus[] = [];
  closed: BrowserCloseReason[] = [];
  queued = 0;
  throwOnFrame = false;
  status(s: RelayStatus): void {
    this.statuses.push(s);
    this.log.push(`status:${s.state}`);
  }
  frame(f: Uint8Array): void {
    if (this.throwOnFrame) throw new Error("socket gone");
    this.frames.push(f);
    this.log.push(`frame:${f[0]}`);
  }
  backlog(): number {
    return this.queued;
  }
  close(r: BrowserCloseReason): void {
    this.closed.push(r);
  }
}

const img = (n: number): Uint8Array => Uint8Array.from([n, 0xd8, 0xff]);

function make(over: Partial<BrowserHubOpts> = {}) {
  const relays: FakeRelay[] = [];
  const errors: string[] = [];
  const timers = new ManualTimers();
  const hub = new BrowserHub({
    relay: (agent, listener) => {
      const r = new FakeRelay();
      r.listener = listener;
      relays.push(r);
      listener.status({ state: "connecting" }); // the real relay reports synchronously at start
      return r;
    },
    timers,
    onError: (a, w, e) => errors.push(`${a} ${w}: ${e instanceof Error ? e.message : String(e)}`),
    ...over,
  });
  return { hub, relays, errors, timers };
}

function join(hub: BrowserHub, agent = "a1"): { lease: NonNullable<ReturnType<BrowserHub["acquire"]>>; viewer: FakeViewer } {
  const lease = hub.acquire(agent);
  assert.ok(lease, "acquire returned null");
  const viewer = new FakeViewer();
  lease.start(viewer);
  return { lease, viewer };
}

test("viewers of one agent share a single relay; frames and statuses fan out to all", () => {
  const { hub, relays } = make();
  const a = join(hub);
  const b = join(hub);
  assert.equal(relays.length, 1);
  assert.equal(hub.streams, 1);
  relays[0]!.listener.status({ state: "live", width: 10, height: 5 });
  relays[0]!.listener.frame(img(1));
  for (const v of [a.viewer, b.viewer]) {
    assert.deepEqual(v.statuses.at(-1), { state: "live", width: 10, height: 5 });
    assert.deepEqual(v.frames, [img(1)]);
  }
});

test("a late joiner gets the latest status, then the latest frame, and nothing older", () => {
  const { hub, relays } = make();
  join(hub);
  relays[0]!.listener.status({ state: "live" });
  relays[0]!.listener.frame(img(1));
  relays[0]!.listener.frame(img(2));
  const late = join(hub);
  assert.deepEqual(late.viewer.log, ["status:live", "frame:2"]);
});

test("a joiner before any frame gets the status only", () => {
  const { hub } = make();
  const v = join(hub);
  assert.deepEqual(v.viewer.log, ["status:connecting"]);
});

test("viewer limit: the 9th acquire is refused without touching the relay; a freed slot admits again", () => {
  const { hub, relays } = make();
  const joined = Array.from({ length: MAX_BROWSER_VIEWERS }, () => join(hub));
  assert.equal(MAX_BROWSER_VIEWERS, 8);
  assert.equal(hub.viewers("a1"), 8);
  assert.equal(hub.acquire("a1"), null);
  assert.equal(hub.viewers("a1"), 8); // the refused attempt left no lease behind
  assert.equal(relays.length, 1);
  joined[0]!.lease.detach();
  assert.ok(hub.acquire("a1"));
  assert.ok(hub.acquire("other")); // the limit is per agent
});

test("last leave stops the relay once and forgets the entry; the next viewer starts fresh without a stale frame", () => {
  const { hub, relays } = make();
  const a = join(hub);
  const b = join(hub);
  relays[0]!.listener.frame(img(1));
  a.lease.detach();
  assert.equal(relays[0]!.stops, 0);
  b.lease.detach();
  b.lease.detach(); // idempotent
  assert.equal(relays[0]!.stops, 1);
  assert.equal(hub.streams, 0);
  const c = join(hub);
  assert.equal(relays.length, 2);
  assert.deepEqual(c.viewer.log, ["status:connecting"]);
});

test("detach before start still counts the lease out and a later start is a no-op", () => {
  const { hub, relays } = make();
  const lease = hub.acquire("a1")!;
  lease.detach();
  assert.equal(relays[0]!.stops, 1);
  const v = new FakeViewer();
  lease.start(v);
  assert.deepEqual(v.log, []);
});

test("latest-frame-wins: a backed-up viewer keeps only the newest frame and gets it on drain; others are unaffected", () => {
  const { hub, relays } = make();
  const slow = join(hub);
  const fast = join(hub);
  slow.viewer.queued = FRAME_BACKLOG_LIMIT; // exactly at the limit: no room
  relays[0]!.listener.frame(img(1));
  relays[0]!.listener.frame(img(2));
  relays[0]!.listener.frame(img(3));
  assert.deepEqual(slow.viewer.frames, []);
  assert.deepEqual(fast.viewer.frames, [img(1), img(2), img(3)]);
  slow.lease.drained(); // still full: nothing is sent
  assert.deepEqual(slow.viewer.frames, []);
  slow.viewer.queued = 0;
  slow.lease.drained();
  assert.deepEqual(slow.viewer.frames, [img(3)]); // 1 and 2 were dropped
  slow.lease.drained();
  assert.equal(slow.viewer.frames.length, 1); // nothing pending any more
});

test("backlog threshold is strict: one byte under the limit still receives", () => {
  const { hub, relays } = make();
  const v = join(hub);
  v.viewer.queued = FRAME_BACKLOG_LIMIT - 1;
  relays[0]!.listener.frame(img(1));
  assert.deepEqual(v.viewer.frames, [img(1)]);
});

test("a viewer that joins while backed up gets the newest frame on drain", () => {
  const { hub, relays } = make();
  join(hub);
  relays[0]!.listener.frame(img(7));
  const lease = hub.acquire("a1")!;
  const v = new FakeViewer();
  v.queued = FRAME_BACKLOG_LIMIT;
  lease.start(v);
  assert.deepEqual(v.frames, []);
  v.queued = 0;
  lease.drained();
  assert.deepEqual(v.frames, [img(7)]);
});

test("a viewer that throws does not stop delivery to the others", () => {
  const { hub, relays, errors } = make();
  const bad = join(hub);
  const good = join(hub);
  bad.viewer.throwOnFrame = true;
  relays[0]!.listener.frame(img(1));
  assert.deepEqual(good.viewer.frames, [img(1)]);
  assert.match(errors.join("\n"), /socket gone/);
});

test("daemon shutdown: closeAll tells every viewer local and stops every relay", () => {
  const { hub, relays } = make();
  const a = join(hub, "a1");
  const b = join(hub, "a2");
  hub.closeAll();
  assert.deepEqual(a.viewer.closed, ["local"]);
  assert.deepEqual(b.viewer.closed, ["local"]);
  assert.deepEqual(
    relays.map((r) => r.stops),
    [1, 1],
  );
  assert.equal(hub.streams, 0);
  a.lease.detach(); // late detach after the end changes nothing
  assert.equal(relays[0]!.stops, 1);
  hub.closeAll(); // idempotent
});

test("agent stop: the liveness probe failing ends viewers with 'ended' and stops the relay", async () => {
  let up = true;
  const { hub, relays, timers } = make({ alive: async () => up });
  const v = join(hub);
  await timers.fire();
  assert.deepEqual(v.viewer.closed, []);
  up = false;
  await timers.fire();
  assert.deepEqual(v.viewer.closed, ["ended"]);
  assert.equal(relays[0]!.stops, 1);
  assert.equal(timers.pending, 0);
  assert.equal(hub.streams, 0);
});

test("a throwing liveness probe is not an agent stop; the probe is retried", async () => {
  let calls = 0;
  const { hub, errors, timers } = make({
    alive: async () => {
      if (++calls === 1) throw new Error("registry down");
      return true;
    },
  });
  const v = join(hub);
  await timers.fire();
  await timers.fire();
  assert.equal(calls, 2);
  assert.deepEqual(v.viewer.closed, []);
  assert.match(errors.join("\n"), /registry down/);
});

test("leaving cancels the liveness timer", () => {
  const { hub, timers } = make({ alive: async () => true });
  const v = join(hub);
  assert.equal(timers.pending, 1);
  v.lease.detach();
  assert.equal(timers.pending, 0);
});

test("end() with an explicit reason reaches viewers once", () => {
  const { hub } = make();
  const v = join(hub);
  hub.end("a1", "error");
  hub.end("a1", "ended");
  assert.deepEqual(v.viewer.closed, ["error"]);
});

test("status backpressure: a backed-up viewer gets no status writes, then only the latest on drain, ahead of the pending frame", () => {
  const { hub, relays } = make();
  const slow = join(hub);
  const fast = join(hub);
  slow.viewer.queued = FRAME_BACKLOG_LIMIT;
  const before = slow.viewer.statuses.length;
  relays[0]!.listener.frame(img(5));
  for (let i = 1; i <= 50; i++) relays[0]!.listener.status({ state: "live", width: i, height: i });
  assert.equal(slow.viewer.statuses.length, before); // nothing written while backed up
  assert.equal(fast.viewer.statuses.length, before + 50); // negative control: others unaffected
  slow.viewer.queued = 0;
  slow.lease.drained();
  assert.equal(slow.viewer.statuses.length, before + 1);
  assert.deepEqual(slow.viewer.statuses.at(-1), { state: "live", width: 50, height: 50 });
  assert.deepEqual(slow.viewer.log.slice(-2), ["status:live", "frame:5"]); // status first, then the frame
  slow.lease.drained();
  assert.equal(slow.viewer.statuses.length, before + 1); // nothing pending any more
});

test("viewer cap holds across a replaced entry: old viewers still draining count until released", () => {
  const { hub } = make();
  const old = Array.from({ length: MAX_BROWSER_VIEWERS }, () => join(hub));
  hub.end("a1"); // entry ends; its viewers are told "ended" but have not detached yet
  assert.equal(old[0]!.viewer.closed[0], "ended");
  assert.equal(hub.acquire("a1"), null); // 8 draining viewers still fill the cap
  assert.equal(hub.viewers("a1"), MAX_BROWSER_VIEWERS);
  old[0]!.lease.detach();
  const fresh = hub.acquire("a1");
  assert.ok(fresh); // one released, one admitted
  assert.equal(hub.acquire("a1"), null); // and the cap is full again
  assert.equal(hub.viewers("a1"), MAX_BROWSER_VIEWERS);
  assert.ok(hub.acquire("other")); // per agent
});
