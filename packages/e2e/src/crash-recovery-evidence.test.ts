import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { dumpDeadlineEvidence } from "./crash-recovery-evidence.ts";

function fixtureDb(dir: string): string {
  const path = join(dir, "pomtreed.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE journal (seq INTEGER, ts INTEGER, agent TEXT, generation INTEGER, payload TEXT);
    CREATE TABLE model_debit_agents (agent TEXT, spent_micros INTEGER);
    CREATE TABLE model_debit_requests (request_id TEXT, agent TEXT, status TEXT, charged_micros INTEGER, created_at INTEGER);
    CREATE TABLE reservations (agent TEXT, micros INTEGER);
    INSERT INTO journal VALUES (1,1000,'ag-a',0,'{"kind":"started"}'),(2,1100,'ag-b',0,'{"kind":"started"}'),(3,1250,'ag-a',0,'{"kind":"yielded"}');
    INSERT INTO model_debit_agents VALUES ('ag-a',700),('ag-b',300);
    INSERT INTO model_debit_requests VALUES ('r1','ag-a','settled',700,1),('r2','ag-b','settled',300,2);
    INSERT INTO reservations VALUES ('ag-a',5000);`);
  db.close();
  return path;
}

test("dumpDeadlineEvidence writes per-agent journals and debit rows, the budget tables, and the total spend", () => {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-crl-ev-"));
  try {
    const written = new Map<string, unknown>();
    const ev = dumpDeadlineEvidence(fixtureDb(dir), (n, v) => written.set(n, v));
    assert.deepEqual(ev, { spentMicrosTotal: 1000, error: null, agents: ["ag-a", "ag-b"] });
    assert.deepEqual(
      (written.get("journal-ag-a.json") as { seq: number }[]).map((e) => e.seq),
      [1, 3],
    );
    assert.deepEqual(
      (written.get("journal-ag-a.json") as { ts: number }[]).map((e) => e.ts),
      [1000, 1250],
      "the journal dump carries each row's commit timestamp",
    );
    assert.equal((written.get("debit-rows-ag-b.json") as unknown[]).length, 1);
    assert.deepEqual(Object.keys(written.get("deadline-tables.json") as object), ["model_debit_agents", "model_debit_requests", "reservations"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative control: a missing state database is reported, not thrown, and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-crl-ev-"));
  try {
    const written: string[] = [];
    const ev = dumpDeadlineEvidence(join(dir, "nope", "pomtreed.sqlite"), (n) => written.push(n));
    assert.equal(ev.spentMicrosTotal, null);
    assert.ok(ev.error);
    assert.deepEqual(written, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
