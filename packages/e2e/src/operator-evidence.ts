// Failure-time evidence for the cli-operator scenarios (YLD-4 flake). Not named cli-operator-*: the root test:docker globs match that prefix.
// It holds the journal rows with their commit timestamps, a harness-side timeline of
// when each step happened, and the daemon's budget and agent tables, so a failed run says whether a wake was lost, slow or wrong.
// Builds on crash-recovery-evidence.ts: journalRows (the one journal query) and dumpDeadlineEvidence (the budget and agent tables, debit rows).
// Pure over node:sqlite; no Docker or process coupling. Never throws: a database that cannot be read is reported inline.
import { DatabaseSync } from "node:sqlite";
import { dumpDeadlineEvidence, journalRows } from "./crash-recovery-evidence.ts";

export interface TimelineEntry {
  at: number; // Date.now() in the harness
  what: string;
}

// Records harness steps with absolute times, to be compared with journal `ts` (same clock, same machine).
export class Timeline {
  readonly entries: TimelineEntry[] = [];
  mark(what: string): void {
    this.entries.push({ at: Date.now(), what });
  }
}

const PAYLOAD_MAX = 240;

// One text block: harness timeline (times relative to the first mark, plus absolute ms), then per agent the journal rows (seq, ts, generation,
// payload) with the gap in ms since the previous row, then the debit rows and budget/agent tables. `agents` maps a label to an agent id.
export function formatYieldEvidence(dbPath: string, agents: Record<string, string>, timeline: Timeline): string {
  const out: string[] = [];
  const t0 = timeline.entries[0]?.at ?? 0;
  out.push("--- harness timeline (ms since first mark; absolute epoch ms)");
  for (const e of timeline.entries) out.push(`+${e.at - t0} (${e.at}) ${e.what}`);
  out.push(`+${Date.now() - t0} (${Date.now()}) evidence collected`);
  for (const [label, id] of Object.entries(agents)) {
    out.push(`--- journal ${label} ${id}`);
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        let prev: number | undefined;
        for (const r of journalRows(db, id)) {
          const line = `seq=${r.seq} ts=${r.ts} gen=${r.generation} ${r.payload.slice(0, PAYLOAD_MAX)}`;
          out.push(`${prev === undefined ? "      " : `+${String(r.ts - prev).padStart(5)}`} ${line}`);
          prev = r.ts;
        }
      } finally {
        db.close();
      }
    } catch (e) {
      out.push(`could not read the journal: ${(e as Error).message}`);
    }
  }
  const written = new Map<string, unknown>();
  const ev = dumpDeadlineEvidence(dbPath, (n, v) => written.set(n, v));
  if (ev.error) out.push(`--- budget tables unreadable: ${ev.error}`);
  for (const [name, value] of written) {
    if (name.startsWith("journal-")) continue; // rendered with gaps above
    if (name.startsWith("debit-rows-") && !Object.values(agents).some((id) => name === `debit-rows-${id}.json`)) continue;
    out.push(`--- ${name}`, JSON.stringify(value));
  }
  return out.join("\n");
}
