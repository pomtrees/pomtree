import { posix } from "node:path";

// One EngineProfile per local container engine id. It carries the CLI binary, the socket-discovery order, the host alias, the flag
// dialect and the error dialect as data, so the single hardening policy in args.ts needs only dialect deltas. Nothing here does I/O.
export type EngineId = "docker" | "podman";

export const ENGINE_IDS: readonly EngineId[] = ["docker", "podman"];

export interface EngineProfile {
  id: EngineId;
  // CLI binary invoked for this engine.
  binary: string;
  // Environment variables consulted for the socket, in order (a unix:// value is a socket; other schemes are refused).
  socketEnv: readonly string[];
  // Environment variable that carries the resolved socket to the CLI, so the CLI and the HTTP API hit one engine.
  cliSocketEnv: string;
  // Config key (operator scope) that overrides discovery; named here so the resolver's error text can cite it.
  socketConfigKey: string;
  // Fixed socket locations tried last, in order, after the CLI's own view. Takes the environment and returns candidate paths.
  defaultSockets: (env: Readonly<Record<string, string | undefined>>) => string[];
  // The CLI's own view of the socket: the argv to run (after the binary) and the parser of its stdout.
  cliView: { args: readonly string[]; parse: (stdout: string) => string | undefined };
  // Name a container uses to reach the host. One constant for both ids; Podman adds this alias itself next to host.containers.internal.
  hostAlias: string;
  // Error dialect: how this engine's CLI words the failures the adapter classifies.
  errors: { alreadyInUse: RegExp; daemonUnreachable: RegExp };
}

export const HOST_ALIAS = "host.docker.internal";

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// `docker context inspect` prints a JSON array; the current context's docker endpoint is Endpoints.docker.Host.
export function parseDockerContextInspect(stdout: string): string | undefined {
  try {
    const first = asRecord((JSON.parse(stdout) as unknown[])[0]);
    const host = asRecord(asRecord(first?.Endpoints)?.docker)?.Host;
    return typeof host === "string" && host !== "" ? host : undefined;
  } catch {
    return undefined;
  }
}

// `podman machine inspect --format ...` prints the path itself; an absent machine (Linux, or none created) prints nothing or fails.
export function parsePodmanMachinePath(stdout: string): string | undefined {
  const path = (stdout.split("\n")[0] ?? "").trim();
  return path.startsWith("/") ? path : undefined;
}

// A bare "no such file or directory" is not enough: a container-side missing exec path says the same. Require a connect/dial context.
const SOCKET_DIAL_FAILED = /connect: (?:no such file or directory|connection refused)|dial unix [^\n]*(?:no such file or directory|connection refused)/i;
const DOCKER_UNREACHABLE = new RegExp(`cannot connect to the docker daemon|is the docker daemon running|${SOCKET_DIAL_FAILED.source}`, "i");
const PODMAN_UNREACHABLE = new RegExp(
  `cannot connect to podman|unable to connect to podman|podman.*(?:socket|machine).*(?:not running|unreachable)|${SOCKET_DIAL_FAILED.source}`,
  "i",
);

// Docker and Podman share the duplicate-name substring (Podman exits 125 on it).
const ALREADY_IN_USE = /is already in use/i;

export const DOCKER_PROFILE: EngineProfile = {
  id: "docker",
  binary: "docker",
  socketEnv: ["DOCKER_HOST"],
  cliSocketEnv: "DOCKER_HOST",
  socketConfigKey: "sandbox.docker.socket",
  defaultSockets: () => ["/var/run/docker.sock"],
  cliView: { args: ["context", "inspect"], parse: parseDockerContextInspect },
  hostAlias: HOST_ALIAS,
  errors: { alreadyInUse: ALREADY_IN_USE, daemonUnreachable: DOCKER_UNREACHABLE },
};

export const PODMAN_PROFILE: EngineProfile = {
  id: "podman",
  binary: "podman",
  socketEnv: ["CONTAINER_HOST"],
  cliSocketEnv: "CONTAINER_HOST",
  socketConfigKey: "sandbox.podman.socket",
  defaultSockets: (env) => [...(env.XDG_RUNTIME_DIR ? [posix.join(env.XDG_RUNTIME_DIR, "podman/podman.sock")] : []), "/run/podman/podman.sock"],
  cliView: { args: ["machine", "inspect", "--format", "{{.ConnectionInfo.PodmanSocket.Path}}"], parse: parsePodmanMachinePath },
  hostAlias: HOST_ALIAS,
  errors: { alreadyInUse: ALREADY_IN_USE, daemonUnreachable: PODMAN_UNREACHABLE },
};

const PROFILES: Record<EngineId, EngineProfile> = { docker: DOCKER_PROFILE, podman: PODMAN_PROFILE };

export function isEngineId(v: unknown): v is EngineId {
  return v === "docker" || v === "podman";
}

export function engineProfile(id: string): EngineProfile {
  if (!isEngineId(id)) throw new Error(`unknown container engine "${id}": expected one of ${ENGINE_IDS.join(", ")}; set sandbox.backend to a listed id`);
  return PROFILES[id];
}

// A socket reference as DOCKER_HOST and CONTAINER_HOST spell it: `unix:///path` or a bare absolute path. Remote schemes are refused.
export function socketPathFromHost(profile: EngineProfile, source: string, value: string): string {
  const v = value.trim();
  if (/^unix:\/\//i.test(v)) {
    const path = v.slice("unix://".length);
    if (path.startsWith("/")) return path;
  } else if (v.startsWith("/")) return v;
  throw new Error(
    `${source} for the ${profile.id} engine is "${v}", which is not a local unix socket (remote tcp:// and ssh:// engines are not supported); set ${source} to unix:///<absolute path> or unset it`,
  );
}

// No socket could be located for a profile; routine when that engine is simply not installed, unlike a refused or malformed setting.
export class SocketNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocketNotFoundError";
  }
}

export type SocketSource = "config" | "env" | "cli" | "default";

export interface ResolvedSocket {
  path: string;
  source: SocketSource;
  // The config key, environment variable, CLI command or default location that supplied the path, for operator text.
  via: string;
}

export interface SocketProbes {
  // Runs the profile's CLI view and returns its stdout, or undefined when the CLI is missing or fails.
  cliView: (profile: EngineProfile) => Promise<string | undefined>;
  exists: (path: string) => boolean;
}

export interface ResolveSocketInput {
  profile: EngineProfile;
  // The operator's configured socket for this profile (profile.socketConfigKey), if any.
  configured?: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  probes: SocketProbes;
}

// Discovery order: configured socket, then the profile's environment variables, then the CLI's own view, then the fixed defaults.
// Explicit sources are trusted without an existence check (a wrong value fails loudly at the first request); defaults must exist.
export async function resolveSocket(input: ResolveSocketInput): Promise<ResolvedSocket> {
  const { profile, env, probes } = input;
  if (input.configured !== undefined && input.configured !== "") {
    return { path: socketPathFromHost(profile, profile.socketConfigKey, input.configured), source: "config", via: profile.socketConfigKey };
  }
  for (const name of profile.socketEnv) {
    const value = env[name];
    if (value !== undefined && value !== "") return { path: socketPathFromHost(profile, name, value), source: "env", via: name };
  }
  const out = await probes.cliView(profile);
  const fromCli = out === undefined ? undefined : profile.cliView.parse(out);
  if (fromCli !== undefined) {
    const via = `${profile.binary} ${profile.cliView.args.join(" ")}`;
    return { path: socketPathFromHost(profile, via, fromCli), source: "cli", via };
  }
  const candidates = profile.defaultSockets(env);
  for (const path of candidates) if (probes.exists(path)) return { path, source: "default", via: path };
  throw new SocketNotFoundError(
    `no ${profile.id} socket found: ${profile.socketConfigKey} and ${profile.socketEnv.join("/")} are unset, \`${profile.binary} ${profile.cliView.args[0]}\` gave no socket, and none of ${candidates.join(", ")} exists; start ${profile.id} (or its machine) or set ${profile.socketConfigKey}`,
  );
}

// The environment that points the profile's CLI at the resolved socket, so the CLI and the HTTP API reach one engine.
export function cliSocketEnv(profile: EngineProfile, socketPath: string): Record<string, string> {
  return { [profile.cliSocketEnv]: `unix://${socketPath}` };
}
