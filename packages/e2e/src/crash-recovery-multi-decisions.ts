// Pure decisions for the live multi-agent crash-and-recovery harness (crash-recovery-live-multi.ts is the shell; REC-1):
// argv parsing, the task texts, and the assertion logic over plain evidence objects. No fs, process, Docker or network.
// Each agent is judged by evaluateRecovery (crash-recovery-decisions.ts, adopt variant) and the tree-level facts it cannot see are added
// here: parent/child shape, one result and one reap per child, settlements equal to debit rows, one container at a time, no leftovers.
// Also here: the operator's decide step for the budget_raise approval a budget-stalled agent raises (planGrants, decideStep) and the dry-run plan.
import { POMTREED_KINDS } from "@pomtree/core";
import type { Check } from "./browser-live-audit.ts";
import { DEFAULT_BUDGET_MICROS, DEFAULT_MODEL, evaluateRecovery, SANDBOX_KIND, SETTLEMENT_KIND } from "./crash-recovery-decisions.ts";
import type { Evidence, JEntry, Observation, Verdict } from "./crash-recovery-decisions.ts";
import { BUDGET_RAISE_KIND, parseBudgetRaiseTarget } from "../../pomtreed/src/budget-raise.ts";

export const BUDGET_REFUSE_ABOVE = 150_000;
// 15000 leaves the parent 30000 of a 60000 budget: each request needs about 8400 of headroom at reserve time (Wave 4 run 1 saw the 402).
export const CHILD_BUDGET_MICROS = 15_000;
export const CHILD_COUNT = 2;
// The parent carves both children out of its own budget, so a top-level budget below this cannot run the scenario.
export const BUDGET_REFUSE_BELOW = CHILD_BUDGET_MICROS * CHILD_COUNT + 10_000;
export const ROOT_BUDGET_FACTOR = 3;
// After the restart a crash-time reservation is charged only once the proxy expires it (2 x model.upstreamTimeoutMs, about 4 minutes in the
// last live run), the stall then escalates, and a granted child resumes cold and finishes its steps: 8 minutes was too tight for that path.
// The agents' own 15-minute spawn deadline still bounds the run.
export const DEFAULT_DEADLINE_MS = 600_000;

// The decide step. A stalled agent (adopted after the crash, refused by the proxy below its minimum) parks on a
// budget_raise approval at its parent's rung; the harness plays the operator and approves it. The grant refills a child to its carved size:
// the approval's own request (50% of the original budget) can sit below the proxy's per-call minimum, which would stall the agent again.
export const GRANT_MICROS = CHILD_BUDGET_MICROS;
// More than this many decisions in one run means a stall loop, not recovery: stop granting and let the run fail visibly. Bounded exposure:
// MAX_GRANTS x GRANT_MICROS (45000) comes out of the root budget, which keeps one top-level budget unallocated (the 60000 the runbook uses);
// a grant the root cannot cover is refused by the daemon (409 insufficient_budget), which counts as a failed decision here.
export const MAX_GRANTS = 3;
export const MAX_REQUESTED_MICROS = 2 * GRANT_MICROS; // an approval asking for more than this is not decided automatically
export const MAX_DECIDE_FAILURES = 3;

export interface MultiArgs {
  image: string;
  out: string;
  budgetMicros: number; // per top-level agent (the parent and the unrelated agent); the root budget is ROOT_BUDGET_FACTOR times it
  model: string;
  deadlineMs: number; // wall clock for the whole tree to finish after the restart
  agentListen: string | undefined;
  dryRun: boolean; // preflight only: refusals, image and key checks, then print the plan and its spend bounds; starts nothing, spends nothing
}

// Argv to MultiArgs, or the refusal reason (exit 2). Only the adopt variant exists, so `--kill-container` is refused, as is
// `--i-know-the-cap`: the cap is a hard refusal.
export function parseMultiArgs(argv: string[]): MultiArgs | { refusal: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--kill-container") return { refusal: "--kill-container is not supported by this harness (REC-1 is the adopt variant only)" };
    if (a === "--i-know-the-cap") return { refusal: "--i-know-the-cap is not supported by this harness" };
    if (a === "--dry-run") {
      flags.set("dry-run", "1");
      continue;
    }
    if (!a.startsWith("--")) return { refusal: `unexpected argument ${a}` };
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) return { refusal: `${a} needs a value` };
    flags.set(a.slice(2), v);
  }
  const image = flags.get("image");
  const out = flags.get("out");
  if (!image) return { refusal: "--image is required" };
  if (!out) return { refusal: "--out is required" };
  const budgetMicros = Number(flags.get("budget-micros") ?? DEFAULT_BUDGET_MICROS);
  if (!Number.isSafeInteger(budgetMicros) || budgetMicros < 1) return { refusal: "--budget-micros must be a positive integer" };
  if (budgetMicros > BUDGET_REFUSE_ABOVE) return { refusal: `--budget-micros ${budgetMicros} exceeds the ${BUDGET_REFUSE_ABOVE} cap` };
  if (budgetMicros < BUDGET_REFUSE_BELOW)
    return {
      refusal: `--budget-micros ${budgetMicros} is below ${BUDGET_REFUSE_BELOW}: the parent must fund its ${CHILD_COUNT} children at ${CHILD_BUDGET_MICROS} each`,
    };
  const deadlineMs = Number(flags.get("deadline-ms") ?? DEFAULT_DEADLINE_MS);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 30_000) return { refusal: "--deadline-ms must be an integer >= 30000" };
  const model = flags.get("model") ?? DEFAULT_MODEL;
  if (!/^[^/\s]+\/\S+$/.test(model)) return { refusal: "--model must be PROVIDER/ID" };
  return { image, out, budgetMicros, model, deadlineMs, agentListen: flags.get("agent-listen"), dryRun: flags.has("dry-run") };
}

// ---- task texts ----------------------------------------------------------------------------------------------------------

// A child's task: several separate slow tool turns, so a kill after its first model call lands mid-run. No single quotes: it is
// embedded in a single-quoted shell argument by the parent's task. Each child writes files named for itself: both children are merged into
// the parent's branch, and two clones adding the same path would conflict on the second merge.
export const childTask = (n: number): string =>
  "Do the following steps strictly one at a time, each as its own bash tool call, and do not combine them. " +
  `1) run: sleep 15. 2) run: echo step2 >> progress-kid${n}.txt && sleep 15. 3) run: echo step3 >> progress-kid${n}.txt && sleep 15. ` +
  `4) run: echo done > result-kid${n}.txt && git add progress-kid${n}.txt result-kid${n}.txt && git commit -m kid${n}-result. ` +
  "Then report your result as your instructions say. Keep every reply to one short sentence.";

// The parent first commits and pushes its own branch: `pomtree merge CHILD` needs the caller to have a pushed branch to merge into (409
// otherwise), and a pushed child cannot be reaped until merged. It then spawns two children and waits for, merges and reaps each. The
// merge and the reap of a child are one command joined with `;`: a child that never pushed has nothing to merge (the merge is refused and the
// reap is allowed), and a child that did push is merged first. Every wait is a bounded retry loop with a 15 s long-poll (under the 20 s
// wait.yieldMs default) so a `pomtree wait` that fails while the daemon is down is retried instead of ending the run.
//
// Each merge-and-reap ends with the sync the product asks for. `pomtree merge` has the controller write a merge commit onto the parent's own
// ingested ref in the daemon mirror (`daemon/merge.ts`, target `own`) and does not touch the parent's clone, so after a merge the parent's
// local branch is behind its ref and its next `pomtree push` is refused `non_fast_forward` by design. `pomtree merge` itself prints "run 'pomtree
// pull' to fetch the merge commit into your clone before your next push" (`packages/pomtree/src/merge.ts`), so the task does exactly that and
// fast-forwards. Without it the run depends on the model improvising `pomtree push --force`, which would erase the controller's merge commit:
// REC-1 run 1 of 2026-11-03 did improvise it and run 2 hung at that step instead, never reporting (recorded in the results table).
export function parentTask(model: string): string {
  const spawn = (n: number) =>
    `pomtree spawn --task '${childTask(n)}' --name kid${n} --budget ${CHILD_BUDGET_MICROS} --model ${model} > /tmp/kid${n}.id && cat /tmp/kid${n}.id`;
  const wait = (n: number) => `for i in $(seq 1 120); do pomtree wait $(cat /tmp/kid${n}.id) --timeout 15000 && break; sleep 3; done`;
  // POMTREE_AGENT_ID is set in every agent container (`daemon/lifecycle.ts`), and `pomtree pull` puts the agent's own ingested branch at
  // refs/remotes/pomtreed-agents/<id>/heads/agent/<id>. The fast-forward is strict, so a ref that is not an ancestor fails loudly.
  const sync = 'pomtree pull && git merge --ff-only "refs/remotes/pomtreed-agents/$POMTREE_AGENT_ID/heads/agent/$POMTREE_AGENT_ID"';
  const mergeReap = (n: number) => `pomtree merge $(cat /tmp/kid${n}.id); pomtree reap $(cat /tmp/kid${n}.id); ${sync}`;
  return (
    "You coordinate two child agents. Do the following steps strictly one at a time, each as its own bash tool call, and do not combine them. " +
    "Run each step exactly as written and do not add flags of your own; in particular never pass --force to pomtree push. " +
    "1) run: echo parent > parent-note.txt && git add parent-note.txt && git commit -m parent-note && pomtree push " +
    `2) run: ${spawn(1)} ` +
    `3) run: ${spawn(2)} ` +
    `4) run: ${wait(1)} ` +
    `5) run: ${mergeReap(1)} ` +
    `6) run: ${wait(2)} ` +
    `7) run: ${mergeReap(2)} ` +
    "8) run: pomtree push " +
    "Then report your result as your instructions say. Keep every reply to one short sentence."
  );
}

// ---- the operator's decide step -----------------------------------------------------------------------------------------

// One row of the daemon's approvals table (read-only), as the harness reads it.
export interface ApprovalRow {
  id: string;
  requester_id: string;
  action_kind: string;
  action_target: string;
  state: string;
}
export interface DecisionRecord {
  approval: string;
  requester: string;
  grantMicros: number;
  outcome: "approved" | "failed";
  detail: string;
}
export interface DecideState {
  records: DecisionRecord[]; // one per approval the step acted on (approved, or given up after MAX_DECIDE_FAILURES)
  skipped: Map<string, string>; // approval id -> why it was left undecided; the run reports these
  failures: Map<string, number>;
}
export const newDecideState = (): DecideState => ({ records: [], skipped: new Map(), failures: new Map() });

export interface PlannedGrant {
  approval: string;
  requester: string;
  grantMicros: number;
}

// Which pending approvals the operator approves now, and which it leaves (with the reason, kept in the report). Only budget_raise
// approvals raised by an agent of this tree and asking for at most MAX_REQUESTED_MICROS are approved, at most MAX_GRANTS in the run.
export function planGrants(rows: readonly ApprovalRow[], tree: ReadonlySet<string>, state: DecideState): { grants: PlannedGrant[]; skip: [string, string][] } {
  const grants: PlannedGrant[] = [];
  const skip: [string, string][] = [];
  const done = new Set(state.records.map((r) => r.approval));
  let used = state.records.filter((r) => r.outcome === "approved").length;
  for (const r of rows) {
    if (r.state !== "pending" || done.has(r.id) || state.skipped.has(r.id)) continue;
    if (r.action_kind !== BUDGET_RAISE_KIND) skip.push([r.id, `not a budget raise (${r.action_kind})`]);
    else if (!tree.has(r.requester_id)) skip.push([r.id, `requester ${r.requester_id} is not in this run's tree`]);
    else {
      const raise = parseBudgetRaiseTarget(r.action_target);
      if (!raise) skip.push([r.id, "malformed budget-raise target"]);
      else if (raise.requestedMicros > MAX_REQUESTED_MICROS)
        skip.push([r.id, `asks for ${raise.requestedMicros} micros, over the ${MAX_REQUESTED_MICROS} the harness decides alone`]);
      else if (used >= MAX_GRANTS) skip.push([r.id, `grant limit of ${MAX_GRANTS} reached (a stall loop, not recovery)`]);
      else {
        used++;
        grants.push({ approval: r.id, requester: r.requester_id, grantMicros: GRANT_MICROS });
      }
    }
  }
  return { grants, skip };
}

// One poll of the decide step: read the pending approvals, approve the plannable ones, remember the rest. `decide` throws on any failure
// (the `pomtree decide` exit is non-zero, including an approval another rung just decided: that row is no longer pending on the next poll,
// so it is simply not retried). A decision that keeps failing is given up after MAX_DECIDE_FAILURES and recorded as failed.
export async function decideStep(
  io: { pending: () => Promise<ApprovalRow[]> | ApprovalRow[]; decide: (approval: string, grantMicros: number) => Promise<void> },
  tree: ReadonlySet<string>,
  state: DecideState,
): Promise<void> {
  const { grants, skip } = planGrants(await io.pending(), tree, state);
  for (const [id, why] of skip) state.skipped.set(id, why);
  for (const g of grants) {
    try {
      await io.decide(g.approval, g.grantMicros);
      state.records.push({ ...g, outcome: "approved", detail: "approved" });
    } catch (e) {
      const n = (state.failures.get(g.approval) ?? 0) + 1;
      state.failures.set(g.approval, n);
      if (n >= MAX_DECIDE_FAILURES)
        state.records.push({ ...g, outcome: "failed", detail: `gave up after ${n} failures: ${(e as Error).message.slice(0, 200)}` });
    }
  }
}

// The `pomtree decide` argv (before --json): the grant is raw micro-dollars.
export const decideArgs = (approval: string, grantMicros: number): string[] => [
  "decide",
  approval,
  "approve",
  "--grant",
  String(grantMicros),
  "--why",
  "REC-1 harness: refill a budget-stalled agent after the pomtreed crash",
];

// ---- spend plan (the dry run prints it; the runbook's go-ahead is for these numbers) ---------------------------------------

export interface SpendPlan {
  rootBudgetMicros: number; // the proxy's hard cap for the whole run: nothing the harness does can spend more
  topLevelBudgetMicros: number;
  childBudgetMicros: number;
  maxGrantMicros: number; // extra budget the decide step can hand out (it comes out of the root, so it is inside the root cap)
}
export const spendPlan = (a: Pick<MultiArgs, "budgetMicros">): SpendPlan => ({
  rootBudgetMicros: a.budgetMicros * ROOT_BUDGET_FACTOR,
  topLevelBudgetMicros: a.budgetMicros,
  childBudgetMicros: CHILD_BUDGET_MICROS,
  maxGrantMicros: MAX_GRANTS * GRANT_MICROS,
});

export function renderPlan(a: MultiArgs): string {
  const p = spendPlan(a);
  return [
    `REC-1 plan (dry run: nothing was started or spent): image ${a.image}, model ${a.model}`,
    `agents: parent (${p.topLevelBudgetMicros} micros, funds ${CHILD_COUNT} children at ${p.childBudgetMicros} each) and one solo agent (${p.topLevelBudgetMicros} micros)`,
    `hard spend cap: root budget ${p.rootBudgetMicros} micros; the decide step may grant up to ${MAX_GRANTS} x ${GRANT_MICROS} = ${p.maxGrantMicros} micros of extra budget (inside the cap)`,
    `wall clock: up to ${Math.round(a.deadlineMs / 1000)} s after the restart (agents' own deadline 15 m)`,
    "the run then SIGKILLs and restarts its own pomtreed, decides any budget_raise approval its tree raises, and exits 0 only if every assertion holds",
  ].join("\n");
}

// ---- the campaign gate ---------------------------------------------------------------------------------------------------

// The per-run observation name. The campaign gate reads its leading "yes" or "no", so the two are one fact in one place.
export const STALL_OBSERVATION = "budget stall exercised";

// How many passing runs clear REC-1.
export const CAMPAIGN_PASSES_REQUIRED = 3;

// One recorded run, as a row of the REC-1 results table states it.
export interface CampaignRun {
  date: string;
  base: string; // the commit the run ran on
  outcome: string; // pass | fail | blocked | skipped
  stalled: boolean | null; // null when the row does not say, which the gate treats as not stalled and reports
  spendMicros: number;
}

export interface CampaignVerdict {
  ok: boolean;
  checks: Check[];
  passes: number;
  stalledPasses: number;
  spendMicros: number;
}

// The gate over a recorded SET of runs. It is a hard verdict, not a note: a campaign of three passing runs in which none exercised the
// budget stall FAILS and says so by name, which is the whole point of moving the stall guarantee to this level. `base` matters because
// only runs on the final assertion set count; the caller passes the commits it will accept.
export function evaluateCampaign(runs: CampaignRun[], acceptedBases: string[]): CampaignVerdict {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const onAccepted = runs.filter((r) => acceptedBases.some((b) => r.base.startsWith(b) || b.startsWith(r.base)));
  const passes = onAccepted.filter((r) => r.outcome === "pass");
  const stalledPasses = passes.filter((r) => r.stalled === true);
  // This campaign's spend, not the item's whole history: the ledger also holds rows from earlier attempts on other bases.
  const spendMicros = onAccepted.reduce((n, r) => n + r.spendMicros, 0);

  add(
    `${CAMPAIGN_PASSES_REQUIRED} passing runs on the accepted assertion set`,
    passes.length >= CAMPAIGN_PASSES_REQUIRED,
    `${passes.length} pass(es) of ${onAccepted.length} run(s) on ${JSON.stringify(acceptedBases)}; ${runs.length} recorded run(s) in all`,
  );
  // The gate the per-run verdict cannot provide. Without it a set of green runs says nothing about the stall path.
  add(
    "at least one passing run exercised the budget stall",
    stalledPasses.length >= 1,
    `${stalledPasses.length} of ${passes.length} passing run(s) stalled; per-run "${STALL_OBSERVATION}" says ${JSON.stringify(passes.map((r) => r.stalled))}`,
  );
  // Only a PASSING run's stall word is load-bearing, since those are what the gate above counts. A failed run's row may say nothing
  // without silently weakening the gate, and rows are append-only, so this must not reach back into rows already written.
  const unstated = passes.filter((r) => r.stalled === null);
  add("every passing run states whether it stalled", unstated.length === 0, `${unstated.length} passing run(s) whose row carries no "stall: yes|no"`);
  return { ok: checks.every((c) => c.ok), checks, passes: passes.length, stalledPasses: stalledPasses.length, spendMicros };
}

// Reads the REC-1 rows out of the results file so the campaign verdict is computable from the ledger a human reads, rather than
// from a second copy of the same facts. Columns are found by the HEADER NAME of the table a row sits under, never by position, and the
// names are those of the Results header in docs/validation.md (`Gate | Commit | Date (UTC) | Host | Outcome | Spend (micros) | Evidence`),
// which scripts/live/results-row.sh also writes: a positional reader on a table with an extra `Host` column once took `Host` for the
// outcome and counted 0 passes without complaint. A REC-1 row under a header that lacks a required column, or before any header,
// throws instead: a quiet 0 is the failure this parser must not have. The evidence cell must carry `stall: yes` or `stall: no`
// (the per-run observation's leading word, written into the row when the run is recorded).
type CampaignColumn = "item" | "date" | "base" | "outcome" | "notes" | "spend";
const CAMPAIGN_COLUMN_NAMES: Record<CampaignColumn, RegExp> = {
  item: /^gate$/,
  date: /^date \(utc\)$/,
  base: /^commit$/,
  outcome: /^outcome$/,
  notes: /^evidence$/,
  spend: /^spend \(micros\)$/,
};

export function parseCampaignRows(markdown: string, item = "REC-1"): CampaignRun[] {
  const out: CampaignRun[] = [];
  let cols: Partial<Record<CampaignColumn, number>> | null = null;
  for (const line of markdown.split("\n")) {
    // Prose may sit between a table's rows in the log, so the last header seen stays in force until the next one replaces it.
    if (!line.startsWith("|")) continue;
    // cells[0] is the empty string before the leading pipe.
    const cells = line.split("|").map((c) => c.trim());
    if (/^\|[\s:|-]+\|?$/.test(line)) continue; // the `| --- | --- |` rule under a header
    const lower = cells.map((c) => c.toLowerCase());
    if (CAMPAIGN_COLUMN_NAMES.item.test(lower[1] ?? "")) {
      cols = {};
      for (const [name, re] of Object.entries(CAMPAIGN_COLUMN_NAMES) as [CampaignColumn, RegExp][]) {
        const at = lower.findIndex((c, i) => i > 0 && re.test(c));
        if (at > 0) cols[name] = at;
      }
      continue;
    }
    if (cells[1] !== item) continue;
    if (!cols)
      throw new Error(
        `results row for ${item} has no table header above it: add the header row (\`| Gate | Commit | Date (UTC) | ... |\`, as in docs/validation.md) so its columns can be read by name`,
      );
    const missing = (Object.keys(CAMPAIGN_COLUMN_NAMES) as CampaignColumn[]).filter((c) => cols![c] === undefined);
    if (missing.length > 0)
      throw new Error(
        `results table header lacks the column(s) ${missing.join(", ")} needed to read ${item}: rename the header cells to the names in docs/validation.md (Gate, Commit, Date (UTC), Outcome, Spend (micros), Evidence) rather than reorder or drop them`,
      );
    const at = (c: CampaignColumn) => cells[cols![c]!] ?? "";
    const m = /stall:\s*(yes|no)\b/i.exec(at("notes"));
    const spend = Number(at("spend").replace(/[^0-9]/g, ""));
    out.push({
      date: at("date"),
      base: at("base"),
      outcome: at("outcome").toLowerCase(),
      stalled: m ? m[1]!.toLowerCase() === "yes" : null,
      spendMicros: Number.isFinite(spend) ? spend : 0,
    });
  }
  return out;
}

export function renderCampaign(v: CampaignVerdict, acceptedBases: string[]): string {
  return [
    `REC-1 campaign verdict: ${v.ok ? "PASS" : "FAIL"} (accepted bases ${acceptedBases.join(", ")})`,
    `${v.passes} passing run(s), ${v.stalledPasses} of them exercised the budget stall; recorded spend ${v.spendMicros} micros`,
    ...v.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`),
  ].join("\n");
}

// ---- evidence ------------------------------------------------------------------------------------------------------------

export type Role = "parent" | "child" | "solo";

// A model_debit_requests row with the provider-wire columns the shared narrow `DebitRow` omits. These are the facts only a real provider
// can produce, so they are asserted here and nowhere shared: `evaluateMulti` is built solely by the live harness, while `evaluateRecovery`
// and `evaluateCost` also judge stub-model runs whose `FakeModelUpstream` reports token counts and no cost, model or response id at all.
// `charged_micros` is null while a row is still reserved; `upstream_status` is null on a row the crash charged without a reply.
export interface WireDebitRow {
  request_id: string;
  status: string;
  charged_micros: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  model: string | null;
  response_id: string | null; // the provider's own id, indexed by the store so an invoice line can find its settled call
  upstream_status: number | null;
}

export interface AgentEvidence {
  role: Role;
  id: string;
  name: string;
  parent: string | null; // parent agent id as `pomtree show` reports it
  capMicros: number; // this agent's own budget
  pre: Omit<Evidence["pre"], "maxSeq">; // taken just before the kill (agent) and from the database right after it
  preJournal: JEntry[]; // this agent's journal rows read right after the kill
  final: Evidence["final"]; // agentContainers: this agent's own containers (egress sidecars excluded)
  wireDebit: WireDebitRow[]; // every debit row of this agent at the end of the run, with its provider-wire columns
}

export interface MultiEvidence {
  parentId: string;
  rootId: string; // the root supervisor's id, read from the parent's own parent (every operator spawn is a child of the root)
  maxSeq: number; // global journal MAX(seq) right after the kill
  totalCapMicros: number; // the root budget
  agents: AgentEvidence[];
  samples: string[][]; // per poll of the docker host: sandbox ids of the agent containers running at that moment
  leftovers: { containers: string[]; volumes: string[]; networks: string[] }; // of this run, after cleanup
  decisions: DecisionRecord[]; // what the decide step did (approvals it acted on)
  skippedApprovals: [string, string][]; // pending approvals it left undecided, with the reason
}

// Budget stall rows of one agent's journal, after the kill: the escalation, the grant that resumed it and any denial.
const budgetRows = (a: AgentEvidence, boundary: number) => {
  const after = a.final.journal.filter((e) => e.seq > boundary);
  const of = (k: string) => after.filter((e) => kind(e) === k);
  return { escalated: of(POMTREED_KINDS.budgetEscalated), granted: of(POMTREED_KINDS.budgetGranted), denied: of(POMTREED_KINDS.budgetDenied) };
};

const TERMINAL = new Set(["exited", "reaped"]);
const kind = (e: JEntry) => e.payload.kind;
const isProbe = (r: { request_id: string }) => r.request_id.endsWith(":probe");

const startedSandboxes = (j: JEntry[]) =>
  new Set(j.filter((e) => kind(e) === SANDBOX_KIND && e.payload.phase === "started").map((e) => String(e.payload.sandbox)));

export function evaluateMulti(ev: MultiEvidence): Verdict {
  const checks: Check[] = [];
  const observations: Observation[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // --- the tree shape the run was meant to test
  const kids = ev.agents.filter((a) => a.parent === ev.parentId);
  const parent = ev.agents.find((a) => a.id === ev.parentId);
  add("the parent spawned exactly two children", parent !== undefined && kids.length === CHILD_COUNT, `${kids.length} children of ${ev.parentId}`);
  // "Unrelated" means a sibling of the parent under the root supervisor, not parentless: the daemon records an operator spawn as a child
  // of the root (`packages/pomtreed/src/api.ts`, scope "operator"), and the root counts as a live ancestor for custody (`Tree.custodian`).
  // What this run cares about is that the solo agent is NOT under the killed parent, so neither the kill nor the restart can touch it.
  const solos = ev.agents.filter((a) => a.role === "solo");
  add(
    "the unrelated agent is a child of the root, not of the killed parent",
    ev.rootId.startsWith("root-") && ev.rootId !== ev.parentId && solos.length === 1 && solos.every((a) => a.parent === ev.rootId && a.parent !== ev.parentId),
    `root=${ev.rootId}; ${solos.length} solo agent(s); parents ${JSON.stringify(solos.map((a) => a.parent))}`,
  );
  add(
    "every agent was running when pomtreed was killed",
    ev.agents.length > 0 && ev.agents.every((a) => a.pre.agent.state === "running" && a.pre.agent.sandbox !== null),
    JSON.stringify(ev.agents.map((a) => `${a.name}:${a.pre.agent.state}`)),
  );
  const settledBefore = ev.agents.flatMap((a) => a.pre.debit).filter((r) => !isProbe(r) && r.status === "settled").length;
  add("at least one model call had settled before the kill", settledBefore >= 1, `${settledBefore} settled pre-kill rows across the tree`);

  const resultSeq = (a: AgentEvidence) => a.final.journal.find((e) => kind(e) === POMTREED_KINDS.result)?.seq;

  for (const a of ev.agents) {
    const pfx = (n: string) => `${a.name}: ${n}`;
    const j = a.final.journal;

    // The single-agent judge, per agent. Its own checks and observations are carried over under the agent's name.
    // A budget grant raises the agent's budget and resumes it in a new container: its cap and its expected resumes follow its grants.
    const b = budgetRows(a, ev.maxSeq);
    // A grant raises every agent from the asker up to the payer, so the parent's budget also rises by each grant its children received.
    const amountOf = (rows: JEntry[]) => rows.reduce((n, e) => n + (Number(e.payload.amount) || 0), 0);
    const grantedMicros = amountOf(b.granted) + (a.role === "parent" ? kids.reduce((n, k) => n + amountOf(budgetRows(k, ev.maxSeq).granted), 0) : 0);
    const v = evaluateRecovery({
      variant: "adopt",
      capMicros: a.capMicros + grantedMicros,
      grantResumes: b.granted.length,
      pre: { ...a.pre, maxSeq: ev.maxSeq },
      final: a.final,
    });
    for (const c of v.checks) checks.push({ ...c, name: pfx(c.name) });
    for (const o of v.observations) observations.push({ name: pfx(o.name), detail: o.detail });

    add(
      pfx("finished succeeded"),
      TERMINAL.has(a.final.agent.state) && a.final.agent.exit === "succeeded",
      `state=${a.final.agent.state} exit=${a.final.agent.exit}`,
    );

    const results = j.filter((e) => kind(e) === POMTREED_KINDS.result);
    add(pfx("exactly one recorded result"), results.length === 1, `${results.length} result entries`);
    const resumedN = j.filter((e) => kind(e) === "resumed").length;
    add(pfx("no duplicate resumed entry"), resumedN <= b.granted.length, `${resumedN} resumed entries, ${b.granted.length} budget grant(s)`);
    // The stall path (proxy-reserve-restart): every escalation is granted exactly once and nothing is denied. No escalation at all is fine
    // (the crash charge only exhausts an agent whose request was in flight at the kill); it is reported as an observation.
    const escApprovals = b.escalated.map((e) => String(e.payload.approval));
    const grantCount = (id: string) => b.granted.filter((e) => e.payload.approval === id).length;
    add(
      pfx("every budget escalation was granted exactly once, none denied"),
      b.denied.length === 0 && escApprovals.every((id) => grantCount(id) === 1) && b.granted.length === new Set(escApprovals).size,
      `${b.escalated.length} escalated, ${b.granted.length} granted, ${b.denied.length} denied`,
    );
    if (b.escalated.length)
      observations.push({
        name: pfx("budget stall"),
        detail: JSON.stringify(
          b.escalated.map((e) => ({
            approval: e.payload.approval,
            requested: e.payload.requested,
            spent: e.payload.spent,
            budget: e.payload.budget,
            remaining: e.payload.remainingMicros,
            minimum: e.payload.minimumMicros,
          })),
        ),
      });

    // Pre-kill journal is an unchanged prefix of the final one, and seq strictly increases.
    const strict = j.every((e, i) => i === 0 || e.seq > j[i - 1]!.seq);
    const prefixBad = a.preJournal.filter((e, i) => j[i]?.seq !== e.seq || JSON.stringify(j[i]?.payload) !== JSON.stringify(e.payload)).map((e) => e.seq);
    add(
      pfx("pre-kill journal is an unchanged prefix"),
      strict && prefixBad.length === 0,
      `seq strictly increasing: ${strict}; rewritten or missing pre-kill seq: ${JSON.stringify(prefixBad)}`,
    );

    // Journaled settlements are exactly the settled debit rows (a duplicate journal entry is evaluateRecovery's check).
    const journaled = j.filter((e) => kind(e) === SETTLEMENT_KIND).map((e) => String(e.payload.requestId));
    const debitIds = a.final.debit.filter((r) => !isProbe(r) && r.status === "settled").map((r) => r.request_id);
    const debitDup = debitIds.filter((id, i) => debitIds.indexOf(id) !== i);
    const onlyJournal = journaled.filter((id) => !debitIds.includes(id));
    const onlyDebit = debitIds.filter((id) => !journaled.includes(id));
    add(
      pfx("debit rows equal journaled settlements"),
      debitDup.length === 0 && onlyJournal.length === 0 && onlyDebit.length === 0,
      `${journaled.length} journaled, ${debitIds.length} settled rows; only in journal ${JSON.stringify(onlyJournal)}; only in debit ${JSON.stringify(onlyDebit)}`,
    );

    // At most one container of this agent ran at any sampled moment.
    const mine = startedSandboxes(j);
    const peak = ev.samples.reduce((m, s) => Math.max(m, s.filter((sb) => mine.has(sb)).length), 0);
    add(
      pfx("at most one container at a time"),
      ev.samples.length > 0 && peak <= 1,
      `${ev.samples.length} samples, peak ${peak} running of ${mine.size} started`,
    );
  }

  // --- the parent reaped both children itself
  if (parent) {
    const pr = resultSeq(parent);
    for (const k of kids) {
      const reaped = k.final.journal.filter((e) => kind(e) === "reaped");
      add(
        `${k.name}: reaped under the parent`,
        k.final.agent.state === "reaped" && k.parent === ev.parentId,
        `state=${k.final.agent.state} parent=${k.parent}`,
      );
      add(`${k.name}: exactly one reaped entry`, reaped.length === 1, `${reaped.length} reaped entries`);
      add(
        `${k.name}: reaped before the parent's result`,
        reaped.length === 1 && pr !== undefined && reaped[0]!.seq < pr,
        `reaped seq ${reaped[0]?.seq}, parent result seq ${pr}`,
      );
    }
  }
  // Top-level agents are root children, which finishTail reaps at exit (HANDOFF, scope of the custody claim): exited or reaped, once.
  for (const a of ev.agents.filter((x) => x.role !== "child")) {
    const reapedN = a.final.journal.filter((e) => kind(e) === "reaped").length;
    add(`${a.name}: at most one reaped entry`, reapedN <= 1, `state=${a.final.agent.state}; ${reapedN} reaped entries`);
  }

  // --- the decide step: it approved what the tree raised, and left nothing it could not decide
  const failedDecisions = ev.decisions.filter((d) => d.outcome !== "approved");
  add(
    "the operator decided every budget approval the tree raised",
    failedDecisions.length === 0 && ev.skippedApprovals.length === 0,
    `${ev.decisions.length - failedDecisions.length} approved; failed ${JSON.stringify(failedDecisions)}; left undecided ${JSON.stringify(ev.skippedApprovals)}`,
  );
  // Whether this run exercised the budget stall. It stays an OBSERVATION, because it cannot be forced per run: the crash charges every
  // in-flight request at its full reservation, a reservation is clamped to the agent's whole remainder, and so whichever agents happen to
  // be mid-call at the kill are exhausted outright. Waiting for a chosen agent to be mid-call catches the others too, which cost runs 4
  // and 5 of 2026-11-03 two to three times the usual spend and failed agents outright. The guarantee is therefore made over a CAMPAIGN:
  // `evaluateCampaign` fails a set of runs in which none stalled. This detail is that gate's per-run input, so it leads with yes or no.
  const crashCharged = ev.agents.flatMap((a) => a.wireDebit.filter((r) => r.status === "expired-charged").map(() => `${a.name}:${a.role}`));
  const grantsAll = ev.agents.flatMap((a) => budgetRows(a, ev.maxSeq).granted);
  const didStall = crashCharged.length >= 1 && grantsAll.length >= 1 && ev.decisions.length >= 1;
  observations.push({
    name: STALL_OBSERVATION,
    detail: `${didStall ? "yes" : "no"}: crash-charged ${JSON.stringify(crashCharged)}, ${grantsAll.length} grant(s), ${ev.decisions.length} operator decision(s)`,
  });

  // --- the provider wire: facts only a live run can reach (TODO(cost-live-verify)). These are asserted here rather than in the shared
  // evaluateRecovery / evaluateCost because MultiEvidence is built only by the live harness, so a stub-model run never reaches them:
  // FakeModelUpstream reports token counts and no cost, model or response id at all.
  const wire = ev.agents.flatMap((a) => a.wireDebit);
  const settledWire = wire.filter((r) => !isProbe(r) && r.status === "settled");
  const zeroCharged = settledWire.filter((r) => !((r.charged_micros ?? 0) > 0));
  add(
    "every settled model call was charged more than zero micros",
    settledWire.length >= 1 && zeroCharged.length === 0,
    `${settledWire.length} settled call(s); ${zeroCharged.length} charged zero or null`,
  );
  const thinWire = settledWire.filter((r) => !((r.tokens_in ?? 0) > 0) || !((r.tokens_out ?? 0) > 0) || r.upstream_status !== 200 || !r.model);
  add(
    "every settled model call records provider tokens, a model and a 200 upstream status",
    settledWire.length >= 1 && thinWire.length === 0,
    `${thinWire.length} of ${settledWire.length} settled call(s) missing tokens, a model or a 200 status`,
  );
  // The store indexes response_id so an invoice line can find its settled call, which is what makes BUD-2 a query instead of a new test.
  const noId = settledWire.filter((r) => typeof r.response_id !== "string" || r.response_id.length === 0);
  add(
    "every settled model call kept a provider response id for invoice reconciliation",
    settledWire.length >= 1 && noId.length === 0,
    `${noId.length} of ${settledWire.length} settled call(s) without a response id`,
  );
  // --- spend and cleanup
  const spent = ev.agents.reduce((n, a) => n + a.final.spentMicros, 0);
  add("tree spend within the root budget", spent <= ev.totalCapMicros, `${spent} of ${ev.totalCapMicros} micros`);
  const left = [...ev.leftovers.containers, ...ev.leftovers.volumes, ...ev.leftovers.networks];
  add("no containers, volumes or networks of this run left after cleanup", left.length === 0, JSON.stringify(ev.leftovers));

  observations.push({
    name: "tree spend",
    detail: `${spent} micros across ${ev.agents.length} agents; peak concurrent containers sampled: ${Math.max(0, ...ev.samples.map((s) => s.length))}`,
  });
  return { ok: checks.every((c) => c.ok), checks, observations };
}
