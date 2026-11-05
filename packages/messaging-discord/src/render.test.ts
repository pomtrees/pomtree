import assert from "node:assert/strict";
import { test } from "node:test";
import { CUSTOM_ID_MAX, MAX_OUTBOUND_LENGTH, decodeAction, encodeAction, parseEscalationId, renderReceipt, withStatus } from "./render.ts";

const AP = `ap-${"0123456789abcdef".repeat(2)}`;
const ES = `es-${"f".repeat(64)}`;

test("renderReceipt renders a workflow launch", () => {
  assert.equal(renderReceipt({ kind: "launched", agent: "a7" }), "✓ launched a7");
});

test("parseEscalationId correlates approval ids as well as escalation ids, and not a longer hex run", () => {
  assert.equal(parseEscalationId(`approve publish? ${AP} reply approve or deny`), AP);
  assert.equal(parseEscalationId(`see ${ES}`), ES);
  assert.equal(parseEscalationId(`${AP}0`), undefined);
  assert.equal(parseEscalationId(`ap-${"A".repeat(32)}`), undefined);
});

test("encodeAction and decodeAction round-trip within Discord's custom_id limit", () => {
  for (const a of [
    { id: AP, choice: { kind: "approve" } },
    { id: AP, choice: { kind: "deny" } },
    { id: AP, choice: { kind: "pass" } },
    { id: ES, choice: { kind: "pass" } },
    { id: ES, choice: { kind: "option", index: 0 } },
    { id: ES, choice: { kind: "option", index: 24 } },
  ] as const) {
    const s = encodeAction(a);
    assert.ok(s.length <= CUSTOM_ID_MAX, s);
    assert.deepEqual(decodeAction(s), a);
  }
  assert.throws(() => encodeAction({ id: ES, choice: { kind: "approve" } }));
  assert.throws(() => encodeAction({ id: ES, choice: { kind: "option", index: 25 } }));
  assert.equal(decodeAction("pair:approve:bob"), null);
});

test("withStatus appends one status line, replaces an earlier one, and stays within the Discord limit", () => {
  assert.equal(withStatus("[ask] q", "approve by A"), "[ask] q\n— approve by A");
  assert.equal(withStatus("[ask] q\n— failed, press again", "approve by A"), "[ask] q\n— approve by A");
  const long = withStatus("x".repeat(MAX_OUTBOUND_LENGTH), "done");
  assert.equal(long.length, MAX_OUTBOUND_LENGTH);
  assert.ok(long.endsWith("[truncated]\n— done"));
  assert.equal(withStatus(undefined, "done"), "\n— done");
});
