import { execFile, execFileSync } from "node:child_process";
import { SandboxUnavailableError } from "@pomtree/core";
import { normalizeImageId, REQUIRED_SANDBOX_TAGS } from "./engine-dialect.ts";
import { detectLocalEngine, type EngineProbes, EngineUnreachableError, type EngineSelection, realEngineProbes } from "./engine-detect.ts";
import { cliSocketEnv, DOCKER_PROFILE, type EngineId, type EngineProfile, engineProfile, type ResolvedSocket, SocketNotFoundError } from "./engine-profile.ts";

// The one object pomtreed reaches its local container engine through: the selected profile, the resolved socket, the CLI binary and
// the engine's dialect helpers. Built once at the composition root (openLocalEngine) and passed to every pomtreed call site that used
// to run a hard-coded CLI. Folding its checks into the sandbox capability probe later is mechanical. Every process runs
// through an injected EngineExec, so the shared fake (local-engine-fake.ts) scripts results and records calls.

export interface EngineRunResult {
  code: number | null; // null = the CLI could not be spawned, or it timed out
  stdout: string;
  stderr: string;
}

export interface EngineRunOptions {
  timeoutMs: number;
}

// The process seam. `env` is added to this process's environment. Never throws: a spawn failure or a timeout is code null.
export interface EngineExec {
  run(file: string, args: readonly string[], opts: EngineRunOptions & { env?: Readonly<Record<string, string>> }): Promise<EngineRunResult>;
  runSync(file: string, args: readonly string[], opts: EngineRunOptions & { env?: Readonly<Record<string, string>> }): EngineRunResult;
}

// The CLI half of a LocalEngine: what a caller needs to run the engine's own commands. Onboarding adapts its probe runner to it.
export interface EngineCli {
  readonly binary: string;
  run(args: readonly string[], opts: EngineRunOptions): Promise<EngineRunResult>;
}

export interface LocalEngine extends EngineCli {
  readonly id: EngineId;
  readonly profile: EngineProfile;
  // The product name for prose ("Docker", "Podman"); commands always use `binary`.
  readonly displayName: string;
  // undefined = no socket was located or the engine did not answer at boot: the CLI then uses its own default, as before detection.
  readonly socket: ResolvedSocket | undefined;
  // Operator-visible notes from construction (the engine did not answer, `auto` saw a second engine or skipped a refused one).
  readonly findings: readonly string[];
  runSync(args: readonly string[], opts: EngineRunOptions): EngineRunResult;
  // Like run, but resolves stdout on exit 0 and rejects with the CLI's own stderr otherwise.
  output(args: readonly string[], opts: EngineRunOptions): Promise<string>;
  // The engine's printed image id as `sha256:<hex>` (Podman prints bare hex), or undefined when the text is not an image id.
  normalizeImageId(raw: string): string | undefined;
  // One label of a local image, read synchronously; undefined when the image is absent, unlabelled or the engine is unreachable.
  imageLabel(image: string, label: string): string | undefined;
  // The DockerSandbox options that select this engine.
  sandboxDeps(): { profile: EngineProfile; socket?: string };
}

const DISPLAY_NAME: Record<EngineId, string> = { docker: "Docker", podman: "Podman" };

export function engineDisplayName(profile: EngineProfile): string {
  return DISPLAY_NAME[profile.id];
}

// `<binary> network inspect <default network> -f <gateway>` (pomtreed's agent-net.ts runs and parses it): Docker's default network is `bridge` with the gateway under IPAM; Podman's
// is `podman` with it under Subnets. Run against rootless Podman 5.7.0 (pasta): the read prints the network definition's gateway, but a pasta
// container does not use it, so it is no host-side address (engine-samples/podman.json).
export function gatewayInspectArgs(profile: EngineProfile): string[] {
  return profile.id === "podman"
    ? ["network", "inspect", "podman", "-f", "{{(index .Subnets 0).Gateway}}"]
    : ["network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}"];
}

// The argv that prints the engine's server version, so it fails when the daemon or service does not answer. Podman's info has no
// ServerVersion; its version is .Version.Version (run against rootless Podman 5.7.0, which prints `5.7.0`).
export function engineInfoArgs(profile: EngineProfile): string[] {
  return ["info", "--format", profile.id === "podman" ? "{{.Version.Version}}" : "{{.ServerVersion}}"];
}

// The inspect format that prints one image label (`<no value>` when absent).
export function imageLabelArgs(image: string, label: string): string[] {
  return ["image", "inspect", "--format", `{{ index .Config.Labels "${label}" }}`, image];
}

// `--add-host <alias>:host-gateway` for an engine that needs it; Podman adds the alias itself (args.ts hostGatewayArgs, same rule).
export function hostGatewayArgs(profile: EngineProfile): string[] {
  return profile.id === "podman" ? [] : ["--add-host", `${profile.hostAlias}:host-gateway`];
}

const execResult = (err: Error | null, stdout: string, stderr: string): EngineRunResult => {
  if (!err) return { code: 0, stdout, stderr };
  const code = (err as { code?: unknown }).code;
  return { code: typeof code === "number" ? code : null, stdout, stderr: stderr || err.message };
};

export const realEngineExec: EngineExec = {
  run: (file, args, opts) =>
    new Promise((resolve) => {
      try {
        execFile(
          file,
          [...args],
          { timeout: opts.timeoutMs, encoding: "utf8", ...(opts.env && { env: { ...process.env, ...opts.env } }) },
          (err, stdout, stderr) => resolve(execResult(err, stdout, stderr)),
        );
      } catch (e) {
        resolve({ code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
      }
    }),
  runSync: (file, args, opts) => {
    try {
      const stdout = execFileSync(file, [...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: opts.timeoutMs,
        ...(opts.env && { env: { ...process.env, ...opts.env } }),
      });
      return { code: 0, stdout, stderr: "" };
    } catch (e) {
      const err = e as { status?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
      return {
        code: typeof err.status === "number" ? err.status : null,
        stdout: typeof err.stdout === "string" ? err.stdout : "",
        stderr: (typeof err.stderr === "string" && err.stderr) || err.message || String(e),
      };
    }
  },
};

const LABEL_TIMEOUT_MS = 2000;

export interface LocalEngineParts {
  profile: EngineProfile;
  socket?: ResolvedSocket | undefined;
  findings?: readonly string[];
  exec?: EngineExec;
}

// Assembles the object from already-resolved parts. openLocalEngine is the composition root's constructor; this is also what the
// fake builds on, so the fake and the real object share every method body.
export function localEngineFrom(parts: LocalEngineParts): LocalEngine {
  const { profile } = parts;
  const exec = parts.exec ?? realEngineExec;
  const socket = parts.socket;
  const env = socket ? cliSocketEnv(profile, socket.path) : undefined;
  const withEnv = (opts: EngineRunOptions) => ({ ...opts, ...(env && { env }) });
  const engine: LocalEngine = {
    id: profile.id,
    profile,
    binary: profile.binary,
    displayName: engineDisplayName(profile),
    socket,
    findings: parts.findings ?? [],
    run: (args, opts) => exec.run(profile.binary, args, withEnv(opts)),
    runSync: (args, opts) => exec.runSync(profile.binary, args, withEnv(opts)),
    output: async (args, opts) => {
      const r = await engine.run(args, opts);
      if (r.code === 0) return r.stdout;
      throw new Error(`${profile.binary} ${args[0] ?? ""} ${r.code === null ? "did not run or timed out" : `exited ${r.code}`}: ${r.stderr.trim()}`);
    },
    normalizeImageId: (raw) => normalizeImageId(profile, raw),
    imageLabel: (image, label) => {
      const r = engine.runSync(imageLabelArgs(image, label), { timeoutMs: LABEL_TIMEOUT_MS });
      const v = r.code === 0 ? r.stdout.trim() : "";
      return v === "" || v === "<no value>" ? undefined : v;
    },
    sandboxDeps: () => ({ profile, ...(socket && { socket: socket.path }) }),
  };
  return engine;
}

export interface OpenLocalEngineInput {
  // The configured backend: an engine id or `auto` (pomtreed resolves it from sandbox.backend). Default docker.
  selection?: EngineSelection;
  env: Readonly<Record<string, string | undefined>>;
  // Configured socket per engine id (sandbox.docker.socket, sandbox.podman.socket).
  configured?: Partial<Record<EngineId, string | undefined>>;
  probes?: EngineProbes;
  exec?: EngineExec;
}

// Builds the LocalEngine from the detector and the configuration, the one place this happens. An explicit engine that is not running
// (no socket, or no answer) is not fatal: the daemon has always booted with its engine down (readyz.allowSandboxDown), so the engine
// is returned without a socket and the cause is a finding. Everything else the detector refuses (an engine that answers as another
// id, a remote or malformed socket setting, an unidentifiable engine, `auto` finding nothing) throws: those are configuration errors
// the operator must fix. Findings `auto` collected (a skipped refusal, a second engine) are carried, never dropped (decision 17).
export async function openLocalEngine(input: OpenLocalEngineInput): Promise<LocalEngine> {
  const selection = input.selection ?? DOCKER_PROFILE.id;
  const exec = input.exec ?? realEngineExec;
  try {
    const found = await detectLocalEngine({
      selection,
      env: input.env,
      probes: input.probes ?? realEngineProbes,
      ...(input.configured && { configured: input.configured }),
    });
    return localEngineFrom({ profile: found.profile, socket: found.socket, findings: found.findings, exec });
  } catch (err) {
    if (selection === "auto" || !(err instanceof EngineUnreachableError || err instanceof SocketNotFoundError)) throw err;
    const profile = engineProfile(selection);
    return localEngineFrom({
      profile,
      findings: [`${err.message}; pomtreed starts anyway and sandbox calls fail until the ${profile.id} engine answers`],
      exec,
    });
  }
}

export type LegacyBootCheck = { ok: true } | { refuse: string } | { skipped: string };

// Boot check for containers created before the host and generation labels existed (the adapter stamps both on every
// container it creates, so a pomtree container without them predates the stamp): when any container labelled
// pomtree=1 on the selected engine lacks a required tag, the start is refused with the ids, the missing labels and the exact cleanup
// command for this engine. Nothing is removed: the only engine calls are the sandbox's read-only scan (ps and inspect).
export async function legacyContainerBootCheck(
  engine: Pick<LocalEngine, "id" | "binary">,
  sandbox: { legacyContainerRefusal(): Promise<string | undefined> },
): Promise<LegacyBootCheck> {
  let refusal: string | undefined;
  try {
    refusal = await sandbox.legacyContainerRefusal();
  } catch (err) {
    if (!(err instanceof SandboxUnavailableError)) throw err;
    return {
      skipped: `could not check the ${engine.id} engine for containers without the ${REQUIRED_SANDBOX_TAGS.join(" and ")} labels (${err.message}); the check runs again at the next start`,
    };
  }
  return refusal === undefined ? { ok: true } : { refuse: refusal };
}
