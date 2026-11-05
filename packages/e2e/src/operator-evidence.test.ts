import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { formatYieldEvidence, Timeline } from "./operator-evidence.ts";

function fixtureDb(dir: string): string {
  const path = join(dir, "pomtreed.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE journal (seq INTEGER, ts INTEGER, agent TEXT, generation INTEGER, payload TEXT);
    CREATE TABLE model_debit_agents (agent TEXT, spent_micros INTEGER);
    CREATE TABLE model_debit_requests (request_id TEXT, agent TEXT, status TEXT, charged_micros INTEGER, created_at INTEGER);
    INSERT INTO journal VALUES (1,1000,'ag-a',0,'{"kind":"yielded"}'),(2,1250,'ag-a',0,'{"kind":"interrupt_requested"}'),(3,9000,'ag-a',1,'{"kind":"resumed"}'),(4,1100,'ag-b',0,'{"kind":"started"}');
    INSERT INTO model_debit_agents VALUES ('ag-a',5);`);
  db.close();
  return path;
}

test("formatYieldEvidence lists the timeline, each agent's journal rows with ts and gaps, and the budget tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-cli-ev-"));
  try {
    const tl = new Timeline();
    tl.mark("sent");
    const text = formatYieldEvidence(fixtureDb(dir), { yielder: "ag-a" }, tl);
    assert.match(text, /\+0 \(\d+\) sent/);
    assert.match(text, /--- journal yielder ag-a/);
    assert.match(text, /seq=1 ts=1000 gen=0 \{"kind":"yielded"\}/);
    assert.match(text, /\+ {2}250 seq=2 ts=1250/, "the gap since the previous row is shown");
    assert.match(text, /\+ 7750 seq=3 ts=9000 gen=1 \{"kind":"resumed"\}/, "a slow resume shows as a large gap");
    assert.ok(!text.includes("ts=1100"), "only the named agents' journal rows are dumped");
    assert.match(text, /--- model_debit_agents|--- deadline-tables\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatYieldEvidence reports an unreadable database inline instead of throwing", () => {
  const text = formatYieldEvidence("/nonexistent/pomtreed.sqlite", { yielder: "ag-a" }, new Timeline());
  assert.match(text, /could not read the journal/);
  assert.match(text, /budget tables unreadable/);
});

test("formatYieldEvidence keeps each agent's journal readable when another agent's payload is not JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-cli-ev-"));
  try {
    const path = join(dir, "pomtreed.sqlite");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE journal (seq INTEGER, ts INTEGER, agent TEXT, generation INTEGER, payload TEXT);
      INSERT INTO journal VALUES (1,1000,'ag-a',0,'not json {'),(2,2000,'ag-b',0,'{"kind":"resumed"}');`);
    db.close();
    const text = formatYieldEvidence(path, { first: "ag-a", second: "ag-b" }, new Timeline());
    assert.match(text, /seq=1 ts=1000 gen=0 not json \{/, "the raw payload is printed");
    assert.match(text, /seq=2 ts=2000 gen=0 \{"kind":"resumed"\}/, "the later agent's journal is still dumped");
    assert.ok(!/could not read the journal/.test(text), "no agent's journal is reported unreadable");
    assert.match(text, /budget tables unreadable/, "the budget failure is still reported on its own");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
