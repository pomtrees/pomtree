import assert from "node:assert/strict";
import { test } from "node:test";
import { RingBuffer, trimToSafeStart } from "./ringbuffer.ts";

const b = (s: string): Uint8Array => new TextEncoder().encode(s);
const s = (u: Uint8Array): string => new TextDecoder().decode(u);

test("ring: append and snapshot in order", () => {
  const r = new RingBuffer(8);
  r.append(b("abc"));
  r.append(b("de"));
  assert.equal(r.size, 5);
  assert.equal(s(r.snapshot()), "abcde");
});

test("ring: exact fit does not evict", () => {
  const r = new RingBuffer(5);
  r.append(b("abcde"));
  assert.equal(r.size, 5);
  assert.equal(s(r.snapshot()), "abcde");
});

test("ring: wraparound evicts oldest and keeps order", () => {
  const r = new RingBuffer(5);
  r.append(b("abcd"));
  r.append(b("efg"));
  assert.equal(s(r.snapshot()), "cdefg");
  r.append(b("hijkl"));
  assert.equal(s(r.snapshot()), "hijkl");
  r.append(b("m"));
  assert.equal(s(r.snapshot()), "ijklm");
});

test("ring: oversized append keeps the tail", () => {
  const r = new RingBuffer(4);
  r.append(b("ab"));
  r.append(b("0123456789"));
  assert.equal(s(r.snapshot()), "6789");
  assert.equal(r.size, 4);
});

test("ring: clear, empty snapshot, bad capacity", () => {
  const r = new RingBuffer(4);
  r.append(b("abc"));
  r.clear();
  assert.equal(r.size, 0);
  assert.equal(r.snapshot().length, 0);
  r.append(b("z"));
  assert.equal(s(r.snapshot()), "z");
  assert.throws(() => new RingBuffer(0), RangeError);
  assert.equal(new RingBuffer().capacity, 256 * 1024);
});

test("ring: snapshot is a copy", () => {
  const r = new RingBuffer(4);
  r.append(b("ab"));
  const snap = r.snapshot();
  snap[0] = 0x7a;
  assert.equal(s(r.snapshot()), "ab");
});

test("ring: random chunks match a reference tail", () => {
  const r = new RingBuffer(7);
  let ref = "";
  for (let i = 0; i < 200; i++) {
    const chunk = "x".repeat(i % 5) + String.fromCharCode(97 + (i % 26));
    r.append(b(chunk));
    ref = (ref + chunk).slice(-7);
    assert.equal(s(r.snapshot()), ref);
  }
});

test("trim: after the first newline", () => {
  assert.equal(s(trimToSafeStart(b("31mgarbled\nline two\n"))), "line two\n");
});

test("trim: mid-CSI without newline drops through the next complete sequence", () => {
  assert.equal(s(trimToSafeStart(b("1;31mred\x1b[0mplain"))), "plain");
});

test("trim: mid-OSC terminated by BEL and by ST", () => {
  assert.equal(s(trimToSafeStart(b("x\x1b]0;title\x07after"))), "after");
  assert.equal(s(trimToSafeStart(b("x\x1b]0;title\x1b\\after"))), "after");
});

test("trim: incomplete trailing escape yields nothing", () => {
  assert.equal(trimToSafeStart(b("ab\x1b[1;3")).length, 0);
  assert.equal(trimToSafeStart(b("ab\x1b")).length, 0);
});

test("trim: leading UTF-8 continuation bytes dropped", () => {
  const euro = Buffer.from("€"); // e2 82 ac
  const cut = Buffer.concat([euro.subarray(1), Buffer.from("ok")]);
  assert.equal(s(trimToSafeStart(cut)), "ok");
  assert.equal(s(trimToSafeStart(b("€ok"))), "€ok");
});

test("trim: no newline and no ESC returns plain text unchanged; empty ok", () => {
  assert.equal(s(trimToSafeStart(b("just text"))), "just text");
  assert.equal(trimToSafeStart(new Uint8Array(0)).length, 0);
});

test("trim: two-byte escape boundary", () => {
  assert.equal(s(trimToSafeStart(b("zz\x1b7rest"))), "rest");
});
