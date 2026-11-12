// Live demo (see docs/economy.md sections 13.2 to 13.5): an interactive (TTY) Pi agent exhausts a small
// model budget, parks behind a `budget_raise` approval, and the operator decides. Real Docker + real Pi + a real model through the
// key-issuing proxy. Spends real money (a few thousand micro-dollars per scenario; 1,000,000 micros = $1).
//   A  APPROVE: exhaustion trigger fires (usage over budget vs the proxy's 402 error event is RECORDED, with the error text),
//      approval opens, agent yielded (container gone, slot freed, key revoked), ask on the "ui" channel, parked agent refuses
//      resume (409 budget_pending) and a message does not wake it (scenario C), operator approves, grant journaled, budget raised,
//      only root's remaining fell, resumed at generation+1 in a NEW container with a fresh key whose cap is the raised TOTAL,
//      the agent finishes succeeded.
//   B  DENY: same setup; denial finishes the agent over_budget with its checkpoint (and, if observable, folder) kept.
// Run: POMTREED_LIVE=1 POMTREED_PI_PROVIDER=deepseek POMTREED_MODEL_BASE_URL=... POMTREED_MODEL_UPSTREAM_KEY_FILE=<0600 key file> node packages/e2e/src/demo/budget-escalate.ts
// Optional: POMTREED_DEMO_MODEL (default deepseek-flash), POMTREED_DEMO_TIMEOUT_MS (per phase, default 240000), POMTREED_AGENT_IMAGE,
// POMTREED_DEMO_AGENT_BUDGET_MICROS (default 8000), POMTREED_DEMO_SCENARIOS (default "AB"; each letter is one live run).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelRefusalCodeIn } from "@pomtree/core";
import { PI_SINK_FILE, PI_TTY_ENV, createPiHarness, fileTailSource, piArgv } from "@pomtree/harness-pi";
import { Daemon, LocalOrchestrator, wireLocalHost } from "@pomtree/pomtreed";
import { buildChannelRegistry } from "../../../pomtreed/src/channels.ts";
import { DockerSandbox } from "@pomtree/sandbox-docker";
import { openStore } from "@pomtree/store-sqlite";
import { until as pollUntil } from "@pomtree/testing";
import { DirReportStore } from "@pomtree/report-dir";
import { demoWorkspace } from "./demo-workspace.ts";
import { startLiveModel } from "../live-model.ts";
import { listenAgentEndpoint } from "./agent-endpoint.ts";

const env = process.env;
const phaseMs = Number(env.POMTREED_DEMO_TIMEOUT_MS ?? 240_000);
const rootBudget = 2_000_000;
const agentBudget = Number(env.POMTREED_DEMO_AGENT_BUDGET_MICROS ?? 8_000);
const scenarios = env.POMTREED_DEMO_SCENARIOS ?? "AB";
const image = env.POMTREED_AGENT_IMAGE ?? env.PTREE_E2E_IMAGE ?? "pomtree/agent:dev";
const model = env.POMTREED_DEMO_MODEL ?? "deepseek-flash";
const modelEnv = {
  ...env,
  POMTREED_MODEL_BASE_URL: env.POMTREED_MODEL_BASE_URL ?? env.PTREE_E2E_MODEL_BASE_URL,
};

console.log(`pomtree budget-escalate demo: LIVE model calls (spends real money), interactive Pi in Docker.
  provider: ${env.POMTREED_PI_PROVIDER ?? "(unset; POMTREED_PI_PROVIDER is required)"} · model ${model} · image ${image}
  agent budget ${agentBudget} micros · scenarios ${scenarios} · per-phase timeout ${Math.round(phaseMs / 1000)}s`);
if (env.POMTREED_LIVE !== "1") {
  console.error("\nrefusing to run: set POMTREED_LIVE=1 to confirm live model calls and real money.");
  process.exit(2);
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@pomtree", ...a], { cwd, encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const code = `BX-${randomBytes(3).toString("hex").toUpperCase()}`;
const taskFor = (tag: string) => `Your code word is ${code}-${tag} (a harmless test label, not a secret).
Do these steps in order, each as its own separate bash tool call, one command per call (do not combine them):
  1. echo one >> steps.log   2. echo two >> steps.log   3. echo three >> steps.log   4. echo four >> steps.log
  5. echo five >> steps.log   6. echo six >> steps.log   7. echo seven >> steps.log   8. echo eight >> steps.log
  9. cat steps.log
If you are resumed after a pause, check steps.log, continue from where it stopped, and do not repeat finished steps.
When all nine are done, run exactly: pomtree result --summary "code=<your code word>"`;

const tempDir = mkdtempSync(join(tmpdir(), "pomtree-budget-escalate-"));
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
  defaultBudgetMicros: agentBudget,
  topLevelBudgetMicros: agentBudget,
  graceMs: 10_000,
  admitRetryMs: 500,
  checkpoints: store.checkpoints,
  sessions: store.sessions,
  sessionRoot: join(stateDir, "sessions"),
  terminal: { size: { cols: 80, rows: 24 }, env: PI_TTY_ENV, sinkFile: PI_SINK_FILE },
  escalations: store.escalations,
  approvals: store.approvals,
  budgetRaisePct: 400, // request 4x the original budget so one grant covers the rest of the task
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

async function scenario(tag: "A" | "B"): Promise<void> {
  const approve = tag === "A";
  console.log(`\n== scenario ${tag}: ${approve ? "APPROVE (+ parked-agent checks)" : "DENY"} ==`);
  const top = await daemon.root();
  const a = await daemon.spawn(top.id, { name: `escalator-${tag}`, task: taskFor(tag), idempotencyKey: `be-${tag}` });
  const id = a.id;
  console.log(`spawned ${id}; budget ${a.budgetMicros} micros`);
  const containers = async () => (await sandbox.list()).filter((s) => s.agent === id).map((s) => s.id);
  const evs = async () => (await daemon.events({ agent: id })).map((e) => ({ seq: e.seq, p: e.payload as P }));
  const kinds = async () => (await evs()).map((e) => e.p.kind);
  const c0 = (await until("first container", async () => (await containers())[0]))!;
  const key0 = issued.at(-1)!.key;
  const rootRemain0 = await daemon.remainingMicros((await daemon.root())!);
  const budget0 = (await daemon.get(id))!.budgetMicros;

  // Exhaustion trigger: the first of a usage event at/over budget or the proxy's 402 surfacing as an error event.
  const esc = await until("budget_escalated journal entry", async () => (await evs()).find((e) => e.p.kind === "ext.pomtreed.budget_escalated"));
  const all = await evs();
  const refusal = all.find(
    (e) => (e.p.kind === "error" || e.p.kind === "provider_error") && modelRefusalCodeIn(String(e.p.message ?? "")) === "model_budget_exhausted",
  );
  const lastUsage = all.filter((e) => e.p.kind === "usage" && e.seq < esc.seq).at(-1);
  const spentAtEsc = Number(esc.p.spent);
  const trigger = refusal && (!lastUsage || refusal.seq > lastUsage.seq) ? "proxy 402 error event" : "usage event over budget";
  console.log(`  TRIGGER: ${trigger}; spent ${spentAtEsc} of ${esc.p.budget}; ${all.filter((e) => e.p.kind === "usage").length} usage events`);
  console.log(
    `  TRIGGER 402 error event present: ${refusal ? `yes, kind=${refusal.p.kind} message=${JSON.stringify(String(refusal.p.message).slice(0, 400))}` : "no"}`,
  );
  const errs = all.filter((e) => e.p.kind === "error" || e.p.kind === "provider_error");
  if (!refusal && errs.length) console.log(`  other error events: ${errs.map((e) => JSON.stringify(String(e.p.message).slice(0, 200))).join(" | ")}`);
  check(`${tag} exhaustion trigger fired`, spentAtEsc >= budget0 || !!refusal, trigger);

  const approvalId = String(esc.p.approval);
  const requested = Number(esc.p.requested);
  const ap0 = await store.approvals.get(approvalId);
  check(
    `${tag} budget_raise approval opened`,
    ap0?.action.kind === "budget_raise" && ap0.state === "pending" && requested > 0,
    `requested ${requested} micros, state ${ap0?.state}`,
  );

  await until("state yielded", async () => (await daemon.get(id))?.state === "yielded");
  const parked = (await daemon.get(id))!;
  // yield() returns before settleYield releases the slot and the container (~400 ms), so poll rather than check once.
  const settled = await until(
    "yielded, container gone, slot freed",
    async () => (await daemon.get(id))?.state === "yielded" && (await containers()).length === 0 && !(await daemon.placementStatus()).running.includes(id),
    5_000,
  ).catch(() => false);
  check(`${tag} agent yielded, container gone, slot freed`, settled === true, `generation ${parked.generation}`);
  const revoked = await until("key revoked", async () => live.gateway.authorize(key0) === null, 15_000).catch(() => false);
  check(`${tag} pre-park model key revoked`, revoked === true);
  const cp = await store.checkpoints.latest(id);
  check(`${tag} checkpoint written`, !!cp && cp.generation === parked.generation, cp ? `gen ${cp.generation} wait=${cp.wait?.kind ?? "none"}` : "none");
  const k1 = await kinds();
  check(
    `${tag} journal has ext.pomtreed.budget_escalated and yielded`,
    k1.includes("ext.pomtreed.budget_escalated") && k1.includes("yielded"),
    k1.filter((x) => x.startsWith("ext.pomtreed.budget") || x === "yielded").join(" "),
  );
  const ask = (await daemon.events({})).find((e) => {
    const p = e.payload as P;
    return p.kind === "message_sent" && p.purpose === "ask" && p.channel === "ui" && String(p.subject).includes(id);
  });
  check(`${tag} user-bound ask message_sent on ui`, !!ask, ask ? JSON.stringify((ask.payload as P).subject ?? "").slice(0, 120) : "none");

  if (approve) {
    // Scenario C: while parked, resume is refused and a message does not wake the agent.
    const err = await daemon.resumeAgent(id, "demo resume", {}, "be-A-resume").then(
      () => undefined,
      (e) => e as { status?: number; extra?: { code?: string }; message?: string },
    );
    check(
      "C resume of a parked agent is 409 budget_pending",
      err?.status === 409 && err.extra?.code === "budget_pending",
      `${err?.status} ${err?.extra?.code}`,
    );
    const m = await daemon.messageAgent(id, "demo: are you there? (must not wake a budget-parked agent)", "be-A-msg").catch((e) => ({ error: String(e) }));
    await sleep(4000);
    const still = (await daemon.get(id))!;
    check(
      "C a message does not wake the parked agent",
      still.state === "yielded" && still.generation === parked.generation && (await containers()).length === 0,
      `state=${still.state} gen=${still.generation} msg=${JSON.stringify(m).slice(0, 80)}`,
    );
  }

  const rootRemainParked = await daemon.remainingMicros((await daemon.root())!);
  const decision = await daemon.decideApproval(
    approvalId,
    approve ? "approve" : "deny",
    "operator",
    approve ? "demo approve" : "demo deny",
    `be-${tag}-decide`,
  );
  console.log(`  decided ${approve ? "approve" : "deny"}: approval state ${decision.state}`);

  if (approve) {
    await until("budget_granted", async () => (await kinds()).includes("ext.pomtreed.budget_granted"));
    const granted = (await evs()).find((e) => e.p.kind === "ext.pomtreed.budget_granted")!;
    check(
      "A budget_granted journaled",
      Number(granted.p.amount) === requested,
      `amount ${granted.p.amount} payer ${granted.p.payer} newBudget ${granted.p.newBudget}`,
    );
    await until("resume", async () => {
      const r = await daemon.get(id);
      return r !== null && r.generation > parked.generation && (await containers()).length > 0;
    });
    const res = (await daemon.get(id))!;
    const c1 = (await containers())[0]!;
    check("A resumed at generation+1 in a NEW container", res.generation === parked.generation + 1 && c1 !== c0, `${parked.generation} -> ${res.generation}`);
    check("A asker budget rose by the grant", res.budgetMicros === budget0 + requested, `${budget0} -> ${res.budgetMicros}`);
    const rootRemain1 = await daemon.remainingMicros((await daemon.root())!);
    check(
      "A only root's remaining fell (by the grant)",
      rootRemainParked - rootRemain1 === requested,
      `${rootRemainParked} -> ${rootRemain1} (start ${rootRemain0})`,
    );
    const key1 = issued.at(-1)!.key;
    check("A fresh key issued, old rejected", key1 !== key0 && live.gateway.authorize(key0) === null && live.gateway.authorize(key1) !== null);
    const sp = await live.gateway.spend(id);
    check("A new key's proxy cap is the raised TOTAL", sp.budgetMicros === budget0 + requested, `cap ${sp.budgetMicros}, spent ${sp.spentMicros}`);
    let waited = await daemon.waitDone(id, phaseMs);
    const doneBy = Date.now() + phaseMs;
    while (!waited.done && Date.now() < doneBy) waited = await daemon.waitDone(id, doneBy - Date.now());
    await until("reaped", async () => (await daemon.get(id))?.state === "reaped", 30_000).catch(() => {});
    const fin = (await daemon.get(id))!;
    const spentEnd = (await live.gateway.spend(id)).spentMicros;
    check(
      "A agent finished succeeded",
      fin.exit === "succeeded",
      `state=${fin.state} exit=${fin.exit} result=${JSON.stringify(fin.result ?? null).slice(0, 80)}`,
    );
    check("A spend continued after the grant", spentEnd > spentAtEsc, `${spentAtEsc} at park -> ${spentEnd} micros (old cap ${budget0})`);
    console.log(
      `  journal: ${(await kinds()).filter((x) => ["started", "yielded", "resumed", "reaped", "ext.pomtreed.budget_escalated", "ext.pomtreed.budget_granted"].includes(x)).join(" ")}`,
    );
  } else {
    let waited = await daemon.waitDone(id, phaseMs);
    const doneBy = Date.now() + phaseMs;
    while (!waited.done && Date.now() < doneBy) waited = await daemon.waitDone(id, doneBy - Date.now());
    const folder = cp ? workspace.hostPath(cp.workspace) : undefined;
    const folderThere = folder !== undefined && existsSync(folder);
    const fin = (await daemon.get(id))!;
    check("B agent ended over_budget", fin.exit === "over_budget", `state=${fin.state} exit=${fin.exit}`);
    const k = await kinds();
    check(
      "B budget_denied journaled, no grant",
      k.includes("ext.pomtreed.budget_denied") && !k.includes("ext.pomtreed.budget_granted"),
      k.filter((x) => x.startsWith("ext.pomtreed.budget")).join(" "),
    );
    const cpAfter = await store.checkpoints.latest(id);
    const bytes = cpAfter ? await store.sessions.get(cpAfter.sessionRef) : null;
    check("B checkpoint and session kept", !!cpAfter && !!bytes && bytes.length > 0, `${bytes?.length ?? 0} bytes`);
    const branches = git(repo, "branch", "-a", "--list", "*agents*");
    console.log(
      `  observed after over_budget finish: state=${fin.state}; workspace folder ${folderThere ? "present" : "absent (reaped with the root supervisor, if state=reaped)"}; agent branches in repo: ${branches ? branches.split("\n").length : 0}`,
    );
    check("B no container left", (await containers()).length === 0);
  }
}

let exitCode = 0;
try {
  const endpoint = await listenAgentEndpoint(daemon);
  apiUrl = endpoint.apiUrl;
  for (const s of scenarios) {
    if (s !== "A" && s !== "B") continue;
    try {
      await scenario(s);
      console.log(
        `SCENARIO ${s}: ${checks.filter((c) => c.name.startsWith(s) || (s === "A" && c.name.startsWith("C "))).every((c) => c.ok) ? "PASS" : "FAIL"}`,
      );
    } catch (e) {
      exitCode = 1;
      console.error(`SCENARIO ${s}: FAIL (${e instanceof Error ? (e.stack ?? e.message) : String(e)})`);
    }
  }
  endpoint.close();
} catch (e) {
  exitCode = 1;
  console.error(`budget-escalate demo failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  console.error(`temp dir: ${tempDir}`);
} finally {
  for (const s of await sandbox.list().catch(() => [])) await sandbox.kill(s.id).catch(() => {});
  for (const w of await workspace.list().catch(() => [])) await workspace.evict(w).catch(() => {});
  await live.close().catch(() => {});
  store.close();
  rmSync(socketPath, { force: true });
  console.log(`cleaned up containers and worktrees; temp dir kept at ${tempDir}`);
}
const bad = checks.filter((c) => !c.ok);
if (bad.length) exitCode = 1;
console.log(
  `\nGATE ${exitCode === 0 ? "PASS" : "FAIL"}: ${checks.length - bad.length}/${checks.length} checks${bad.length ? `; failed: ${bad.map((c) => c.name).join("; ")}` : ""}`,
);
process.exit(exitCode);
