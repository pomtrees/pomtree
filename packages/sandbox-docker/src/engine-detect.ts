import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";
import {
  engineProfile,
  ENGINE_IDS,
  resolveSocket,
  SocketNotFoundError,
  type EngineId,
  type EngineProfile,
  type ResolvedSocket,
  type SocketProbes,
} from "./engine-profile.ts";

// Local-engine detection. Identity comes from what the engine says about itself (the `Libpod-Api-Version` header on /_ping and the
// first component name on /version), never from the socket path: a podman-docker shim serves Podman behind a docker-looking path.
export const LIBPOD_HEADER = "libpod-api-version";

export type EngineSelection = EngineId | "auto";

export interface PingInfo {
  // Response headers of GET /_ping, names lower-cased.
  headers: Readonly<Record<string, string | undefined>>;
}

export interface VersionInfo {
  Components?: readonly { Name?: unknown }[];
}

export interface EngineIdentity {
  id: EngineId;
  // Components[0].Name as reported, or undefined when /version carried none.
  component: string | undefined;
  // Libpod-Api-Version header value, or undefined for a Docker-family engine.
  libpodVersion: string | undefined;
}

const PODMAN_COMPONENT = /^podman engine$/i;

// Header present means Podman; component name "Podman Engine" means Podman. The two must agree: a disagreement is a proxy or shim
// rewriting one of them, and guessing would route policy to the wrong dialect.
export function identifyEngine(ping: PingInfo, version: VersionInfo): EngineIdentity {
  if (typeof version !== "object" || version === null || Array.isArray(version)) {
    throw new Error("GET /version returned JSON that is not an object; point the socket at the engine itself, not at a proxy or another service");
  }
  const libpodVersion = Object.entries(ping.headers).find(([k]) => k.toLowerCase() === LIBPOD_HEADER)?.[1];
  const first = version.Components?.[0]?.Name;
  const component = typeof first === "string" ? first : undefined;
  const headerSaysPodman = libpodVersion !== undefined && libpodVersion !== "";
  const nameSaysPodman = component !== undefined && PODMAN_COMPONENT.test(component);
  if (component !== undefined && headerSaysPodman !== nameSaysPodman) {
    throw new Error(
      `container engine identity is inconsistent: /_ping ${headerSaysPodman ? "has" : "lacks"} the Libpod-Api-Version header but /version names the first component "${component}"; point the socket at the engine itself, not at a proxy that rewrites its headers`,
    );
  }
  return { id: headerSaysPodman ? "podman" : "docker", component, libpodVersion: headerSaysPodman ? libpodVersion : undefined };
}

export class EngineMismatchError extends Error {
  readonly selected: EngineId;
  readonly actual: EngineId;
  readonly socket: string;
  constructor(selected: EngineId, actual: EngineId, socket: string) {
    super(
      `sandbox.backend is "${selected}" but the engine answering on ${socket} is ${actual}; set sandbox.backend to "${actual}", or point ${engineProfile(selected).socketConfigKey} at a ${selected} socket`,
    );
    this.name = "EngineMismatchError";
    this.selected = selected;
    this.actual = actual;
    this.socket = socket;
  }
}

export function assertEngineMatches(selected: EngineId, identity: EngineIdentity, socket: string): void {
  if (identity.id !== selected) throw new EngineMismatchError(selected, identity.id, socket);
}

// The engine did not answer its socket; routine for an engine that is not running, unlike a refused setting or a bad identity.
export class EngineUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineUnreachableError";
  }
}

export interface EngineProbes extends SocketProbes {
  // GET /_ping on the unix socket; rejects when the engine does not answer.
  ping: (socket: string) => Promise<PingInfo>;
  // GET /version on the unix socket; rejects when the engine does not answer.
  version: (socket: string) => Promise<VersionInfo>;
}

export interface LocalEngine {
  id: EngineId;
  profile: EngineProfile;
  socket: ResolvedSocket;
  identity: EngineIdentity;
  // Operator-visible notes (for example that `auto` also saw another answering engine).
  findings: string[];
}

export interface DetectInput {
  selection: EngineSelection;
  env: Readonly<Record<string, string | undefined>>;
  probes: EngineProbes;
  // Configured socket per id (sandbox.docker.socket, sandbox.podman.socket).
  configured?: Partial<Record<EngineId, string | undefined>>;
}

async function probeEngine(id: EngineId, input: DetectInput): Promise<LocalEngine> {
  const profile = engineProfile(id);
  const socket = await resolveSocket({ profile, configured: input.configured?.[id], env: input.env, probes: input.probes });
  let ping: PingInfo;
  let version: VersionInfo;
  try {
    [ping, version] = await Promise.all([input.probes.ping(socket.path), input.probes.version(socket.path)]);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new EngineUnreachableError(
      `the ${id} engine does not answer on ${socket.path} (from ${socket.via}): ${cause}; start ${id} (or its machine) or set ${profile.socketConfigKey} to a live socket`,
    );
  }
  let identity: EngineIdentity;
  try {
    identity = identifyEngine(ping, version);
  } catch (err) {
    throw new Error(`the ${id} engine on ${socket.path} (from ${socket.via}) cannot be identified: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { id, profile, socket, identity, findings: [] };
}

// Detects the local engine. An explicit id must match what answers (mismatch is an error). `auto` tries docker then podman: a docker
// CLI whose engine is Podman counts as podman; if both ids answer docker wins with a finding naming the other; if none answers the error
// carries both causes.
export async function detectLocalEngine(input: DetectInput): Promise<LocalEngine> {
  if (input.selection !== "auto") {
    const found = await probeEngine(input.selection, input);
    assertEngineMatches(input.selection, found.identity, found.socket.path);
    return found;
  }
  const answered = new Map<EngineId, LocalEngine>();
  const causes: string[] = [];
  // Refusals (a remote host, an inconsistent identity) must reach the operator even when the other engine answers; a plain
  // not-installed or not-running engine is routine and stays out of the findings.
  const notable: string[] = [];
  for (const id of ENGINE_IDS) {
    try {
      const found = await probeEngine(id, input);
      if (!answered.has(found.identity.id)) answered.set(found.identity.id, { ...found, id: found.identity.id, profile: engineProfile(found.identity.id) });
    } catch (err) {
      const cause = `${id}: ${err instanceof Error ? err.message : String(err)}`;
      causes.push(cause);
      if (!(err instanceof EngineUnreachableError || err instanceof SocketNotFoundError)) notable.push(cause);
    }
  }
  const chosen = answered.get("docker") ?? answered.get("podman");
  if (!chosen) {
    throw new Error(`no local container engine answered (${causes.join("; ")}); start Docker or Podman, or set sandbox.backend and its socket explicitly`);
  }
  for (const cause of notable) chosen.findings.push(`skipped ${cause}`);
  const other = ENGINE_IDS.find((id) => id !== chosen.id && answered.has(id));
  if (other) chosen.findings.push(`both docker and ${other} answer; using ${chosen.id} (set sandbox.backend to "${other}" to use the other)`);
  return chosen;
}

// Thin real probes: one HTTP GET over a unix socket, and the profile's CLI view. Exercised against a temporary server in the tests.
const PROBE_TIMEOUT_MS = 5000;

function unixGet(socket: string, path: string): Promise<{ headers: Record<string, string | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method: "GET", timeout: PROBE_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        if ((res.statusCode ?? 0) !== 200) return reject(new Error(`GET ${path} returned HTTP ${res.statusCode}`));
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
        resolve({ headers, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`GET ${path} timed out after ${PROBE_TIMEOUT_MS}ms`)));
    req.on("error", reject);
    req.end();
  });
}

export const realEngineProbes: EngineProbes = {
  exists: (path) => existsSync(path),
  cliView: (profile) =>
    new Promise((resolve) => {
      execFile(profile.binary, [...profile.cliView.args], { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => resolve(err ? undefined : stdout));
    }),
  ping: async (socket) => ({ headers: (await unixGet(socket, "/_ping")).headers }),
  version: async (socket) => JSON.parse((await unixGet(socket, "/version")).body) as VersionInfo,
};
