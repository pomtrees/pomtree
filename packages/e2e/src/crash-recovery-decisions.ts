// Pure decisions for the live crash-and-recovery harness (crash-recovery-live.ts is the shell): argv parsing and the assertion
// logic over collected evidence. No fs, process, Docker or network, so every check has a negative-variant unit test.
// What the daemon PROMISES (SPEC "reconcile" paragraph, restart.test.ts) is asserted; behavior the code leaves
// unclear (dead container without a checkpoint, adopted-agent result path, model calls after adoption) is only OBSERVED.
import type { Check, DebitRow } from "./browser-live-audit.ts";

export const DEFAULT_BUDGET_MICROS = 100_000;
export const BUDGET_REFUSE_ABOVE = 300_000;
export const DEFAULT_MODEL = "openrouter/anthropic/claude-haiku-5.5";
export const SANDBOX_KIND = "ext.pomtreed.sandbox";
export const SETTLEMENT_KIND = "ext.pomtreed.model_settlement";

export type Variant = "adopt" | "dead-container";

export interface Args {
  image: string;
  out: string;
  budgetMicros: number;
  model: string;
  variant: Variant;
  deadlineMs: number; // wall clock for the agent to finish after the restart
  agentListen: string | undefined; // POMTREED_AGENT_LISTEN override (default: pinned loopback port on macOS, daemon default elsewhere)
}

// Argv to Args, or the refusal reason (exit 2). `--i-know-the-cap` is deliberately NOT accepted: the cap is a hard refusal.
export function parseArgs(argv: string[]): Args | { refusal: string } {
  const flags = new Map<string, string>();
  let kill = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--kill-container") kill = true;
    else if (a.startsWith("--") && a !== "--i-know-the-cap") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { refusal: `${a} needs a value` };
      flags.set(a.slice(2), v);
    } else return { refusal: a === "--i-know-the-cap" ? "--i-know-the-cap is not supported by this harness" : `unexpected argument ${a}` };
  }
  const image = flags.get("image");
  const out = flags.get("out");
  if (!image) return { refusal: "--image is required" };
  if (!out) return { refusal: "--out is required" };
  const budgetMicros = Number(flags.get("budget-micros") ?? DEFAULT_BUDGET_MICROS);
  if (!Number.isSafeInteger(budgetMicros) || budgetMicros < 1) return { refusal: "--budget-micros must be a positive integer" };
  if (budgetMicros > BUDGET_REFUSE_ABOVE) return { refusal: `--budget-micros ${budgetMicros} exceeds the ${BUDGET_REFUSE_ABOVE} cap` };
  const deadlineMs = Number(flags.get("deadline-ms") ?? 420_000);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 30_000) return { refusal: "--deadline-ms must be an integer >= 30000" };
  const model = flags.get("model") ?? DEFAULT_MODEL;
  if (!/^[^/\s]+\/\S+$/.test(model)) return { refusal: "--model must be PROVIDER/ID" };
  return { image, out, budgetMicros, model, variant: kill ? "dead-container" : "adopt", deadlineMs, agentListen: flags.get("agent-listen") };
}

// The agent's task: several separate tool turns spread over about a minute, so a kill after the first model call lands mid-run.
export const TASK =
  "Do the following steps strictly one at a time, each as its own bash tool call, and do not combine them. " +
  "1) run: sleep 20. 2) run: echo step2 >> progress.txt && sleep 20. 3) run: echo step3 >> progress.txt && sleep 20. " +
  "4) run: echo done > result.txt && git add result.txt progress.txt && git commit -m crash-recovery-result. " +
  "Then report your result as your instructions say. Keep every reply to one short sentence.";

// ---- evidence ------------------------------------------------------------------------------------------------------------

export interface JEntry {
  seq: number;
  generation: number;
  payload: { kind?: string; [k: string]: unknown };
}
export interface AgentView {
  state: string;
  exit: string | null;
  generation: number;
  sandbox: string | null;
}
export interface ContainerView {
  id: string; // docker container id/name
  running: boolean;
}
export interface Evidence {
  variant: Variant;
  capMicros: number; // the agent's budget including any grants
  grantResumes?: number; // adopt variant: budget grants after the kill; each legitimately parks the adopted agent and resumes it in a new container (default 0)
  pre: { agent: AgentView; maxSeq: number; debit: DebitRow[]; spentMicros: number; containerRunningAfterKill: boolean };
  final: {
    agent: AgentView;
    journal: JEntry[];
    debit: DebitRow[];
    spentMicros: number;
    agentContainers: ContainerView[]; // agent containers for this store (egress sidecars excluded)
    workspaceDirs: number; // directories under <state>/workspaces
    operatorApiOk: boolean; // `pomtree ps` through the restarted daemon with the on-disk operator token
  };
}

const TERMINAL = new Set(["exited", "reaped"]);
const kind = (e: JEntry) => e.payload.kind;
const sandboxEntries = (j: JEntry[], phase: string) => j.filter((e) => kind(e) === SANDBOX_KIND && e.payload.phase === phase);
const isProbe = (r: DebitRow) => r.request_id.endsWith(":probe") && r.maximum_micros === 0;

export interface Observation {
  name: string;
  detail: string;
}
export interface Verdict {
  ok: boolean;
  checks: Check[];
  observations: Observation[];
}

export function evaluateRecovery(ev: Evidence): Verdict {
  const checks: Check[] = [];
  const observations: Observation[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const obs = (name: string, detail: string) => observations.push({ name, detail });
  const j = ev.final.journal;
  const boundary = ev.pre.maxSeq;

  add("agent finished after restart", TERMINAL.has(ev.final.agent.state), `state=${ev.final.agent.state} exit=${ev.final.agent.exit}`);

  // Precondition of the variant, reported as a check so a vacuous run cannot pass.
  if (ev.variant === "adopt")
    add("container survived the pomtreed SIGKILL", ev.pre.containerRunningAfterKill, `running after kill: ${ev.pre.containerRunningAfterKill}`);
  else add("container was dead before the restart", !ev.pre.containerRunningAfterKill, `running after container kill: ${ev.pre.containerRunningAfterKill}`);

  // --- no duplicate terminal outcome / publish / settlement
  const exits = j.filter((e) => kind(e) === "exited");
  add("exactly one terminal exited record", exits.length === 1, `${exits.length} lifecycle 'exited' entries`);
  const reports = j.filter((e) => kind(e) === "report_published").map((e) => String(e.payload.report));
  add("no duplicate publish", new Set(reports).size === reports.length, `${reports.length} report_published entries, ${new Set(reports).size} distinct`);
  const reqIds = j.filter((e) => kind(e) === SETTLEMENT_KIND).map((e) => String(e.payload.requestId));
  add("no duplicate model settlement", new Set(reqIds).size === reqIds.length, `${reqIds.length} settlements, ${new Set(reqIds).size} distinct request ids`);

  // --- journal and debit continuity
  const seqs = new Set(j.map((e) => e.seq));
  add(
    "journal rows from before the kill survive",
    j.some((e) => e.seq <= boundary) && boundary > 0,
    `pre-kill max seq ${boundary}, ${seqs.size} entries after`,
  );

  const finalById = new Map(ev.final.debit.map((r) => [r.request_id, r]));
  const preReal = ev.pre.debit.filter((r) => !isProbe(r));
  const missing = preReal.filter((r) => !finalById.has(r.request_id)).map((r) => r.request_id);
  const changed = preReal
    .filter((r) => r.status === "settled")
    .filter((r) => {
      const f = finalById.get(r.request_id);
      return f !== undefined && (f.status !== "settled" || f.charged_micros !== r.charged_micros);
    })
    .map((r) => r.request_id);
  add(
    "debit rows survive the restart unchanged",
    preReal.length > 0 && missing.length === 0 && changed.length === 0,
    `${preReal.length} pre-kill rows; missing=${JSON.stringify(missing)} changed=${JSON.stringify(changed)}`,
  );
  // An in-flight reservation the proxy expires after a crash is charged in full (status expired-charged) and counts toward spend, but has no journaled settlement.
  const settledSum = ev.final.debit.filter((r) => r.status === "settled" || r.status === "expired-charged").reduce((s, r) => s + (r.charged_micros ?? 0), 0);
  add("spend equals settled debits", settledSum === ev.final.spentMicros, `recomputed ${settledSum}, reported ${ev.final.spentMicros}`);
  add("spend is monotone across the restart", ev.final.spentMicros >= ev.pre.spentMicros, `before ${ev.pre.spentMicros}, after ${ev.final.spentMicros}`);
  add("total spend within cap", ev.final.spentMicros <= ev.capMicros, `${ev.final.spentMicros} of ${ev.capMicros} micros`);
  add("operator API and token work after the restart", ev.final.operatorApiOk, `pomtree ps ok: ${ev.final.operatorApiOk}`);

  // --- at most one live container once the agent is terminal
  const stillRunning = ev.final.agentContainers.filter((c) => c.running);
  add("no agent container left running", TERMINAL.has(ev.final.agent.state) && stillRunning.length === 0, `${stillRunning.length} running`);

  const started = sandboxEntries(j, "started");
  const startedIds = new Set(started.map((e) => String(e.payload.sandbox)));
  const resumed = j.filter((e) => kind(e) === "resumed");
  const afterErrors = j.filter((e) => e.seq > boundary && kind(e) === "error").map((e) => String(e.payload.message ?? "").slice(0, 160));
  const secondContainer = startedIds.size > 1;

  const grantResumes = ev.grantResumes ?? 0;
  if (ev.variant === "adopt" && grantResumes > 0) {
    // Adopted, then refused by the proxy below its minimum, parked on a budget approval and resumed by the grant (proxy-reserve-restart):
    // a second container and a bumped generation are the designed path, so the plain-adoption checks are replaced by these.
    const origin = ev.pre.agent.sandbox;
    add(
      "adopted first, then resumed by a budget grant: the original container started first",
      origin !== null && started[0]?.payload.sandbox === origin,
      `original ${origin}; first started ${JSON.stringify(started[0]?.payload.sandbox)}`,
    );
    add(
      "a budget grant bumped the generation",
      ev.final.agent.generation > ev.pre.agent.generation,
      `generation ${ev.pre.agent.generation} -> ${ev.final.agent.generation} after ${grantResumes} grant(s)`,
    );
    add("no more resumes than grants", resumed.length <= grantResumes, `${resumed.length} 'resumed' entries, ${grantResumes} grant(s)`);
    // Whether a yield tears the adopted container down with a journaled sandbox exit is not asserted (unverified live): observed only.
    obs(
      "sandbox exits journaled after the restart",
      JSON.stringify(
        sandboxEntries(j, "exited")
          .filter((e) => e.seq > boundary)
          .map((e) => e.payload.sandbox),
      ),
    );
  } else if (ev.variant === "adopt") {
    add(
      "adopted, not restarted: no second container",
      startedIds.size === 1 && ev.final.agentContainers.length <= 1,
      `${startedIds.size} sandbox 'started' ids, ${ev.final.agentContainers.length} agent containers on the docker host`,
    );
    add(
      "generation not bumped by adoption",
      ev.final.agent.generation === ev.pre.agent.generation,
      `generation ${ev.pre.agent.generation} -> ${ev.final.agent.generation}`,
    );
    add("no resume journaled", resumed.length === 0, `${resumed.length} 'resumed' lifecycle entries`);
    const origin = ev.pre.agent.sandbox;
    const exitedFor = sandboxEntries(j, "exited").filter((e) => e.seq > boundary);
    add(
      "adopted container's exit is journaled against the original container",
      origin !== null && exitedFor.length >= 1 && exitedFor.every((e) => e.payload.sandbox === origin),
      `original ${origin}; post-restart exited entries for ${JSON.stringify(exitedFor.map((e) => e.payload.sandbox))}`,
    );
  } else {
    // Dead container: the daemon promises exactly one outcome and no leaked state; WHICH outcome depends on whether a checkpoint existed.
    add(
      "dead container: no concurrent second container",
      stillRunning.length === 0 && TERMINAL.has(ev.final.agent.state),
      `${stillRunning.length} running at the end`,
    );
    if (secondContainer || resumed.length > 0) {
      const evicted = j.some((e) => kind(e) === "workspace_evicted");
      add(
        "resume reused the same folder",
        ev.final.workspaceDirs === 1 && !evicted,
        `${ev.final.workspaceDirs} workspace dir(s); workspace_evicted=${evicted}`,
      );
      add(
        "resume fenced the dead instance (generation bumped)",
        ev.final.agent.generation > ev.pre.agent.generation,
        `generation ${ev.pre.agent.generation} -> ${ev.final.agent.generation}`,
      );
    }
    obs(
      "dead-container outcome",
      secondContainer || resumed.length > 0
        ? `resumed: ${startedIds.size} containers started, ${resumed.length} resumed entries, final ${ev.final.agent.state}/${ev.final.agent.exit}`
        : `not resumed: final ${ev.final.agent.state}/${ev.final.agent.exit}; causes ${JSON.stringify(j.filter((e) => kind(e) === "exited").map((e) => e.payload.cause ?? null))}`,
    );
  }

  // --- observations: behavior the code or SPEC leaves unclear
  obs("final record", `${ev.final.agent.state}/${ev.final.agent.exit}, generation ${ev.final.agent.generation}`);
  const causes = j.filter((e) => kind(e) === "exited").map((e) => e.payload.cause ?? null);
  obs("exit cause(s) on the terminal record", JSON.stringify(causes));
  const settlementsAfter = j.filter((e) => e.seq > boundary && kind(e) === SETTLEMENT_KIND).length;
  obs(
    "model calls after the restart",
    `${settlementsAfter} settlements journaled after the kill (0 means the agent made no further model call, or an adopted container could not reach the restarted proxy)`,
  );
  obs("errors journaled after the restart", JSON.stringify(afterErrors));
  obs(
    "restart-related journal entries",
    JSON.stringify(
      j
        .filter((e) => e.seq > boundary && /auto-restart|adopt|restart/i.test(String(e.payload.message ?? "")))
        .map((e) => String(e.payload.message).slice(0, 120)),
    ),
  );
  obs("typed result", `adopted agents finish from the container exit code (TODO(adopted-degraded)); exit=${ev.final.agent.exit}`);

  return { ok: checks.every((c) => c.ok), checks, observations };
}
