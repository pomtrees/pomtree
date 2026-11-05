// Evidence dump for the live crash-recovery harnesses (REC-1): reads the daemon's own accounting out of a pomtreed state database
// before the harness deletes the state dir, so a run that never finishes still leaves its spend, debit rows and journals behind.
// Thin over node:sqlite and a caller-supplied writer (which scrubs); no Docker or process coupling.
import { DatabaseSync } from "node:sqlite";

export interface DeadlineEvidence {
  spentMicrosTotal: number | null; // null when the database could not be read
  error: string | null;
  agents: string[];
}

type Writer = (name: string, value: unknown) => void;

export interface JournalRow {
  seq: number;
  ts: number;
  generation: number;
  payload: string; // raw JSON text, as stored
}

// One agent's journal rows in seq order, payload left unparsed. The single journal query, shared by the JSON dump below and the text dump in operator-evidence.ts.
export function journalRows(db: DatabaseSync, agent: string): JournalRow[] {
  return db.prepare("SELECT seq, ts, generation, payload FROM journal WHERE agent=? ORDER BY seq").all(agent) as unknown as JournalRow[];
}

// Writes journal-<agent>.json, debit-rows-<agent>.json and deadline-tables.json (every model_debit* table plus reservations, journal_spend and agents), and returns
// the total spend. Never throws: a missing or unreadable database is reported in `error` with spentMicrosTotal null.
export function dumpDeadlineEvidence(dbPath: string, write: Writer): DeadlineEvidence {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return { spentMicrosTotal: null, error: (e as Error).message, agents: [] };
  }
  try {
    const agents = (db.prepare("SELECT DISTINCT agent FROM journal ORDER BY agent").all() as { agent: string }[]).map((r) => r.agent);
    for (const agent of agents) {
      const journal = journalRows(db, agent).map((r) => ({ seq: r.seq, ts: r.ts, generation: r.generation, payload: JSON.parse(r.payload) }));
      write(`journal-${agent}.json`, journal);
      write(`debit-rows-${agent}.json`, db.prepare("SELECT * FROM model_debit_requests WHERE agent=? ORDER BY created_at, request_id").all(agent));
    }
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'model_debit%' OR name IN ('reservations', 'journal_spend', 'agents')) ORDER BY name",
        )
        .all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    write("deadline-tables.json", Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()])));
    const s = (db.prepare("SELECT COALESCE(SUM(spent_micros), 0) AS s FROM model_debit_agents").get() as { s: number }).s;
    return { spentMicrosTotal: Number(s), error: null, agents };
  } catch (e) {
    return { spentMicrosTotal: null, error: (e as Error).message, agents: [] };
  } finally {
    db.close();
  }
}
