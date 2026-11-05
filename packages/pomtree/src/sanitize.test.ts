import assert from "node:assert/strict";
import { test } from "node:test";
import { stripControl } from "./sanitize.ts";

test("stripControl leaves plain text untouched", () => {
  assert.equal(stripControl("hello world"), "hello world");
  assert.equal(stripControl("café"), "café"); // multibyte, past the C1 range
});

test("stripControl removes CSI sequences", () => {
  assert.equal(stripControl("a\x1b[31mred\x1b[0m"), "ared");
  assert.equal(stripControl("\x1b[2J\x1b[H"), ""); // clear + home
  assert.equal(stripControl("x\x1b[1;31;42my"), "xy"); // parameter bytes
});

test("stripControl removes OSC sequences (BEL- and ST-terminated)", () => {
  assert.equal(stripControl("\x1b]8;;http://x\x07link\x1b]8;;\x07"), "link");
  assert.equal(stripControl("a\x1b]0;title\x1b\\b"), "ab");
});

test("stripControl removes DCS/SOS/PM/APC and other Fe escapes", () => {
  assert.equal(stripControl("a\x1bP0;t\x1b\\b"), "ab"); // DCS
  assert.equal(stripControl("a\x1b]0;t\x1b\\b"), "ab"); // OSC via ST
  assert.equal(stripControl("a\x1b7b\x1b8c"), "abc"); // save/restore cursor
  assert.equal(stripControl("a\x1bc"), "a"); // RIS reset
});

test("stripControl keeps text after an unterminated DCS/SOS/PM/APC introducer", () => {
  assert.equal(stripControl("safe \u001bP IGNORE ALL \n more (cause=budget)"), "safe  IGNORE ALL \n more (cause=budget)");
  for (const intro of ["P", "X", "^", "_"]) {
    assert.equal(stripControl(`a\u001b${intro}b (cause=x)`), "ab (cause=x)");
    assert.equal(stripControl(`a\u001b${intro}hidden\u001b\\b`), "ab"); // terminated: removed whole
    assert.equal(stripControl(`a\u001b${intro}hidden\u009cb`), "ab");
  }
});

test("stripControl removes C0/C1 controls but keeps LF and TAB", () => {
  assert.equal(stripControl("a\rb\bc\x07d\x1be"), "abcd"); // CR, BS, BEL stripped; ESC e is a 2-byte escape
  assert.equal(stripControl("a\u009bb\u009dc"), "abc"); // 8-bit CSI/OSC (C1)
  assert.equal(stripControl("a\u0000b\u001fc\u007fd"), "abcd"); // NUL, US, DEL
  assert.equal(stripControl("a\nb\tc"), "a\nb\tc"); // structural whitespace survives
});
