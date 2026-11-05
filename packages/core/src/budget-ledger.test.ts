import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetLedger, LEDGER_MAX_DEPTH, type LedgerNode, ledgerAncestry, ledgerFits } from "./index.ts";

const node = (id: string, parent: string | null, budgetMicros: number, usedMicros = 0): LedgerNode => ({ id, parent, budgetMicros, live: true, usedMicros });

test("ledgerFits admits a fitting reservation and refuses an exhausted one with cause exhausted", () => {
  const v = budgetLedger([node("root", null, 1000), node("a", "root", 400, 100)]);
  assert.deepEqual(ledgerFits(v, "a", 300), { ok: true });
  const r = ledgerFits(v, "a", 301);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.cause, "exhausted");
    assert.equal(r.at, "a");
    assert.equal(r.remainingMicros, 300);
  }
});

test("ledgerFits refuses when a parent cycle keeps the walk from any root, even when the carve absorbs the growth", () => {
  // a <-> b: no root; a's carve would absorb a small reservation before the old walk ever noticed.
  const v = budgetLedger([node("root", null, 1000), node("a", "b", 500), node("b", "a", 500)]);
  const r = ledgerFits(v, "a", 1);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.cause, "cycle");
    assert.match(r.reason, /cycle/);
    assert.match(r.reason, /fail closed/);
  }
});

test("ledgerFits refuses when an ancestor is missing from the ledger and names the missing parent", () => {
  const v = budgetLedger([node("root", null, 1000), node("a", "ghost", 500)]);
  const r = ledgerFits(v, "a", 1);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.cause, "unknown-node");
    assert.equal(r.at, "ghost");
    assert.match(r.reason, /ghost/);
  }
  const unknown = ledgerFits(v, "nobody", 1);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.cause, "unknown-node");
});

test("ledgerFits refuses a chain deeper than LEDGER_MAX_DEPTH, and admits one at the limit", () => {
  const chain = (n: number): LedgerNode[] => {
    const nodes = [node("n0", null, 1_000_000)];
    for (let i = 1; i < n; i++) nodes.push(node(`n${i}`, `n${i - 1}`, 1_000_000 - i));
    return nodes;
  };
  const atLimit = budgetLedger(chain(LEDGER_MAX_DEPTH));
  assert.deepEqual(ledgerFits(atLimit, `n${LEDGER_MAX_DEPTH - 1}`, 1), { ok: true });
  const over = budgetLedger(chain(LEDGER_MAX_DEPTH + 1));
  const r = ledgerFits(over, `n${LEDGER_MAX_DEPTH}`, 1);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.cause, "too-deep");
    assert.match(r.reason, new RegExp(String(LEDGER_MAX_DEPTH)));
  }
});

test("ledgerAncestry returns the chain from the node to its root", () => {
  const v = budgetLedger([node("root", null, 1000), node("a", "root", 500), node("b", "a", 100)]);
  const r = ledgerAncestry(v, "b");
  assert.equal(r.ok, true);
  if (r.ok)
    assert.deepEqual(
      r.chain.map((n) => n.id),
      ["b", "a", "root"],
    );
});
