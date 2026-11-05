// REC-1 side poller (harness.sh rec1). Read-only: opens the newest <tmp>/pomtree-crlm-*/state/pomtreed.sqlite every 2 s and prints, once each,
// the budget-stall evidence: budget_escalated / budget_granted journal rows (ids and numbers only), the stall-unescalated error rows (seq only),
// approvals (id, requester, kind, state) and unsettled model debit rows. It prints no message text, payload body, key or token.
// Usage: node rec1-poll.mjs <tmp dir>; killed by harness.sh when the harness exits.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmp = process.argv[2];
const seen = new Set();
const num = (v) => (typeof v === "number" ? v : v === null ? "null" : undefined);
const emit = (o) => {
  const line = JSON.stringify(o);
  if (!seen.has(line)) {
    seen.add(line);
    console.log(`${new Date().toISOString()} ${line}`);
  }
};
const t0 = Date.now();
setInterval(() => {
  let dir;
  try {
    // Only roots created after this poller started belong to this run.
    dir = readdirSync(tmp)
      .filter((d) => d.startsWith("pomtree-crlm-"))
      .map((d) => join(tmp, d))
      .filter((d) => statSync(d).ctimeMs >= t0 - 5000)
      .sort((a, b) => statSync(b).ctimeMs - statSync(a).ctimeMs)[0];
  } catch {
    return;
  }
  if (!dir) return;
  emit({ t: "root", dir });
  let db;
  try {
    db = new DatabaseSync(join(dir, "state", "pomtreed.sqlite"), { readOnly: true });
  } catch {
    return; // not there yet
  }
  const each = (sql, fn) => {
    try {
      for (const r of db.prepare(sql).all()) fn(r);
    } catch {
      // table missing or mid-write: next tick
    }
  };
  each("SELECT seq, agent, generation, payload FROM journal WHERE payload LIKE '%budget_escalated%' OR payload LIKE '%budget_granted%' ORDER BY seq", (r) => {
    const p = JSON.parse(r.payload);
    emit({
      t: "journal",
      seq: r.seq,
      agent: r.agent,
      gen: r.generation,
      kind: p.kind,
      approval: p.approval,
      requested: num(p.requested),
      spent: num(p.spent),
      budget: num(p.budget),
      remainingMicros: num(p.remainingMicros),
      minimumMicros: num(p.minimumMicros),
    });
  });
  each(
    "SELECT seq, agent, generation FROM journal WHERE payload LIKE '%budget-stall-unescalated%' OR (payload LIKE '%\"kind\":\"error\"%' AND payload LIKE '%out of budget%') ORDER BY seq",
    (r) => emit({ t: "stall-error", seq: r.seq, agent: r.agent, gen: r.generation }),
  );
  each("SELECT id, requester_id, action_kind, state, rung_index FROM approvals", (r) => emit({ t: "approval", ...r }));
  each("SELECT agent, request_id, status, charged_micros, maximum_micros FROM model_debit_requests WHERE status <> 'settled'", (r) =>
    emit({ t: "debit", ...r }),
  );
  each("SELECT id, state, generation FROM agents", (r) => emit({ t: "agent", ...r }));
  db.close();
}, 2000);
