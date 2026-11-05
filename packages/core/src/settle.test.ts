import assert from "node:assert/strict";
import { test } from "node:test";
import { WAITING_KIND } from "./waiting.ts";
import { USER_ESC_KIND, USER_ESC_WINDOW_MS, isUserAbort, AWAIT_USER_KIND, PASSIVE_SETTLE_KIND, USER_INPUT_KIND, initialSettle, settleStep } from "./settle.ts";

const e = (kind: string) => ({ payload: { kind } });
const fold = (ks: string[]) => ks.map(e).reduce(settleStep, initialSettle);

test("consecutive passive settles count; text-only replies and bookkeeping do not reset", () => {
  assert.equal(fold([PASSIVE_SETTLE_KIND, "message", "usage", "signal", "ext.pomtreed.steered", PASSIVE_SETTLE_KIND]).passive, 2);
});

test("a tool call, an interactive message or a waiting marker resets the count", () => {
  assert.equal(fold([PASSIVE_SETTLE_KIND, "tool_call"]).passive, 0);
  assert.equal(fold([PASSIVE_SETTLE_KIND, "message_received"]).passive, 0);
  assert.equal(fold([PASSIVE_SETTLE_KIND, USER_INPUT_KIND]).passive, 0);
  assert.equal(fold([PASSIVE_SETTLE_KIND, WAITING_KIND]).passive, 0);
});

test("typed input or an operator message makes await-user acceptable; accepting declares the settle and consumes the message", () => {
  assert.deepEqual(fold([USER_INPUT_KIND]), { passive: 0, human: true, declared: false, lastEsc: null });
  assert.equal(fold(["message_received", "tool_call"]).human, true);
  assert.deepEqual(fold(["message_received", AWAIT_USER_KIND]), { passive: 0, human: false, declared: true, lastEsc: null });
  assert.equal(fold(["child_exited", "signal", "message"]).human, false, "only interactive messages count");
});

test("a new human message withdraws a pending declaration; a waiting marker consumes it; a passive settle keeps the unanswered message", () => {
  assert.equal(fold([USER_INPUT_KIND, AWAIT_USER_KIND, USER_INPUT_KIND]).declared, false);
  assert.deepEqual(fold([USER_INPUT_KIND, AWAIT_USER_KIND, WAITING_KIND]), { passive: 0, human: false, declared: false, lastEsc: null });
  assert.deepEqual(fold([USER_INPUT_KIND, PASSIVE_SETTLE_KIND]), { passive: 1, human: true, declared: false, lastEsc: null });
});

test("isUserAbort needs both the sink flag and a viewer Esc inside the window; a waiting marker consumes the Esc", () => {
  const st = [{ ts: 1000, payload: { kind: USER_ESC_KIND } }].reduce(settleStep, initialSettle);
  assert.equal(isUserAbort(st, true, 1000 + USER_ESC_WINDOW_MS), true);
  assert.equal(isUserAbort(st, true, 1001 + USER_ESC_WINDOW_MS), false, "too old");
  assert.equal(isUserAbort(st, true, 999), false, "Esc after the settle");
  assert.equal(isUserAbort(st, false, 1000), false, "no sink flag");
  assert.equal(isUserAbort(st, undefined, 1000), false);
  assert.equal(isUserAbort(initialSettle, true, 1000), false, "forged flag, no Esc");
  assert.equal(isUserAbort([e(WAITING_KIND)].reduce(settleStep, st), true, 1000), false);
});
