// Live demo: yield a live interactive (TTY) Pi container and
// resume it, twice in one run, against real Docker + real Pi + a real model through the key-issuing proxy. Spends real money. (Design: docs/economy.md section 13.8.)
// Checks at each yield: state yielded, container gone, admission slot freed, pre-yield model token rejected, checkpoint
// (ids/hashes only, version stamped) and session file verified. Checks at each resume: generation+1, a NEW container, a fresh
// key, the agent recalls a code word from before the yield (context continuity), one spend ledger, final succeeded + reaped.
// Run: POMTREED_LIVE=1 POMTREED_PI_PROVIDER=deepseek POMTREED_MODEL_BASE_URL=... POMTREED_MODEL_UPSTREAM_KEY_FILE=<0600 key file> node packages/e2e/src/demo/yield-resume.ts
// Optional: POMTREED_DEMO_MODEL (default deepseek-flash), POMTREED_DEMO_TIMEOUT_MS (per phase, default 240000), POMTREED_AGENT_IMAGE.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_SINK_FILE, PI_TTY_ENV, createPiHarness, fileTailSource, piArgv, sessionParses } from "@pomtree/harness-pi";
import { Daemon, wireLocalHost } from "@pomtree/pomtreed";
import { buildChannelRegistry } from "../../../pomtreed/src/channels.ts";
import { DockerSandbox } from "@pomtree/sandbox-docker";
import { openStore } from "@pomtree/store-sqlite";
import { until as pollUntil } from "@pomtree/testing";
import { DirReportStore } from "@pomtree/report-dir";
import { demoWorkspace } from "./demo-workspace.ts";
import { LocalOrchestrator } from "@pomtree/pomtreed";
import { startLiveModel } from "../live-model.ts";
import { listenAgentEndpoint } from "./agent-endpoint.ts";

const env = process.env;
const phaseMs = Number(env.POMTREED_DEMO_TIMEOUT_MS ?? 240_000);
const budgetMicros = Number(env.POMTREED_BUDGET_ROOT_MICROS ?? 2_000_000);
const image = env.POMTREED_AGENT_IMAGE ?? env.PTREE_E2E_IMAGE ?? "pomtree/agent:dev";
const model = env.POMTREED_DEMO_MODEL ?? "deepseek-flash";
const modelEnv = {
  ...env,
  POMTREED_MODEL_BASE_URL: env.POMTREED_MODEL_BASE_URL ?? env.PTREE_E2E_MODEL_BASE_URL,
};

console.log(`pomtree yield/resume demo: LIVE model calls (spends real money), interactive Pi in Docker.
  provider: ${env.POMTREED_PI_PROVIDER ?? "(unset; POMTREED_PI_PROVIDER is required)"} · model ${model} · image ${image}
  budget cap: $${(budgetMicros / 1_000_000).toFixed(2)} · per-phase timeout ${Math.round(phaseMs / 1000)}s`);
if (env.POMTREED_LIVE !== "1") {
  console.error("\nrefusing to run: set POMTREED_LIVE=1 to confirm live model calls and real money.");
  process.exit(2);
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@pomtree", ...a], { cwd, encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const code = `ZX-${randomBytes(3).toString("hex").toUpperCase()}`;
const TASK = `Your code word is ${code} (a harmless test label, not a secret). Remember it exactly.
Step 1: run exactly this command and nothing else: pomtree yield --until message
Step 2: after you are woken, follow the instruction in the wake message.`;
const WAKE1 = "You have been resumed (first time). Do not report yet. Run exactly this command and nothing else: pomtree yield --until message";
const WAKE2 = `You have been resumed (second time). Without looking anything up, recall the harmless test code word from your original task, then run exactly: pomtree result --summary "code=<the code word>"`;

const tempDir = mkdtempSync(join(tmpdir(), "pomtree-yield-resume-"));
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
// Record every key the daemon issues (held in memory only, never printed) so the pre-yield token can be probed after revocation.
const issued: { key: string; at: number }[] = [];
const gateway = Object.create(live.gateway) as typeof live.gateway;
gateway.issueKey = async (...a: Parameters<typeof live.gateway.issueKey>) => {
  const r = await live.gateway.issueKey(...a);
  issued.push({ key: r.key, at: Date.now() });
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
  rootBudgetMicros: budgetMicros,
  defaultBudgetMicros: Math.floor(budgetMicros / 2),
  graceMs: 10_000,
  admitRetryMs: 500,
  checkpoints: store.checkpoints,
  sessions: store.sessions,
  sessionRoot: join(stateDir, "sessions"),
  terminal: { size: { cols: 80, rows: 24 }, env: PI_TTY_ENV, sinkFile: PI_SINK_FILE },
  escalations: store.escalations,
  channels: buildChannelRegistry([], []),
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

// Scenario "midturn" (POMTREED_DEMO_SCENARIO=midturn): the daemon yields an agent that is mid-tool-call (a bash sleep),
// as the drive loop will on over-budget; then a message resumes it. Records what happens to the in-flight tool.
async function midTurn(): Promise<void> {
  const task = `Your code word is ${code} (a harmless test label, not a secret). Remember it exactly.
Run exactly this one bash command, with the bash tool timeout set to 120 seconds:
  echo started >> ran.log; sleep 45; echo finished >> ran.log
When the command has finished, run exactly: pomtree result --summary "code=<your code word>"`;
  const top = await daemon.root();
  const a = await daemon.spawn(top.id, { name: "midturn", task, idempotencyKey: "yr-mid" });
  const id = a.id;
  console.log(`spawned ${id}; code word ${code}`);
  const containers = async () => (await sandbox.list()).filter((s) => s.agent === id).map((s) => s.id);
  const evs = async () =>
    (await daemon.events({ agent: id })).map((e) => e.payload as { kind: string; callId?: string; input?: unknown; output?: string; ok?: boolean });
  const sleepCalls = async () => (await evs()).filter((p) => p.kind === "tool_call" && JSON.stringify(p.input).includes("sleep 45"));
  const first = await until("in-flight sleep tool call", async () => {
    const calls = await sleepCalls();
    const all = await evs();
    return calls.find((c) => !all.some((p) => p.kind === "tool_result" && p.callId === c.callId));
  });
  await sleep(4000); // let the sleep be genuinely in flight
  const open = await evs();
  check("tool call in flight when yield is forced", !open.some((p) => p.kind === "tool_result" && p.callId === first.callId));
  const rec = (await daemon.get(id))!;
  const oldKey = issued.at(-1)!.key;
  const oldContainer = (await containers())[0]!;
  const spend0 = (await live.gateway.spend(id)).spentMicros;
  const cp = await daemon.yield(id, { wait: { kind: "message" }, idempotencyKey: "yr-force" });
  const after = (await daemon.get(id))!;
  check("forced yield: state yielded", after.state === "yielded", `generation ${after.generation}`);
  await until("container gone", async () => (await containers()).length === 0, 30_000).catch(() => {});
  check("forced yield: container gone", (await containers()).length === 0);
  // yield() returns before settleYield releases the slot and revokes the key, so poll (and report the lag).
  const t0 = Date.now();
  const settled = await until(
    "slot freed and key revoked",
    async () => !(await daemon.placementStatus()).running.includes(id) && live.gateway.authorize(oldKey) === null,
    15_000,
  ).catch(() => false);
  check("forced yield: slot freed and pre-yield token rejected", settled === true, `${Date.now() - t0}ms after yield() returned`);
  const bytes = (await store.sessions.get(cp.sessionRef))!;
  const text = Buffer.from(bytes).toString("utf8");
  check("forced yield: session hash matches checkpoint", createHash("sha256").update(bytes).digest("hex") === cp.sessionRef, `${bytes.length} bytes`);
  check("forced yield: session fully parseable, newline-terminated", sessionParses(text) && text.endsWith("\n"));
  const roles = text
    .trimEnd()
    .split("\n")
    .map((l) => {
      try {
        const j = JSON.parse(l);
        return `${j.type ?? "?"}:${j.message?.role ?? ""}`;
      } catch {
        return "BAD";
      }
    });
  const toolCallsInSession = (text.match(/"type":"toolCall"/g) ?? []).length;
  const toolResultsInSession = (text.match(/"role":"toolResult"/g) ?? []).length;
  console.log(
    `  SEMANTICS session at yield: toolCall blocks=${toolCallsInSession} toolResult entries=${toolResultsInSession}; last entries: ${roles.slice(-3).join(", ")}`,
  );
  const ws = join(workspace.hostPath(cp.workspace), "ran.log");
  const ranBefore = (() => {
    try {
      return execFileSync("cat", [ws], { encoding: "utf8" });
    } catch {
      return "(unreadable)";
    }
  })();
  console.log(`  ran.log at yield: ${JSON.stringify(ranBefore)}`);
  const gen0 = rec.generation;
  const keysBefore = issued.length;
  const w = await daemon.messageAgent(
    id,
    "You were interrupted (the session was parked) and have been resumed. Continue your task from where you are; check ran.log in your working directory first if unsure of the state.",
    "yr-mid-wake",
  );
  console.log(`  wake delivered=${w.delivered}`);
  await until("resume", async () => (await daemon.get(id))!.generation > gen0 && (await containers()).length > 0);
  const res = (await daemon.get(id))!;
  const newContainer = (await containers())[0]!;
  check("resumed at generation+1", res.generation === gen0 + 1, `${gen0} -> ${res.generation}`);
  check("new container", newContainer !== oldContainer);
  check(
    "fresh key issued, old rejected",
    issued.length > keysBefore && live.gateway.authorize(oldKey) === null && live.gateway.authorize(issued.at(-1)!.key) !== null,
  );
  let waited = await daemon.waitDone(id, phaseMs);
  const doneBy = Date.now() + phaseMs;
  while (!waited.done && Date.now() < doneBy) waited = await daemon.waitDone(id, doneBy - Date.now());
  await until("reaped", async () => (await daemon.get(id))?.state === "reaped", 30_000).catch(() => {});
  const fin = (await daemon.get(id))!;
  check("run ends succeeded and reaped", fin.exit === "succeeded" && fin.state === "reaped", `state=${fin.state} exit=${fin.exit}`);
  check("agent still reports the code word", JSON.stringify(fin.result ?? null).includes(code), JSON.stringify(fin.result ?? null).slice(0, 100));
  const spendEnd = (await live.gateway.spend(id)).spentMicros;
  check("one ledger: spend accumulates", spend0 > 0 && spendEnd > spend0, `${spend0} -> ${spendEnd} micros`);
  const ranAfter = (() => {
    try {
      return execFileSync("cat", [ws], { encoding: "utf8" });
    } catch {
      return "(unreadable)";
    }
  })();
  const finalEvs = await evs();
  const sleeps = finalEvs.filter((p) => p.kind === "tool_call" && JSON.stringify(p.input).includes("sleep 45")).length;
  const k = (await daemon.events({ agent: id })).map((e) => e.payload.kind as string).filter((x) => ["started", "yielded", "resumed", "reaped"].includes(x));
  console.log(`  SEMANTICS after resume: sleep tool calls journaled=${sleeps} (1 = not replayed); ran.log=${JSON.stringify(ranAfter)}; journal ${k.join(" ")}`);
}

let exitCode = 0;
try {
  const endpoint = await listenAgentEndpoint(daemon);
  apiUrl = endpoint.apiUrl;
  if (env.POMTREED_DEMO_SCENARIO === "midturn") {
    await midTurn();
    endpoint.close();
  } else {
    const top = await daemon.root();
    const a = await daemon.spawn(top.id, { name: "yielder", task: TASK, idempotencyKey: "yr-agent" });
    const id = a.id;
    console.log(`spawned ${id}; code word ${code}`);
    const containers = async () => (await sandbox.list()).filter((s) => s.agent === id).map((s) => s.id);
    const kinds = async () => (await daemon.events({ agent: id })).map((e) => e.payload.kind as string);
    const states: string[] = [];
    const stateOf = async () => {
      const s = (await daemon.get(id))?.state ?? "gone";
      if (states.at(-1) !== s) states.push(s);
      return s;
    };

    let runningContainer = (await until("first container", async () => (await containers())[0]))!;
    const spendAt: number[] = [];
    let lastGen = (await daemon.get(id))!.generation;
    console.log(`generation ${lastGen}, container ${runningContainer.slice(0, 12)}`);

    for (const pass of [1, 2]) {
      console.log(`\n== yield #${pass} ==`);
      const preKeys = issued.map((m) => m.key);
      await until(`state yielded (pass ${pass})`, async () => (await stateOf()) === "yielded");
      const rec = (await daemon.get(id))!;
      check(`#${pass} state yielded`, rec.state === "yielded", `generation ${rec.generation}`);
      await until("container gone", async () => (await containers()).length === 0, 30_000).catch(() => {});
      const left = await containers();
      check(`#${pass} no container for the agent`, left.length === 0 && !left.includes(runningContainer), left.join(",") || "none");
      const status = await daemon.placementStatus();
      check(`#${pass} admission slot freed`, !status.running.includes(id), `running=${status.running.length} queue=${status.queue.length}`);
      const last = preKeys.at(-1);
      check(
        `#${pass} pre-yield model token rejected by the proxy`,
        last !== undefined && live.gateway.authorize(last) === null,
        `${preKeys.length} keys issued so far`,
      );
      const cp = await store.checkpoints.latest(id);
      check(
        `#${pass} checkpoint written`,
        !!cp && cp.generation === rec.generation && (cp.version ?? 0) >= 1,
        cp ? `version ${cp.version} gen ${cp.generation} wait=${cp.wait?.kind ?? "none"}` : "none",
      );
      const hasPath = cp ? /\/|\\/.test(`${cp.sessionRef}${cp.workspace}`) && /^(\/|[A-Za-z]:)/.test(cp.sessionRef) : true;
      check(
        `#${pass} checkpoint holds ids/hashes only`,
        !!cp && !hasPath && /^[0-9a-f]{64}$/.test(cp.sessionRef),
        cp ? `sessionRef ${cp.sessionRef.slice(0, 12)}...` : "",
      );
      const bytes = cp ? await store.sessions.get(cp.sessionRef) : null;
      const text = bytes ? Buffer.from(bytes).toString("utf8") : "";
      check(
        `#${pass} session file stored, hash matches, holds the code word`,
        !!bytes && bytes.length > 0 && createHash("sha256").update(bytes).digest("hex") === cp!.sessionRef && text.includes(code),
        `${bytes?.length ?? 0} bytes`,
      );
      check(
        `#${pass} session last line is whole JSON`,
        !!text &&
          (() => {
            try {
              JSON.parse(text.trimEnd().split("\n").at(-1)!);
              return true;
            } catch {
              return false;
            }
          })(),
      );
      const sp = (await live.gateway.spend(id)).spentMicros;
      spendAt.push(sp);
      console.log(`  spend at yield #${pass}: ${sp} micros`);

      // wake from the operator
      const priorContainer = runningContainer;
      const priorKeys = issued.length;
      const genBefore = rec.generation;
      const r = await daemon.messageAgent(id, pass === 1 ? WAKE1 : WAKE2, `yr-wake-${pass}`);
      console.log(`  wake #${pass} delivered=${r.delivered}`);
      await until(`resume (pass ${pass})`, async () => {
        const s = await daemon.get(id);
        return s !== null && s.generation > genBefore && (await containers()).length > 0;
      });
      const after = (await daemon.get(id))!;
      runningContainer = (await containers())[0]!;
      check(`#${pass} resumed at generation+1`, after.generation === genBefore + 1, `${genBefore} -> ${after.generation}`);
      check(`#${pass} new container`, runningContainer !== priorContainer, `${priorContainer.slice(0, 12)} -> ${runningContainer.slice(0, 12)}`);
      check(`#${pass} fresh model key issued`, issued.length > priorKeys && issued.at(-1)!.key !== last && live.gateway.authorize(issued.at(-1)!.key) !== null);
      check(`#${pass} old token still rejected after resume`, last !== undefined && live.gateway.authorize(last) === null);
      lastGen = after.generation;
      if (pass === 1) await until("second yield", async () => (await stateOf()) === "yielded" && (await daemon.get(id))!.generation === lastGen);
    }

    console.log("\n== completion ==");
    let waited = await daemon.waitDone(id, phaseMs);
    const doneBy = Date.now() + phaseMs;
    while (!waited.done && Date.now() < doneBy) waited = await daemon.waitDone(id, doneBy - Date.now());
    await until(
      "reaped",
      async () => {
        const s = await stateOf();
        return s === "reaped";
      },
      30_000,
    ).catch(() => {});
    const fin = (await daemon.get(id))!;
    const resultText = JSON.stringify(fin.result ?? null);
    check(
      "run ends succeeded and reaped",
      fin.exit === "succeeded" && fin.state === "reaped",
      `state=${fin.state} exit=${fin.exit} generation=${fin.generation}`,
    );
    check("agent recalled the code word after two yields (context continuity)", resultText.includes(code), resultText.slice(0, 120));
    const finalSpend = (await live.gateway.spend(id)).spentMicros;
    check(
      "one ledger: spend accumulates across generations",
      spendAt[0]! > 0 && spendAt[1]! >= spendAt[0]! && finalSpend > spendAt[1]!,
      `${spendAt.join(" -> ")} -> ${finalSpend} micros`,
    );
    const k = await kinds();
    const seq = k.filter((x) => ["started", "yielded", "resumed", "reaped"].includes(x));
    check(
      "journal: started, (yielded, resumed) x2",
      seq.filter((x) => x === "yielded").length === 2 && seq.filter((x) => x === "resumed").length === 2,
      seq.join(" "),
    );
    check("no containers left for the agent", (await containers()).length === 0);
    console.log(`  states seen: ${states.join(" > ")} · gens ${lastGen} -> ${fin.generation}`);
    endpoint.close();
  }
} catch (e) {
  exitCode = 1;
  console.error(`yield/resume demo failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
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
