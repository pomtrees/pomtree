// Verify a live relay run directory (RLY-5/RLY-6/CUS-1). Usage: node verify-relay.mjs <rundir> <topBudget> <k>
// <k> is relay.sh's k, so the leaf level is k+1. It is REQUIRED: without it this file cannot tell a relay that relayed
// from one where the top did the whole task itself, which is the one thing a relay run has to prove.
// Serves: RLY-5, RLY-6 and CUS-1. Reads only the files relay.sh wrote into <rundir>; no network, no key.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const [dir, topB, kArg] = process.argv.slice(2);
const k = Number(kArg);
const shows = readdirSync(dir)
  .filter((f) => /^show-ag-.*\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
const agents = shows.map((s) => ({ ...s.agent, events: s.events ?? [] }));
const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
const norm = (t) =>
  String(t ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
const traces = Object.fromEntries(
  agents.map((a) => {
    try {
      return [a.id, readFileSync(join(dir, `trace-${a.id}.md`), "utf8")];
    } catch {
      return [a.id, ""];
    }
  }),
);
let html = "";
try {
  html = readFileSync(join(dir, "poem.html"), "utf8");
} catch {}
const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
const pre = body
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^>]+>/g, "\n")
  .replace(/&amp;/g, "&")
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&quot;/g, '"');
const names = agents.map((a) => a.name).sort();
const out = [];
const ok = (name, cond, detail) => out.push(`${cond ? "ok  " : "FAIL"} ${name}: ${detail}`);
const top = byName["relay-1"];
const leafName = names[names.length - 1];
const leaf = byName[leafName];
const spend = JSON.parse(readFileSync(join(dir, "spend.json"), "utf8")).totalSpendMicros;
// The levels check used to be `ok("levels", true, ...)`: hard-coded true, with k never passed in. A run in which the top
// agent skipped spawning and wrote the poem itself therefore passed every check, because `leafName` is just the last name in
// sort order and became the top itself. That is the relay property this verifier exists to assert, so it is now a real check.
const leafExpected = `relay-${k + 1}`;
ok("levels: k given", Number.isInteger(k) && k >= 0, `k=${kArg}`);
ok("levels: the leaf level was reached", names.includes(leafExpected), `expected ${leafExpected} among the agents, saw ${names.join(",") || "none"}`);
ok("levels: the poem's leaf IS the leaf level", leafName === leafExpected, `leaf used ${leafName ?? "none"}, expected ${leafExpected}`);
for (const a of agents) {
  const settle = (traces[a.id].match(/model_settlement/g) ?? []).length;
  out.push(
    `-    ${a.name} ${a.id} state=${a.state}/${a.exit} gen=${a.generation} budget=${a.budgetMicros} parent=${a.parent?.slice(0, 12)} trace-settlements~${settle}`,
  );
}
ok("top succeeded", top?.exit === "succeeded", `${top?.state}/${top?.exit}`);
ok(
  "poem: top result == leaf result",
  norm(top?.result?.summary) === norm(leaf?.result?.summary) && norm(leaf?.result?.summary) !== "",
  `top ${norm(top?.result?.summary).length} chars, leaf ${norm(leaf?.result?.summary).length} chars`,
);
ok("poem: report == leaf result", norm(pre) === norm(leaf?.result?.summary), `report ${norm(pre).length} chars`);
for (const a of agents) {
  if (a === top) continue;
  const parent = agents.find((p) => p.id === a.parent);
  ok(`${a.name} reaped`, a.state === "reaped", a.state);
  ok(`${a.name} budget <= parent budget`, parent && a.budgetMicros < parent.budgetMicros, `${a.budgetMicros} < ${parent?.budgetMicros}`);
  const t = traces[parent?.id] ?? "";
  const op = a.events.find((e) => e.payload?.kind === "ext.pomtreed.op" && e.payload.op === "reap");
  // A reap returns what the agent still HELD: its carve, less its OWN spend, less the carves still out with its children,
  // because each child's remainder comes back through that child's own reap and not through its parent's. This used to
  // subtract the whole SUBTREE's spend, which coincides only for a leaf, so it passed for a leaf and for a k=1 relay and
  // could never have been right for a middle with a child. CUS-1 on 2026-11-04 is the run that showed it: relay-2 returned
  // 28435 = 89709 carve - 1952 own - 59322 carved on, while the old formula expected 89709 - 2783 = 86926. The daemon was
  // right and this check was wrong; the whole-tree reconciliation below is what actually guards against losing money.
  const own = (x) => [...traces[x.id].matchAll(/"micros":(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0); // settlements from the full trace
  const carvedOn = agents.filter((c) => c.parent === a.id).reduce((n, c) => n + c.budgetMicros, 0);
  const held = a.budgetMicros - own(a) - carvedOn;
  ok(
    `${a.name} reap unusedMicros == carve - own spend - carves to children`,
    op && op.payload.unusedMicros === held,
    `unused ${op?.payload.unusedMicros}, ${a.budgetMicros} - own ${own(a)} - carved on ${carvedOn} = ${held}`,
  );
  ok(`${a.name} reaped by its parent's own pomtree reap`, t.includes("pomtree reap") && t.includes(a.id), `parent trace mentions pomtree reap and ${a.id}`);
}
ok("total spend <= top budget", spend <= Number(topB), `${spend} <= ${topB}`);
// The reconciliation the per-agent arithmetic above cannot give on its own: every agent's own settled micros must add up to
// the daemon's reported total, so no spend is dropped from a trace or counted in two places.
const ownAll = (x) => [...(traces[x] ?? "").matchAll(/"micros":(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
const sumOwn = agents.reduce((n, a) => n + ownAll(a.id), 0);
ok("sum of per-agent settlements == reported total spend", sumOwn === spend, `${sumOwn} == ${spend}`);
console.log(out.join("\n"));
console.log(`SPEND ${spend}`);
// Verdict: this file is the verdict for a relay run, so a failed check must be visible in the EXIT CODE and not only in the
// prose above. Without it a caller that runs this verifier still cannot tell a passing run from a failing one. 4 means checks
// failed; 0 means every check held. Fail closed: no agent show files at all is a failure, not an empty pass.
const failed = out.filter((l) => l.startsWith("FAIL"));
if (agents.length === 0) {
  console.log("VERDICT fail: no show-ag-*.json in the run directory, so nothing was actually checked");
  process.exit(4);
}
if (failed.length > 0) {
  console.log(`VERDICT fail: ${failed.length} of ${out.length} checks failed`);
  process.exit(4);
}
console.log(`VERDICT pass: ${out.length} checks held`);
