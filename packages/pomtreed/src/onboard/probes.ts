// Gathers what `pomtreed preflight` evaluates: every host observation goes through an injected ProbeRunner (commands) or an injected
// stat (files), so the gathering is testable with FakeProbeRunner and nothing here touches the real host. Evaluation is findings.ts.
import { REVISION_LABEL } from "@pomtree/agent-image";
import { DOCKER_PROFILE, type EngineCli, type EngineProfile, engineInfoArgs, imageLabelArgs, PODMAN_PROFILE } from "@pomtree/sandbox-docker";
import { imageCheckVerdict, probeEgressProxy } from "../image-check.ts";
import { targetRepoRefusal } from "./repo.ts";
import type { SetupFacts } from "./steps.ts";

export interface ProbeResult {
  code: number | null; // null = command not found, could not spawn, or timed out
  stdout: string;
  stderr: string;
  spawnError?: string; // the errno code (ENOENT, EACCES, ENOEXEC) of a refused spawn, when the runner knows it; absent for a command that ran
}

// TODO(onboard-probe-port): ProbeRunner belongs in core ports.ts so the fake can implement it nominally; current: structural type in pomtreed, the fake in @pomtree/testing matches it structurally
export interface ProbeOptions {
  timeoutMs?: number; // bounds one command (the shell's default applies when absent)
  cwd?: string; // absent: the shell's working directory
  env?: Readonly<Record<string, string>>; // added to the shell's environment
}

export interface ProbeRunner {
  run(command: string, args: readonly string[], opts?: ProbeOptions): Promise<ProbeResult>;
}

// pnpm is probed from the checkout, so the version that answers is the one the checkout pins (corepack and pnpm's own version
// switching both read the nearest packageManager field; from the target repo, untrusted content would choose what runs). Neither
// may download a pnpm: preflight changes nothing and uses no network.
// Sources (accessed 2026-10-26): https://github.com/nodejs/corepack#environment-variables (COREPACK_ENABLE_NETWORK,
// COREPACK_ENABLE_DOWNLOAD_PROMPT); https://pnpm.io/settings#managepackagemanagerversions.
export const PNPM_PROBE_ENV: Readonly<Record<string, string>> = {
  COREPACK_ENABLE_NETWORK: "0",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  npm_config_manage_package_manager_versions: "false",
};

export interface FileStat {
  mode: number;
  uid: number;
  isDirectory: boolean;
}

export interface ProbeHost {
  platform: string;
  nodeVersion: string;
  uid: number | null; // null on win32
  facts: SetupFacts;
  checkout: string; // the pomtree checkout root
  repoDir?: string; // the target repository (--repo); absent: not checked, never defaulted to the working directory
  stateDir: string;
  image: string; // the agent image
  egressImage?: string; // the egress-proxy sidecar image; absent = the agent image (what the deploy example and pomtree-up use)
  keyFile?: string;
  engine?: EngineProfile; // the container engine to check; absent = Docker
  stat(path: string): FileStat | null;
  realpath(path: string): string; // realpathLoose in the shell
}

export type StateVisible = "ok" | "fail" | "unknown" | "skipped"; // unknown = the probe never answered (timeout or spawn failure)
// unset: no --repo given; refused: targetRepoRefusal (the checkout, or overlapping it), with its message in repoRefusal
export type RepoState = "ok" | "no-commit" | "not-git" | "skipped" | "unset" | "refused";

export interface ImageObs {
  ref: string;
  state: "present" | "missing" | "skipped";
  revision: string | undefined;
  /** Whether the image carries the egress proxy; probed only for the egress image. unknown = the probe gave no clear answer (timed out, could not start, the image has no node, or node crashed). */
  egressProxy?: "present" | "absent" | "unknown" | "skipped";
}

export interface Observations {
  host: ProbeHost;
  git: string | null; // `git --version` output, null = not on PATH
  corepack: string | null;
  pnpm: string | null;
  pnpmSpawnError: string | null; // the errno code of a pnpm spawn refused for a reason other than ENOENT (EACCES, ENOEXEC): the binary exists but cannot be run
  pnpmUnresolved: boolean; // pnpm (or corepack's shim) is on PATH but gave no version offline: the pinned pnpm is not downloaded yet
  // The selected engine's CLI version, whether its daemon or service answers, and (Docker only) whether buildx is present.
  engine: { profile: EngineProfile; version: string | null; daemon: boolean; buildx: boolean | null };
  podman: string | null; // `podman --version` when the selected engine is Docker (reported as not validated); null otherwise
  images: { agent: ImageObs; egress: ImageObs; egressDefaulted: boolean };
  checkoutRevision: string | undefined;
  stateVisible: { state: StateVisible; why: string };
  ufw: "active" | "inactive" | "n/a";
  repo: RepoState;
  repoRefusal?: string;
  keyFile?: { path: string; stat: FileStat | null };
}

export const DOCKER_RUN_TIMEOUT_MS = 30_000;
export { EGRESS_PROXY_PATH } from "@pomtree/sandbox-docker"; // the path the sidecar runs; the shared probe checks it
const out = (r: ProbeResult): string | null => (r.code === 0 ? r.stdout.trim() : null);

// Node >= 26 throws a spawn refusal such as ENOEXEC synchronously (a shebang-less PATH shim that a shell would run via /bin/sh), so a
// runner's `run` can throw or reject instead of resolving null; a diagnostic tool must never die on the machine it is diagnosing.
// The refusal's errno code is kept in `spawnError` so findings.ts can tell ENOENT (not on PATH) from EACCES/ENOEXEC (present but not runnable).
function safeRun(runner: ProbeRunner): ProbeRunner["run"] {
  return async (command, args, opts) => {
    try {
      return await runner.run(command, args, opts);
    } catch (e) {
      const spawnError = (e as { code?: unknown } | null)?.code;
      return { code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e), ...(typeof spawnError === "string" && { spawnError }) };
    }
  };
}

export async function gatherObservations(host: ProbeHost, runner: ProbeRunner): Promise<Observations> {
  const run = safeRun(runner);
  const engine = host.engine ?? DOCKER_PROFILE;
  const b = engine.binary;
  const isDocker = engine.id === DOCKER_PROFILE.id;
  const [git, corepack, pnpm, engineVersion, podman, ufw] = await Promise.all([
    run("git", ["--version"]),
    run("corepack", ["--version"]),
    run("pnpm", ["--version"], { cwd: host.checkout, env: PNPM_PROBE_ENV }),
    run(b, ["--version"]),
    isDocker ? run(PODMAN_PROFILE.binary, ["--version"]) : Promise.resolve(undefined),
    host.platform === "linux" ? run("systemctl", ["is-active", "ufw"]) : Promise.resolve(undefined),
  ]);
  const engineFound = engineVersion.code === 0;
  // buildx is Docker's builder plugin; Podman builds with its own `podman build`.
  const [info, buildx] = engineFound
    ? await Promise.all([run(b, engineInfoArgs(engine)), isDocker ? run(b, ["buildx", "version"]) : Promise.resolve(undefined)])
    : [undefined, undefined];
  const daemon = info?.code === 0 && info.stdout.trim() !== "";

  const inspect = async (ref: string): Promise<ImageObs> => {
    if (!daemon) return { ref, state: "skipped", revision: undefined };
    const r = await run(b, imageLabelArgs(ref, REVISION_LABEL));
    const label = out(r);
    return r.code === 0
      ? { ref, state: "present", revision: label === null || label === "" || label === "<no value>" ? undefined : label }
      : { ref, state: "missing", revision: undefined };
  };
  // Both images the sandbox starts (the agent's and the egress sidecar's); one ref is probed once.
  const egressRef = host.egressImage ?? host.image;
  const agent = await inspect(host.image);
  const egressInspected = egressRef === host.image ? { ...agent } : await inspect(egressRef);
  // Existence only: proxy.ts itself errors without config even when healthy, so it is never run as a probe. The probe and its
  // verdict are the boot check's (image-check.ts): exit 0 present, its own exit 3 absent, anything else (node's 1 for any crash,
  // the engine CLI's 125-127, a timeout) unknown. The runner is adapted to the engine CLI, keeping preflight's run timeout.
  let egressProxy: NonNullable<ImageObs["egressProxy"]> = "skipped";
  if (egressInspected.state === "present") {
    const cli: EngineCli = { binary: b, run: (args) => run(b, args, { timeoutMs: DOCKER_RUN_TIMEOUT_MS }) };
    const v = imageCheckVerdict({ image: egressRef, revision: egressInspected.revision, ...(await probeEgressProxy(egressRef, cli)) });
    egressProxy = "ok" in v ? "present" : "refuse" in v ? "absent" : "unknown";
  }
  const egress = { ...egressInspected, egressProxy };
  const images = { agent, egress, egressDefaulted: host.egressImage === undefined };
  const checkoutRevision = out(await run("git", ["-C", host.checkout, "rev-parse", "--short", "HEAD"])) || undefined;

  // The bind-mount visibility probe formerly in scripts/pomtree-up (TODO(doctor-state-visible)); this is its pomtreed-side home.
  // It never creates the state dir: the engine would create a missing bind source as root.
  let stateVisible: Observations["stateVisible"];
  if (!daemon) stateVisible = { state: "skipped", why: `${b} daemon not reachable` };
  else if (images.agent.state !== "present") stateVisible = { state: "skipped", why: `image ${host.image} is not present` };
  else if (!host.stat(host.stateDir)?.isDirectory) stateVisible = { state: "skipped", why: `state dir ${host.stateDir} does not exist yet` };
  else if (/[,"]/.test(host.stateDir))
    stateVisible = {
      state: "skipped",
      why: `state dir ${host.stateDir} contains a comma or double quote, which ${b}'s --mount syntax cannot carry; it cannot be probed`,
    };
  else {
    // --mount, not -v: a ":" in the path would mis-parse as -v's separator.
    const r = await run(
      b,
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "ls",
        "--mount",
        `type=bind,src=${host.stateDir},dst=/pomtreed-state-probe,readonly`,
        host.image,
        "/pomtreed-state-probe",
      ],
      { timeoutMs: DOCKER_RUN_TIMEOUT_MS },
    );
    // A null code is no answer (timeout, spawn failure; a cold first engine run can exceed the timeout), so it must not block.
    stateVisible =
      r.code === 0
        ? { state: "ok", why: "" }
        : r.code === null
          ? { state: "unknown", why: `the ${b} run probe did not answer within ${DOCKER_RUN_TIMEOUT_MS / 1000} s or could not start` }
          : { state: "fail", why: r.stderr.trim().split("\n")[0] || `${b} run failed` };
  }

  let repo: RepoState = "skipped";
  const repoRefusal = host.repoDir === undefined ? null : targetRepoRefusal(host.realpath(host.repoDir), host.realpath(host.checkout));
  if (host.repoDir === undefined) repo = "unset";
  else if (repoRefusal !== null) repo = "refused";
  else if (git.code === 0) {
    if ((await run("git", ["-C", host.repoDir, "rev-parse", "--verify", "-q", "HEAD"])).code === 0) repo = "ok";
    else repo = (await run("git", ["-C", host.repoDir, "rev-parse", "--git-dir"])).code === 0 ? "no-commit" : "not-git";
  }

  return {
    host,
    git: out(git),
    corepack: out(corepack),
    pnpm: out(pnpm),
    pnpmSpawnError: pnpm.spawnError !== undefined && pnpm.spawnError !== "ENOENT" ? pnpm.spawnError : null,
    pnpmUnresolved: pnpm.code !== null && pnpm.code !== 0,
    ...(repoRefusal !== null && { repoRefusal }),
    engine: { profile: engine, version: out(engineVersion), daemon, buildx: isDocker ? buildx?.code === 0 : null },
    podman: podman === undefined ? null : out(podman),
    images,
    checkoutRevision,
    stateVisible,
    ufw: ufw === undefined ? "n/a" : ufw.code === 0 && ufw.stdout.trim() === "active" ? "active" : "inactive",
    repo,
    ...(host.keyFile !== undefined && { keyFile: { path: host.keyFile, stat: host.stat(host.keyFile) } }),
  };
}
