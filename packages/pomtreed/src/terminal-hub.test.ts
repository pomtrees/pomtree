import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxUnavailableError } from "@pomtree/core";
import { FakeTerminal } from "@pomtree/testing";
import { TerminalHub, clampSize, MAX_TERMINAL_COLS } from "./terminal-hub.ts";
import type { TerminalCloseReason, TerminalViewer } from "./terminal-hub.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 5));
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function viewer(backlog = 0) {
  const got: string[] = [];
  const closes: TerminalCloseReason[] = [];
  const v: TerminalViewer & { got: string[]; closes: TerminalCloseReason[]; backlogBytes: number } = {
    got,
    closes,
    backlogBytes: backlog,
    send: (c) => {
      got.push(dec(c));
    },
    backlog: () => v.backlogBytes,
    close: (r) => {
      closes.push(r);
    },
  };
  return v;
}

function hubWith() {
  const terms: FakeTerminal[] = [];
  let opens = 0;
  const hub = new TerminalHub({
    open: async (_a, size) => {
      opens++;
      const t = new FakeTerminal(size);
      terms.push(t);
      return t;
    },
    ringCapacity: 1024,
  });
  return { hub, terms, opens: () => opens };
}

test("clampSize: integers within bounds, rejects non-numbers", () => {
  assert.deepEqual(clampSize(100.9, 30), { cols: 100, rows: 30 });
  assert.deepEqual(clampSize(0, -5), { cols: 1, rows: 1 });
  assert.deepEqual(clampSize(1e9, 1e9), { cols: MAX_TERMINAL_COLS, rows: 200 });
  assert.equal(clampSize("80", 24), null);
  assert.equal(clampSize(NaN, 24), null);
});

test("hub: one shared session per agent; output fans out; input and resize reach it; redraw on join", async () => {
  const { hub, terms, opens } = hubWith();
  const l1 = await hub.acquire("a");
  const l2 = await hub.acquire("a");
  assert.equal(opens(), 1);
  const v1 = viewer();
  const v2 = viewer();
  l1.start(v1);
  l2.start(v2);
  assert.equal(terms[0]!.redraws, 2);
  terms[0]!.emit("hello");
  await tick();
  assert.deepEqual(v1.got, ["hello"]);
  assert.deepEqual(v2.got, ["hello"]);
  await l2.write(new TextEncoder().encode("ls\r"));
  assert.equal(terms[0]!.written, "ls\r");
  await l1.resize({ cols: 100, rows: 40 });
  assert.deepEqual(terms[0]!.resizes.at(-1), { cols: 100, rows: 40 });
});

test("hub: late joiner gets the ring snapshot (from a safe start) before live output", async () => {
  const { hub, terms } = hubWith();
  const l1 = await hub.acquire("a");
  l1.start(viewer());
  terms[0]!.emit("line1\nline2\nline3");
  await tick();
  const l2 = await hub.acquire("a");
  const late = viewer();
  l2.start(late);
  assert.deepEqual(late.got, ["line2\nline3"]); // trimToSafeStart drops the first (possibly cut) line
  terms[0]!.emit("!");
  await tick();
  assert.deepEqual(late.got, ["line2\nline3", "!"]);
});

test("hub: last viewer leaving closes the session; reuse opens a fresh session with an empty ring", async () => {
  const { hub, terms, opens } = hubWith();
  const l1 = await hub.acquire("a");
  const l2 = await hub.acquire("a");
  l1.start(viewer());
  l2.start(viewer());
  terms[0]!.emit("x\ny");
  await tick();
  l1.detach();
  assert.equal(terms[0]!.closes, 0);
  l1.detach(); // idempotent
  l2.detach();
  assert.equal(terms[0]!.closes, 1);
  assert.equal(hub.sessions, 0);
  const l3 = await hub.acquire("a");
  assert.equal(opens(), 2);
  const v = viewer();
  l3.start(v);
  assert.deepEqual(v.got, []);
});

test("hub: lease released before start still counts and closes the session", async () => {
  const { hub, terms } = hubWith();
  const l = await hub.acquire("a");
  l.detach();
  assert.equal(terms[0]!.closes, 1);
});

test("hub: container exit notifies every viewer once with the reason and frees the entry", async () => {
  const { hub, terms } = hubWith();
  const l1 = await hub.acquire("a");
  const l2 = await hub.acquire("a");
  const v1 = viewer();
  const v2 = viewer();
  l1.start(v1);
  l2.start(v2);
  terms[0]!.end();
  await tick();
  assert.deepEqual(v1.closes, ["remote"]);
  assert.deepEqual(v2.closes, ["remote"]);
  assert.equal(hub.sessions, 0);
  await l1.write(new Uint8Array([1])); // after close: ignored, no throw
  l1.detach();
  l2.detach();
  const v3 = viewer();
  (await hub.acquire("a")).start(v3);
  assert.equal(terms.length, 2);
});

test("hub: a stream error closes viewers with reason error", async () => {
  const { hub, terms } = hubWith();
  const l = await hub.acquire("a");
  const v = viewer();
  l.start(v);
  terms[0]!.end(new Error("boom"));
  await tick();
  assert.deepEqual(v.closes, ["error"]);
});

test("hub: a viewer past the backlog cap is dropped (error) without stalling the others", async () => {
  const { hub, terms } = hubWith();
  const l1 = await hub.acquire("a");
  const l2 = await hub.acquire("a");
  const slow = viewer();
  const fast = viewer();
  l1.start(slow);
  l2.start(fast);
  slow.backlogBytes = 5 * 1024 * 1024;
  terms[0]!.emit("a");
  await tick();
  assert.deepEqual(slow.closes, ["error"]);
  assert.deepEqual(slow.got, []);
  terms[0]!.emit("b");
  await tick();
  assert.deepEqual(fast.got, ["a", "b"]);
  assert.deepEqual(slow.got, []);
  assert.equal(terms[0]!.closes, 0); // fast still attached
});

test("hub: concurrent first attaches share one open; a failed open rejects all and is retried later", async () => {
  let opens = 0;
  let fail = true;
  const hub = new TerminalHub({
    open: async (_a, size) => {
      opens++;
      await tick();
      if (fail) throw new SandboxUnavailableError();
      return new FakeTerminal(size);
    },
  });
  const r = await Promise.allSettled([hub.acquire("a"), hub.acquire("a")]);
  assert.deepEqual(
    r.map((x) => x.status),
    ["rejected", "rejected"],
  );
  assert.equal(opens, 1);
  assert.equal(hub.sessions, 0);
  fail = false;
  await hub.acquire("a");
  assert.equal(opens, 2);
});

test("hub: closeAll tells viewers local and closes the sessions", async () => {
  const { hub, terms } = hubWith();
  const l = await hub.acquire("a");
  const v = viewer();
  l.start(v);
  hub.closeAll();
  assert.deepEqual(v.closes, ["local"]);
  assert.equal(terms[0]!.closes, 1);
  assert.equal(hub.sessions, 0);
});

test("hub: a lease that starts after the session ended is told immediately", async () => {
  const { hub, terms } = hubWith();
  const l = await hub.acquire("a");
  terms[0]!.end();
  await tick();
  const v = viewer();
  l.start(v);
  assert.deepEqual(v.closes, ["remote"]);
});

test("hub: onEsc fires only for a write that is exactly one 0x1b byte; CSI, Alt-chords, pastes and text do not; the write still goes through", async () => {
  const terms: FakeTerminal[] = [];
  const escs: string[] = [];
  const hub = new TerminalHub({
    open: async (_a, size) => {
      const t = new FakeTerminal(size);
      terms.push(t);
      return t;
    },
    onEsc: (a) => {
      escs.push(a);
    },
  });
  const l = await hub.acquire("a");
  const w = (b: number[]) => l.write(Uint8Array.from(b));
  await w([0x1b]);
  assert.deepEqual(escs, ["a"]);
  await w([0x1b, 0x5b, 0x41]); // ArrowUp (CSI)
  await w([0x1b, 0x4f, 0x41]); // ArrowUp (SS3)
  await w([0x1b, 0x62]); // Alt-b
  await w([0x68, 0x69, 0x1b]); // text ending in an Esc byte
  await l.write(new TextEncoder().encode("ls\r"));
  assert.deepEqual(escs, ["a"]);
  assert.equal(terms[0]!.written.length, 1 + 3 + 3 + 2 + 3 + 3, "every write is forwarded");
});

test("hub: a throwing onEsc is reported and never blocks the write", async () => {
  const terms: FakeTerminal[] = [];
  const errs: string[] = [];
  const hub = new TerminalHub({
    open: async (_a, size) => {
      const t = new FakeTerminal(size);
      terms.push(t);
      return t;
    },
    onEsc: () => {
      throw new Error("journal down");
    },
    onError: (_a, where) => {
      errs.push(where);
    },
  });
  const l = await hub.acquire("a");
  await l.write(Uint8Array.from([0x1b]));
  assert.deepEqual(errs, ["esc"]);
  assert.equal(terms[0]!.written, "\x1b");
});
