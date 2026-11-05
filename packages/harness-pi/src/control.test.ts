import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripControl } from "./control.ts";
import { normalizeRecord } from "./pi-format.ts";

// The cases pomtree's sanitize.test.ts pins for its copy (TODO(sanitize-core)); the same list here keeps the two in step.
test("stripControl matches pomtree's case list: CSI, OSC, DCS, Fe escapes and C0/C1, keeping LF and TAB", () => {
  assert.equal(stripControl("hello world"), "hello world");
  assert.equal(stripControl("café"), "café");
  assert.equal(stripControl("a\x1b[31mred\x1b[0m"), "ared");
  assert.equal(stripControl("\x1b[2J\x1b[H"), "");
  assert.equal(stripControl("\x1b]8;;http://x\x07link\x1b]8;;\x07"), "link");
  assert.equal(stripControl("a\x1bP0;t\x1b\\b"), "ab");
  assert.equal(stripControl("a\x1b7b\x1b8c"), "abc");
  assert.equal(stripControl("a\rb\bc\x07d\x1be"), "abcd");
  assert.equal(stripControl("a\u009bb\u009dc"), "abc");
  assert.equal(stripControl("a\nb\tc"), "a\nb\tc");
});

test("the harness copy of stripControl is the same code as pomtree's (drift guard until it moves to core)", () => {
  const body = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.trim().startsWith(".replace("));
  const ours = body("./control.ts");
  assert.equal(ours.length, 5);
  assert.deepEqual(ours, body("../../pomtree/src/sanitize.ts"));
});

const assistant = (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

test("normalizeRecord strips spinner frames and ANSI redraws from message text before it reaches the journal", () => {
  const spinner = "\x1b[?25l\r\x1b[2K⠋ Working…\r\x1b[2K⠙ Working…\x1b[0m\x1b[?25h\nDone: 3 files changed";
  assert.deepEqual(normalizeRecord(assistant(spinner)), [{ kind: "message", role: "assistant", text: "⠋ Working…⠙ Working…\nDone: 3 files changed" }]);
  assert.deepEqual(normalizeRecord({ type: "message_end", message: { role: "user", content: "\x1b]0;title\x07hi" } }), [
    { kind: "message", role: "user", text: "hi" },
  ]);
  assert.deepEqual(normalizeRecord({ type: "user_input", text: "typed\x1b[D\x1b[C" }), [{ kind: "user_input", text: "typed" }]);
  // Negative: plain text, including tabs, newlines and non-ASCII, is unchanged.
  const plain = "line 1\n\tindented — ünïcode ⠋";
  assert.deepEqual(normalizeRecord(assistant(plain)), [{ kind: "message", role: "assistant", text: plain }]);
});

test("normalizeRecord strips controls from tool names, tool output and error text; details stay as Pi sent them", () => {
  assert.deepEqual(normalizeRecord({ type: "tool_execution_start", toolCallId: "c", toolName: "bash\x1b[31m", args: { cmd: "ls\x1b[0m" } }), [
    { kind: "tool_call", tool: "bash", callId: "c", input: { cmd: "ls\x1b[0m" } },
  ]);
  const details = { exitCode: 1, raw: "\x1b[31mred" };
  const [r] = normalizeRecord({
    type: "tool_execution_end",
    toolCallId: "c",
    isError: true,
    result: { content: [{ type: "text", text: "\x1b[1;31merror:\x1b[0m boom\r\n" }], details },
  });
  assert.deepEqual(r, { kind: "tool_result", callId: "c", ok: false, output: "error: boom\n", details });
  const [e] = normalizeRecord({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "\x1b[31mbash tool failed\x1b[0m" },
  });
  assert.deepEqual(e, { kind: "error", message: "bash tool failed" });
  assert.deepEqual(normalizeRecord({ type: "session_compact_failed", errorMessage: "\x07x" }), [{ kind: "error", message: "compaction failed: x" }]);
  assert.deepEqual(normalizeRecord({ type: "operator_diagnostic", message: "\x1b[2Jnote" }), [{ kind: "error", message: "note" }]);
});

test("stripControl: an unterminated DCS/SOS/PM/APC loses only its introducer, never the text or cause suffix after it", () => {
  assert.equal(stripControl("safe \u001bP IGNORE ALL \n more (cause=budget)"), "safe  IGNORE ALL \n more (cause=budget)");
  for (const c of "PX^_") assert.equal(stripControl(`a\u001b${c}hidden (cause=oom)`), "ahidden (cause=oom)", c);
  // A terminated string is still removed whole (ST as ESC \ or C1 0x9c), and a later one does not reach back.
  assert.equal(stripControl("a\u001bPsecret\u001b\\b\u001bPtail"), "abtail");
  assert.equal(stripControl("a\u001b_x\u009cb"), "ab");
});

test("normalizeRecord keeps text after an unterminated DCS in a message; text parts are joined before stripping", () => {
  assert.deepEqual(normalizeRecord(assistant("ok \u001bP hidden? (cause=budget)")), [
    { kind: "message", role: "assistant", text: "ok  hidden? (cause=budget)" },
  ]);
  // A sequence split across two text parts is stripped after the join, not left as residue.
  const split = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "a\u001b[3" },
        { type: "text", text: "1mb" },
      ],
    },
  };
  assert.deepEqual(normalizeRecord(split), [{ kind: "message", role: "assistant", text: "ab" }]);
});
