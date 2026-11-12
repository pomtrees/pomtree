// Live demo of escalations through a real depth-3 ancestor chain, root -> A -> B -> C. The leaf C is an interactive (TTY) Pi in Docker through the key-issuing proxy; A and B
// are real registry agents (running, parent chain root -> A -> B) driven from this script through the agent-scoped HTTP API
// with their own agent tokens, exactly as `pomtree decide|answer|pass` would. They have no container and cost nothing.
// Spends real money (a few thousand micro-dollars per scenario; 1,000,000 micros = $1).
// (Closes the gap listed in docs/economy.md section 13.11; see also docs/tasks.md section 4.)
//   1  BUDGET via ancestors: C exhausts a small budget (the proxy's 402), the budget_raise approval's holder is B (an `escalation`
//      signal lands in B's inbox and the always-wake path fires); B cannot cover (409 insufficient_budget) and passes; the
//      approval advances to A; A approves from its own remaining. Only A's remaining falls; B's budget and consumed both rise by
//      the grant (slack, remaining unchanged); C's budget rises; C resumes at generation+1 in a NEW container with a fresh key
//      whose proxy cap is the raised TOTAL, and finishes succeeded.
//   2  ASK bubbling: C runs `pomtree ask` (parks), holder B passes, A answers; C resumes with the answer as a human_answer from agent A.
//   3  TIMEOUT hop: with a tiny agent-rung window, an unanswered ask advances B -> A -> the operator (a user-bound ask
//      message_sent on the configured channel); the operator answers and C finishes.
// Run: POMTREED_LIVE=1 POMTREED_PI_PROVIDER=deepseek POMTREED_MODEL_BASE_URL=... POMTREED_MODEL_UPSTREAM_KEY_FILE=<0600 key file> node packages/e2e/src/demo/escalation-chain.ts
// Optional: POMTREED_DEMO_MODEL (default deepseek-flash), POMTREED_DEMO_TIMEOUT_MS (per phase, default 240000), POMTREED_AGENT_IMAGE,
// POMTREED_DEMO_SCENARIOS (default "123"; each digit is one live Pi run).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "@pomtree/core";
import { PI_SINK_FILE, PI_TTY_ENV, createPiHarness, fileTailSource, piArgv } from "@pomtree/harness-pi";
import { Daemon, LocalOrchestrator, handle, wireLocalHost } from "@pomtree/pomtreed";
import { buildChannelRegistry } from "../../../pomtreed/src/channels.ts";
import { DockerSandbox } from "@pomtree/sandbox-docker";
import { openStore } from "@pomtree/store-sqlite";
import { until as pollUntil } from "@pomtree/testing";
import { DirReportStore } from "@pomtree/report-dir";
import { demoWorkspace } from "./demo-workspace.ts";
import { startLiveModel } from "../live-model.ts";
import { sandboxOpKey, sandboxOwner } from "../../../pomtreed/src/daemon/sandbox-ops.ts";
import { listenAgentEndpoint } from "./agent-endpoint.ts";

const env = process.env;
const phaseMs = Number(env.POMTREED_DEMO_TIMEOUT_MS ?? 240_000);
const scenarios = env.POMTREED_DEMO_SCENARIOS ?? "123";
const image = env.POMTREED_AGENT_IMAGE ?? env.PTREE_E2E_IMAGE ?? "pomtree/agent:dev";
const model = env.POMTREED_DEMO_MODEL ?? "deepseek-flash";
const rootBudget = 2_000_000;
const tightBudget = 8_000; // scenario 1 leaf: exhausts via the proxy's 402 within a few tool calls
const roomyBudget = 60_000; // scenarios 2 and 3 leaf: room to ask and report
const hopWindowMs = 600_000;
const shortHopMs = 5_000; // scenario 3 agent-rung window
const modelEnv = {
  ...env,
  POMTREED_MODEL_BASE_URL: env.POMTREED_MODEL_BASE_URL ?? env.PTREE_E2E_MODEL_BASE_URL,
};

console.log(`pomtree escalation-chain demo: LIVE model calls (spends real money), interactive Pi leaf in Docker.
  provider: ${env.POMTREED_PI_PROVIDER ?? "(unset; POMTREED_PI_PROVIDER is required)"} · model ${model} · image ${image}
  chain root -> A -> B -> C(leaf, real Pi) · scenarios ${scenarios} · per-phase timeout ${Math.round(phaseMs / 1000)}s`);
if (env.POMTREED_LIVE !== "1") {
  console.error("\nrefusing to run: set POMTREED_LIVE=1 to confirm live model calls and real money.");
  process.exit(2);
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@pomtree", ...a], { cwd, encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const code = `EC-${randomBytes(3).toString("hex").toUpperCase()}`;
const budgetTask = (tag: string) => `Your code word is ${code}-${tag} (a harmless test label, not a secret).
Do these steps in order, each as its own separate bash tool call, one command per call (do not combine them):
  1. echo one >> steps.log   2. echo two >> steps.log   3. echo three >> steps.log   4. echo four >> steps.log
  5. echo five >> steps.log   6. echo six >> steps.log   7. echo seven >> steps.log   8. echo eight >> steps.log
  9. cat steps.log
If you are resumed after a pause, check steps.log, continue from where it stopped, and do not repeat finished steps.
When all nine are done, run exactly: pomtree result --summary "code=<your code word>"`;
const askTask = (tag: string) => `Your code word is ${code}-${tag} (a harmless test label, not a secret).
Step 1: run exactly this one command in a single bash call (it pauses you until someone answers):
  pomtree ask "Which database should the demo use: pg or sqlite?" --wait 600000
Step 2: after you are resumed, the resume message contains an answer token. Run exactly: pomtree result --summary "answer=<the exact answer token from the resume message>"`;

const tempDir = mkdtempSync(join(tmpdir(), "pomtree-escalation-chain-"));
const repo = join(tempDir, "repo");
const stateDir = join(tempDir, "state");
mkdirSync(repo);
mkdirSync(stateDir, { mode: 0o700 });
git(repo, "init", "-q", "-b", "main");
writeFileSync(join(repo, "seed.md"), "# seed\n");
git(repo, "add", "seed.md");
git(repo, "commit", "-q", "-m", "seed");

const secret = randomBytes(32).toString("hex");
const socketPath = join(stateDir, "pomtreed.sock");
const store = openStore(join(stateDir, "pomtreed.sqlite"));
const workspace = demoWorkspace({ repoDir: repo, stateDir });
const provider = env.POMTREED_PI_PROVIDER; // required (startLiveModel refuses without it)
const live = await startLiveModel({ store, secret, stateDir, provider, env: modelEnv });
// Record every key the daemon issues (in memory only, never printed) so a pre-park key can be probed after revocation.
const issued: { key: string }[] = [];
const gateway = Object.create(live.gateway) as typeof live.gateway;
gateway.issueKey = async (...a: Parameters<typeof live.gateway.issueKey>) => {
  const r = await live.gateway.issueKey(...a);
  issued.push({ key: r.key });
  return r;
};
const orchestrator = new LocalOrchestrator();
// Every wake the daemon issues (the always-wake hop path), recorded without changing behavior.
const wakes: { agent: string; kind: string }[] = [];
const wake0 = orchestrator.wake.bind(orchestrator);
orchestrator.wake = async (agent, signal) => {
  wakes.push({ agent, kind: signal.kind });
  return wake0(agent, signal);
};
let apiUrl: string | undefined;
const { placement, sandbox } = wireLocalHost({
  hostId: "demo",
  hosts: store.hosts,
  workspace,
  sessionRoot: join(stateDir, "sessions"),
  image,
  capacity: { maxSessions: 1 },
  makeSandbox: (mounts) => new DockerSandbox({ mounts }),
});
const daemon = new Daemon({
  hostId: "demo",
  secret,
  image,
  sandboxSocketPath: "/run/pomtreed.sock",
  untemplatedEgress: "registry", // main.ts states it (boot refuses unset); registry keeps untemplated spawns reaching package registries
  socketHostPath: socketPath,
  agentApiUrl: () => apiUrl,
  registry: store.registry,
  journal: store.journal,
  mailbox: store.mailbox,
  sandbox,
  workspace,
  harness: createPiHarness({ sink: (agent) => fileTailSource(join(stateDir, "sessions", agent, PI_SINK_FILE)) }),
  gateway,
  command: (task) => piArgv({ prompt: task, ...(provider && { provider }), model }),
  // The Daemon's default spec model is the one Pi is told to call, so the gateway signs it into each key's model allowlist.
  ...(provider && { provider }),
  model,
  credentials: live.credentials,
  rootBudgetMicros: rootBudget,
  defaultBudgetMicros: tightBudget,
  topLevelBudgetMicros: tightBudget,
  graceMs: 10_000,
  admitRetryMs: 500,
  checkpoints: store.checkpoints,
  sessions: store.sessions,
  sessionRoot: join(stateDir, "sessions"),
  terminal: { size: { cols: 80, rows: 24 }, env: PI_TTY_ENV, sinkFile: PI_SINK_FILE },
  escalations: store.escalations,
  approvals: store.approvals,
  budgetRaisePct: 400, // request 4x the original budget so one grant covers the rest of the task
  escAgentMs: hopWindowMs,
  channels: buildChannelRegistry([], ["ui"]),
  watchdogs: store.watchdogs,
  schedules: store.schedules,
  reportStore: new DirReportStore({ root: join(stateDir, "reports"), registry: store.registry }),
  reportMaxBytes: 8 * 1024 * 1024,
  placement,
  orchestrator,
});
placement.onAdmit((agent) => daemon.admitted(agent));

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

async function until<T>(what: string, f: () => Promise<T | undefined | false>, ms = phaseMs): Promise<T> {
  let found: T | undefined | false;
  await pollUntil(
    async () => {
      found = await f();
      return !!found;
    },
    ms,
    { what, intervalMs: 400 },
  );
  return found as T;
}

type P = { kind: string; [k: string]: unknown };
type Sig = { kind: string; id?: string; subject?: string; from?: string; requestedMicros?: number };

const get = async (id: string) => (await daemon.get(id)) as AgentRecord;
const remaining = async (id: string) => daemon.remainingMicros(await get(id));
const evs = async (id?: string) => (await daemon.events(id ? { agent: id } : {})).map((e) => ({ seq: e.seq, p: e.payload as P }));
const kindsOf = async (id: string) => (await evs(id)).map((e) => e.p.kind);
const inbox = async (id: string) => ((await store.mailbox.peek(id)) as unknown as Sig[]).filter((s) => s.kind === "escalation");
const containersOf = async (id: string) => (await sandbox.list(sandboxOwner(daemon.deps, daemon.epoch))).filter((s) => s.agent === id).map((s) => s.id);
const userAsk = async (c: string) =>
  (await evs()).find((e) => e.p.kind === "message_sent" && e.p.purpose === "ask" && e.p.channel === "ui" && String(e.p.subject).includes(c));
// Act as an ancestor agent through the HTTP API with its own agent-scoped token (what `pomtree decide|answer|pass` does).
const as = (agent: string, url: string, body: unknown) => handle(daemon, { method: "POST", url, token: daemon.agentToken(agent), body });
const bodyOf = (r: { body: unknown }) => r.body as { code?: string; rungIndex?: number; state?: string };

// A and B: registry agents that are `running` with the right parent chain (root -> A -> B), no container, no model.
async function ancestors(tag: string, aBudget: number, bBudget: number): Promise<{ a: AgentRecord; b: AgentRecord }> {
  const root = await daemon.root();
  if (root.executor !== "container") throw new Error("demo root must be a container agent");
  const mk = async (name: string, parent: string, budgetMicros: number) => {
    const rec = await store.registry.create({
      executor: "container",
      spec: root.spec,
      parent,
      name,
      task: "scripted ancestor driven by the demo",
      host: "demo",
      budgetMicros,
      idempotencyKey: name,
    });
    return store.registry.transition(rec.id, rec.generation, "running", { idempotencyKey: `${name}-run` });
  };
  const a = await mk(`anc-A-${tag}`, root.id, aBudget);
  const b = await mk(`anc-B-${tag}`, a.id, bBudget);
  return { a, b };
}

async function finish(id: string): Promise<AgentRecord> {
  let waited = await daemon.waitDone(id, phaseMs);
  const doneBy = Date.now() + phaseMs;
  while (!waited.done && Date.now() < doneBy) waited = await daemon.waitDone(id, doneBy - Date.now());
  await until("reaped or exited", async () => ["exited", "reaped"].includes((await get(id)).state), 30_000).catch(() => {});
  return get(id);
}

let totalSpent = 0;
const noStaleHops = async (tag: string, ...ids: string[]) => {
  const left = (await Promise.all(ids.map(async (i) => (await inbox(i)).length))).reduce((x, y) => x + y, 0);
  check(`${tag} no stale hop signal left unacked on A or B`, left === 0, `${left} left`);
};
const noContainers = async (tag: string, id: string) => {
  const gone = await until("container gone", async () => (await containersOf(id)).length === 0, 15_000).catch(() => false);
  check(`${tag} no container left for the leaf`, gone === true);
};

async function scenario1(): Promise<void> {
  console.log("\n== scenario 1: BUDGET via ancestors (C -> B cannot cover, passes -> A pays) ==");
  daemon.deps.escAgentMs = hopWindowMs;
  const { a, b } = await ancestors("1", 500_000, 30_000);
  const c = await daemon.spawn(b.id, { name: "leaf-1", task: budgetTask("1"), idempotencyKey: "ec-1", budgetMicros: tightBudget });
  console.log(`A=${a.id} B=${b.id} C=${c.id}; budgets A ${a.budgetMicros} B ${b.budgetMicros} C ${c.budgetMicros}`);
  check("1 C's parent chain is root -> A -> B -> C", c.parent === b.id && b.parent === a.id && a.parent === (await daemon.root()).id);
  await until("first container", async () => (await containersOf(c.id))[0]);
  const c0 = (await containersOf(c.id))[0]!;
  const key0 = issued.at(-1)!.key;
  const esc = await until("budget_escalated", async () => (await evs(c.id)).find((e) => e.p.kind === "ext.pomtreed.budget_escalated"));
  const approvalId = String(esc.p.approval);
  const X = Number(esc.p.requested);
  const ap0 = (await store.approvals.get(approvalId))!;
  console.log(
    `  exhausted: spent ${esc.p.spent} of ${esc.p.budget}; requested ${X}; rungs ${ap0.rungs.map((r) => (r.startsWith("agent:") ? (r === `agent:${b.id}` ? "B" : r === `agent:${a.id}` ? "A" : r) : r)).join(",")}`,
  );
  check(
    "1 budget_raise approval's rungs are [B, A, operator, owner], pending at B",
    ap0.action.kind === "budget_raise" &&
      ap0.state === "pending" &&
      ap0.rungIndex === 0 &&
      JSON.stringify(ap0.rungs) === JSON.stringify([`agent:${b.id}`, `agent:${a.id}`, "operator", "owner"]),
    `state ${ap0.state} rungIndex ${ap0.rungIndex}`,
  );
  const parked = await until("yielded", async () => ((await get(c.id)).state === "yielded" ? get(c.id) : false));
  const settled = await until(
    "container gone",
    async () => (await containersOf(c.id)).length === 0 && !(await daemon.placementStatus()).running.includes(c.id),
    10_000,
  ).catch(() => false);
  check("1 C parked (yielded, container gone, slot freed)", settled === true, `generation ${parked.generation}`);
  const sigB = (await inbox(b.id)).find((s) => s.subject === "budget_raise");
  check(
    "1 B got a budget_raise escalation signal from C; A did not",
    !!sigB && sigB.from === c.id && sigB.requestedMicros === X && (await inbox(a.id)).length === 0,
    `requested ${sigB?.requestedMicros}`,
  );
  check(
    "1 B was woken (always-wake), A not yet",
    wakes.some((w) => w.agent === b.id && w.kind === "escalation") && !wakes.some((w) => w.agent === a.id),
    JSON.stringify(wakes.slice(-2)),
  );
  const jb = (await evs(b.id)).find((e) => e.p.kind === "signal" && (e.p.signal as Sig).subject === "budget_raise");
  check("1 the hop signal is journaled on B", !!jb);
  check("1 nothing reached the user while ancestors hold it", (await userAsk(c.id)) === undefined);

  const remA0 = await remaining(a.id);
  const remB0 = await remaining(b.id);
  const budA0 = (await get(a.id)).budgetMicros;
  const budB0 = (await get(b.id)).budgetMicros;
  const budC0 = (await get(c.id)).budgetMicros;
  const consB0 = budB0 - remB0;
  const url = `/v1/approvals/${approvalId}/decide`;

  const nonHolder = await as(a.id, url, { decision: "approve", idempotencyKey: "a-early" });
  check("1 A (not yet the holder) cannot decide: 403", nonHolder.status === 403, `${nonHolder.status}`);
  const tooMuch = await as(b.id, url, { decision: "approve", idempotencyKey: "b-approve" });
  const tooMuchExplicit = await as(b.id, url, { decision: "approve", grantMicros: remB0 + 1, idempotencyKey: "b-approve-2" });
  check(
    "1 B cannot cover: approve is 409 insufficient_budget (requested and explicit grant above its remaining)",
    tooMuch.status === 409 &&
      bodyOf(tooMuch).code === "insufficient_budget" &&
      tooMuchExplicit.status === 409 &&
      bodyOf(tooMuchExplicit).code === "insufficient_budget",
    `B remaining ${remB0} < requested ${X}`,
  );
  check(
    "1 the failed approvals moved nothing",
    (await store.approvals.get(approvalId))!.state === "pending" && (await remaining(b.id)) === remB0 && (await get(c.id)).state === "yielded",
  );
  const pass = await as(b.id, url, { decision: "pass", idempotencyKey: "b-pass" });
  check(
    "1 B passes: approval advances to rung 1 (A)",
    pass.status === 201 && bodyOf(pass).rungIndex === 1,
    `${pass.status} rungIndex ${bodyOf(pass).rungIndex}`,
  );
  check(
    "1 B's hop signal acked, A's delivered and A woken",
    (await inbox(b.id)).length === 0 && (await inbox(a.id)).length === 1 && wakes.some((w) => w.agent === a.id && w.kind === "escalation"),
  );
  const replay = await as(b.id, url, { decision: "pass", idempotencyKey: "b-pass" });
  check("1 replaying the pass key is a no-op (A still has exactly one signal)", replay.status === 201 && (await inbox(a.id)).length === 1);
  check("1 B (past its rung) can no longer decide: 403", (await as(b.id, url, { decision: "approve", idempotencyKey: "b-late" })).status === 403);

  const approve = await as(a.id, url, { decision: "approve", why: "demo: A pays", grantMicros: X, idempotencyKey: "a-approve" });
  check(
    "1 A approves with a grant of the requested amount",
    approve.status === 201 && bodyOf(approve).state === "approved",
    `${approve.status} ${bodyOf(approve).state}`,
  );
  await until("budget_granted", async () => (await kindsOf(c.id)).includes("ext.pomtreed.budget_granted"));
  const granted = (await evs(c.id)).find((e) => e.p.kind === "ext.pomtreed.budget_granted")!;
  check(
    "1 budget_granted journaled with payer A and amount X",
    granted.p.payer === a.id && Number(granted.p.amount) === X,
    `amount ${granted.p.amount} newBudget ${granted.p.newBudget}`,
  );
  await until("resume", async () => (await get(c.id)).generation > parked.generation && (await containersOf(c.id)).length > 0);
  const res = await get(c.id);
  const c1 = (await containersOf(c.id))[0]!;
  check("1 C resumed at generation+1 in a NEW container", res.generation === parked.generation + 1 && c1 !== c0, `${parked.generation} -> ${res.generation}`);
  const remA1 = await remaining(a.id);
  const remB1 = await remaining(b.id);
  const budA1 = (await get(a.id)).budgetMicros;
  const budB1 = (await get(b.id)).budgetMicros;
  check("1 only A's remaining fell, by X", remA0 - remA1 === X && budA1 === budA0, `A remaining ${remA0} -> ${remA1}, A budget ${budA0} -> ${budA1}`);
  check(
    "1 B's budget and consumed both rose by X (remaining unchanged: slack)",
    budB1 === budB0 + X && budB1 - remB1 === consB0 + X && remB1 === remB0,
    `B budget ${budB0} -> ${budB1}, consumed ${consB0} -> ${budB1 - remB1}, remaining ${remB0} -> ${remB1}`,
  );
  check("1 C's budget rose by X", res.budgetMicros === budC0 + X, `${budC0} -> ${res.budgetMicros}`);
  const key1 = issued.at(-1)!.key;
  check("1 fresh key issued, old rejected", key1 !== key0 && live.gateway.authorize(key0) === null && live.gateway.authorize(key1) !== null);
  const sp = await live.gateway.spend(c.id);
  check("1 new key's proxy cap is the raised TOTAL", sp.budgetMicros === budC0 + X, `cap ${sp.budgetMicros}, spent ${sp.spentMicros}`);
  const fin = await finish(c.id);
  totalSpent += (await live.gateway.spend(c.id)).spentMicros;
  check("1 C finished succeeded", fin.exit === "succeeded", `state=${fin.state} exit=${fin.exit} result=${JSON.stringify(fin.result ?? null).slice(0, 80)}`);
  const ks = await kindsOf(c.id);
  check(
    "1 journal has budget_escalated, yielded, budget_granted, resumed",
    ["ext.pomtreed.budget_escalated", "yielded", "ext.pomtreed.budget_granted", "resumed"].every((k) => ks.includes(k)),
    ks.filter((k) => ["started", "yielded", "resumed", "exited", "ext.pomtreed.budget_escalated", "ext.pomtreed.budget_granted"].includes(k)).join(" "),
  );
  await noStaleHops("1", a.id, b.id);
  await noContainers("1", c.id);
}

// Wait for the leaf's ask, returning the open escalation.
const openAsk = (c: string) => until("open escalation", async () => (await store.escalations.list({ agent: c, state: "open" }))[0]);

async function scenario2(): Promise<void> {
  console.log("\n== scenario 2: ASK bubbling (C asks -> B passes -> A answers) ==");
  daemon.deps.escAgentMs = hopWindowMs;
  const { a, b } = await ancestors("2", 500_000, 200_000);
  const c = await daemon.spawn(b.id, { name: "leaf-2", task: askTask("2"), idempotencyKey: "ec-2", budgetMicros: roomyBudget });
  console.log(`A=${a.id} B=${b.id} C=${c.id}`);
  const token = `ANS-${randomBytes(3).toString("hex").toUpperCase()}`;
  const esc = await openAsk(c.id);
  check("2 the ask is held by B (nearest ancestor)", esc.holder === b.id, `holder ${esc.holder === b.id ? "B" : esc.holder}`);
  await until("C parked on the ask", async () => (await get(c.id)).state === "yielded");
  const parked = await get(c.id);
  const cp = await store.checkpoints.latest(c.id);
  check(
    "2 C parked on the ask (yielded, checkpoint written)",
    parked.state === "yielded" && !!cp,
    `generation ${parked.generation} wait=${cp?.wait?.kind ?? "none"}`,
  );
  const sigB = (await inbox(b.id))[0];
  check(
    "2 B has the ask signal and was woken; A has none",
    sigB?.subject === "ask" && sigB.from === c.id && (await inbox(a.id)).length === 0 && wakes.some((w) => w.agent === b.id && w.kind === "escalation"),
  );
  check("2 nothing reaches the user while ancestors hold it", (await userAsk(c.id)) === undefined);

  const ansUrl = `/v1/escalations/${esc.id}/answer`;
  const passUrl = `/v1/escalations/${esc.id}/pass`;
  check(
    "2 A (not the holder) cannot answer or pass: 403",
    (await as(a.id, ansUrl, { body: "early", idempotencyKey: "a-early" })).status === 403 &&
      (await as(a.id, passUrl, { idempotencyKey: "a-early-p" })).status === 403,
  );
  const pass = await as(b.id, passUrl, { idempotencyKey: "b-pass" });
  const afterPass = (await store.escalations.get(esc.id))!;
  check(
    "2 B passes: holder advances to A, B's signal acked, A's delivered and woken",
    pass.status === 201 &&
      afterPass.holder === a.id &&
      (await inbox(b.id)).length === 0 &&
      (await inbox(a.id)).length === 1 &&
      wakes.some((w) => w.agent === a.id && w.kind === "escalation"),
  );
  check("2 replaying the pass is a no-op", (await as(b.id, passUrl, { idempotencyKey: "b-pass" })).status === 201 && (await inbox(a.id)).length === 1);
  check("2 B can no longer answer: 403", (await as(b.id, ansUrl, { body: "late", idempotencyKey: "b-late" })).status === 403);
  const hop = (await evs(c.id)).find((e) => e.p.kind === "ext.pomtreed.escalation_hop");
  check("2 escalation_hop journaled (idx 1, holder A)", hop?.p.idx === 1 && hop.p.holder === a.id);

  const ans = await as(a.id, ansUrl, { body: token, idempotencyKey: "a-answer" });
  check("2 A answers", ans.status === 201, `${ans.status}`);
  const done = (await store.escalations.get(esc.id))!;
  const by = done.answeredBy as { channel?: string; sender?: string } | undefined;
  check(
    "2 escalation answered by agent A",
    done.state === "answered" && by?.channel === "agent" && by.sender === a.id,
    `${by?.channel}:${by?.sender === a.id ? "A" : by?.sender}`,
  );
  check("2 A's hop signal cleared on answering", (await inbox(a.id)).length === 0);
  await until("resume", async () => (await get(c.id)).generation > parked.generation);
  const fin = await finish(c.id);
  totalSpent += (await live.gateway.spend(c.id)).spentMicros;
  check(
    "2 C resumed at generation+1 and finished succeeded",
    fin.generation === parked.generation + 1 && fin.exit === "succeeded",
    `gen ${parked.generation} -> ${fin.generation} exit=${fin.exit}`,
  );
  const summary = JSON.stringify(fin.result ?? null);
  check("2 C continued with A's answer (human_answer from agent A)", summary.includes(token), `result=${summary.slice(0, 100)}`);
  const ev = (await evs(c.id)).find((e) => e.p.kind === "escalation_answered");
  const evBy = ev?.p.answeredBy as { channel?: string; sender?: string } | undefined;
  check("2 escalation_answered journaled with sender A", evBy?.channel === "agent" && evBy.sender === a.id);
  await noStaleHops("2", a.id, b.id);
  await noContainers("2", c.id);
}

async function scenario3(): Promise<void> {
  console.log(`\n== scenario 3: TIMEOUT hops (agent windows ${shortHopMs} ms: B -> A -> operator) ==`);
  daemon.deps.escAgentMs = shortHopMs;
  const { a, b } = await ancestors("3", 500_000, 200_000);
  const c = await daemon.spawn(b.id, { name: "leaf-3", task: askTask("3"), idempotencyKey: "ec-3", budgetMicros: roomyBudget });
  console.log(`A=${a.id} B=${b.id} C=${c.id}`);
  const token = `ANS-${randomBytes(3).toString("hex").toUpperCase()}`;
  const esc = await openAsk(c.id);
  await until("C parked on the ask", async () => (await get(c.id)).state === "yielded");
  const parked = await get(c.id);
  const seen: string[] = [esc.holder === b.id ? "B" : String(esc.holder)];
  let bDrained = false;
  let aDrained = false;
  const end = Date.now() + 120_000;
  let cur = esc;
  while (cur.holder !== null && Date.now() < end) {
    await sleep(1000);
    await daemon.sweepEscalations(); // no tick loop runs in this demo: drive the hop sweep by hand
    cur = (await store.escalations.get(esc.id))!;
    const name = cur.holder === b.id ? "B" : cur.holder === a.id ? "A" : cur.holder === null ? "operator" : String(cur.holder);
    if (seen.at(-1) !== name) {
      seen.push(name);
      if (name === "A") bDrained = (await inbox(b.id)).length === 0 && (await inbox(a.id)).length === 1;
      if (name === "operator") aDrained = (await inbox(a.id)).length === 0;
    }
  }
  console.log(`  holders over time: ${seen.join(" -> ")}`);
  check("3 an unanswered ask advances B -> A -> operator on lapsed windows", seen.join(",") === "B,A,operator", seen.join(" -> "));
  check("3 each lapsed holder's signal was acked as the ask moved on", bDrained && aDrained, `B drained ${bDrained}, A drained ${aDrained}`);
  check(
    "3 A was woken at its hop",
    wakes.some((w) => w.agent === a.id && w.kind === "escalation"),
  );
  const hops = (await evs(c.id))
    .filter((e) => e.p.kind === "ext.pomtreed.escalation_hop")
    .map((e) => `${e.p.idx}:${e.p.holder === a.id ? "A" : e.p.holder === null ? "operator" : "?"}`);
  check("3 escalation_hop journaled for each advance", hops.join(",") === "1:A,2:operator", hops.join(","));
  const ask = await userAsk(c.id);
  check("3 user-bound ask message_sent on the configured channel (ui)", !!ask, ask ? JSON.stringify(ask.p.subject ?? "").slice(0, 100) : "none");
  daemon.deps.escAgentMs = hopWindowMs;
  const ans = await daemon.answerEscalation(esc.id, token, { channel: "cli", sender: "operator" }, "op-answer");
  check("3 the operator answers", ans.state === "answered");
  await noStaleHops("3", a.id, b.id);
  const fin = await finish(c.id);
  totalSpent += (await live.gateway.spend(c.id)).spentMicros;
  check(
    "3 C resumed at generation+1 with the operator's answer and finished succeeded",
    fin.generation === parked.generation + 1 && fin.exit === "succeeded" && JSON.stringify(fin.result ?? null).includes(token),
    `gen ${parked.generation} -> ${fin.generation} exit=${fin.exit}`,
  );
  await noContainers("3", c.id);
}

let exitCode = 0;
try {
  const endpoint = await listenAgentEndpoint(daemon);
  apiUrl = endpoint.apiUrl;
  for (const s of scenarios) {
    const run = { "1": scenario1, "2": scenario2, "3": scenario3 }[s];
    if (!run) continue;
    try {
      await run();
      console.log(`SCENARIO ${s}: ${checks.filter((c) => c.name.startsWith(`${s} `)).every((c) => c.ok) ? "PASS" : "FAIL"}`);
    } catch (e) {
      exitCode = 1;
      console.error(`SCENARIO ${s}: FAIL (${e instanceof Error ? (e.stack ?? e.message) : String(e)})`);
    }
  }
  endpoint.close();
} catch (e) {
  exitCode = 1;
  console.error(`escalation-chain demo failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  console.error(`temp dir: ${tempDir}`);
} finally {
  const left = await sandbox.list(sandboxOwner(daemon.deps, daemon.epoch)).catch(() => []);
  check("no containers left at the end", left.length === 0, `${left.length} left (killing)`);
  for (const s of left) await sandbox.kill(s.id, sandboxOpKey("kill", s.id)).catch(() => {});
  for (const w of await workspace.list().catch(() => [])) await workspace.evict(w).catch(() => {});
  await live.close().catch(() => {});
  store.close();
  rmSync(socketPath, { force: true });
  console.log(`leaf spend across scenarios: ${totalSpent} micro-USD; cleaned up containers and worktrees; temp dir kept at ${tempDir}`);
}
const bad = checks.filter((c) => !c.ok);
if (bad.length) exitCode = 1;
console.log(
  `\nGATE ${exitCode === 0 ? "PASS" : "FAIL"}: ${checks.length - bad.length}/${checks.length} checks${bad.length ? `; failed: ${bad.map((c) => c.name).join("; ")}` : ""}`,
);
process.exit(exitCode);
