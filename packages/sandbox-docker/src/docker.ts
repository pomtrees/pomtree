import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { loadProxyConfig, markEgressSpoolClosed, prepareEgressSpool, type EgressProxyConfig } from "./audit.ts";
import {
  DOCKER_GROUP_ACTION,
  IMAGE_REBUILD_ACTION,
  SANDBOX_TAGS,
  SandboxStartError,
  SandboxUnavailableError,
  readOwnerStamp,
  sandboxIdForKey,
  type AgentId,
  type ByteStream,
  type HostId,
  type ImageIdentity,
  type LoopbackPort,
  type MountProvider,
  type ResolvedMount,
  type Sandbox,
  type SandboxDeclaration,
  type SandboxHandle,
  type SandboxId,
  type SandboxInfo,
  type SandboxListing,
  type SandboxOwner,
  type SandboxSpec,
  type TerminalSession,
} from "@pomtree/core";
import {
  AGENT_LABEL,
  buildEgressProxyArgs,
  egressSocketVolumeOptions,
  buildRunArgs,
  describeRunHardening,
  EGRESS_LABEL,
  ID_LABEL,
  LABEL,
  runEnv,
  stopTimeoutSeconds,
  userLabelArgs,
} from "./args.ts";
import { LOOPBACK_BRIDGE_MAIN, LOOPBACK_PORTS, NODE_BIN } from "./container-contract.gen.ts";
import { openExecStream } from "./exec-stream.ts";
import { buildAttachRequest, buildResizeRequest, createTerminalSession, engineCall, engineSocketPath, realEngineApi, type EngineApi } from "./terminal.ts";
import { cliSocketEnv, DOCKER_PROFILE, type EngineProfile } from "./engine-profile.ts";
import { findLegacyContainers, isEngineError, legacyContainerRefusal, normalizeImageId } from "./engine-dialect.ts";
import { collectResultWork } from "./result-work.ts";
import {
  defaultDenyEgress,
  egressAllowCsv,
  egressAttribution,
  type EgressOwner,
  egressOwnedBy,
  EGRESS_SOCKET_PATH,
  egressSocketVolumeName,
  egressProxyName,
  OWNER_EPOCH_LABEL,
  OWNER_STORE_LABEL,
} from "./egress.ts";
import { EGRESS_NETWORK, ensureEgressNetwork } from "./network.ts";

export type Exec = (args: string[], env?: Record<string, string>) => Promise<string>;
// `env` carries the variables that point the CLI at the resolved engine socket; absent for an engine run on the CLI's own defaults.
export type SpawnFn = (cmd: string, args: string[], env?: Record<string, string>) => ChildProcessWithoutNullStreams;
// The slice of node:child_process execFile the adapter uses; injectable so tests can record which binary each call runs.
export type ExecFileFn = (
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv },
  callback: (err: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export interface DockerDeps {
  // Resolves spec.mounts to host realizations; host paths never leave this adapter.
  mounts: MountProvider;
  exec?: Exec;
  spawn?: SpawnFn;
  // Test seam: the process launcher behind the default exec. Ignored when `exec` is given.
  execFile?: ExecFileFn;
  // The capability declaration this adapter reports. Default: Docker's (DOCKER_DECLARATION); provider.ts passes Podman's for the podman engine.
  declaration?: SandboxDeclaration;
  // The container engine this adapter runs against: its CLI binary, host alias and error dialect. Default: the Docker profile.
  profile?: EngineProfile;
  // The engine's resolved unix socket path (engine-detect.ts). It is used for terminals and handed to the CLI through the profile's
  // socket variable, so the CLI and the HTTP API reach one engine. Unset: the CLI uses its own default, and terminals use DOCKER_HOST
  // (docker profile only; any other profile must pass it).
  socket?: string;
  // Operator opt-in for SELinux relabeling of read-only shared bind mounts (Podman on a Linux SELinux host). Refused for other engines.
  selinuxRelabel?: boolean;
  // Max buffered output bytes per output() stream; oldest chunks are dropped past this, with a visible marker.
  maxOutputBytes?: number;
  // Container pid limit (docker --pids-limit). Default 512.
  pidsLimit?: number;
  // Cap on the in-memory delivered-exit cache (per sandbox id); oldest entries are evicted past it.
  maxExitedCache?: number;
  // Deprecated compatibility field. Egress is always enforced; it is deliberately not an
  // opt-out because a missing proxy would otherwise silently grant unrestricted network access.
  enforceEgress?: boolean;
  // Rebuilt agent image containing /opt/pomtree/egress/proxy.ts, digest-pinned: `name[:tag]@sha256:<64 hex>` or a local
  // image id `sha256:<64 hex>`: field 2 (the engine-local id) of the build line `<tag> <engineLocalId> <configDigest> [mediaType]`
  // that agent-image's build.ts prints, not the config digest in field 3. Checked against the local image before the first sidecar
  // start; never pulled by the adapter. Defaults to spec.image (with a warning; see TODO(egress-image)).
  egressProxyImage?: string;
  // Byte cap for relayed daemon/model-proxy connections, written into the sidecar's config as limits.relayMaxBytes.
  // pomtreed passes cfg["push.maxBytes"]. Unset: the proxy's own default applies.
  egressRelayMaxBytes?: number;
  // Visible daemon-owned directory, never worker-mounted. Required for audited-public; any other egress mode with attribution gets an audit spool when it is set.
  egressAuditRoot?: string;
  // Daemon-host addresses the egress proxy must never dial unless an exact relay grants them. Default: this host's interfaces.
  hostAddresses?: () => string[];
  // Bound on the `docker run` (which includes any image pull). Past it the start fails with a
  // retryable pull_failed SandboxStartError. Default 5 min; 0 disables.
  startTimeoutMs?: number;
  // Retries for a retryable pull_failed start failure (bounded). Default 2.
  startRetries?: number;
  // Delay between start retries (ms), injectable for tests. Default 1000 * attempt.
  retryDelayMs?: (attempt: number) => number;
  // Engine API transport for terminals (unix socket from DOCKER_HOST). Built lazily; injectable for tests.
  engine?: EngineApi;
  // Name of the shared ICC-off egress sidecar network (network.ts). Default EGRESS_NETWORK; tests use a pomtree-test- name.
  egressNetwork?: string;
  // Operator-facing warnings for failures that do not fail the call (an egress sidecar or socket volume left behind). Default console.warn.
  warn?: (message: string) => void;
}

// Maps a CLI failure to SandboxUnavailableError when the engine is unreachable, and returns the original error otherwise. These are
// the only failures the daemon treats as retryable "sandbox unavailable"; every other failure stays a generic Error. What counts as
// unreachable is the profile's data (engine-profile.ts, read through engine-dialect.ts): a bare "no such file or directory" is not
// enough, since a container-side missing path says the same; the socket dial context is required.
export function classifyDockerError(cause: Error, profile: EngineProfile = DOCKER_PROFILE): Error {
  return isEngineError(profile, "daemonUnreachable", cause.message) ? new SandboxUnavailableError() : cause;
}

const defaultExecFile: ExecFileFn = (file, args, options, callback) => execFile(file, args, options, (err, stdout, stderr) => callback(err, stdout, stderr));

// The real CLI call for a profile. `docker logs` replays the container's stderr on this process's stderr, so a successful logs call
// returns both streams.
export function makeExec(profile: EngineProfile = DOCKER_PROFILE, run: ExecFileFn = defaultExecFile): Exec {
  return (args, env) =>
    new Promise((resolve, reject) => {
      run(profile.binary, args, env ? { env: { ...process.env, ...env } } : {}, (err, stdout, stderr) =>
        err
          ? reject(classifyDockerError(new Error(`${profile.binary} ${args[0]} failed: ${stderr || err.message}`), profile))
          : resolve((args[0] === "logs" ? `${stdout}${stderr}` : stdout).trim()),
      );
    });
}

const defaultSpawn: SpawnFn = (cmd, args, env) => spawn(cmd, args, env ? { env: { ...process.env, ...env } } : {});

// Every address on the daemon host's interfaces (scope ids stripped, deduplicated); evaluated per start, never stored.
export function hostAddressList(ifaces: NodeJS.Dict<Pick<NetworkInterfaceInfo, "address">[]> = networkInterfaces()): string[] {
  return [...new Set(Object.values(ifaces).flatMap((entries) => (entries ?? []).map((e) => e.address.replace(/%.*$/, ""))))];
}

// The digest an egressProxyImage reference pins (`sha256:<hex>`), or undefined when it is not digest-pinned. A bare
// `sha256:<hex>` is a local image id (verified against .Id); `name[:tag]@sha256:<hex>` is verified against .RepoDigests.
export function pinnedImageDigest(ref: string, profile: EngineProfile = DOCKER_PROFILE): { digest: string; imageId: boolean } | undefined {
  if (/^sha256:[0-9a-f]{64}$/.test(ref)) return { digest: ref, imageId: true };
  // Podman prints and resolves a local image id as bare hex: that form is kept as the reference, and only compared as sha256:<hex>.
  if (profile.id === "podman" && /^[0-9a-f]{64}$/.test(ref)) return { digest: `sha256:${ref}`, imageId: true };
  const at = ref.lastIndexOf("@");
  return at > 0 && /^[^@\s]+$/.test(ref.slice(0, at)) && /^sha256:[0-9a-f]{64}$/.test(ref.slice(at + 1))
    ? { digest: ref.slice(at + 1), imageId: false }
    : undefined;
}

const name = (id: SandboxId) => `pomtree-${id}`;
const errmsg = (e: unknown) => String(e instanceof Error ? e.message : e);
const gone = (e: unknown, profile: EngineProfile = DOCKER_PROFILE) => isEngineError(profile, "containerGone", errmsg(e));
// The engine's rejection of `rm` while another remover already holds the container (Docker: "removal of container X is already in progress").
// Deliberately separate from gone(): readState and wait must not read an in-progress removal as an absent container.
export const removalRace = (e: unknown, profile: EngineProfile = DOCKER_PROFILE) => isEngineError(profile, "removalRace", errmsg(e));

// Default output() buffer budget (bytes).
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// Default cap on the delivered-exit cache.
const DEFAULT_MAX_EXITED_CACHE = 1024;

// The Podman counterpart of DOCKER_GROUP_ACTION: its rootless socket is the user's own, so the fix is the socket, not a group.
const PODMAN_SOCKET_ACTION =
  "the Podman socket is not open to this user: on Linux run `systemctl --user start podman.socket`, on macOS run `podman machine start`, and run pomtreed as the user that owns the socket";

const MOUNT_RACE_RETRIES = 2;
const MOUNT_RACE_DELAY_MS = 250;

// Maps a `start` failure to the typed SandboxStartError the contract promises. A
// SandboxUnavailableError reaching here is the daemon-unreachable signal produced by
// classifyDockerError (the real docker exec path), which becomes endpoint_unreachable; otherwise
// the message is classified as a bad image ref, a transient pull/network failure, or unknown.
export function classifyStartError(cause: unknown, profile: EngineProfile = DOCKER_PROFILE): SandboxStartError {
  if (cause instanceof SandboxUnavailableError) {
    return new SandboxStartError("endpoint_unreachable", cause.message, true);
  }
  const message = errmsg(cause);
  if (isEngineError(profile, "socketPermission", message))
    return new SandboxStartError(
      "endpoint_unreachable",
      `${profile.binary} socket permission denied: ${message}; ${profile.id === "podman" ? PODMAN_SOCKET_ACTION : DOCKER_GROUP_ACTION}`,
      false,
    );
  if (isEngineError(profile, "imageUnavailable", message)) return new SandboxStartError("image_unavailable", message, false);
  if (isEngineError(profile, "pullFailed", message)) return new SandboxStartError("pull_failed", message, true);
  return new SandboxStartError("unknown", message, false);
}

// A failure standing up the egress proxy/socket volume. Docker being down, or the proxy image missing or failing to pull, keeps its
// own kind (the operator's fix is the same as for the worker image); any other failure there is `egress_start_failed`, not
// `unknown`, so the daemon can say the network sidecar (not the agent image) is what failed. Not retryable unless the caller
// built a typed error that says so (a sidecar still running when its readiness probe failed): it fails closed.
export function egressStartError(cause: unknown, profile: EngineProfile = DOCKER_PROFILE): SandboxStartError {
  const typed = cause instanceof SandboxStartError ? cause : classifyStartError(cause, profile);
  if (typed.kind !== "unknown") return typed;
  return new SandboxStartError("egress_start_failed", `egress proxy start failed: ${typed.message}`, false);
}

const EGRESS_MESSAGE_BUDGET = 900; // the daemon clips start-failure messages at 1000
const EGRESS_FIELD_MAX = 200; // per variable field (probe error, docker's State.Error, the last log line), so the action always fits
const clipField = (s: string): string => (s.length > EGRESS_FIELD_MAX ? `${s.slice(0, EGRESS_FIELD_MAX - 1)}…` : s);

// The typed error for an egress sidecar whose readiness probe failed, from `docker inspect -f '{{json .State}}'` and the
// tail of `docker logs`. Pure. A sidecar that exited (usually a proxy that refused its config: image older than pomtreed) is
// terminal; one still running lost a race and a retry may succeed. A sidecar left in `created` never started, and inspect
// output that is not a State object says so; both fail closed with their own wording.
export function egressProbeFailure(stateJson: string, logs: string, probeError: string): SandboxStartError {
  const probe = clipField(probeError);
  let state: { Status?: unknown; Running?: unknown; ExitCode?: unknown; OOMKilled?: unknown; Error?: unknown } | undefined;
  try {
    const parsed: unknown = JSON.parse(stateJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed;
  } catch {
    state = undefined;
  }
  if (!state)
    return new SandboxStartError(
      "egress_start_failed",
      `egress proxy readiness probe failed (${probe}) and \`docker inspect\` returned an unreadable state (${clipField(stateJson.trim()) || "empty"}); check \`docker version\` and \`docker events\` for the proxy container, then respawn the agent`,
      false,
    );
  const dockerError = state.Error ? `, docker: ${clipField(String(state.Error))}` : "";
  if (state.Running === true && state.Status !== "exited" && state.Status !== "dead")
    return new SandboxStartError(
      "egress_start_failed",
      `egress proxy readiness probe failed while the proxy was still running (${probe}); respawn the agent (the proxy may have lost a startup race), and if it recurs ${IMAGE_REBUILD_ACTION}`,
      true,
    );
  if (state.Status === "created")
    return new SandboxStartError(
      "egress_start_failed",
      `egress proxy container was created but never started (${probe}${dockerError}); check \`docker events\` for the proxy container and the Docker daemon log for why the start did not happen, then respawn the agent`,
      false,
    );
  const lines = logs
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-5);
  const oom = state.OOMKilled === true;
  const head = `egress proxy exited during startup (exit code ${String(state.ExitCode)}${oom ? ", OOM-killed" : ""}${dockerError})`;
  const action = oom ? "give the host more memory, then restart pomtreed" : IMAGE_REBUILD_ACTION;
  const tail = lines.length ? ` (log tail: ${lines.join(" | ")})` : " (no log output)";
  const last = lines.length ? `: ${clipField(lines.at(-1) ?? "")}` : "";
  const fixed = `${head}${last}; ${action}`;
  const room = Math.max(0, EGRESS_MESSAGE_BUDGET - fixed.length);
  const clipped = tail.length > room ? `${tail.slice(0, Math.max(0, room - 2))}…)` : tail;
  return new SandboxStartError("egress_start_failed", `${fixed}${room > 20 ? clipped : ""}`, false);
}

// Lifecycle semantics: a container that exits on its own stays (logs and inspect keep working) until
// kill() reaps it. stop() and kill() both wait for the exit, remember its code, and then remove the
// container, so list() never shows stopped zombies and a concurrent wait() still resolves with the code
// (the in-process `exited` cache is only a delivered-value cache; durable truth is the container label set).
// realpath of the deepest existing ancestor plus the not-yet-created remainder (the audit root does not exist before its first spool).
function realpathLoose(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  return join(realpathSync(current), ...missing);
}

// What Docker does today, restricted to what the adapter implements through the facet
// shape. `docker commit` is not a sandbox snapshot, so snapshot.* and fork are false; pause, connect and files exist as Docker verbs
// but have no facet here yet. loopback is true: the loopback facet runs the baked bridge over the streaming exec. egress.allowHost is true although the engine alone only offers network none: the adapter enforces the
// host:port allowlist with its egress sidecar and throws when it cannot (start). image.digestAttest is true because imageIdentity
// always reports the engine-local image id (the OCI config digest too on the classic store, null on the containerd store).
export const DOCKER_DECLARATION: SandboxDeclaration = {
  backend: "docker",
  capabilities: {
    terminal: true,
    connect: false,
    loopback: true,
    "files.put": false,
    "files.get": false,
    "files.volume": false,
    "mounts.host": true,
    "image.ociPull": true,
    "image.template": false,
    "image.digestAttest": true,
    "snapshot.disk": false,
    "snapshot.memory": false,
    fork: false,
    pause: false,
    "list.byTag": true,
    "egress.denyAll": true,
    "egress.allowHost": true,
    "egress.allowCidr": false,
    "reach.outbound": true,
    "reach.exposedPort": false,
    "reach.hostAlias": true,
    "secrets.env": true,
    "secrets.proxySwap": false,
    "resources.limits": true,
    "isolation.gvisor": true,
    "isolation.microvm": false,
    "lease.extend": false,
  },
  region: null,
  idempotency: "unique-name",
  idempotencyWindowMs: null,
  tagging: "metadata",
  output: "stream",
  maxLifetimeMs: null,
  preemptible: false,
  billing: { unit: "none", whileStopped: false, whilePaused: false },
  local: { seccompProfile: true, sysctlIpv6Disable: true },
};

// Docker's container status mapped to the port's listing state.
function listingState(status: string): SandboxListing["state"] {
  switch (status) {
    case "created":
      return "creating";
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "exited":
    case "dead":
      return "exited";
    case "removing":
      return "stopped";
    default:
      return "unknown";
  }
}

// The classic image store (graph drivers) reports the OCI config digest as the image id; the containerd image store reports the
// manifest or index digest instead.
const CONTAINERD_STORE = /io\.containerd\.snapshotter/;

const egressOwner = (o: SandboxOwner): EgressOwner => ({ storeId: o.storeId, epoch: String(o.epoch) });

export class DockerSandbox implements Sandbox {
  readonly declaration: SandboxDeclaration;
  resultWork(id: SandboxId, opts?: { save?: boolean; expectedFingerprint?: string; maxBytes?: number }) {
    return collectResultWork(this.spawnFn, name(id), opts, this.profile.binary);
  }
  private readonly exec: Exec;
  private readonly spawnFn: SpawnFn;
  private readonly profile: EngineProfile;
  private readonly socket: string | undefined;
  private readonly selinuxRelabel: boolean;
  private readonly maxOutputBytes: number;
  private readonly pidsLimit: number | undefined;
  private readonly mounts: MountProvider;
  private readonly maxExitedCache: number;
  private readonly egressProxyImage: string | undefined;
  private readonly egressRelayMaxBytes: number | undefined;
  private runtimes: string[] | undefined;
  private egressImageVerified = false;
  private egressFallbackWarned = false;
  private readonly egressAuditRoot: string | undefined;
  private readonly egressNetwork: string;
  private readonly warn: (message: string) => void;
  // Sandbox ids whose start() is running in this instance: the orphan sweep leaves their egress resources (a sidecar exists
  // before its worker does). A transient guard only; ownership itself is the durable label set.
  // Counted, so an idempotent retry of the same key finishing first does not clear a start still running.
  private readonly starting = new Map<SandboxId, number>();
  private readonly hostAddresses: () => string[];
  private readonly startTimeoutMs: number;
  private readonly startRetries: number;
  private readonly retryDelayMs: (attempt: number) => number;
  private engineApi: EngineApi | undefined;
  private readonly exited = new Map<SandboxId, { exitCode: number; oomKilled: boolean }>();

  constructor(deps: DockerDeps) {
    this.declaration = deps.declaration ?? DOCKER_DECLARATION;
    this.profile = deps.profile ?? DOCKER_PROFILE;
    this.socket = deps.socket;
    this.selinuxRelabel = deps.selinuxRelabel === true;
    if (this.selinuxRelabel && this.profile.id !== "podman")
      throw new Error(`selinuxRelabel is a Podman mount option and the ${this.profile.id} engine rejects it; drop selinuxRelabel or select the podman engine`);
    // The resolved socket reaches every CLI call (exec and spawn), so the CLI and the HTTP API talk to one engine.
    const cliEnv = this.socket === undefined ? undefined : cliSocketEnv(this.profile, this.socket);
    const rawExec = deps.exec ?? makeExec(this.profile, deps.execFile);
    const rawSpawn = deps.spawn ?? defaultSpawn;
    this.exec = cliEnv ? (args, env) => rawExec(args, { ...cliEnv, ...env }) : rawExec;
    this.spawnFn = cliEnv ? (cmd, args, env) => rawSpawn(cmd, args, { ...cliEnv, ...env }) : rawSpawn;
    this.maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.mounts = deps.mounts;
    this.pidsLimit = deps.pidsLimit; // unset: the runtime shape's limit applies
    this.maxExitedCache = deps.maxExitedCache ?? DEFAULT_MAX_EXITED_CACHE;
    if (deps.egressProxyImage !== undefined && !pinnedImageDigest(deps.egressProxyImage, this.profile))
      throw new Error(
        `egressProxyImage ${JSON.stringify(deps.egressProxyImage)} is not digest-pinned: set it to name[:tag]@sha256:<64 hex> or a local image id ${this.profile.id === "podman" ? "(<64 hex> or sha256:<64 hex>)" : "sha256:<64 hex>"}`,
      );
    if (deps.egressRelayMaxBytes !== undefined && !(Number.isSafeInteger(deps.egressRelayMaxBytes) && deps.egressRelayMaxBytes > 0))
      throw new Error(`egressRelayMaxBytes ${JSON.stringify(deps.egressRelayMaxBytes)} must be a positive integer byte count`);
    this.egressProxyImage = deps.egressProxyImage;
    this.egressRelayMaxBytes = deps.egressRelayMaxBytes;
    this.egressAuditRoot = deps.egressAuditRoot;
    this.egressNetwork = deps.egressNetwork ?? EGRESS_NETWORK;
    this.warn = deps.warn ?? ((message) => console.warn(message));
    this.hostAddresses = deps.hostAddresses ?? hostAddressList;
    this.startTimeoutMs = deps.startTimeoutMs ?? 300_000;
    this.startRetries = deps.startRetries ?? 2;
    this.retryDelayMs = deps.retryDelayMs ?? ((n) => 1000 * n);
    this.engineApi = deps.engine;
  }

  async start(spec: SandboxSpec, idempotencyKey: string): Promise<SandboxHandle> {
    const id = sandboxIdForKey(idempotencyKey);
    let egressStarted = false;
    this.starting.set(id, (this.starting.get(id) ?? 0) + 1);
    try {
      // Idempotent by key: if the container already exists (running or exited-but-unreaped),
      // re-adopt it rather than starting a second one under the same name.
      const existing = await this.readState(id);
      if (existing) {
        if (existing.networkMode !== "none") throw new Error("cannot re-adopt sandbox without network-none transport; stop/reap it explicitly");
        const attribution = egressAttribution(spec);
        if (spec.egress?.auditedPublic && !this.egressAuditRoot) throw new Error("audited-public requires egressAuditRoot");
        if (attribution && this.egressAuditRoot) {
          const configPath = join(this.egressAuditRoot, id, "config", "config.json");
          if (!existsSync(configPath))
            throw new Error(
              `egress audit spool missing for re-adopted sandbox ${id}; it started unaudited, so stop and reap it (pomtree kill) and start it again`,
            );
          const config = loadProxyConfig(configPath);
          const expected = { sandbox: id, agent: spec.agent, host: attribution.host, generation: attribution.generation };
          if (
            !config.identity ||
            Object.entries(expected).some(([key, value]) => config.identity![key as keyof typeof expected] !== value) ||
            (config.auditedPublic === true) !== Boolean(spec.egress?.auditedPublic)
          )
            throw new Error("immutable egress config attribution mismatch on re-adoption");
        }
        return { id, output: () => this.output(id), wait: () => this.wait(id) };
      }
      const restricted = defaultDenyEgress(spec);
      // Before any container (sidecar included) exists: a missing runtime must not leave half a sandbox.
      await this.assertRuntime(describeRunHardening(restricted, {}, this.profile).ociRuntime);
      const mounts = await this.resolveMounts(restricted);
      // Checked before startEgress so a rejected start leaves no spool counting against the retention cap.
      if (egressAttribution(restricted) && this.egressAuditRoot) {
        const audit = realpathLoose(this.egressAuditRoot);
        for (const mount of mounts) {
          if (mount.type === "tmpfs") continue;
          const source = realpathSync(mount.hostPath);
          if (source === audit || audit.startsWith(source.endsWith(sep) ? source : `${source}${sep}`) || source.startsWith(`${audit}${sep}`))
            throw new Error("worker mount overlaps private egress audit root");
        }
      }
      await this.startEgress(id, restricted).catch((e: unknown) => {
        throw egressStartError(e, this.profile);
      });
      egressStarted = true;
      await this.runWithRetry(id, restricted, mounts);
      // docker run has no initial-size flag on Linux (--console-size is Windows-only), so size the pty
      // right after start. Best effort: a failure leaves the default 80x24, which openTerminal's size corrects.
      if (spec.tty) await engineCall(this.engine(), buildResizeRequest(name(id), spec.tty.cols, spec.tty.rows)).catch(() => {});
      return { id, output: () => this.output(id), wait: () => this.wait(id) };
    } catch (e) {
      // A sandbox `docker run` failure after a successful startEgress would otherwise leak the
      // proxy/network; reclaim them best-effort before surfacing the typed start error.
      if (egressStarted) await this.cleanupEgress(id).catch(() => {});
      throw e instanceof SandboxStartError ? e : classifyStartError(e, this.profile);
    } finally {
      const n = (this.starting.get(id) ?? 1) - 1;
      if (n > 0) this.starting.set(id, n);
      else this.starting.delete(id);
    }
  }

  // The runtimes Docker reports. Only a list that includes the requested runtime is cached per instance, so an operator who
  // installs gVisor after reading the error is not refused until restart. A failed, garbled or timed-out `docker info` is an error.
  private async assertRuntime(runtime: "runsc" | undefined): Promise<void> {
    if (!runtime || this.runtimes?.includes(runtime)) return;
    let timer: NodeJS.Timeout | undefined;
    const info = this.exec(["info", "--format", "{{json .Runtimes}}"]);
    info.catch(() => {});
    const out = await Promise.race([
      info,
      new Promise<never>((_, rej) => {
        if (this.startTimeoutMs)
          timer = setTimeout(
            () =>
              rej(
                new Error(
                  `docker info timed out after ${this.startTimeoutMs}ms while checking ociRuntime ${JSON.stringify(runtime)}; check that the Docker daemon is responsive`,
                ),
              ),
            this.startTimeoutMs,
          );
      }),
    ]).finally(() => clearTimeout(timer));
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error(
        `docker info did not report a runtimes object (got ${JSON.stringify(out.slice(0, 80))}); check that the Docker daemon is reachable and supports \`docker info --format\``,
      );
    const known = Object.keys(parsed);
    if (!known.includes(runtime))
      throw new Error(
        `docker runtime ociRuntime ${JSON.stringify(runtime)} is not available: docker info reports runtimes [${known.join(", ")}]; install gVisor and register it as "${runtime}" in the Docker daemon config (https://gvisor.dev/docs/user_guide/install/), or remove runtime.ociRuntime from the template`,
      );
    this.runtimes = known;
  }

  // Resolves every spec mount; a failure names the mount kind and container path, never a host path
  // (the provider's own message is dropped: it may carry one).
  private resolveMounts(spec: SandboxSpec): Promise<ResolvedMount[]> {
    return Promise.all(
      spec.mounts.map((m) =>
        this.mounts.resolve(spec.agent, m).catch(() => {
          throw new Error(`${m.kind} mount at ${m.containerPath} could not be resolved`);
        }),
      ),
    );
  }

  // `docker run` with a start timeout (the pull happens inside it) and bounded retry of retryable
  // pull failures. A timed-out or failed attempt's half-created container is removed first.
  private async runWithRetry(id: SandboxId, spec: SandboxSpec, mounts: ResolvedMount[]): Promise<void> {
    let mountRetries = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.withTimeout(
          this.exec(
            buildRunArgs(id, spec, { pidsLimit: this.pidsLimit, mounts, ...(this.selinuxRelabel ? { selinuxRelabel: true } : {}) }, this.profile),
            runEnv(spec),
          ),
          id,
        );
        return;
      } catch (e) {
        // TODO(sandbox-mount-race): Docker Desktop transiently reports `bind source path does not exist`
        // for a workspace dir created moments earlier (clone+rename); root cause unproven. Current
        // behavior: retry up to MOUNT_RACE_RETRIES times, MOUNT_RACE_DELAY_MS apart, then fail as before.
        if (isEngineError(this.profile, "mountRace", errmsg(e)) && mountRetries < MOUNT_RACE_RETRIES) {
          mountRetries++;
          await this.exec(["rm", "-f", name(id)]).catch(() => {});
          await new Promise((r) => setTimeout(r, MOUNT_RACE_DELAY_MS));
          attempt--;
          continue;
        }
        const typed = classifyStartError(e, this.profile);
        if (typed.kind !== "pull_failed" || attempt > this.startRetries) throw typed;
        await this.exec(["rm", "-f", name(id)]).catch(() => {});
        await new Promise((r) => setTimeout(r, this.retryDelayMs(attempt)));
      }
    }
  }

  private withTimeout<T>(p: Promise<T>, id: SandboxId): Promise<T> {
    if (!this.startTimeoutMs) return p;
    let timer: NodeJS.Timeout;
    const t = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`docker run timed out after ${this.startTimeoutMs}ms (image pull i/o timeout) for ${id}`)), this.startTimeoutMs);
    });
    p.catch(() => {});
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }

  // Re-adopt an existing live container (by sandbox id) after a daemon restart, so a restarted
  // daemon can finish/drain a checkpoint-less agent. output() tails `docker logs -f` and wait()
  // resolves from the container's exit, both derived from container state on demand.
  async attach(id: SandboxId, agent: AgentId): Promise<SandboxHandle> {
    // `agent` is accepted for contract symmetry; the handle derives identity from the container's
    // labels on demand (list()/inspect read them), so nothing here needs it yet.
    const state = await this.readState(id);
    if (!state || !state.running) throw new SandboxUnavailableError();
    if (state.networkMode !== "none") throw new Error("cannot attach sandbox without network-none transport; stop/reap it explicitly");
    return { id, output: () => this.output(id), wait: () => this.wait(id) };
  }

  private engine(): EngineApi {
    if (this.engineApi) return this.engineApi;
    // The docker profile keeps its DOCKER_HOST/default-socket lookup; another engine has no such default, so its socket must be passed.
    if (this.socket === undefined && this.profile.id !== "docker")
      throw new Error(
        `the ${this.profile.id} engine has no default terminal socket; pass the socket resolved by detectLocalEngine (config key ${this.profile.socketConfigKey})`,
      );
    this.engineApi = realEngineApi(this.socket ?? engineSocketPath());
    return this.engineApi;
  }

  readonly terminal = { open: (id: SandboxId, size?: { cols: number; rows: number }) => this.openTerminal(id, size) };

  private async openTerminal(id: SandboxId, size?: { cols: number; rows: number }): Promise<TerminalSession> {
    const state = await this.readState(id);
    if (!state || !state.running) throw new SandboxUnavailableError();
    const api = this.engine();
    const { socket, head } = await api.upgrade(buildAttachRequest(name(id)));
    const resize = (cols: number, rows: number) => engineCall(api, buildResizeRequest(name(id), cols, rows));
    const session = createTerminalSession(socket, head, resize, size);
    if (size) {
      try {
        await session.resize(size.cols, size.rows);
      } catch (e) {
        session.close();
        throw e;
      }
    }
    return session;
  }

  readonly loopback = { open: (id: SandboxId, port: LoopbackPort) => this.openLoopbackStream(id, port) };

  private async openLoopbackStream(id: SandboxId, port: LoopbackPort): Promise<ByteStream> {
    if (!(LOOPBACK_PORTS as readonly number[]).includes(port))
      throw new RangeError(`loopback port ${port} is not one of ${LOOPBACK_PORTS.join(", ")}; open only a port listed in LOOPBACK_PORTS`);
    const state = await this.readState(id);
    if (!state || !state.running) throw new SandboxUnavailableError();
    return openExecStream(this.engine(), name(id), [NODE_BIN, LOOPBACK_BRIDGE_MAIN, String(port)]);
  }

  // Stand up the per-sandbox socket volume + UDS-only proxy, failing closed: any failure here
  // throws BEFORE the sandbox container is created, and tears down whatever was already created.
  private async startEgress(id: SandboxId, spec: SandboxSpec): Promise<void> {
    const volume = egressSocketVolumeName(id);
    // The numeric uid the sidecar and the socket volume use. Podman's keep-id maps the host user to container uid 1000, so there the
    // container-side uid is 1000 whatever the host uid is (unverified on a real engine until the Podman gated run).
    const uid = this.profile.id === "podman" ? 1000 : process.getuid?.() || 1000;
    const proxy = egressProxyName(id);
    let volumeCreated = false;
    let proxyRan = false;
    const publicPolicy = spec.egress?.auditedPublic;
    const attribution = egressAttribution(spec);
    // Any attributed sandbox with an audit root is audited (spooled, chain-hashed); only the public policy also opens public egress.
    const audited = attribution !== undefined && this.egressAuditRoot !== undefined;
    const config: EgressProxyConfig = {
      allow: egressAllowCsv(spec).split(",").filter(Boolean),
      relay: (spec.egress?.relay ?? []).map((t) => `${t.host}:${t.port ?? 443}`),
      ...(audited ? { identity: { sandbox: id, agent: spec.agent, host: attribution.host, generation: attribution.generation } } : {}),
      ...(publicPolicy ? { auditedPublic: true as const } : {}),
      ...(this.egressRelayMaxBytes !== undefined ? { limits: { relayMaxBytes: this.egressRelayMaxBytes } } : {}),
    };
    if (publicPolicy && !this.egressAuditRoot) throw new Error("audited-public requires egressAuditRoot");
    if (audited && (!process.getuid || process.getuid() === 0))
      throw new Error("egress audit spool requires an unprivileged host daemon uid (no chown or world-writable directories)");
    const image = await this.egressImage(spec);
    // The shared network is validated (ICC off, ours) or created before anything per-sandbox exists; a wrong
    // same-named network fails the start here. It is never removed by this sandbox's cleanup.
    // A sidecar on its own pasta network (rootless Podman) is isolated by construction: no shared network exists to validate.
    if (describeRunHardening(spec, {}, this.profile).sidecarNetwork !== "pasta") await ensureEgressNetwork(this.exec, this.egressNetwork, this.profile);
    const spool = audited ? prepareEgressSpool(this.egressAuditRoot!, id, config) : undefined;
    // A crash between startEgress and the worker run can leave this sandbox's exact-named proxy and socket volume;
    // reclaim them (names derive from the id, no worker exists) so start is idempotent. Audit spools are never touched.
    await this.exec(["rm", "-f", proxy]).catch(() => {});
    await this.exec(["volume", "rm", volume]).catch(() => {});
    try {
      // Named tmpfs volume: only socket state, never audit. No privileged chown/init container.
      await this.exec([
        "volume",
        "create",
        "--driver",
        "local",
        "--opt",
        "type=tmpfs",
        "--opt",
        "device=tmpfs",
        "--opt",
        egressSocketVolumeOptions(this.profile, uid),
        "--label",
        `${ID_LABEL}=${id}`,
        "--label",
        `${EGRESS_LABEL}=1`,
        ...userLabelArgs(spec.labels),
        volume,
      ]);
      volumeCreated = true;
      await this.exec(
        buildEgressProxyArgs(
          id,
          spec,
          {
            uid,
            network: this.egressNetwork,
            hostAddresses: this.hostAddresses(),
            image,
            config,
            ...(spool ? { spool } : {}),
            ...(this.selinuxRelabel ? { selinuxRelabel: true } : {}),
          },
          this.profile,
        ),
      );
      proxyRan = true;
      // Real socket readiness, not a Docker/config label. Failure prevents worker creation.
      await this.exec([
        "exec",
        proxy,
        "node",
        "-e",
        `const net=require('node:net');let tries=0;function check(){const s=net.connect(${JSON.stringify(EGRESS_SOCKET_PATH)},()=>{s.destroy();process.exit(0)});s.once('error',()=>{s.destroy();if(++tries===100)process.exit(1);setTimeout(check,100)})}check()`,
      ]);
    } catch (e) {
      // The sidecar's exit state and logs are read BEFORE it is removed: `rm -f` destroys the only evidence of why it died.
      const diagnosed = proxyRan ? await this.diagnoseEgress(proxy, e) : undefined;
      await this.exec(["rm", "-f", proxy]).catch(() => {});
      if (volumeCreated) await this.exec(["volume", "rm", volume]).catch(() => {});
      if (diagnosed) {
        this.warn(diagnosed.message);
        throw diagnosed;
      }
      if (proxyRan && !(e instanceof SandboxUnavailableError))
        throw new Error(
          `${errmsg(e)}; the proxy container could not be inspected (it is gone): check \`docker events\` for the proxy container; if it recurs, ${IMAGE_REBUILD_ACTION}`,
        );
      throw e;
    }
  }

  // Best effort: a failing inspect or logs never masks the original error (undefined means the sidecar could not be inspected).
  private async diagnoseEgress(proxy: string, cause: unknown): Promise<SandboxStartError | undefined> {
    if (cause instanceof SandboxUnavailableError) return undefined;
    const state = await this.exec(["inspect", "-f", "{{json .State}}", proxy]).catch(() => undefined);
    if (state === undefined) return undefined;
    // Only Status, ExitCode, OOMKilled, Error, StartedAt, FinishedAt are ever read; no mounts or host paths.
    const logs = await this.exec(["logs", "--tail", "20", proxy]).catch(() => "");
    return egressProbeFailure(state, logs, errmsg(cause));
  }

  // The sidecar image. A configured egressProxyImage is verified once per instance against the local image store (never
  // pulled), so the enforcer that runs is the pinned one; a failure throws before anything per-sandbox exists.
  private async egressImage(spec: SandboxSpec): Promise<string> {
    const ref = this.egressProxyImage;
    if (ref === undefined) {
      // TODO(egress-image): with no egressProxyImage the sidecar runs the worker's own spec.image, so a template author picks
      // their own egress enforcer. Current behavior: allowed, with one warning per instance; pomtreed should always pass a pinned image.
      if (!this.egressFallbackWarned) {
        this.egressFallbackWarned = true;
        console.warn("egress proxy sidecar falls back to the worker image (spec.image); set egressProxyImage to a digest-pinned image");
      }
      return spec.image;
    }
    if (this.egressImageVerified) return ref;
    const pin = pinnedImageDigest(ref, this.profile);
    if (!pin) throw new Error(`egressProxyImage ${ref} is not digest-pinned`); // unreachable: the constructor refused it
    let out: string;
    try {
      out = await this.exec(["image", "inspect", "--format", pin.imageId ? "{{.Id}}" : "{{json .RepoDigests}}", ref]);
    } catch (e) {
      if (e instanceof SandboxUnavailableError) throw e;
      throw new Error(
        `egressProxyImage ${ref} is not present on the daemon host (${errmsg(e)}); load that exact image there first, the adapter never fetches it`,
      );
    }
    let found: string[] = [];
    if (pin.imageId) found = [normalizeImageId(this.profile, out) ?? out.trim()];
    else {
      try {
        const parsed: unknown = JSON.parse(out || "null");
        if (Array.isArray(parsed)) found = parsed.filter((d): d is string => typeof d === "string");
      } catch {
        /* unreadable: treated as no repo digests */
      }
    }
    if (!found.some((d) => d === pin.digest || d.endsWith(`@${pin.digest}`)))
      throw new Error(
        `egressProxyImage ${ref} resolves to a local image whose ${pin.imageId ? "id" : "repo digests"} ${JSON.stringify(found)} do not match ${pin.digest}; load the exact digest-pinned image on the daemon host`,
      );
    this.egressImageVerified = true;
    return ref;
  }

  private async cleanupEgress(id: SandboxId): Promise<void> {
    // Names derive from the sandbox id, so a restarted daemon (no in-memory map) still reclaims
    // the proxy and socket volume; both carry the exact sandbox label. Audit is independent.
    // SIGTERM closes/audits tunnels before removal; the retained host spool is never deleted here (see DiskEgressAudit.vacuum). The shared egress
    // network is deliberately left alone: other sandboxes' sidecars may be attached (network.ts, removeEgressNetwork).
    // A removal that fails for any reason but "already gone" (a repeated finish, a volume-only orphan) is reported, never fatal:
    // the rest of the cleanup still runs, and the next boot's orphan sweep reclaims what is left (REC-8 left a volume silently).
    const proxy = egressProxyName(id);
    const volume = egressSocketVolumeName(id);
    await this.exec(["stop", "-t", "2", proxy]).catch(() => {});
    let proxyGone = true;
    await this.exec(["rm", "-f", proxy]).catch((e) => {
      proxyGone = false;
      if (!gone(e, this.profile))
        this.warn(
          `egress sidecar ${proxy} could not be removed (${errmsg(e)}); the next boot's sweep reclaims it, or run ${this.profile.binary} rm -f ${proxy}`,
        );
    });
    await this.exec(["volume", "rm", volume]).catch((e) => {
      if (!isEngineError(this.profile, "noSuchVolume", errmsg(e)))
        this.warn(
          `egress socket volume ${volume} could not be removed (${errmsg(e)}); the next boot's sweep reclaims it, or run ${this.profile.binary} volume rm ${volume}`,
        );
    });
    // Only once the proxy is confirmed gone can no row be appended, so only then is the spool marked closed (vacuumable after its
    // grace window, once acknowledged and journaled). A failure leaves the spool retained, as before.
    if (proxyGone && this.egressAuditRoot) {
      try {
        markEgressSpoolClosed(this.egressAuditRoot, id);
      } catch {
        console.error("egress audit spool could not be marked closed; it is retained");
      }
    }
  }

  private async *output(id: SandboxId): AsyncGenerator<{ stream: "stdout" | "stderr"; chunk: string }> {
    const p = this.spawnFn(this.profile.binary, ["logs", "-f", name(id)]);
    const queue: { stream: "stdout" | "stderr"; chunk: string }[] = [];
    let queuedBytes = 0;
    let droppedBytes = 0;
    let done = false;
    let failure: Error | undefined;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let wake: (() => void) | undefined;
    const push = (stream: "stdout" | "stderr") => (chunk: string) => {
      const size = Buffer.byteLength(chunk);
      queue.push({ stream, chunk });
      queuedBytes += size;
      while (queuedBytes > this.maxOutputBytes) {
        const dropped = queue.shift()!;
        queuedBytes -= Buffer.byteLength(dropped.chunk);
        droppedBytes += Buffer.byteLength(dropped.chunk);
      }
      wake?.();
    };
    // setEncoding decodes with a StringDecoder, so multibyte characters split across chunks stay intact.
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", push("stdout"));
    p.stderr.on("data", push("stderr"));
    p.on("error", (e) => {
      failure = e;
      done = true;
      wake?.();
    });
    p.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal ?? null;
      done = true;
      wake?.();
    });
    try {
      while (true) {
        if (droppedBytes) {
          const n = droppedBytes;
          droppedBytes = 0;
          yield { stream: "stderr", chunk: `[pomtree: ${n} bytes of output dropped]\n` };
        }
        const next = queue.shift();
        if (next) {
          queuedBytes -= Buffer.byteLength(next.chunk);
          yield next;
        } else if (done) {
          if (failure) throw failure;
          // Surface the docker logs -f exit code so a caller can tell a clean close (code 0)
          // from a broken log stream (non-zero exit or killed by a signal).
          yield {
            stream: "stderr",
            chunk: exitSignal
              ? `[pomtree: docker logs killed by signal ${exitSignal}]\n`
              : `[pomtree: docker logs exited with code ${exitCode ?? "unknown"}]\n`,
          };
          return;
        } else await new Promise<void>((r) => (wake = r));
      }
    } finally {
      p.kill();
    }
  }

  // Reads the container's terminal state in one `docker inspect` round-trip (Running, ExitCode,
  // OOMKilled). Returns null when the container is already gone; other failures propagate, so a
  // daemon-unreachable inspect surfaces SandboxUnavailableError rather than a stale cache hit.
  private async readState(id: SandboxId): Promise<{
    running: boolean;
    exitCode: number | null;
    oomKilled: boolean;
    networkMode: string | undefined;
    status: string | undefined;
    stamp: { host: HostId | null; generation: number | null } | undefined;
  } | null> {
    try {
      // The state fields come first (space-separated, status last so a line without it still parses; a missing or malformed one is
      // dropped, callers treat absent as unknown), then the owner stamp labels after tabs (a host cannot hold a tab: ownerStampTags
      // refuses control characters). A line with no tab fields reports no stamp; an absent label (`<no value>` or empty) is null.
      const out = await this.exec([
        "inspect",
        "-f",
        `{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}} {{.HostConfig.NetworkMode}} {{.State.Status}}\t{{index .Config.Labels "${SANDBOX_TAGS.host}"}}\t{{index .Config.Labels "${SANDBOX_TAGS.generation}"}}`,
        name(id),
      ]);
      const fields = out.split("\t");
      const [head = "", host, generation] = fields;
      const [running, code, oom, networkMode, rawStatus] = head.split(" ");
      const status = rawStatus && /^[a-z]+$/.test(rawStatus) ? rawStatus : undefined;
      const label = (v: string | undefined) => (v === undefined || v === "<no value>" ? undefined : v);
      // No tab at all is a bare state line (no stamp to report). Any other field count means a label held a tab: fail closed, the
      // stamp reads null for both (the same reading list gives, since readOwnerStamp refuses a control character in a host).
      const stamp =
        fields.length === 1
          ? undefined
          : fields.length !== 3 || host === undefined || generation === undefined
            ? { host: null, generation: null }
            : readOwnerStamp({ [SANDBOX_TAGS.host]: label(host), [SANDBOX_TAGS.generation]: label(generation) });
      return { running: running === "true", exitCode: running === "true" ? null : Number(code), oomKilled: oom === "true", networkMode, status, stamp };
    } catch (e) {
      if (gone(e, this.profile)) return null;
      throw e;
    }
  }

  private async wait(id: SandboxId): Promise<{ exitCode: number; oomKilled?: boolean }> {
    const known = this.exited.get(id);
    if (known !== undefined) return { exitCode: known.exitCode, ...(known.oomKilled ? { oomKilled: true } : {}) };
    try {
      const exitCode = Number(await this.exec(["wait", name(id)]));
      // The container has exited; read OOMKilled before anything removes it. If a concurrent
      // finish() already reaped it, the cache it populated holds the captured flag.
      // TODO(oom-flag-race): Docker can record a real OOM kill as OOMKilled=false with exit 137 (issue #532); then oomKilled is omitted here.
      const oomKilled = (await this.readState(id))?.oomKilled ?? this.exited.get(id)?.oomKilled ?? false;
      return { exitCode, ...(oomKilled ? { oomKilled: true } : {}) };
    } catch (e) {
      const late = this.exited.get(id);
      if (late !== undefined) return { exitCode: late.exitCode, ...(late.oomKilled ? { oomKilled: true } : {}) };
      // TODO(exit-race): container removed externally before its exit was observed and no cached code exists;
      // the exit code and last stderr are unrecoverable here (the journal holds what output() already streamed).
      if (gone(e, this.profile)) throw new Error(`sandbox ${id} was removed before its exit was observed (exit code unknown)`);
      throw e;
    }
  }

  private async finish(id: SandboxId): Promise<void> {
    let exitCode: number | undefined;
    try {
      exitCode = Number(await this.exec(["wait", name(id)]));
    } catch (e) {
      if (!gone(e, this.profile)) throw e;
    }
    // Capture OOMKilled BEFORE rm -f; after removal the flag is gone for good.
    const state = await this.readState(id);
    if (state && exitCode === undefined) exitCode = state.exitCode ?? undefined;
    if (exitCode !== undefined) {
      this.exited.set(id, { exitCode, oomKilled: state?.oomKilled ?? this.exited.get(id)?.oomKilled ?? false });
      // Bound the delivered-exit cache: evict the oldest entry once past the cap. It is only a
      // delivered-value cache (durable truth is the container labels), so eviction is lossless.
      while (this.exited.size > this.maxExitedCache) {
        const oldest = this.exited.keys().next().value;
        if (oldest === undefined) break;
        this.exited.delete(oldest);
      }
    }
    // TODO(finish-serialize): kill, stop and reap paths are not serialized per sandbox, so two finishers can race on this rm; the loser
    // is tolerated (someone else is removing the container) and goes on to cleanupEgress without waiting for the removal to complete.
    await this.exec(["rm", "-f", name(id)]).catch((e) => {
      if (!gone(e, this.profile) && !removalRace(e, this.profile)) throw e;
    });
    await this.cleanupEgress(id);
  }

  // The key is accepted for the port contract; stop and kill are idempotent by nature ("already gone" is success).
  async stop(id: SandboxId, graceMs: number, _idempotencyKey: string): Promise<void> {
    await this.exec(["stop", "-t", String(stopTimeoutSeconds(graceMs)), name(id)]).catch((e) => {
      if (!gone(e, this.profile)) throw e;
    });
    await this.finish(id);
  }

  async kill(id: SandboxId, _idempotencyKey: string): Promise<void> {
    await this.exec(["kill", name(id)]).catch((e) => {
      if (!gone(e, this.profile)) throw e;
    });
    await this.finish(id);
  }

  async inspect(id: SandboxId): Promise<SandboxInfo | null> {
    const s = await this.readState(id);
    if (s)
      return {
        running: s.running,
        exitCode: s.exitCode,
        ...(!s.running && s.oomKilled ? { oomKilled: true } : {}),
        ...(s.status ? { status: s.status } : {}),
        ...(s.stamp ?? {}),
      };
    // Removed after an observed exit: the last state was exited.
    const cached = this.exited.get(id);
    return cached === undefined
      ? null
      : { running: false, exitCode: cached.exitCode, ...(cached.oomKilled ? { oomKilled: true } : {}), status: "exited", host: null, generation: null };
  }

  // Every labelled container with its raw labels, caller labels and Docker status; list and reclaim filter it.
  private async scan(): Promise<
    { id: SandboxId; engineId: string; agent: string; raw: Record<string, string>; labels: Record<string, string>; status: string }[]
  > {
    const containers = await this.exec(["ps", "-aq", "--filter", `label=${LABEL}=1`]);
    if (!containers) return [];
    // `docker ps` exposes .Labels as an ambiguous comma-separated string. Inspect the canonical
    // map instead so commas and other valid characters in caller label values remain intact.
    const sandboxes: Awaited<ReturnType<DockerSandbox["scan"]>> = [];
    const format = `{{index .Config.Labels "${ID_LABEL}"}}\t{{index .Config.Labels "${AGENT_LABEL}"}}\t{{json .Config.Labels}}\t{{.Image}}\t{{.State.Status}}`;
    // A container also carries its image's labels (e.g. org.opencontainers.image.*), which the caller did not supply: subtract them.
    const imageLabels = new Map<string, Record<string, unknown>>();
    const labelsOfImage = async (image: string): Promise<Record<string, unknown>> => {
      const cached = imageLabels.get(image);
      if (cached) return cached;
      let found: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse((await this.exec(["image", "inspect", "--format", "{{json .Config.Labels}}", image])) || "null");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) found = parsed as Record<string, unknown>;
      } catch {
        /* image gone or unreadable: nothing to subtract */
      }
      imageLabels.set(image, found);
      return found;
    };
    for (const container of containers.split("\n")) {
      let out: string;
      try {
        out = await this.exec(["inspect", "--format", format, container]);
      } catch (e) {
        if (gone(e, this.profile)) continue;
        throw e;
      }
      const [id = "", agent = "", json, image, status = ""] = out.split("\t");
      const inherited = image ? await labelsOfImage(image) : {};
      const labels: Record<string, string> = {};
      const raw: Record<string, string> = {};
      try {
        const parsed: unknown = JSON.parse(json || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string") raw[k] = v;
            if (!k.startsWith("pomtree") && typeof v === "string" && inherited[k] !== v) labels[k] = v;
          }
        }
      } catch {
        /* unparseable label map: report none */
      }
      sandboxes.push({ id, engineId: container, agent, raw, labels, status });
    }
    return sandboxes;
  }

  // The sandboxes `owner`'s daemon may have created: everything except containers positively owned by someone else, i.e. a
  // store_id label that differs from owner.storeId, or a daemon_epoch label newer than owner.epoch. Containers with no store_id
  // label (a daemon without a store id stamps none) are included, so a storeless daemon still lists its own. This is looser than
  // reclaim's egressOwnedBy, which needs a matching store label because it deletes. Host and generation come from the pomtree.host and
  // pomtree.generation labels start() stamps; a container without them reads null (legacyContainerRefusal refuses those at boot).
  async list(owner: SandboxOwner): Promise<SandboxListing[]> {
    return (await this.scan())
      .filter((c) => {
        const store = c.raw[OWNER_STORE_LABEL];
        if (store !== undefined && store !== owner.storeId) return false;
        const epoch = Number(c.raw[OWNER_EPOCH_LABEL]);
        return !(Number.isFinite(epoch) && epoch > owner.epoch);
      })
      .map((c) => ({
        id: c.id,
        agent: c.agent,
        backend: "docker",
        ...readOwnerStamp(c.raw),
        state: listingState(c.status),
        ...(Object.keys(c.labels).length ? { labels: c.labels } : {}),
      }));
  }

  // The refusal text when any pomtree container on the engine predates the host and generation labels (engine-dialect.ts), or
  // undefined when none does. Pure over one scan; the caller (boot) decides to refuse. Pomtree never removes these containers.
  async legacyContainerRefusal(): Promise<string | undefined> {
    const legacy = findLegacyContainers((await this.scan()).map((c) => ({ engineId: c.engineId, labels: c.raw })));
    return legacy.length ? legacyContainerRefusal(this.profile, legacy) : undefined;
  }

  // TODO(rec8-egress-volume): find why REC-8 leaks an egress volume. Current behavior: this sweep runs once per boot.
  // egressOwnedBy accepts older epochs of the same store, so a later boot reclaims a volume stamped with the pre-restart epoch.
  // Reclaim exact named proxies/socket volumes whose labelled sandbox container is gone,
  // e.g. a crash between startEgress and the agent `docker run`. Only this instance's owner's resources are candidates
  // (egressOwnedBy: our store_id, not a newer daemon_epoch), never another daemon's on the same engine, and never one whose
  // start is in flight here. A resource without our owner labels (another daemon's, or one created before the labels existed)
  // is not ours and is left for its owner or the operator. The passed owner governs, not the constructor's. Another daemon of
  // the same store and an older epoch is presumed dead (one daemon per store). Returns reclaimed ids.
  async reclaim(passed: SandboxOwner): Promise<SandboxId[]> {
    const owner = egressOwner(passed);
    const live = new Set((await this.scan()).map((s) => s.id));
    const ids = new Set<SandboxId>();
    const fmt = `{{.Label "${ID_LABEL}"}}\t{{.Label "${OWNER_STORE_LABEL}"}}\t{{.Label "${OWNER_EPOCH_LABEL}"}}`;
    for (const args of [
      ["ps", "-a", "--filter", `label=${EGRESS_LABEL}=1`, "--format", fmt],
      ["volume", "ls", "--filter", `label=${EGRESS_LABEL}=1`, "--format", fmt],
    ]) {
      const out = await this.exec(args);
      for (const line of out.split("\n")) {
        const [id = "", store, epoch] = line.split("\t");
        if (!id || live.has(id) || this.starting.has(id)) continue;
        if (egressOwnedBy({ [OWNER_STORE_LABEL]: store, [OWNER_EPOCH_LABEL]: epoch }, owner)) ids.add(id);
      }
    }
    for (const id of ids) await this.cleanupEgress(id);
    return [...ids];
  }

  // `docker info` DriverStatus, read once per instance; a failure clears the memo so the next call retries.
  private imageStore: Promise<string> | undefined;
  private imageStoreInfo(ref: string): Promise<string> {
    // Only the docker engine has a containerd image store; Podman's `info` has no DriverStatus, so the question does not arise.
    if (this.profile.id !== "docker") return Promise.resolve("");
    this.imageStore ??= this.exec(["info", "--format", "{{json .DriverStatus}}"]).catch((e) => {
      this.imageStore = undefined;
      throw new Error(`cannot read the image identity of ${ref}: docker info failed (${errmsg(e)}); start the container engine and retry`);
    });
    return this.imageStore;
  }

  async imageIdentity(ref: string): Promise<ImageIdentity> {
    const info = await this.imageStoreInfo(ref);
    const containerd = CONTAINERD_STORE.test(info);
    let out: string;
    try {
      out = await this.exec(["image", "inspect", "--format", '{{.Id}}\t{{index .Config.Labels "org.opencontainers.image.revision"}}', ref]);
    } catch (e) {
      throw new Error(`cannot read the image identity of ${ref}: ${errmsg(e)}; pull or build the image locally, or fix the reference`);
    }
    const [rawId = "", label = ""] = out.split("\t");
    // Docker prints sha256:<hex>; Podman prints the bare hex of the config digest, normalized here for the digest only.
    const id = normalizeImageId(this.profile, rawId);
    if (id === undefined) {
      throw new Error(
        `cannot read the image identity of ${ref}: ${this.profile.binary} reported the image id ${JSON.stringify(rawId)}, which is not sha256:<64 hex>, so the image cannot be pinned; check that the reference names a local image with \`${this.profile.binary} image inspect --format '{{.Id}}' ${ref}\` (pull or build it if that fails), and report the output if it names an image`,
      );
    }
    const revision = label && label !== "<no value>" ? label : null;
    // On the containerd store the id is the index/manifest digest, not the OCI config digest, which `docker save` alone would reveal.
    // The engine-local id keeps the engine's own form (Podman: bare hex, which `run` resolves); only the config digest is canonical.
    return { engineLocalId: rawId, configDigest: containerd ? null : id, revision };
  }
}
