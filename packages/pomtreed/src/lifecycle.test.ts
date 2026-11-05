import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { DEFAULT_LIMITS, LifecycleError, agentIdFor, carve, checkFanout, findZombies, unreaped } from "./lifecycle.ts";

const rec = (o: Partial<AgentRecord>): AgentRecord =>
  ({
    id: "a",
    parent: "p",
    name: "n",
    task: "t",
    state: "exited",
    exit: "succeeded",
    result: null,
    host: "h",
    generation: 1,
    sandbox: null,
    budgetMicros: 1,
    createdAt: 0,
    updatedAt: 0,
    executor: "container",
    spec: { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "registry" } },
    ...o,
  }) as AgentRecord;
const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e) => e instanceof LifecycleError && e.status === 409 && re.test(e.message));

test("agentIdFor is deterministic, opaque, and scoped to the parent", () => {
  assert.equal(agentIdFor("p", "k"), agentIdFor("p", "k"));
  assert.notEqual(agentIdFor("p", "k"), agentIdFor("q", "k"));
  assert.notEqual(agentIdFor("p", "k"), agentIdFor("p", "k2"));
  assert.match(agentIdFor("p", "k"), /^ag-[0-9a-f]{26}$/);
});

test("checkFanout bounds depth for everyone and children only for non-root parents", () => {
  const l = { ...DEFAULT_LIMITS, maxDepth: 2, maxChildren: 2 };
  checkFanout(l, { depth: 2, liveChildren: 1, isRoot: false });
  refused(() => checkFanout(l, { depth: 3, liveChildren: 0, isRoot: false }), /depth 3/);
  refused(() => checkFanout(l, { depth: 3, liveChildren: 0, isRoot: true }), /depth 3/);
  refused(() => checkFanout(l, { depth: 1, liveChildren: 2, isRoot: false }), /2 unreaped children/);
  checkFanout(l, { depth: 1, liveChildren: 99, isRoot: true });
});

test("carve defaults to what is left, refuses overdraw, and refuses an empty default", () => {
  assert.equal(carve(undefined, 1000, 5000), 1000);
  assert.equal(carve(undefined, 1000, 300), 300);
  assert.equal(carve(200, 1000, 300), 200);
  assert.equal(carve(0, 1000, 300), 0);
  refused(() => carve(400, 1000, 300), /^budget \$0\.0004 \(400 micros\) exceeds the \$0\.0003 \(300 micros\) the parent has left; /);
  try {
    carve(2_500_000, 1000, 1_000_000);
    assert.fail("expected a refusal");
  } catch (e) {
    assert.ok(e instanceof LifecycleError);
    assert.equal(e.status, 409);
    assert.deepEqual(e.extra, { code: "budget_exceeds_parent" });
    assert.match(e.message, /^budget \$2\.50 \(2500000 micros\) exceeds the \$1\.00 \(1000000 micros\) the parent has left/);
  }
  refused(() => carve(undefined, 1000, 0), /no budget left/);
  // Negative: an empty default is a different class and carries no budget_exceeds_parent code.
  assert.throws(
    () => carve(undefined, 1000, 0),
    (e) => e instanceof LifecycleError && e.extra === undefined,
  );
});

test("findZombies picks exited, aged, non-root-parented agents only", () => {
  const all = [
    rec({ id: "old", updatedAt: 0 }),
    rec({ id: "fresh", updatedAt: 950 }),
    rec({ id: "rooted", parent: "root", updatedAt: 0 }),
    rec({ id: "reaped", state: "reaped", updatedAt: 0 }),
    rec({ id: "top", parent: null, updatedAt: 0 }),
  ];
  assert.deepEqual(
    findZombies(all, 1000, 100, "root").map((a) => a.id),
    ["old"],
  );
});

test("unreaped keeps everything not yet reaped", () => {
  assert.deepEqual(
    unreaped([rec({ id: "x", state: "running" }), rec({ id: "y", state: "reaped" }), rec({ id: "z" })]).map((a) => a.id),
    ["x", "z"],
  );
});
