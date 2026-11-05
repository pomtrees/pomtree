import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Harness } from "@pomtree/core";
import { DockerSandbox } from "@pomtree/sandbox-docker";
import { Daemon, ProxyCredentialGateway, LocalOrchestrator, listen, listenAgents, wireLocalHost } from "@pomtree/pomtreed";
import { buildChannelRegistry } from "../../pomtreed/src/channels.ts";
import { detectBridgeGateway, planAgentListen } from "../../pomtreed/src/agent-net.ts";
import { openStore } from "@pomtree/store-sqlite";
import { FakeModelCatalog } from "@pomtree/testing";
import { DirReportStore } from "@pomtree/report-dir";
import { GitWorkspace } from "@pomtree/workspace-git";
import { SECRET, gitRepo, tmp } from "./harness.ts";
import { imageRevisionSkip } from "./image-gate.ts";

const IMAGE = process.env.PTREE_E2E_IMAGE ?? "pomtree/agent:dev";

const ok = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
};

const out = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 10000 }).trim();
  } catch {
    return undefined;
  }
};

// Same dirty-source rule as packages/sandbox-docker/src/docker-gate.ts: tracked changes against the revision, or any
// untracked file under the image sources, make the image unprovable. A git error counts as dirty.
function sourcesDirty(revision: string): boolean {
  const paths = [":(top)packages/agent-image", ":(top)packages/sandbox-docker"];
  if (!ok("git", ["diff", "--quiet", revision, "--", ...paths])) return true;
  return out("git", ["ls-files", "--others", "--exclude-standard", "--", ...paths]) !== "";
}

// Needs a reachable Docker daemon and an agent image built from this checkout; uses no model.
function skipReason(): string | false {
  if (process.env.PTREE_DOCKER_TESTS !== "1") return "PTREE_DOCKER_TESTS not set (lite run)";
  if (!ok("docker", ["info"])) return "docker daemon unreachable";
  if (!ok("docker", ["image", "inspect", IMAGE])) return `image ${IMAGE} not present (build it or set PTREE_E2E_IMAGE)`;
  const revision = process.env.PTREE_AGENT_TEST_REVISION ?? out("git", ["rev-parse", "--short", "HEAD"]);
  return imageRevisionSkip(
    IMAGE,
    out("docker", ["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', IMAGE]),
    revision,
    sourcesDirty(revision ?? "HEAD"),
  );
}

// The agent is a shell script: the container command replaces Pi, and the harness only reports when it exits.
const scriptHarness = (output: string[]): Harness => ({
  async start({ agent, sandbox }) {
    return {
      session: `sess-${agent}`,
      async *events() {
        const drain = (async () => {
          for await (const o of sandbox.output()) output.push(`[${agent} ${o.stream}] ${o.chunk}`);
        })();
        const { exitCode } = await sandbox.wait();
        await drain.catch(() => {});
        output.push(`[${agent}] exit ${exitCode}`);
      },
      steer: async () => {},
      stop: async () => {},
    };
  },
  async resume() {
    throw new Error("resume not supported");
  },
});

const ROOT_SCRIPT = `
set -eu
test -n "$POMTREE_API" || { echo "no POMTREE_API" >&2; exit 11; }
test -n "$POMTREE_TOKEN" || exit 12
command -v pomtree >/dev/null || exit 13
a=$(pomtree spawn --task CHILD:alpha --name alpha --budget 100000)
b=$(pomtree spawn --task CHILD:beta --name beta --budget 100000)
pomtree wait "$a" --timeout 15000 >/dev/null
pomtree wait "$b" --timeout 15000 >/dev/null
pomtree reap "$a" >/dev/null
pomtree reap "$b" >/dev/null
pomtree result --summary "spawned, waited, reaped two children" "{\\"children\\":[\\"$a\\",\\"$b\\"]}"
`;

const childScript = (name: string) => `
set -eu
echo "section ${name}" > "section-${name}.txt"
git -c user.name=agent -c user.email=agent@pomtree add "section-${name}.txt" 2>/dev/null \\
  && git -c user.name=agent -c user.email=agent@pomtree commit -q -m "section ${name}" 2>/dev/null || true
pomtree push
pomtree result --summary "wrote section-${name}.txt" "{\\"file\\":\\"section-${name}.txt\\"}"
`;

const dockerPs = (agent?: string): string[] =>
  execFileSync("docker", ["ps", "-aq", "--filter", agent ? `label=pomtree.agent=${agent}` : "label=pomtree.agent"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((l) => l !== "");

const command = (task: string) => ["sh", "-c", task === "ROOT" ? ROOT_SCRIPT : childScript(task.slice("CHILD:".length))];

test("real Docker, no model: scripted root spawns two children, waits, reaps, reports", { skip: skipReason(), timeout: 240000 }, async () => {
  const stateDir = tmp("fan");
  const repo = gitRepo();
  const socketPath = join(stateDir, "pomtreed.sock");
  const store = openStore(join(stateDir, "pomtreed.sqlite"));
  const mirrorDir = join(stateDir, "mirror.git");
  const workspace = new GitWorkspace({ repoDir: repo, mirrorDir, foldersRoot: join(stateDir, "workspaces") });
  const { placement, sandbox } = wireLocalHost({
    hostId: "h1",
    hosts: store.hosts,
    workspace,
    sessionRoot: join(stateDir, "sessions"),
    image: IMAGE,
    capacity: { maxSessions: 4 },
    makeSandbox: (mounts) => new DockerSandbox({ mounts }),
  });
  const orchestrator = new LocalOrchestrator();
  let apiUrl: string | undefined;
  const output: string[] = [];
  const daemon = new Daemon({
    hostId: "h1",
    // Stamps store_id on the containers: reconcile of any other daemon on this Docker host (the e2e suite boots real pomtreeds in parallel
    // files) leaves containers of another store alone, whereas an unlabelled-by-store container with no registry record there is killed.
    storeId: "e2e-docker-fanout",
    secret: SECRET,
    image: IMAGE,
    sandboxSocketPath: "/run/pomtreed.sock",
    untemplatedEgress: "registry", // main.ts states it (boot refuses unset); registry keeps untemplated spawns reaching package registries
    socketHostPath: socketPath,
    command,
    agentApiUrl: () => apiUrl,
    rootBudgetMicros: 10_000_000,
    defaultBudgetMicros: 1_000_000,
    graceMs: 5000,
    admitRetryMs: 100,
    registry: store.registry,
    journal: store.journal,
    mailbox: store.mailbox,
    sandbox,
    workspace,
    harness: scriptHarness(output),
    gateway: new ProxyCredentialGateway({ journal: store.journal, registry: store.registry, secret: SECRET, proxyBaseUrl: "http://m", tokenTtlMs: 3_600_000 }),
    checkpoints: store.checkpoints,
    sessions: store.sessions,
    sessionRoot: join(stateDir, "sessions"),
    escalations: store.escalations,
    channels: buildChannelRegistry([], []),
    watchdogs: store.watchdogs,
    schedules: store.schedules,
    reportStore: new DirReportStore({ root: join(stateDir, "reports"), registry: store.registry }),
    reportMaxBytes: 8 * 1024 * 1024,
    placement,
    orchestrator,
    models: new FakeModelCatalog(),
  });
  const server = await listen(daemon, socketPath);
  // Bind where pomtreed binds its agent endpoint (loopback on Docker Desktop, the bridge gateway on Linux); containers use host.docker.internal.
  const plan = planAgentListen({
    listen: undefined,
    platform: process.platform,
    gateway: process.platform === "linux" ? await detectBridgeGateway(async (c, a) => execFileSync(c, a, { encoding: "utf8", timeout: 10_000 })) : undefined,
  });
  const agents = await listenAgents(daemon, plan.host, 0);
  apiUrl = `http://host.docker.internal:${agents.port}`;
  // Containers from other stacks (a live pomtreed on this Docker host) are not this test's to assert on.
  const preexisting = new Set((await sandbox.list()).map((c) => c.id));
  const preexistingDocker = new Set(dockerPs());
  try {
    const top = await daemon.root();
    const root = await daemon.spawn(top.id, { name: "root", task: "ROOT", idempotencyKey: "fan-root" });
    await orchestrator.idle();

    const done = (await daemon.get(root.id))!;
    const logs = output.join("");
    assert.equal(done.state, "reaped", `root state ${done.state}\n${logs}`);
    assert.equal(done.exit, "succeeded", logs);
    const kids = (done.result as { children: string[] }).children;
    assert.equal(kids.length, 2);

    for (const [i, id] of kids.entries()) {
      const rec = (await daemon.get(id))!;
      assert.equal(rec.state, "reaped", `child ${id} must be reaped by the root`);
      assert.equal(rec.parent, root.id);
      const ing = await workspace.ingested(id);
      assert.ok(ing, `child pushed its work (ingested ref recorded) for ${id}`);
      const name = ["alpha", "beta"][i]!;
      const blob = execFileSync("git", ["--git-dir", mirrorDir, "show", `${ing.commit}:section-${name}.txt`], { encoding: "utf8" });
      assert.equal(blob.trim(), `section ${name}`);
    }

    // Scope to this tree's agents: a concurrent suite (docker-pi) shares the Docker host and
    // its live containers are not leftovers of this test.
    const tree = new Set([root.id, ...kids]);
    assert.deepEqual(
      (await sandbox.list()).filter((c) => tree.has(c.agent) && !preexisting.has(c.id)),
      [],
      "no containers left",
    );
    assert.deepEqual(
      [...tree].flatMap((id) => dockerPs(id)).filter((c) => !preexistingDocker.has(c)),
      [],
      "docker reports no new pomtree containers",
    );
  } finally {
    server.close();
    agents.server.close();
    store.close();
  }
});
