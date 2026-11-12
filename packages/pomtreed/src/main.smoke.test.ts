// Entrypoint smoke: spawns the real main.ts offline on a temp state dir and checks /readyz, a clean SIGTERM and the config commands.
// The refusals (bad config, missing provider, chat channels without senders) are tested in packages/e2e/src/boot-refusals.test.ts.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { until as sharedUntil } from "@pomtree/testing";

const main = join(import.meta.dirname, "main.ts");
const UPSTREAM_KEY = "upstream-key-sentinel-7f3a";

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

// The model proxy binds the docker bridge gateway on Linux whatever agent.listen says, and pomtreed learns the gateway from `docker network
// inspect bridge`. A real host-side docker0 address is not local inside a container on the default bridge network (EADDRNOTAVAIL), and a
// missing Docker CLI would change the plan. So every boot gets a stub `docker` first on its PATH that names a bindable stand-in: 127.0.0.2
// is loopback-range (local anywhere on Linux) and every other docker subcommand fails, as with an unreachable daemon.
const STUB_GATEWAY = "127.0.0.2";
function stubDockerDir(root: string): string {
  const dir = join(root, "stub-bin");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "docker");
  writeFileSync(file, `#!/bin/sh\n[ "$1 $2 $3" = "network inspect bridge" ] && { echo ${STUB_GATEWAY}; exit 0; }\nexit 1\n`, { mode: 0o755 });
  // A podman-selected boot must never run the machine's real podman either: every podman subcommand fails, as with no engine.
  writeFileSync(join(dir, "podman"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return dir;
}

// The engine socket every boot is pointed at: a path in the temp root where nothing listens, so engine detection never reaches a real
// Docker or Podman on the test machine (the engine is "not running", which boot reports and tolerates).
const absentEngineSocket = (root: string) => `unix://${join(root, "no-engine.sock")}`;

function boot(extra: Record<string, string>, root: string, port: number, args: string[] = []) {
  // The sensitive upstream key is read only from a file (model.upstreamKey via POMTREED_MODEL_UPSTREAM_KEY_FILE).
  writeFileSync(join(root, "upstream.key"), `${UPSTREAM_KEY}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [main, ...args], {
    env: {
      PATH: `${stubDockerDir(root)}:${process.env.PATH ?? ""}`,
      DOCKER_HOST: absentEngineSocket(root),
      HOME: root,
      POMTREED_STATE_DIR: join(root, "s"),
      POMTREED_SOCKET_PATH: join(root, "p.sock"),
      POMTREED_MODEL_BASE_URL: "http://127.0.0.1:1",
      POMTREED_MODEL_UPSTREAM_KEY_FILE: join(root, "upstream.key"),
      POMTREED_PI_PROVIDER: "x",
      POMTREED_MODEL_PROXY_PORT: String(port),
      POMTREED_AGENT_LISTEN: "off",
      POMTREED_REPO_DIR: root,
      POMTREED_READYZ_ALLOW_SANDBOX_DOWN: "1", // no Docker needed
      POMTREED_AGENT_EGRESS_PROXY_IMAGE: `sha256:${"0".repeat(64)}`, // required and digest-pinned; verified only when a sidecar starts, which no smoke boot does
      POMTREED_AGENT_UNTEMPLATED_EGRESS: "registry",
      // Required: what unset resolved to before (all with an outbound escalation channel, none when the channels are set empty).
      POMTREED_EXTENSIONS_APPROVAL: extra.POMTREED_ESCALATION_CHANNELS === "" ? "none" : "all",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
  return { child, exited, log: () => log };
}

function getSock(sock: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ socketPath: sock, path }, (r) => {
      let b = "";
      r.on("data", (d) => (b += d));
      r.on("end", () => resolve({ status: r.statusCode!, body: b }));
    })
      .on("error", reject)
      .end();
  });
}

async function until<T>(f: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  let found: T | undefined;
  await sharedUntil(
    async () => {
      found = await f().catch(() => undefined);
      return found !== undefined;
    },
    ms,
    { what: "the daemon under test", intervalMs: 100 },
  );
  return found as T;
}

test("pomtreed --version prints one build-identity line to stdout and exits 0 before any config or state", () => {
  const root = mkdtempSync(join(tmpdir(), "pomtreed-smoke-"));
  try {
    const rootVersion = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "package.json"), "utf8")) as { version: string }).version;
    for (const flag of ["--version", "-V"]) {
      // No config at all: a version query must not need (or refuse on) the startup settings.
      const r = spawnSync(process.execPath, [main, flag], {
        env: { PATH: process.env.PATH ?? "", HOME: root, POMTREED_STATE_DIR: join(root, "s") },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^v${rootVersion.replaceAll(".", "\\.")}\\*? \\((?:[0-9a-f]{4,}|unknown revision)\\)\n$`));
      assert.equal(r.stderr, "");
    }
    assert.equal(existsSync(join(root, "s")), false, "--version creates nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pomtreed config show resolves like startup, masks the secret and exits 0; a config error exits 2", async () => {
  const root = mkdtempSync(join(tmpdir(), "pomtreed-smoke-"));
  try {
    const port = await freePort();
    const ok = boot({ POMTREED_AGENT_MAX_DEPTH: "3" }, root, port, ["config", "show", "--origin", "--set", "drain.timeoutMs=5000"]);
    assert.equal(await ok.exited, 0, ok.log());
    assert.match(ok.log(), /^agent\.maxDepth=3 {2}origin=env:POMTREED_AGENT_MAX_DEPTH default=4$/m);
    assert.match(ok.log(), /^drain\.timeoutMs=5000 {2}origin=set default=10000$/m);
    assert.match(ok.log(), /^model\.upstreamKey="<redacted>" {2}origin=file-secret:POMTREED_MODEL_UPSTREAM_KEY_FILE default=""$/m);
    assert.doesNotMatch(ok.log(), new RegExp(UPSTREAM_KEY));
    assert.doesNotMatch(ok.log(), /listening/);
    assert.equal(existsSync(join(root, "s")), false, "config show creates nothing");
    const bad = boot({}, root, port, ["config", "show", "--set", "agent.maxDepht=1"]);
    assert.equal(await bad.exited, 2, bad.log());
    assert.match(bad.log(), /^pomtreed: config: --set: unknown key agent\.maxDepht \(did you mean agent\.maxDepth\?\)$/m);
    const usage = boot({}, root, port, ["--bogus"]);
    assert.equal(await usage.exited, 2);
    assert.match(usage.log(), /unknown option --bogus/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension-contributed keys: resolved and shown like core keys; a bad value, declaration, undeclared env or unloaded key exits 2", async () => {
  const root = mkdtempSync(join(tmpdir(), "pomtreed-smoke-"));
  try {
    const extDir = join(root, "ext");
    mkdirSync(join(extDir, "fixture"), { recursive: true });
    const manifest = (params: unknown) =>
      writeFileSync(
        join(extDir, "fixture", "manifest.json"),
        JSON.stringify({ apiVersion: 2, name: "fixture", entry: "entry.mjs", capabilities: {}, deps: [], credentials: ["token"], params }),
      );
    manifest([{ key: "sizeBytes", kind: "bytes", doc: "Size.", default: 100, min: 1 }]);
    const env = { POMTREED_EXTENSIONS_DIR: extDir };
    const port = await freePort();
    const show = boot({ ...env, POMTREED_EXT_FIXTURE_SIZE_BYTES: "300" }, root, port, ["config", "show", "--origin", "--set", "ext.fixture.sizeBytes=400"]);
    assert.equal(await show.exited, 0, show.log());
    assert.match(show.log(), /^ext\.fixture\.sizeBytes=400 {2}origin=set default=100$/m);
    const viaEnv = boot({ ...env, POMTREED_EXT_FIXTURE_SIZE_BYTES: "300", POMTREED_EXT_FIXTURE_TOKEN: "t" }, root, port, ["config", "show", "--origin"]);
    assert.equal(await viaEnv.exited, 0, viaEnv.log());
    assert.match(viaEnv.log(), /^ext\.fixture\.sizeBytes=300 {2}origin=env:POMTREED_EXT_FIXTURE_SIZE_BYTES default=100$/m);
    assert.doesNotMatch(viaEnv.log(), /POMTREED_EXT_FIXTURE_TOKEN/, "a declared credential is neither a key nor printed");
    for (const [extra, args, re] of [
      [
        { POMTREED_EXT_FIXTURE_SIZE_BYTES: "lots" },
        [],
        /^pomtreed: config: ext\.fixture\.sizeBytes="lots" \(env:POMTREED_EXT_FIXTURE_SIZE_BYTES\): expected a non-negative integer of bytes$/m,
      ],
      [
        { POMTREED_EXT_FIXTURE_SIZE_BYTE: "1" },
        [],
        /^pomtreed: config: unknown env POMTREED_EXT_FIXTURE_SIZE_BYTE: extension fixture declares no such key or credential/m,
      ],
      [
        { POMTREED_EXT_GHOST_SIZE_BYTES: "1" },
        [],
        /^pomtreed: config: unknown env POMTREED_EXT_GHOST_SIZE_BYTES: it names no loaded extension \(loaded: fixture\)/m,
      ],
      [{}, ["--set", "ext.ghost.sizeBytes=1"], /^pomtreed: config: --set: unknown key ext\.ghost\.sizeBytes: no loaded extension owns ext\.ghost\./m],
    ] as const) {
      const b = boot({ ...env, ...extra }, root, port, [...args]);
      assert.equal(await b.exited, 2, b.log());
      assert.match(b.log(), re);
      assert.equal(existsSync(join(root, "s")), false, "refused before the state dir is created");
    }
    manifest([{ key: "sizeBytes", kind: "bytes", doc: "Size.", default: 100, container: true }]);
    const bad = boot(env, root, port);
    assert.equal(await bad.exited, 2, bad.log());
    assert.match(bad.log(), /^pomtreed: config: extension fixture: params\[0\] \(sizeBytes\): container is not allowed in a manifest/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pomtreed boots offline, tightens the state dir, answers /readyz, warns on ui-without-listener, exits 0 on SIGTERM", async () => {
  const root = mkdtempSync(join(tmpdir(), "pomtreed-smoke-"));
  try {
    mkdirSync(join(root, "s"), { mode: 0o755 });
    chmodSync(join(root, "s"), 0o755);
    const b = boot({}, root, await freePort());
    try {
      const r = await until(async () => {
        const x = await getSock(join(root, "p.sock"), "/readyz");
        return x;
      }).catch(() => undefined);
      assert.ok(r, `pomtreed did not become ready: ${b.log().slice(-300)}`);
      await until(async () => (/pomtreed listening on/.test(b.log()) ? true : undefined)); // signal handlers are installed last
      assert.equal(r.status, 200, r.body);
      // The listening line names the build identity (revision.ts buildVersion).
      assert.match(b.log(), /pomtreed listening on \S+ \(host [^,]+, v\d+\.\d+\.\d+\*? \((?:[0-9a-f]{4,}|unknown revision)\)\)/);
      assert.equal(statSync(join(root, "s")).mode & 0o777, 0o700);
      assert.match(b.log(), /POMTREED_UI_LISTEN is off/);
      assert.doesNotMatch(b.log(), /SECURITY WARNING/, "the default config (ui-only) raises no security warning");
      assert.doesNotMatch(b.log(), /refusing to start/i);
      // The engine is not running: boot names it and the cause through the LocalEngine finding, and starts anyway.
      assert.match(b.log(), /^pomtreed: the docker engine does not answer on \S+no-engine\.sock \(from DOCKER_HOST\): .*pomtreed starts anyway/m);
      b.child.kill("SIGTERM");
      assert.equal(await b.exited, 0, b.log());
    } finally {
      b.child.kill("SIGKILL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pomtreed refuses to start when the engine setting is one the LocalEngine refuses (a remote DOCKER_HOST), before any state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pomtreed-smoke-"));
  try {
    const b = boot({ DOCKER_HOST: "tcp://10.0.0.1:2375" }, root, await freePort());
    try {
      // Bounded: a pomtreed that wrongly starts never exits on its own, which must fail here rather than hang the suite.
      const code = await Promise.race([b.exited, new Promise<string>((res) => setTimeout(() => res("still running after 30 s"), 30_000).unref())]);
      assert.equal(code, 1, b.log());
      assert.match(
        b.log(),
        /^pomtreed: refusing to start: DOCKER_HOST for the docker engine is "tcp:\/\/10\.0\.0\.1:2375", which is not a local unix socket .*; set DOCKER_HOST to unix:\/\/\/<absolute path> or unset it$/m,
      );
      assert.equal(existsSync(join(root, "s")), false, "a refused start creates no state dir");
    } finally {
      b.child.kill("SIGKILL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Starts pomtreed with the given env, waits for /readyz, then SIGTERMs it. Returns the log, or undefined when not ready here.
// Fails (never skips) when pomtreed does not become ready: a skipped boot test would pass vacuously in CI.
async function bootClean(extra: Record<string, string>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "pomtreed-smoke-"));
  try {
    const b = boot(extra, root, await freePort());
    try {
      const r = await until(async () => getSock(join(root, "p.sock"), "/readyz")).catch(() => undefined);
      assert.ok(r, `pomtreed did not become ready: ${b.log().slice(-300)}`);
      await until(async () => (/pomtreed listening on/.test(b.log()) ? true : undefined));
      assert.equal(r.status, 200, r.body);
      b.child.kill("SIGTERM");
      assert.equal(await b.exited, 0, b.log());
      return b.log();
    } finally {
      b.child.kill("SIGKILL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("pomtreed boots with zero channels and warns nothing about senders", async () => {
  const log = await bootClean({ POMTREED_ESCALATION_CHANNELS: "" });
  assert.doesNotMatch(log, /SECURITY WARNING/);
  assert.doesNotMatch(log, /refusing to start/i);
  for (const line of log.split("\n")) if (/warning/i.test(line)) assert.doesNotMatch(line, /POMTREED_MESSAGING_SENDERS/);
});

test("pomtreed boots with a chat channel when POMTREED_MESSAGING_SENDERS is set", async () => {
  const log = await bootClean({ POMTREED_MESSAGING_CHANNELS: "discord", POMTREED_ESCALATION_CHANNELS: "discord", POMTREED_MESSAGING_SENDERS: "discord:u1" });
  assert.doesNotMatch(log, /SECURITY WARNING/);
  assert.doesNotMatch(log, /refusing to start/i);
});

// A scripted engine API on a unix socket in the temp root: GET /_ping and /version answer as Docker or as Podman (the identity fields
// the detector reads, nothing else), so engine selection is exercised without a real engine.
async function fakeEngine(path: string, kind: "docker" | "podman"): Promise<Server> {
  const server = createHttpServer((req, res) => {
    if (req.url === "/_ping") {
      res.writeHead(200, kind === "podman" ? { "Libpod-Api-Version": "6.2.0" } : {});
      res.end("OK");
    } else if (req.url === "/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Components: [{ Name: kind === "podman" ? "Podman Engine" : "Engine" }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((res) => server.listen(path, res));
  return server;
}

// Boots and waits (bounded) for the exit: a pomtreed that wrongly starts never exits on its own.
async function bootRefused(extra: (root: string) => Record<string, string>): Promise<{ code: unknown; log: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "pomtreed-smoke-"));
  const b = boot(extra(root), root, await freePort());
  try {
    const code = await Promise.race([b.exited, new Promise<string>((res) => setTimeout(() => res("still running after 30 s"), 30_000).unref())]);
    return { code, log: b.log(), root };
  } finally {
    b.child.kill("SIGKILL");
  }
}

test("sandbox.backend naming a built-in this build does not carry (kubernetes) refuses the start with the cause and the action, before any state", async () => {
  const r = await bootRefused(() => ({ POMTREED_SANDBOX_BACKEND: "kubernetes" }));
  try {
    assert.equal(r.code, 1, r.log);
    assert.match(
      r.log,
      /^pomtreed: refusing to start: built-in backend kubernetes is not available in this build; available: auto, docker, podman; set sandbox\.backend to one of them$/m,
    );
    assert.equal(existsSync(join(r.root, "s")), false, "a refused start creates no state dir");
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("sandbox.backend=podman selects Podman: a Podman that is not running is named with podman's own socket variable, never docker", async () => {
  const root = mkdtempSync(join(tmpdir(), "pomtreed-smoke-"));
  try {
    const log = await bootClean({ POMTREED_SANDBOX_BACKEND: "podman", CONTAINER_HOST: `unix://${join(root, "no-podman.sock")}` });
    assert.match(log, /^pomtreed: the podman engine does not answer on \S+no-podman\.sock \(from CONTAINER_HOST\): .*until the podman engine answers$/m);
    assert.doesNotMatch(log, /the docker engine/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox.backend=podman with a Docker engine answering on CONTAINER_HOST refuses the start (selection and engine disagree)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pomtreed-eng-"));
  const sock = join(dir, "e.sock");
  const server = await fakeEngine(sock, "docker");
  try {
    const r = await bootRefused(() => ({ POMTREED_SANDBOX_BACKEND: "podman", CONTAINER_HOST: `unix://${sock}` }));
    rmSync(r.root, { recursive: true, force: true });
    assert.equal(r.code, 1, r.log);
    assert.match(
      r.log,
      /^pomtreed: refusing to start: sandbox\.backend is "podman" but the engine answering on \S+e\.sock is docker; set sandbox\.backend to "docker"/m,
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox.podman.socket pointing at a Docker engine refuses the start, naming both engines, the key and the action", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pomtreed-eng-"));
  const sock = join(dir, "e.sock");
  const server = await fakeEngine(sock, "docker");
  try {
    const r = await bootRefused(() => ({ POMTREED_SANDBOX_BACKEND: "podman", POMTREED_SANDBOX_PODMAN_SOCKET: sock }));
    rmSync(r.root, { recursive: true, force: true });
    assert.equal(r.code, 1, r.log);
    assert.match(
      r.log,
      /^pomtreed: refusing to start: sandbox\.backend is "podman" but the engine answering on \S+e\.sock is docker; set sandbox\.backend to "docker", or point sandbox\.podman\.socket at a podman socket$/m,
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox.docker.socket from --set reaches engine detection: the configured engine answers, so no 'does not answer' finding is printed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pomtreed-eng-"));
  const sock = join(dir, "d.sock");
  const server = await fakeEngine(sock, "docker");
  const root = mkdtempSync(join(tmpdir(), "pomtreed-smoke-"));
  try {
    const b = boot({}, root, await freePort(), ["--set", `sandbox.docker.socket=${sock}`]);
    try {
      const r = await until(async () => getSock(join(root, "p.sock"), "/readyz")).catch(() => undefined);
      assert.ok(r, `pomtreed did not become ready: ${b.log().slice(-300)}`);
      await until(async () => (/pomtreed listening on/.test(b.log()) ? true : undefined));
      assert.doesNotMatch(b.log(), /the docker engine does not answer/, "DOCKER_HOST (absent) must lose to the configured socket");
      b.child.kill("SIGTERM");
      assert.equal(await b.exited, 0, b.log());
    } finally {
      b.child.kill("SIGKILL");
    }
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox.backend=auto with both engines answering uses docker and names the other in a finding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pomtreed-eng-"));
  const docker = await fakeEngine(join(dir, "d.sock"), "docker");
  const podman = await fakeEngine(join(dir, "p.sock"), "podman");
  try {
    const log = await bootClean({
      POMTREED_SANDBOX_BACKEND: "auto",
      DOCKER_HOST: `unix://${join(dir, "d.sock")}`,
      CONTAINER_HOST: `unix://${join(dir, "p.sock")}`,
    });
    assert.match(log, /^pomtreed: both docker and podman answer; using docker \(set sandbox\.backend to "podman" to use the other\)$/m);
  } finally {
    docker.close();
    podman.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
