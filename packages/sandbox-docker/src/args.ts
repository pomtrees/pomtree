import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ResolvedMount, SandboxId, SandboxSpec } from "@pomtree/core";
import type { EgressProxyConfig } from "./audit.ts";
import { EGRESS_SOCKET_DIR } from "@pomtree/core";
import {
  buildNetworkArgs,
  EGRESS_PROXY_MEMORY_BYTES,
  EGRESS_PROXY_PATH,
  EGRESS_SOCKET_PATH,
  egressProxyName,
  egressSocketVolumeName,
  proxyEnv,
} from "./egress.ts";
import { DOCKER_PROFILE, type EngineProfile } from "./engine-profile.ts";
import { EGRESS_GID } from "./worker-ready.ts";

export const LABEL = "pomtree";
export const ID_LABEL = "pomtree.sandbox";
export const AGENT_LABEL = "pomtree.agent";
// Marks an egress proxy sidecar / network so an orphan sweep can find them (list() filters on LABEL).
export const EGRESS_LABEL = "pomtree.egress";

const RESERVED_LABEL = /^pomtree/;
// Validates and renders spec.labels as `--label k=v` args.
export function userLabelArgs(labels: Record<string, string> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (!/^[A-Za-z0-9_.-]+$/.test(k) || RESERVED_LABEL.test(k)) throw new Error(`invalid sandbox label name: ${k}`);
    out.push("--label", `${k}=${v}`);
  }
  return out;
}

// Default docker --pids-limit: bounds the per-sandbox pid namespace so a fork bomb or pid leak in
// the agent cannot exhaust the host pid table. Overridable via RunArgsOptions.pidsLimit.
export const DEFAULT_PIDS_LIMIT = 512;

// Default docker --cpus for a sandbox whose spec sets no resources.cpus. pomtreed sizes auto max-sessions from the same value.
export const DEFAULT_CONTAINER_CPUS = 2;

// Minimum sane docker stop grace: `docker stop -t 0` skips SIGTERM entirely (immediate SIGKILL),
// defeating graceful shutdown. Clamp every grace to at least one second.
export const MIN_GRACE_MS = 1000;

// Container-level --stop-timeout default (seconds). stop(id, graceMs) overrides per call with -t;
// this default matches the daemon's graceMs so a `docker stop` without -t still allows a graceful
// SIGTERM-first shutdown instead of the unbounded default.
export const DEFAULT_GRACE_MS = 10_000;

// Docker's per-container `--storage-opt size` is not a disk quota for this adapter: it
// applies only to the container writable layer, while the workspace and session/config
// directories are writable bind mounts. Accepting diskBytes with that flag would let an
// agent exceed its stated limit through those mounts. A MountProvider that supplies every
// writable surface from a quota-backed filesystem is required before this can be realized.
export const DISK_QUOTA_UNSUPPORTED = "resources.diskBytes requires quota-backed workspace and writable mounts; docker storage-opt does not limit bind mounts";

// Converts a millisecond grace to docker stop-timeout seconds (floor: MIN_GRACE_MS).
export function stopTimeoutSeconds(graceMs: number): number {
  return Math.max(MIN_GRACE_MS / 1000, Math.ceil(graceMs / 1000));
}

// The Docker realization of a template: every container-shape flag that is not an image, mount,
// resource or env. Core carries it as the opaque `SandboxSpec.runtime`; only this adapter reads it.
// TODO(sandbox-floor): deployment requirement — rootless Docker or userns-remap so container uid 1000 is not host uid 1000
export interface DockerShape {
  user: string;
  capDrop: string[];
  noNewPrivileges: boolean;
  init: boolean;
  pidsLimit: number;
  stopTimeoutSeconds: number;
  logOpts: string[];
  readOnlyRootfs: boolean;
  // `--tmpfs` entries; with a read-only rootfs these are the writable paths besides the mounts.
  tmpfs: string[];
  // Without egress, add the host-gateway alias so agents reach the daemon's TCP endpoint (harmless on Docker Desktop).
  addHostGateway: boolean;
  // The OCI runtime for the worker container (never the egress sidecar). `runsc` is gVisor, opt-in; see TODO(browser-userns).
  ociRuntime: "default" | "runsc";
}

// The `code` template's shape. Pi's write paths that are not mounts: the agent image sets
// HOME=/home/node and Pi's config dir lives under it; /tmp is scratch. With a read-only rootfs both
// are tmpfs; mounts stay writable regardless of `--read-only`.
export const CODE_DOCKER_SHAPE: Readonly<DockerShape> = Object.freeze({
  user: "1000:1000",
  capDrop: Object.freeze(["ALL"]) as string[],
  noNewPrivileges: true,
  init: true,
  pidsLimit: DEFAULT_PIDS_LIMIT,
  stopTimeoutSeconds: stopTimeoutSeconds(DEFAULT_GRACE_MS),
  logOpts: Object.freeze(["max-size=10m", "max-file=3"]) as string[],
  readOnlyRootfs: true,
  tmpfs: Object.freeze(["/tmp", "/home/node:rw,mode=1777"]) as string[],
  addHostGateway: true,
  ociRuntime: "default",
});

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isBool = (v: unknown) => typeof v === "boolean";
const isPosInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
const SHAPE_CHECKS: { [K in keyof DockerShape]: (v: unknown) => boolean } = {
  user: (v) => typeof v === "string" && v !== "",
  capDrop: isStringArray,
  noNewPrivileges: isBool,
  init: isBool,
  pidsLimit: isPosInt,
  stopTimeoutSeconds: isPosInt,
  logOpts: isStringArray,
  readOnlyRootfs: isBool,
  tmpfs: isStringArray,
  addHostGateway: isBool,
  ociRuntime: (v) => v === "default" || v === "runsc",
};

// The non-negotiable hardening floor every sandbox shape must meet, whatever its egress mode (the Kubernetes Pod Security
// "restricted" precedent): a template may only tighten it. The user must be a numeric non-root uid:gid (a name can map to
// root inside the image); all capabilities dropped; no-new-privileges; read-only rootfs; the pid limit at most the default
// (DockerDeps.pidsLimit is the operator's knob and may raise it). Throws naming the field and the fix.
// TODO(sandbox-floor): the floor belongs in packages/core (template validation) at the next contract batch; the adapter enforces it until then.
export function assertSandboxFloor(shape: Readonly<DockerShape>): void {
  const below = (field: string, value: unknown, action: string) =>
    new Error(`docker runtime ${field} ${JSON.stringify(value)} is below the sandbox floor: ${action} (templates may only tighten hardening)`);
  const ids = /^([0-9]+):([0-9]+)$/.exec(shape.user);
  if (!ids || Number(ids[1]) === 0 || Number(ids[2]) === 0) throw below("user", shape.user, "use a non-root numeric uid:gid");
  if (!shape.capDrop.includes("ALL")) throw below("capDrop", shape.capDrop, 'include "ALL"');
  if (shape.noNewPrivileges !== true) throw below("noNewPrivileges", shape.noNewPrivileges, "set it to true");
  if (shape.readOnlyRootfs !== true) throw below("readOnlyRootfs", shape.readOnlyRootfs, "set it to true");
  if (shape.pidsLimit > DEFAULT_PIDS_LIMIT) throw below("pidsLimit", shape.pidsLimit, `use at most ${DEFAULT_PIDS_LIMIT}`);
}

// Validates a template's `runtime` block (unknown keys and wrong types rejected), overlays it on CODE_DOCKER_SHAPE and
// refuses a result below the sandbox floor (assertSandboxFloor).
export function parseDockerShape(runtime: Readonly<Record<string, unknown>> | undefined): DockerShape {
  const shape: Record<string, unknown> = { ...CODE_DOCKER_SHAPE };
  for (const [k, v] of Object.entries(runtime ?? {})) {
    if (!Object.hasOwn(SHAPE_CHECKS, k)) throw new Error(`unknown docker runtime key: ${k}`);
    if (!SHAPE_CHECKS[k as keyof DockerShape](v)) throw new Error(`invalid docker runtime value for ${k}`);
    shape[k] = v;
  }
  assertSandboxFloor(shape as unknown as DockerShape);
  return shape as unknown as DockerShape;
}

// A browser-capable worker is the one whose env asks the in-image worker.ts to launch Chromium (worker.ts reads the same variable).
export function isBrowserSpec(spec: Pick<SandboxSpec, "env">): boolean {
  return spec.env.PTREE_BROWSER === "1";
}

// Chromium's seccomp profile, applied only to browser-capable workers (never other workers). It is Docker's default
// profile (moby/profiles seccomp/default.json) with three narrow changes, each needed by Chromium's user-namespace
// sandbox and found necessary by removing it and watching Chromium fail with "No usable sandbox":
//   - clone: the default's namespace-flag mask is relaxed to let CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET through
//     (the zygote launcher); CLONE_NEWNS, NEWUTS, NEWIPC and NEWCGROUP stay denied, and clone3 stays ENOSYS.
//   - unshare: allowed only for flags within CLONE_NEWUSER (the default allows it only with CAP_SYS_ADMIN).
//   - chroot: allowed unconditionally (the default needs CAP_SYS_CHROOT, which cap-drop ALL removes); the sandbox
//     chroots into an empty directory inside its user namespace.
// Capabilities stay dropped, no-new-privileges stays on, and nothing here adds --no-sandbox, --privileged or cap-add.
// [knowledge-only] Under the opt-in gVisor runtime (shape ociRuntime "runsc") the OCI seccomp profile is not applied by default:
// gVisor's Sentry implements user namespaces itself, so CLONE_NEWUSER no longer reaches the host kernel. The flag is still rendered.
// TODO(browser-userns): the default remains runc plus the seccomp allowance above (CLONE_NEWUSER reaches the host kernel); runsc is
// opt-in via runtime.ociRuntime and untested under Docker on this host.
// Returned as a file path because the docker client reads this file.
export function chromiumSeccompProfile(): string {
  return realpathSync(fileURLToPath(new URL("../seccomp/chromium.json", import.meta.url)));
}

// The Podman flag dialect, as deltas over the one shared hardening policy. Only the `podman` profile id selects it; every other
// profile (the default is DOCKER_PROFILE) renders the Docker argv unchanged.
// Rootless Podman maps container root to the host user, so the worker and sidecar (uid 1000) would not own the socket volume
// (uid/gid 1000, mode 0770); keep-id maps the host user to 1000:1000 instead. There is deliberately no `idmap` flag (Docker has none).
export const PODMAN_USERNS = `keep-id:uid=1000,gid=${EGRESS_GID}`;
// Rootless Podman gives the sidecar its own pasta network: isolation by construction, so the shared ICC-off bridge is not used.
const PODMAN_SIDECAR_NETWORK = "pasta";
// SELinux relabel option for a shared read-only bind mount (Linux SELinux hosts only; macOS shares are virtiofs and need none).
// Known limitation: relabel=shared is applied to read-only bind mounts only, by design. On an enforcing-SELinux Linux host an unlabeled
// WRITABLE bind (the workspace bind and the sidecar spool log directory) may be denied to the container, so the operator must pre-label
// those paths or the writable binds need relabel too. Not verified on a real SELinux host (built and tested on macOS).
// TODO(podman-selinux-writable-bind): verify on a Fedora-class enforcing-SELinux host; current behavior: only read-only binds are relabeled, and an
// unlabeled writable bind would probably be denied. Built and tested on macOS only.
const PODMAN_RELABEL = ",relabel=shared";

const isPodman = (profile: EngineProfile) => profile.id === "podman";

// Renders `--add-host <alias>:host-gateway`, or nothing for an engine that adds the alias itself (Podman adds host.docker.internal and
// host.containers.internal on its own; P9 verified both resolve in a rootless container).
function hostGatewayArgs(profile: EngineProfile): string[] {
  return isPodman(profile) ? [] : ["--add-host", `${profile.hostAlias}:host-gateway`];
}

// A bind mount's `--mount` argv. `relabel` adds the SELinux option to read-only binds; it is a Podman option, so another engine refuses it.
function bindMountArgs(m: Extract<ResolvedMount, { type: "bind" }>, profile: EngineProfile, relabel: boolean | undefined): string[] {
  if (relabel && !isPodman(profile))
    throw new Error(`selinuxRelabel is a Podman mount option and the ${profile.id} engine rejects it; drop selinuxRelabel or select the podman engine`);
  return ["--mount", `type=bind,source=${m.hostPath},target=${m.containerPath}${m.readOnly ? ",readonly" : ""}${m.readOnly && relabel ? PODMAN_RELABEL : ""}`];
}

export interface RunArgsOptions {
  // Overrides the shape's pids limit (the DockerSandbox deps knob).
  pidsLimit?: number;
  // spec.mounts resolved by the MountProvider, index-aligned with spec.mounts.
  mounts?: ResolvedMount[];
  // Podman on a Linux SELinux host: relabel read-only bind mounts as shared. Refused for any other engine.
  selinuxRelabel?: boolean;
}

// The hardening `docker run` is told to apply, as plain data. buildRunArgs renders its flags FROM this value, so the
// description and the argv cannot drift (args.test.ts also parses the built argv and compares). Content-free: no host
// paths, env values, labels, secrets or cmd; the seccomp profile is named, never pathed. Journaled by pomtreed (`identity`).
export interface RunHardening {
  // `none`: --network none (every egress spec; the adapter always adds an egress spec). `default`: no --network flag, so Docker's default network applies.
  networkMode: "none" | "default";
  user: string;
  capDrop: string[];
  noNewPrivileges: boolean;
  // `chromium`: the repo's custom profile (browser workers only); `docker-default`: no --security-opt seccomp flag.
  seccomp: "chromium" | "docker-default";
  readOnlyRootfs: boolean;
  init: boolean;
  pidsLimit: number;
  memoryBytes: number;
  // Always equal to memoryBytes: zero swap.
  memorySwapBytes: number;
  cpus: number;
  shmBytes?: number;
  stopTimeoutSeconds: number;
  ipv6Disabled: boolean;
  hostGateway: boolean;
  // Present only for Podman: the `--userns` value that keeps the host user as container uid/gid 1000 (socket volume ownership).
  userns?: string;
  // Present only when the worker runs under gVisor (`--runtime=runsc`), so the description of every default-runtime sandbox is unchanged.
  // Never applies to the egress sidecar.
  ociRuntime?: "runsc";
  // The egress sidecar's network (present whenever the worker has an egress spec, i.e. always under defaultDenyEgress):
  // the one shared user-defined bridge with inter-container communication off (network.ts, ensureEgressNetwork).
  // Podman (rootless) instead gives the sidecar its own `pasta` network.
  sidecarNetwork?: "shared-icc-off" | "pasta";
}

// The worker reaches its egress sidecar only through the socket volume, which is group EGRESS_GID with mode 0770 (the sidecar runs
// as the daemon's uid with that gid). A worker in another primary group cannot open the socket, which used to surface only at
// worker start as an opaque ownership error; refuse it here, before the sidecar or worker starts, naming the cause and the fix.
function assertEgressGroup(spec: SandboxSpec, user: string): void {
  if (!spec.egress) return;
  const gid = Number(user.split(":")[1]);
  if (gid !== EGRESS_GID)
    throw new Error(
      `docker runtime user ${JSON.stringify(user)} cannot reach the egress socket: its gid must be ${EGRESS_GID}, the egress socket volume's group (set runtime.user to "<uid>:${EGRESS_GID}")`,
    );
}

export function describeRunHardening(spec: SandboxSpec, opts: Pick<RunArgsOptions, "pidsLimit"> = {}, profile: EngineProfile = DOCKER_PROFILE): RunHardening {
  const shape = parseDockerShape(spec.runtime);
  assertEgressGroup(spec, shape.user);
  const res = spec.resources ?? {};
  const memoryBytes = res.memoryBytes ?? 2 * 1024 ** 3;
  return {
    networkMode: spec.egress ? "none" : "default",
    user: shape.user,
    capDrop: [...shape.capDrop],
    noNewPrivileges: shape.noNewPrivileges,
    seccomp: isBrowserSpec(spec) ? "chromium" : "docker-default",
    readOnlyRootfs: shape.readOnlyRootfs,
    init: shape.init,
    pidsLimit: opts.pidsLimit ?? shape.pidsLimit,
    memoryBytes,
    memorySwapBytes: memoryBytes,
    cpus: res.cpus ?? DEFAULT_CONTAINER_CPUS,
    ...(res.shmBytes !== undefined ? { shmBytes: res.shmBytes } : {}),
    stopTimeoutSeconds: shape.stopTimeoutSeconds,
    ipv6Disabled: spec.egress?.auditedPublic !== undefined,
    // For Podman this is false because Podman adds the host.docker.internal and host.containers.internal aliases itself, so the
    // description says false while the alias still resolves; not a weaker posture (Docker's non-egress worker also reaches the host via the alias).
    hostGateway: !spec.egress && shape.addHostGateway && !isPodman(profile),
    ...(isPodman(profile) ? { userns: PODMAN_USERNS } : {}),
    ...(shape.ociRuntime === "runsc" ? { ociRuntime: "runsc" as const } : {}),
    ...(spec.egress ? { sidecarNetwork: isPodman(profile) ? PODMAN_SIDECAR_NETWORK : ("shared-icc-off" as const) } : {}),
  };
}

export interface EgressProxyArgsOptions {
  // Host daemon uid the sidecar runs as (gid 1000 shares the socket volume with the worker).
  uid: number;
  // The shared egress network's name; the caller has validated it with ensureEgressNetwork (ICC off) first.
  network: string;
  hostAddresses: string[];
  image: string;
  config: EgressProxyConfig;
  // Audited sandboxes (any egress mode): the spool's config (read-only) and log directories; otherwise the config is passed inline.
  spool?: { configDir: string; logDir: string };
  // Podman on a Linux SELinux host: relabel the read-only spool config bind as shared. Refused for any other engine.
  selinuxRelabel?: boolean;
}

// The egress sidecar's `docker run` argv. Pure; its --network is rendered only when the hardening description names
// the shared ICC-off network (Docker) or the sidecar's own pasta network (Podman), so the description and the argv cannot drift
// (args-hardening.test.ts parses both). The optional trailing profile selects the engine dialect (default Docker, output unchanged).
export function buildEgressProxyArgs(id: SandboxId, spec: SandboxSpec, o: EgressProxyArgsOptions, profile: EngineProfile = DOCKER_PROFILE): string[] {
  const hard = describeRunHardening(spec, {}, profile);
  if (hard.sidecarNetwork === undefined) throw new Error("egress sidecar requires an egress spec");
  const memory = String(EGRESS_PROXY_MEMORY_BYTES);
  return [
    "run",
    "-d",
    "--name",
    egressProxyName(id),
    "--label",
    `${ID_LABEL}=${id}`,
    "--label",
    `${EGRESS_LABEL}=1`,
    // The sandbox's ownership labels (store_id, daemon_epoch), so the orphan sweep can tell whose sidecar this is (egressOwnedBy).
    ...userLabelArgs(spec.labels),
    "--network",
    hard.sidecarNetwork === "pasta" ? PODMAN_SIDECAR_NETWORK : o.network,
    "--mount",
    `type=volume,source=${egressSocketVolumeName(id)},target=${EGRESS_SOCKET_DIR}`,
    // The proxy (not the internal-network agent) dials the daemon's agent endpoint, so it needs the host-gateway alias
    // on Linux; the agent itself reaches host.docker.internal through the proxy (TODO(agent-endpoint)).
    ...hostGatewayArgs(profile),
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--user",
    `${o.uid}:1000`,
    ...(hard.userns ? [`--userns=${hard.userns}`] : []),
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "--pids-limit",
    "64",
    "--cpus",
    "0.5",
    "--log-opt",
    "max-size=1m",
    "--log-opt",
    "max-file=2",
    "--entrypoint",
    "node",
    "-e",
    `EGRESS_SOCKET=${EGRESS_SOCKET_PATH}`,
    "-e",
    `EGRESS_HOST_ADDRESSES=${JSON.stringify(o.hostAddresses)}`,
    ...(o.spool
      ? [
          ...bindMountArgs({ type: "bind", hostPath: o.spool.configDir, containerPath: "/etc/pomtree-egress", readOnly: true }, profile, o.selinuxRelabel),
          ...bindMountArgs({ type: "bind", hostPath: o.spool.logDir, containerPath: "/var/log/pomtree-egress", readOnly: false }, profile, o.selinuxRelabel),
        ]
      : ["-e", `EGRESS_CONFIG_JSON=${JSON.stringify(o.config)}`]),
    "--",
    o.image,
    EGRESS_PROXY_PATH,
  ];
}

// The optional trailing profile selects the engine dialect; absent or DOCKER_PROFILE yields the Docker argv unchanged.
export function buildRunArgs(id: SandboxId, spec: SandboxSpec, opts: RunArgsOptions = {}, profile: EngineProfile = DOCKER_PROFILE): string[] {
  // parseDockerShape enforces the sandbox floor for every egress mode (audited-public included).
  const shape = parseDockerShape(spec.runtime);
  const hard = describeRunHardening(spec, opts, profile);
  const resolved = opts.mounts ?? [];
  if (resolved.length !== spec.mounts.length) throw new Error("resolved mounts do not match spec.mounts");
  const wsAt = spec.mounts.flatMap((m, i) => (m.kind === "workspace" ? [i] : []));
  if (wsAt.length !== 1) throw new Error(`sandbox spec needs exactly one workspace mount (found ${wsAt.length})`);
  const ws = resolved[wsAt[0]!]!;
  // Errors below name the mount kind and container path only; host paths never reach a journaled message.
  if (ws.type !== "bind") throw new Error(`workspace mount at ${ws.containerPath} must resolve to a bind`);
  const res = spec.resources ?? {};
  // This is deliberately fail-closed. Post-exit accounting is not a quota, and Docker's
  // rootfs storage limit does not cover the writable bind mounts this adapter gives agents.
  // TODO(quotas): enforce per-agent disk quotas. Current behavior: any set diskBytes throws, so the start fails (fail-closed).
  // Docker's rootfs storage limit does not cover the writable bind mounts; a quota-backed mount provider is the open mechanism.
  if (res.diskBytes !== undefined) throw new Error(DISK_QUOTA_UNSUPPORTED);
  // TODO(accelerators): accelerators are not realized by the Docker adapter yet; a set value fails the start instead of being ignored.
  if (res.accelerators?.length) throw new Error("resources.accelerators is not supported by the docker sandbox");
  // --memory-swap is memory + swap; setting it equal to --memory gives zero swap (no host swap
  // pressure from a single sandbox). One value drives both so they can never drift apart.
  // `--mount` (not `-v`) so a colon in a path cannot be misread as a host:ctr separator.
  const bind = (m: Extract<ResolvedMount, { type: "bind" }>) => bindMountArgs(m, profile, opts.selinuxRelabel);
  const args = [
    "run",
    "-d",
    ...(spec.tty ? ["-i", "-t"] : []),
    "--name",
    `pomtree-${id}`,
    "--label",
    `${LABEL}=1`,
    "--label",
    `${ID_LABEL}=${id}`,
    "--label",
    `${AGENT_LABEL}=${spec.agent}`,
    ...userLabelArgs(spec.labels),
    "--user",
    hard.user,
    ...(hard.userns ? [`--userns=${hard.userns}`] : []),
    // With egress the daemon channel is allowlisted and reached through the per-sandbox proxy on the
    // egress network, so the host-gateway alias is dropped in favor of that network.
    ...(spec.egress ? buildNetworkArgs(id, spec) : hard.hostGateway ? hostGatewayArgs(profile) : []),
    ...(hard.ipv6Disabled ? ["--sysctl", "net.ipv6.conf.all.disable_ipv6=1", "--sysctl", "net.ipv6.conf.default.disable_ipv6=1"] : []),
    ...hard.capDrop.map((c) => `--cap-drop=${c}`),
    ...(hard.noNewPrivileges ? ["--security-opt", "no-new-privileges"] : []),
    ...(hard.ociRuntime ? [`--runtime=${hard.ociRuntime}`] : []),
    ...(hard.seccomp === "chromium" ? ["--security-opt", `seccomp=${chromiumSeccompProfile()}`] : []),
    // tini as PID 1 reaps grandchildren and forwards signals (no zombie/pid exhaustion); the pid
    // namespace and json-file logs are bounded, and stop honors a graceful timeout.
    ...(hard.init ? ["--init"] : []),
    "--pids-limit",
    String(hard.pidsLimit),
    "--stop-timeout",
    String(hard.stopTimeoutSeconds),
    ...shape.logOpts.flatMap((o) => ["--log-opt", o]),
    "--memory",
    String(hard.memoryBytes),
    "--memory-swap",
    String(hard.memorySwapBytes),
    "--cpus",
    String(hard.cpus),
    ...(hard.shmBytes !== undefined ? [`--shm-size=${hard.shmBytes}`] : []),
    // Read-only rootfs: only the mounts below and the tmpfs write paths stay writable.
    ...(hard.readOnlyRootfs ? ["--read-only"] : []),
    ...shape.tmpfs.flatMap((t) => ["--tmpfs", t]),
    ...bind(ws),
    "-w",
    ws.containerPath,
  ];
  resolved.forEach((m, i) => {
    if (i === wsAt[0]) return;
    if (m.type === "bind") args.push(...bind(m));
    else args.push("--tmpfs", m.sizeBytes !== undefined ? `${m.containerPath}:size=${m.sizeBytes}` : m.containerPath);
  });
  for (const k of Object.keys(spec.env)) args.push("-e", k); // value comes from the docker client's environment, see runEnv
  // Proxy URLs carry no secret, so they are passed inline (unlike spec.env values, which must stay out of argv).
  for (const [k, v] of Object.entries(proxyEnv(id, spec))) args.push("-e", `${k}=${v}`);
  // `--` separates options from the image so an image name beginning with `-` is not read as an option.
  args.push("--", spec.image, ...(spec.cmd ?? []));
  return args;
}

// Keys that would change how the docker client itself behaves if set in its environment.
const CLIENT_SENSITIVE = /^(DOCKER_|PATH$|HOME$|USER$|LD_|DYLD_|SSH_|TMPDIR$)/;

// Values for `-e KEY` flags, passed through the docker client's environment so secrets never appear in argv.
// TODO(docker-env-token): POMTREE_TOKEN reaches docker inspect Config.Env; pomtreed should deliver it via a tmpfs-backed secret file and pomtree/agent-image read POMTREE_TOKEN_FILE; current behavior: passed as env
export function runEnv(spec: SandboxSpec): Record<string, string> {
  for (const k of Object.keys(spec.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid sandbox env name: ${k}`);
    if (CLIENT_SENSITIVE.test(k)) throw new Error(`sandbox env name collides with the docker client environment: ${k}`);
  }
  return { ...spec.env };
}
