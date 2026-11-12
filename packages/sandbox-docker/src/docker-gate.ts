// Shared gate for the real-engine suites: the image must be the one built from a committed revision whose adapter/image sources are unchanged.
// Default `pnpm test` skips these suites, so they drift silently: rerun them (PTREE_DOCKER_TESTS=1, the rebuilt image and its revision)
// at the end of any wave that changes the agent image, browser-run.ts, the browser extension or this adapter's run args.
// PTREE_SANDBOX_BACKEND=docker|podman (default docker) picks the engine the suites target. What holds today: the gate verifies that the
// daemon behind the requested backend's socket identifies as that backend (from its own /_ping and /version, never from the socket path)
// and throws on a mismatch instead of skipping. What does not hold yet: the suites themselves still build DockerSandbox, and run the
// `docker` CLI, without the gate's engine, so a Podman job is not yet guaranteed to exercise Podman.
// TODO(gate-engine-threading): every gated suite must pass `gateEngine().profile` and `gateEngine().socket` into DockerSandbox and use that
// profile's binary for direct CLI calls. Current behavior: not done in docker.test.ts, sandbox-contract.test.ts, result-work.test.ts,
// capture-worker-wacz.test.ts, browser-real-article.test.ts, network-docker.test.ts, args-runtime.test.ts (direct `docker` calls), the e2e
// docker-fanout, docker-pi and docker-proxy-path suites; they always run Docker defaults.
// Behavior change for the docker backend: the gate now runs detectLocalEngine in a child process first (the gates are synchronous) where it
// used to run `docker info` directly. It throws, fail-closed by design, on a remote DOCKER_HOST (tcp://, ssh://), an unidentifiable engine, a
// detector crash or the 30 s child timeout. An engine that is not installed or not running still skips.
import { execFileSync } from "node:child_process";
import { after } from "node:test";
import { pathToFileURL } from "node:url";
import { cliSocketEnv, engineProfile, ENGINE_IDS, isEngineId, type EngineId, type EngineProfile } from "./engine-profile.ts";

export const IMAGE = process.env.PTREE_AGENT_TEST_IMAGE ?? "pomtree/agent:dev";

// The backend the gated suites target. An unrecognised value throws: a typo must not silently run the Docker suites.
export function gateBackend(env: Readonly<Record<string, string | undefined>> = process.env): EngineId {
  const v = env.PTREE_SANDBOX_BACKEND;
  if (v === undefined || v === "") return "docker";
  if (!isEngineId(v)) throw new Error(`PTREE_SANDBOX_BACKEND is "${v}", which is not a known backend; set it to one of ${ENGINE_IDS.join(", ")} or unset it`);
  return v;
}

const engineName = (profile: EngineProfile) => (profile.id === "docker" ? "Docker" : "Podman");

// The opt-in check shared by every gate; the reason names the resolved backend. The docker backend keeps the exact legacy reasons below
// (packages/testing/src/fakes.ts DOCKER_GATE_REASONS matches them by regex); only podman gets new wording.
export function optInSkip(env: Readonly<Record<string, string | undefined>> = process.env): string | false {
  if (env.PTREE_DOCKER_TESTS === "1") return false;
  const backend = gateBackend(env);
  return backend === "docker"
    ? "PTREE_DOCKER_TESTS not set (no Docker execution)"
    : `PTREE_DOCKER_TESTS not set (no ${engineName(engineProfile(backend))} execution; backend ${backend})`;
}

// A missing engine or image on the docker backend keeps its legacy reason; the podman backend names itself and the cause.
const legacyIfDocker = (profile: EngineProfile, legacy: string, reason: string): string => (profile.id === "docker" ? legacy : reason);

// What asking the requested backend's socket returned. `answered` carries the id the engine reported for itself, which may differ.
export type EngineLookup =
  | { kind: "answered"; id: EngineId; socket: string }
  // Not installed or not running: routine, a skip.
  | { kind: "absent"; message: string }
  // A setting was refused (for example a remote tcp:// host) or the engine could not be identified: a failure.
  | { kind: "refused"; message: string };

export interface GateEngine {
  profile: EngineProfile;
  socket: string;
  // Environment for CLI calls against this engine; undefined keeps the process environment (the docker profile's behavior).
  env: NodeJS.ProcessEnv | undefined;
}

// Pure decision over a lookup. Throws on an identity mismatch or a refused setting; returns a skip reason when the engine is absent.
export function checkGateEngine(requested: EngineId, lookup: EngineLookup): GateEngine | string {
  const profile = engineProfile(requested);
  if (lookup.kind === "absent") return `${engineName(profile)} unavailable (backend ${requested}): ${lookup.message}`;
  if (lookup.kind === "refused") throw new Error(`PTREE_SANDBOX_BACKEND=${requested}: ${lookup.message}`);
  if (lookup.id !== requested) {
    throw new Error(
      `PTREE_SANDBOX_BACKEND=${requested} but the engine answering on ${lookup.socket} identifies itself as ${lookup.id}; point ${profile.socketEnv.join("/")} at a ${requested} socket, or set PTREE_SANDBOX_BACKEND=${lookup.id}`,
    );
  }
  return { profile, socket: lookup.socket, env: requested === "docker" ? undefined : { ...process.env, ...cliSocketEnv(profile, lookup.socket) } };
}

// Runs detectLocalEngine in a child node process (the gates are synchronous, the probes are not) and reports what it found.
const DETECT_URL = pathToFileURL(new URL("./engine-detect.ts", import.meta.url).pathname).href;
const PROFILE_URL = pathToFileURL(new URL("./engine-profile.ts", import.meta.url).pathname).href;
const LOOKUP_SCRIPT = `
const d = await import(${JSON.stringify(DETECT_URL)});
const p = await import(${JSON.stringify(PROFILE_URL)});
const out = (o) => process.stdout.write(JSON.stringify(o));
try {
  const e = await d.detectLocalEngine({ selection: process.argv[1], env: process.env, probes: d.realEngineProbes });
  out({ kind: "answered", id: e.identity.id, socket: e.socket.path });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof d.EngineMismatchError) out({ kind: "answered", id: err.actual, socket: err.socket });
  else if (err instanceof d.EngineUnreachableError || err instanceof p.SocketNotFoundError) out({ kind: "absent", message });
  else out({ kind: "refused", message });
}
`;
export function lookupEngineSync(requested: EngineId, env: NodeJS.ProcessEnv = process.env): EngineLookup {
  try {
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", LOOKUP_SCRIPT, requested], { encoding: "utf8", env, timeout: 30000 });
    return JSON.parse(stdout) as EngineLookup;
  } catch (e) {
    return {
      kind: "refused",
      message: `engine detection crashed: ${e instanceof Error ? e.message : String(e)}; rerun with the engine running, or report this`,
    };
  }
}

// Resolved once per process: gates and helpers share one answer.
let resolved: GateEngine | string | undefined;
function resolveGateEngine(): GateEngine | string {
  resolved ??= checkGateEngine(gateBackend(), lookupEngineSync(gateBackend()));
  return resolved;
}

// The engine a gated suite runs against (profile, socket): pass `profile` and `socket` to DockerSandbox. Call it only once a gate is open.
export function gateEngine(): GateEngine {
  const r = resolveGateEngine();
  if (typeof r === "string") throw new Error(r);
  return r;
}

// Runs the backend's CLI synchronously against the gate's engine.
function cli(args: string[], options: { stdio?: "ignore"; encoding?: "utf8"; timeout: number }): string {
  const engine = gateEngine();
  return execFileSync(engine.profile.binary, args, { ...options, ...(engine.env ? { env: engine.env } : {}) }) as unknown as string;
}

// IMAGE pinned by its local image id (`sha256:<hex>`), the digest-pinned form DockerSandbox requires for egressProxyImage.
// Call it only once a gate is open (inside a test body or fixture): it runs `<binary> image inspect` and throws without the engine.
let pinned: string | undefined;
export function pinnedImage(): string {
  pinned ??= cli(["image", "inspect", "--format", "{{.Id}}", IMAGE], { encoding: "utf8", timeout: 10000 }).trim();
  return pinned;
}
export function gate(): string | false {
  const optedOut = optInSkip();
  if (optedOut) return optedOut;
  const engine = resolveGateEngine();
  if (typeof engine === "string") return gateBackend() === "docker" ? "Docker unavailable; network-none/UDS/browser confinement unverified" : engine;
  const revision = process.env.PTREE_AGENT_TEST_REVISION;
  if (!revision || !/^[0-9a-f]{7,40}$/.test(revision)) return "explicit committed PTREE_AGENT_TEST_REVISION required; no old-image proof";
  let expected: string;
  try {
    expected = execFileSync("git", ["rev-parse", "--short", revision], { encoding: "utf8", timeout: 5000 }).trim();
    execFileSync("git", ["diff", "--quiet", revision, "--", ":(top)packages/agent-image", ":(top)packages/sandbox-docker"], { stdio: "ignore", timeout: 5000 });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ":(top)packages/agent-image", ":(top)packages/sandbox-docker"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (untracked.trim()) return "commit adapter/image checkpoint before Docker gates; untracked sources are not image proof";
  } catch {
    return "adapter/image source differs from requested committed image revision";
  }
  try {
    cli(["info"], { stdio: "ignore", timeout: 10000 });
  } catch {
    return `${engineName(engine.profile)} unavailable; network-none/UDS/browser confinement unverified`;
  }
  try {
    cli(["image", "inspect", IMAGE], { stdio: "ignore", timeout: 10000 });
  } catch {
    return legacyIfDocker(
      engine.profile,
      `rebuilt ${IMAGE} unavailable; this gate never pulls or builds`,
      `rebuilt ${IMAGE} unavailable in the ${engine.profile.id} image store; this gate never pulls or builds`,
    );
  }
  try {
    const actual = cli(["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', IMAGE], {
      encoding: "utf8",
      timeout: 10000,
    }).trim();
    if (actual !== expected) return `image revision ${actual || "missing"} does not match approved ${expected}`;
  } catch {
    return "cannot establish rebuilt image revision";
  }
  return false;
}

// Lighter gate for suites that prove a Docker ENGINE property (the shared egress network's ICC-off isolation) rather
// than image confinement: Docker reachable and IMAGE present, without the committed-revision proof, so the suite also
// runs against an uncommitted adapter. It must not be used to claim anything about the image's own sources.
export function engineGate(): string | false {
  const optedOut = optInSkip();
  if (optedOut) return optedOut;
  const engine = resolveGateEngine();
  if (typeof engine === "string") return gateBackend() === "docker" ? "Docker unavailable; egress network isolation unverified" : engine;
  try {
    cli(["info"], { stdio: "ignore", timeout: 10000 });
  } catch {
    return `${engineName(engine.profile)} unavailable; egress network isolation unverified`;
  }
  try {
    cli(["image", "inspect", IMAGE], { stdio: "ignore", timeout: 10000 });
  } catch {
    return legacyIfDocker(
      engine.profile,
      `${IMAGE} unavailable; this gate never pulls or builds`,
      `${IMAGE} unavailable in the ${engine.profile.id} image store; this gate never pulls or builds`,
    );
  }
  return false;
}

// Gated suites run their sidecars on a per-process pomtree-test- network, never the production EGRESS_NETWORK (which by
// design outlives every sandbox), and remove it once the file's tests are done.
export function testEgressNetwork(): string {
  const name = `pomtree-test-egress-${process.pid}`;
  if (process.env.PTREE_DOCKER_TESTS === "1")
    after(() => {
      try {
        cli(["network", "rm", name], { stdio: "ignore", timeout: 20000 });
      } catch {
        /* never created (skipped suite) or already removed */
      }
    });
  return name;
}
