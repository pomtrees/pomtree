// Live demo: one root agent with the `web_fetch` extension actually invokes the tool against
// https://example.com and reports the page title/body. Spends real money.
// Run: POMTREED_LIVE=1 POMTREED_PI_PROVIDER=deepseek POMTREED_MODEL_BASE_URL=... POMTREED_MODEL_UPSTREAM_KEY_FILE=<0600 key file> node packages/e2e/src/demo/pi-ext.ts
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_SINK_FILE, PI_TTY_ENV, createPiHarness, fileTailSource, piArgv } from "@pomtree/harness-pi";
import { CONFIG_DEFAULTS } from "@pomtree/core";
import { Daemon, LocalOrchestrator, createExtGateway, wireLocalHost } from "@pomtree/pomtreed";
import { wireCaptureBroker } from "../../../pomtreed/src/capture-wiring.ts";
import { buildChannelRegistry } from "../../../pomtreed/src/channels.ts";
import { webFetchCaptureScope, webFetchScope } from "../../../pomtreed/src/ext-gateway.ts";
import { startLiveModel } from "../live-model.ts";
import { listenAgentEndpoint } from "./agent-endpoint.ts";
import { DockerSandbox } from "@pomtree/sandbox-docker";
import { openStore } from "@pomtree/store-sqlite";
import { DirReportStore } from "@pomtree/report-dir";
import { FakeTemplateStore } from "@pomtree/testing";
import { demoWorkspace } from "./demo-workspace.ts";

const env = process.env;
const timeoutMs = Number(env.POMTREED_DEMO_TIMEOUT_MS ?? 600_000);
const budgetMicros = Number(env.POMTREED_BUDGET_ROOT_MICROS ?? 1_000_000);
const image = env.POMTREED_AGENT_IMAGE ?? "pomtree/agent:dev";

const TASK = `Use the web_fetch tool to fetch https://example.com. Then run exactly:
  pomtree result --summary "Fetched https://example.com and reported its title and body." '{"title":"<the page title>","body":"<the first ~200 characters of the page body>"}'
using the real title and body text returned by web_fetch. Do not fabricate either field.`;

// The rig uses the shared in-memory FakeTemplateStore instead of the template directory store, so the
// live check exercises the daemon's template -> SpawnSpec path with the real extension name.
const templates = new FakeTemplateStore([{ id: "fetch", extensions: ["web_fetch"], egress: { kind: "allowlist", hosts: ["example.com"] } }]);

console.log(`pomtree pi-ext demo: LIVE model calls (spends real money) + host-side web_fetch.
  provider:   ${env.POMTREED_PI_PROVIDER ?? "(unset; POMTREED_PI_PROVIDER is required)"}
  image:      ${image}
  budget cap: $${(budgetMicros / 1_000_000).toFixed(2)}
  timeout:    ${Math.round(timeoutMs / 1000)}s`);
if (env.POMTREED_LIVE !== "1") {
  console.error("\nrefusing to run: set POMTREED_LIVE=1 to confirm live model calls and real money.");
  process.exit(2);
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@pomtree", ...a], { cwd, encoding: "utf8" }).trim();

const tempDir = mkdtempSync(join(tmpdir(), "pomtree-pi-ext-"));
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
const model = env.POMTREED_DEMO_MODEL ?? "deepseek-flash"; // optional; the resolved spec model each key allows
const live = await startLiveModel({ store, secret, stateDir, provider, env });
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
const reportStore = new DirReportStore({ root: join(stateDir, "reports"), registry: store.registry });
// web_fetch's scope from the agent's template egress, as main.ts's webFetchAllowedFor (lookup failure denies).
const webFetchAllowedFor = async (agent: string) => {
  try {
    const rec = await store.registry.get(agent);
    return rec === null || rec.executor !== "container" ? false : webFetchScope(rec.spec.egress);
  } catch {
    return false;
  }
};
// The capture broker as main.ts composes it (capture-wiring.ts); real network, no test fetch seam.
const captureBroker = wireCaptureBroker({
  stores: store,
  quota: store.quotaCounters(),
  reports: reportStore,
  daemon: { root: () => daemon.root(), captureRecord: (agent, payload, key) => daemon.captureRecord(agent, payload, key) },
  hostId: "demo",
  userAgent: CONFIG_DEFAULTS["workflow.fetch.userAgent"],
  log: (line) => console.error(`pomtreed: ${line}`),
  scopeFor: async (who) => (who.kind === "operator" ? { allows: () => true } : webFetchCaptureScope(await webFetchAllowedFor(who.agent))),
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
  gateway: live.gateway,
  command: (task) => piArgv({ prompt: task, provider, model }),
  // The Daemon's default spec model is the one Pi is told to call, so the gateway signs it into each key's model allowlist.
  ...(provider && { provider }),
  model,
  credentials: live.credentials,
  extensions: createExtGateway({
    capture: captureBroker,
    generationOf: async (agent) => (await store.registry.get(agent))?.generation ?? null,
    webFetchAllowed: webFetchAllowedFor,
  }),
  templates,
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
  reportStore,
  reportMaxBytes: 8 * 1024 * 1024,
  placement,
  orchestrator: new LocalOrchestrator(),
});
placement.onAdmit((agent) => daemon.admitted(agent));
const endpoint = await listenAgentEndpoint(daemon);
apiUrl = endpoint.apiUrl;

let exitCode = 0;
try {
  const top = await daemon.root();
  const root = await daemon.spawn(top.id, { name: "fetcher", task: TASK, idempotencyKey: "pi-ext-root", template: "fetch" });
  const deadline = Date.now() + timeoutMs;
  let waited = await daemon.waitDone(root.id, timeoutMs);
  while (!waited.done && Date.now() < deadline) waited = await daemon.waitDone(root.id, deadline - Date.now());

  const events = await daemon.events({ agent: root.id });
  const proxyCalls = events.filter((e) => e.payload.kind === "proxy_call");
  const proxyResults = events.filter((e) => e.payload.kind === "proxy_result");
  const fetchCall = proxyCalls.find((e) => (e.payload as { extension?: string }).extension === "web_fetch");
  const fetchResult = proxyResults.find((e) => {
    const p = e.payload as { ok?: boolean; callId?: string };
    return p.ok === true && p.callId === (fetchCall?.payload as { callId?: string } | undefined)?.callId;
  });

  const record = (await daemon.get(root.id))!;
  const resultText = JSON.stringify(record.result ?? null);
  const okProxyCall = !!fetchCall;
  const okProxyResult = !!fetchResult;
  const okReflects = record.state === "exited" && resultText.length > 2 && !/failed|error/i.test(resultText) && /example|domain/i.test(resultText);

  if (!(okProxyCall && okProxyResult && okReflects)) exitCode = 1;
  console.log(`\npi-ext result: agent ${root.id} ${record.state} exit=${record.exit}
  proxy_call(web_fetch):   ${okProxyCall ? "present ✓" : "MISSING ✗"}
  proxy_result(ok:true):   ${okProxyResult ? "present ✓" : "MISSING ✗"}
  result reflects content: ${okReflects ? "yes ✓" : "no ✗"}
  result:                  ${resultText.slice(0, 400)}`);
} catch (e) {
  exitCode = 1;
  console.error(`pi-ext demo failed: ${e instanceof Error ? e.message : String(e)}`);
  console.error(`temp dir: ${tempDir}`);
} finally {
  for (const s of await sandbox.list().catch(() => [])) await sandbox.kill(s.id).catch(() => {});
  for (const id of await workspace.list().catch(() => [])) await workspace.evict(id).catch(() => {});
  endpoint.close();
  await captureBroker.close().catch((e) => console.error(`capture broker close failed: ${e instanceof Error ? e.message : String(e)}`));
  store.close();
  rmSync(socketPath, { force: true });
  console.log(`\ncleaned up containers and worktrees; temp dir kept at ${tempDir}`);
}
process.exit(exitCode);
