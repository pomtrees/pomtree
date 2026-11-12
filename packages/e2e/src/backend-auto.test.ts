// The `auto` sandbox backend resolver, end to end (S0, no Docker, no network): the real pomtreed binary (packages/pomtreed/src/main.ts) runs with
// sandbox.backend=auto against scripted fake engine sockets (unix sockets answering the /_ping and /version identity probes) in a temp dir.
// Run: node --test packages/e2e/src/backend-auto.test.ts
//
// Design (sandbox backends, section 3): `auto` considers only the local engines (docker, podman), never a hosted built-in or a contributed
// backend; every refusal it skips is printed, never dropped; a remote DOCKER_HOST is never a silent fallback.
//
// How the chosen engine is observed. Once the engine is resolved, the daemon runs the engine's own CLI with the resolved socket in the
// environment (DOCKER_HOST for docker, CONTAINER_HOST for podman). PATH holds only two fake CLIs that append their name and that environment to a
// log and exit 1, so the log names the engine chosen and the socket it was given, with no real docker or podman involved. Each engine's socket
// is set through its own env variable (an explicit source, trusted without an existence check), so the result never depends on the host's sockets.
//
// Red proof. AUTO_RESOLVER_BREAK=prefer-hosted makes this file's own selector ask for the pinned contributed backend instead of `auto`, in the
// daemon cases and the in-process resolver case alike, so every assertion that auto stays on the local engines must fail.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SANDBOX_CAPABILITIES, SANDBOX_PORT_VERSION } from "@pomtree/core";
import { type EngineProbes, openLocalEngine } from "@pomtree/sandbox-docker";
import { realSetTimeout, scaled } from "@pomtree/testing";
import { BUILTIN_BACKENDS, type BackendRegistry, resolveBackend } from "../../pomtreed/src/sandbox-backends.ts";
import { measureExtensionTree } from "../../pomtreed/src/sandbox-provider-load.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pomtreedMain = join(ROOT, "packages/pomtreed/src/main.ts");

const BREAK = process.env.AUTO_RESOLVER_BREAK === "prefer-hosted";
// What the tests put in sandbox.backend where they mean `auto`.
const AUTO = BREAK ? "toybox" : "auto";

// ---- fake engines ----

type Kind = "docker" | "podman";

// A Docker-family engine answers /_ping with no Libpod header and names itself "Engine"; Podman adds the header and names "Podman Engine".
function fakeEngine(socketPath: string, kind: Kind): Promise<Server> {
  return new Promise((resolve) => {
    const podman = kind === "podman";
    const server = createServer((req, res) => {
      if (req.url === "/_ping") {
        res.writeHead(200, podman ? { "Libpod-Api-Version": "5.0.0" } : {});
        res.end("OK");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ Components: [{ Name: podman ? "Podman Engine" : "Engine" }] }));
      }
    });
    server.listen(socketPath, () => resolve(server));
  });
}

// ---- scratch dir ----

interface Scratch {
  dir: string;
  stateDir: string;
  cliLog: string;
  marker: string; // written by the contributed provider module if it is ever imported
  dockerSock: string; // where the docker env variable points; a fake engine listens there only when a case starts one
  podmanSock: string;
  extensionEnv: Record<string, string>;
  servers: Server[];
}

function writeContributedExtension(dir: string, marker: string): Record<string, string> {
  const extensionsDir = join(dir, "extensions");
  const ext = join(extensionsDir, "toybox");
  mkdirSync(ext, { recursive: true });
  const declaration = {
    backend: "toybox",
    capabilities: { ...Object.fromEntries(SANDBOX_CAPABILITIES.map((c) => [c, false])), connect: true, "resources.limits": true, "image.ociPull": true },
    region: null,
    idempotency: "unique-name",
    idempotencyWindowMs: null,
    tagging: "metadata",
    output: "poll",
    maxLifetimeMs: null,
    preemptible: false,
    billing: { unit: "none", whileStopped: false, whilePaused: false },
  };
  writeFileSync(
    join(ext, "manifest.json"),
    JSON.stringify({
      apiVersion: 2,
      name: "toybox",
      entry: "entry.mjs",
      capabilities: {},
      deps: [],
      provides: [{ kind: "sandbox", id: "toybox", entry: "provider.mjs", portVersion: SANDBOX_PORT_VERSION }],
    }),
  );
  writeFileSync(join(ext, "entry.mjs"), "export default {};\n");
  writeFileSync(
    join(ext, "provider.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "imported");\nexport const portVersion = ${SANDBOX_PORT_VERSION};\nexport const declaration = ${JSON.stringify(declaration)};\nexport function create() { return { declaration }; }\n`,
  );
  const tree = measureExtensionTree(ext);
  return { POMTREED_EXTENSIONS_DIR: extensionsDir, POMTREED_SANDBOX_REVIEWED_BACKENDS: `toybox=${tree.hash}` };
}

// `withExtension` puts a pinned (reviewed) contributed backend on disk; the break mode always needs it, since it selects it.
async function withScratch(withExtension: boolean, fn: (s: Scratch) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pt-auto-"));
  const servers: Server[] = [];
  try {
    mkdirSync(join(dir, "home"));
    mkdirSync(join(dir, "bin"));
    const cliLog = join(dir, "cli.log");
    for (const name of ["docker", "podman"]) {
      writeFileSync(join(dir, "bin", name), `#!/bin/sh\necho "${name} DOCKER_HOST=$DOCKER_HOST CONTAINER_HOST=$CONTAINER_HOST $*" >> "${cliLog}"\nexit 1\n`, {
        mode: 0o755,
      });
    }
    const marker = join(dir, "toybox-imported");
    await fn({
      dir,
      stateDir: join(dir, "state"),
      cliLog,
      marker,
      dockerSock: join(dir, "d.sock"),
      podmanSock: join(dir, "p.sock"),
      extensionEnv: withExtension || BREAK ? writeContributedExtension(dir, marker) : {},
      servers,
    });
  } finally {
    for (const s of servers) s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function startEngine(s: Scratch, kind: Kind): Promise<void> {
  s.servers.push(await fakeEngine(kind === "docker" ? s.dockerSock : s.podmanSock, kind));
}

// ---- running the daemon ----

interface Run {
  code: number | null;
  out: string;
  cli: string[]; // lines the fake CLIs logged
  stateDirCreated: boolean;
  satisfied: boolean; // `until` held before the daemon exited or the budget ran out
}

const pids = new Set<number>();
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Starts the daemon with a clean env (only HOME, PATH holding the fake CLIs, and the variables under test). Returns when it exits or when `until`
// holds, whichever is first, bounded by a scaled budget; then kills it by exact PID and waits for the close. A daemon that wrongly boots and
// idles is therefore still ended, and a refusal is not waited on past its exit.
async function runDaemon(s: Scratch, env: Record<string, string>, until: (r: Run) => boolean = () => false): Promise<Run> {
  const keyFile = join(s.dir, "upstream.key");
  writeFileSync(keyFile, "k".repeat(40), { mode: 0o600 });
  const child = spawn(process.execPath, [pomtreedMain], {
    cwd: s.dir,
    env: {
      HOME: join(s.dir, "home"),
      PATH: join(s.dir, "bin"),
      POMTREED_STATE_DIR: s.stateDir,
      POMTREED_SOCKET_PATH: join(s.dir, "pomtreed.sock"),
      POMTREED_REPO_DIR: s.dir,
      POMTREED_MODEL_BASE_URL: "http://127.0.0.1:9",
      POMTREED_PI_PROVIDER: "deepseek",
      POMTREED_MODEL_UPSTREAM_KEY_FILE: keyFile,
      POMTREED_AGENT_EGRESS_PROXY_IMAGE: `sha256:${"0".repeat(64)}`,
      POMTREED_AGENT_UNTEMPLATED_EGRESS: "none",
      POMTREED_EXTENSIONS_APPROVAL: "none",
      POMTREED_AGENT_LISTEN: "off",
      ...s.extensionEnv,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  assert.ok(pid !== undefined, "the daemon must spawn");
  pids.add(pid);
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString()));
  child.stderr.on("data", (c: Buffer) => (out += c.toString()));
  let code: number | null = null;
  let exited = false;
  const closed = new Promise<void>((res) =>
    child.on("close", (c) => {
      code = c;
      exited = true;
      res();
    }),
  );
  const snapshot = (satisfied: boolean): Run => ({
    code,
    out,
    cli: existsSync(s.cliLog) ? readFileSync(s.cliLog, "utf8").split("\n").filter(Boolean) : [],
    stateDirCreated: existsSync(s.stateDir),
    satisfied,
  });
  const end = Date.now() + scaled(60_000);
  let satisfied = false;
  while (!exited && Date.now() < end) {
    if (until(snapshot(false))) {
      satisfied = true;
      break;
    }
    await new Promise((r) => realSetTimeout(r, 50));
  }
  const final = snapshot(satisfied);
  if (!exited) child.kill("SIGKILL");
  await closed;
  assert.equal(alive(pid), false, `daemon pid ${pid} must be gone after the run`);
  return { ...final, code, out };
}

const refusalLines = (r: Run): string[] => r.out.split("\n").filter((l) => l.startsWith("pomtreed: refusing to start: "));
const engineEnv = (docker: string, podman: string): Record<string, string> => ({
  POMTREED_SANDBOX_BACKEND: AUTO,
  DOCKER_HOST: docker,
  CONTAINER_HOST: podman,
});
const unix = (path: string): string => `unix://${path}`;
const ranCli = (r: Run, name: Kind): string[] => r.cli.filter((l) => l.startsWith(`${name} `));
const gone = (s: Scratch): string => join(s.dir, "no-such-engine.sock");

// A run that is expected to boot as far as the engine's first CLI call (or to exit): the case waits for the first CLI log line.
const reachedCli = (r: Run): boolean => r.cli.length > 0;

function assertRefusedBeforeState(s: Scratch, r: Run): void {
  assert.equal(r.satisfied, false, `the start must refuse, not boot:\n${r.out}`);
  assert.equal(r.code, 1, `exit code:\n${r.out}`);
  assert.doesNotMatch(r.out, /pomtreed listening/);
  assert.equal(r.stateDirCreated, false, "a refused start must not create the state dir");
  assert.equal(existsSync(join(s.dir, "pomtreed.sock")), false, "a refused start must not create the socket");
  assert.deepEqual(r.cli, [], "a refused start runs no engine CLI");
}

// ---- (a) only Docker answers ----

test("auto: only Docker answers -> Docker is chosen, and the docker CLI is handed the docker socket", async () => {
  await withScratch(true, async (s) => {
    await startEngine(s, "docker");
    const r = await runDaemon(s, engineEnv(unix(s.dockerSock), unix(gone(s))), reachedCli);
    assert.equal(r.satisfied, true, `the daemon must get as far as its first engine call:\n${r.out}`);
    assert.ok(ranCli(r, "docker").length > 0, `the docker CLI must be the one run:\n${r.cli.join("\n")}\n${r.out}`);
    assert.ok(ranCli(r, "docker")[0]?.includes(`DOCKER_HOST=${unix(s.dockerSock)} `), `the docker CLI is given the docker socket:\n${r.cli.join("\n")}`);
    assert.deepEqual(ranCli(r, "podman"), [], "the podman CLI is never run");
    assert.doesNotMatch(r.out, /both docker and podman answer|skipped /, "an engine that is merely not running is routine, not a finding");
    assert.deepEqual(refusalLines(r), []);
    assert.equal(existsSync(s.marker), false, "the contributed provider module is never imported");
  });
});

// ---- (b) only Podman answers ----

test("auto: only Podman answers -> Podman is chosen, and the podman CLI is handed the podman socket", async () => {
  await withScratch(true, async (s) => {
    await startEngine(s, "podman");
    const r = await runDaemon(s, engineEnv(unix(gone(s)), unix(s.podmanSock)), reachedCli);
    assert.equal(r.satisfied, true, `the daemon must get as far as its first engine call:\n${r.out}`);
    assert.ok(ranCli(r, "podman").length > 0, `the podman CLI must be the one run:\n${r.cli.join("\n")}\n${r.out}`);
    assert.ok(ranCli(r, "podman")[0]?.includes(`CONTAINER_HOST=${unix(s.podmanSock)} `), `the podman CLI is given the podman socket:\n${r.cli.join("\n")}`);
    assert.deepEqual(ranCli(r, "docker"), [], "the docker CLI is never run");
    assert.doesNotMatch(r.out, /both docker and podman answer|skipped /);
    assert.deepEqual(refusalLines(r), []);
    assert.equal(existsSync(s.marker), false, "the contributed provider module is never imported");
  });
});

// ---- (c) both answer ----

test("auto: both answer -> Docker is chosen and the finding names the other engine and the setting that picks it", async () => {
  await withScratch(true, async (s) => {
    await startEngine(s, "docker");
    await startEngine(s, "podman");
    const r = await runDaemon(s, engineEnv(unix(s.dockerSock), unix(s.podmanSock)), reachedCli);
    assert.equal(r.satisfied, true, `the daemon must get as far as its first engine call:\n${r.out}`);
    assert.ok(r.out.includes('pomtreed: both docker and podman answer; using docker (set sandbox.backend to "podman" to use the other)'), r.out);
    assert.ok(ranCli(r, "docker").length > 0, `the docker CLI must be the one run:\n${r.cli.join("\n")}`);
    assert.deepEqual(ranCli(r, "podman"), [], "the podman CLI is never run");
    assert.deepEqual(refusalLines(r), []);
  });
});

test("auto: a podman-docker shim (Podman answering on the docker socket) counts as podman, and Docker is not claimed", async () => {
  await withScratch(true, async (s) => {
    await startEngine(s, "podman"); // a Podman engine on the docker env variable's socket; the identity comes from the answer, not the path
    const r = await runDaemon(s, engineEnv(unix(s.podmanSock), unix(gone(s))), reachedCli);
    assert.equal(r.satisfied, true, `the daemon must get as far as its first engine call:\n${r.out}`);
    assert.ok(ranCli(r, "podman").length > 0, `the engine that answers as Podman runs the podman CLI:\n${r.cli.join("\n")}\n${r.out}`);
    assert.deepEqual(ranCli(r, "docker"), []);
  });
});

// ---- (d) neither answers ----

test("auto: neither answers -> exit 1 before any state, naming both causes and the action", async () => {
  await withScratch(false, async (s) => {
    const r = await runDaemon(s, engineEnv(unix(gone(s)), unix(gone(s))));
    assertRefusedBeforeState(s, r);
    const [line] = refusalLines(r);
    assert.match(
      line ?? "",
      /^pomtreed: refusing to start: no local container engine answered \(docker: the docker engine does not answer on .*; podman: the podman engine does not answer on .*\); start Docker or Podman, or set sandbox\.backend and its socket explicitly$/,
    );
    assert.deepEqual(refusalLines(r).length, 1);
  });
});

test("control: the explicit `docker` default with no engine does not refuse; it starts with the printed finding, unlike auto", async () => {
  await withScratch(false, async (s) => {
    const r = await runDaemon(s, { POMTREED_SANDBOX_BACKEND: "docker", DOCKER_HOST: unix(gone(s)), CONTAINER_HOST: unix(gone(s)) }, (x) =>
      x.out.includes("starts anyway"),
    );
    assert.equal(r.satisfied, true, `an explicit docker with its engine down starts with a finding:\n${r.out}`);
    assert.match(r.out, /pomtreed: the docker engine does not answer on .*; pomtreed starts anyway and sandbox calls fail until the docker engine answers/);
    assert.deepEqual(refusalLines(r), []);
  });
});

// ---- (e) a remote DOCKER_HOST ----

const REMOTE = "tcp://203.0.113.9:2375"; // TEST-NET-3: never connected to, the socket setting is refused before any probe

test("auto: a remote DOCKER_HOST with no other engine -> exit 1 naming the variable, the value and the action; never a silent fallback", async () => {
  await withScratch(false, async (s) => {
    const r = await runDaemon(s, engineEnv(REMOTE, unix(gone(s))));
    assertRefusedBeforeState(s, r);
    const [line] = refusalLines(r);
    assert.ok(line?.includes("no local container engine answered"), r.out);
    assert.ok(
      line?.includes(
        `docker: DOCKER_HOST for the docker engine is "${REMOTE}", which is not a local unix socket (remote tcp:// and ssh:// engines are not supported); set DOCKER_HOST to unix:///<absolute path> or unset it`,
      ),
      r.out,
    );
  });
});

test("auto: a remote DOCKER_HOST while Podman answers -> Podman is chosen only with the docker refusal printed as a finding", async () => {
  await withScratch(true, async (s) => {
    await startEngine(s, "podman");
    const r = await runDaemon(s, engineEnv(REMOTE, unix(s.podmanSock)), reachedCli);
    assert.equal(r.satisfied, true, `the daemon must get as far as its first engine call:\n${r.out}`);
    assert.ok(
      r.out.includes(`pomtreed: skipped docker: DOCKER_HOST for the docker engine is "${REMOTE}", which is not a local unix socket`),
      `the refusal auto swallowed must reach the operator:\n${r.out}`,
    );
    assert.ok(ranCli(r, "podman").length > 0, `the podman CLI is the one run:\n${r.cli.join("\n")}`);
    assert.deepEqual(ranCli(r, "docker"), [], "the remote docker is never contacted or run");
  });
});

test("docker (explicit): a remote DOCKER_HOST is refused, not started anyway", async () => {
  await withScratch(false, async (s) => {
    const r = await runDaemon(s, { POMTREED_SANDBOX_BACKEND: "docker", DOCKER_HOST: REMOTE, CONTAINER_HOST: unix(gone(s)) });
    assertRefusedBeforeState(s, r);
    assert.ok(refusalLines(r)[0]?.includes("which is not a local unix socket"), r.out);
  });
});

// ---- (f) a contributed backend is never selected by auto ----

test("auto: with no local engine answering, a pinned contributed backend on disk is never selected, imported or named", async () => {
  await withScratch(true, async (s) => {
    const r = await runDaemon(s, engineEnv(unix(gone(s)), unix(gone(s))));
    assertRefusedBeforeState(s, r);
    assert.ok(refusalLines(r)[0]?.startsWith("pomtreed: refusing to start: no local container engine answered"), r.out);
    assert.doesNotMatch(r.out, /toybox/, "the contributed backend is neither selected nor offered as a fallback");
    assert.equal(existsSync(s.marker), false, "the contributed provider module is never imported");
  });
});

// ---- the resolver itself, in process ----
// The same rule one level down, with scripted probes instead of sockets: `auto` asks the local-engine detector and never reaches a hosted or
// contributed entry, even when the registry offers one and no engine answers.

type Probes = EngineProbes;
const fakeProbes = (answering: Kind[]): Probes => ({
  exists: () => false,
  cliView: async () => undefined,
  ping: async (socket) => {
    const kind: Kind = socket.endsWith("p.sock") ? "podman" : "docker";
    if (!answering.includes(kind)) throw new Error("connect ENOENT");
    return { headers: kind === "podman" ? { "libpod-api-version": "5.0.0" } : {} };
  },
  version: async (socket) => {
    const kind: Kind = socket.endsWith("p.sock") ? "podman" : "docker";
    if (!answering.includes(kind)) throw new Error("connect ENOENT");
    return { Components: [{ Name: kind === "podman" ? "Podman Engine" : "Engine" }] };
  },
});

function spyRegistry(): { registry: BackendRegistry; verified: string[] } {
  const verified: string[] = [];
  return {
    verified,
    registry: {
      builtins: BUILTIN_BACKENDS,
      contributed: {
        ids: () => [{ id: "toybox", extension: "toybox" }],
        verify: (id) => {
          verified.push(id);
          return { dir: "/pinned/toybox", pin: `sha256:${"2".repeat(64)}` };
        },
      },
    },
  };
}

const IN_PROCESS_ENV = { DOCKER_HOST: "unix:///fake/d.sock", CONTAINER_HOST: "unix:///fake/p.sock" };
const resolveWith = (answering: Kind[], registry: BackendRegistry) =>
  resolveBackend({
    configured: AUTO,
    registry,
    openLocal: (selection) => openLocalEngine({ selection, env: IN_PROCESS_ENV, probes: fakeProbes(answering) }),
  });

test("resolveBackend(auto): a local engine answering resolves to a built-in local engine; a contributed entry is never verified", async () => {
  for (const [answering, expected] of [
    [["docker"], "docker"],
    [["podman"], "podman"],
    [["docker", "podman"], "docker"],
  ] as const) {
    const { registry, verified } = spyRegistry();
    const resolved = await resolveWith([...answering], registry);
    assert.equal(resolved.origin, "builtin", `${answering.join("+")}: auto resolves to a built-in`);
    assert.equal(resolved.localEngine, true);
    assert.equal(resolved.id, expected);
    assert.deepEqual(verified, [], "the contributed pin check is never reached");
  }
});

test("resolveBackend(auto): no engine answering throws the detector's refusal; the contributed backend is not the fallback", async () => {
  const { registry, verified } = spyRegistry();
  await assert.rejects(resolveWith([], registry), /no local container engine answered/);
  assert.deepEqual(verified, [], "the contributed pin check is never reached");
});

// ---- no leaked processes ----

test("no daemon this file started is still running", () => {
  const leaked = [...pids].filter(alive);
  assert.deepEqual(leaked, [], "every spawned daemon was killed by its exact PID");
});
