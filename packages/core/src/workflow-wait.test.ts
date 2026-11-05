import assert from "node:assert/strict";
import test from "node:test";
import { validWorkflowState, validWorkflowWait, waitChildIds, WORKFLOW_STATE_MAX_BYTES } from "./workflow-wait.ts";

test("validWorkflowWait accepts a nested any of message, timer and child_exited waits", () => {
  assert.equal(
    validWorkflowWait({
      kind: "any",
      of: [{ kind: "message" }, { kind: "timer", at: 5 }, { kind: "any", of: [{ kind: "child_exited", children: ["c"], mode: "all" }] }],
    }),
    true,
  );
});

test("validWorkflowWait bounds any: empty, more than 32 members, and invalid members are rejected", () => {
  assert.equal(validWorkflowWait({ kind: "any", of: [] }), false);
  const at32 = Array.from({ length: 32 }, () => ({ kind: "message" }));
  const at33 = Array.from({ length: 33 }, () => ({ kind: "message" }));
  assert.equal(validWorkflowWait({ kind: "any", of: at32 }), true);
  assert.equal(validWorkflowWait({ kind: "any", of: at33 }), false);
  assert.equal(validWorkflowWait({ kind: "any", of: [{ kind: "message" }, { kind: "bogus" }] }), false);
  assert.equal(validWorkflowWait({ kind: "any", of: [{ kind: "timer", at: -1 }] }), false);
});

test("validWorkflowWait limits any nesting to depth 16", () => {
  const nest = (n: number): unknown => {
    let w: unknown = { kind: "message" };
    for (let i = 0; i < n; i++) w = { kind: "any", of: [w] };
    return w;
  };
  assert.equal(validWorkflowWait(nest(16)), true);
  assert.equal(validWorkflowWait(nest(17)), false);
});

test("validWorkflowWait rejects unknown kinds and non-object values", () => {
  assert.equal(validWorkflowWait({ kind: "sleep" }), false);
  assert.equal(validWorkflowWait({}), false);
  assert.equal(validWorkflowWait(null), false);
  assert.equal(validWorkflowWait(undefined), false);
  assert.equal(validWorkflowWait("message"), false);
  assert.equal(validWorkflowWait(5), false);
});

test("validWorkflowWait timer requires a finite non-negative number", () => {
  assert.equal(validWorkflowWait({ kind: "timer", at: 0 }), true);
  assert.equal(validWorkflowWait({ kind: "timer", at: -1 }), false);
  assert.equal(validWorkflowWait({ kind: "timer", at: Number.NaN }), false);
  assert.equal(validWorkflowWait({ kind: "timer", at: Number.POSITIVE_INFINITY }), false);
  assert.equal(validWorkflowWait({ kind: "timer", at: "5" }), false);
  assert.equal(validWorkflowWait({ kind: "timer" }), false);
});

test("validWorkflowWait child_exited requires 1 to 256 string children and a known mode", () => {
  assert.equal(validWorkflowWait({ kind: "child_exited", children: [], mode: "any" }), false);
  assert.equal(validWorkflowWait({ kind: "child_exited", children: ["c"], mode: "any" }), true);
  const at256 = Array.from({ length: 256 }, (_, i) => `c${i}`);
  assert.equal(validWorkflowWait({ kind: "child_exited", children: at256, mode: "all" }), true);
  const at257 = Array.from({ length: 257 }, (_, i) => `c${i}`);
  assert.equal(validWorkflowWait({ kind: "child_exited", children: at257, mode: "all" }), false);
  assert.equal(validWorkflowWait({ kind: "child_exited", children: [1], mode: "all" }), false);
  assert.equal(validWorkflowWait({ kind: "child_exited", children: ["c"], mode: "first" }), false);
  assert.equal(validWorkflowWait({ kind: "child_exited", children: ["c"] }), false);
});

test("validWorkflowState accepts JSON up to the byte cap and rejects larger or non-JSON state", () => {
  const atCap = "x".repeat(WORKFLOW_STATE_MAX_BYTES - 2); // JSON.stringify adds the two quotes
  assert.equal(validWorkflowState(atCap), true);
  assert.equal(validWorkflowState(`${atCap}x`), false);
  assert.equal(validWorkflowState("\u00e9".repeat(WORKFLOW_STATE_MAX_BYTES / 2)), false, "the cap counts UTF-8 bytes, not characters");
  assert.equal(validWorkflowState({ n: [1, null, "a"] }), true);
  assert.equal(validWorkflowState(undefined), false);
  assert.equal(
    validWorkflowState(() => 1),
    false,
  );
  assert.equal(validWorkflowState(Number.NaN), false);
});

test("validWorkflowState counts UTF-8 bytes at the 64KB boundary for 2-, 3- and 4-byte characters", () => {
  // Each JSON string adds two quote bytes. "é" is 2 bytes, "€" 3 bytes, "😀" 4 bytes (two UTF-16 units).
  assert.equal(validWorkflowState("é".repeat(32767)), true, "2 bytes x 32767 + quotes = 65536");
  assert.equal(validWorkflowState(`${"é".repeat(32767)}a`), false, "65537 bytes is over the cap");
  assert.equal(validWorkflowState("€".repeat(21844)), true, "3 bytes x 21844 + quotes = 65534");
  assert.equal(validWorkflowState("€".repeat(21845)), false, "65537 bytes is over the cap");
  assert.equal(validWorkflowState("\u{1F600}".repeat(16383)), true, "4 bytes x 16383 + quotes = 65534");
  assert.equal(validWorkflowState("\u{1F600}".repeat(16384)), false, "65538 bytes is over the cap");
});

test("waitChildIds enumerates children through nested any and is empty for message and timer", () => {
  assert.deepEqual(waitChildIds({ kind: "message" }), []);
  assert.deepEqual(waitChildIds({ kind: "timer", at: 1 }), []);
  assert.deepEqual(waitChildIds({ kind: "child_exited", children: ["a", "b"], mode: "all" }), ["a", "b"]);
  assert.deepEqual(
    waitChildIds({
      kind: "any",
      of: [
        { kind: "timer", at: 1 },
        { kind: "child_exited", children: ["a"], mode: "any" },
        { kind: "any", of: [{ kind: "child_exited", children: ["b", "c"], mode: "all" }] },
      ],
    }),
    ["a", "b", "c"],
  );
});
