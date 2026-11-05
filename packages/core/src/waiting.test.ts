import assert from "node:assert/strict";
import { test } from "node:test";
import { STEERED_KIND, WAITING_KIND, waitingStep } from "./waiting.ts";

const e = (kind: string, ts: number) => ({ ts, payload: { kind } });
const fold = (es: ReturnType<typeof e>[]) => es.reduce<number | null>(waitingStep, null);

test("waiting starts at the marker and survives passive entries", () => {
  assert.equal(fold([e("message", 1), e(WAITING_KIND, 5)]), 5);
  assert.equal(fold([e(WAITING_KIND, 5), e("message_received", 6), e("signal", 7), e("ext.pomtreed.interrupt", 8), e("ext.pomtreed.watchdog_nudge", 9)]), 5);
});

test("agent activity, a steer ack, a result or an exit ends the wait; a second marker restarts it", () => {
  for (const k of ["message", "tool_call", "tool_result", "usage", "error", "exited", STEERED_KIND]) assert.equal(fold([e(WAITING_KIND, 5), e(k, 6)]), null, k);
  assert.equal(fold([e(WAITING_KIND, 5), e("message", 6), e(WAITING_KIND, 9)]), 9);
});
