import { EGRESS_LABEL } from "./args.ts";

// The ONE shared user-defined network every egress sidecar joins (workers stay --network none and reach their sidecar
// over the per-sandbox socket volume). Inter-container communication is off, so a sidecar (or anything else attached
// here) cannot reach another container's ports on this network, while outbound traffic through the bridge gateway works.
//
// Lifecycle: created lazily by ensureEgressNetwork() before each sidecar start, never deleted by per-sandbox cleanup or
// the orphan sweep (other sandboxes' sidecars may be attached), and removed only by removeEgressNetwork(), an explicit
// operator/test action that Docker itself refuses while any container is still attached.
export const EGRESS_NETWORK = "pomtree-egress";
export const EGRESS_NETWORK_ROLE_LABEL = "pomtree.egress.network";
export const ICC_OPTION = "com.docker.network.bridge.enable_icc";

type NetExec = (args: string[]) => Promise<string>;

const errmsg = (e: unknown) => String(e instanceof Error ? e.message : e);
const NOT_FOUND = /no such network|network \S+ not found/i;
const ALREADY_EXISTS = /already exists/i;

export class EgressNetworkMismatchError extends Error {}

// The labels mirror the egress socket volumes' marker (EGRESS_LABEL) plus a role label naming the shared network. There
// is no per-sandbox or per-daemon owner label: the network is host-local Docker state shared by every daemon on the engine.
export function egressNetworkCreateArgs(name: string): string[] {
  return [
    "network",
    "create",
    "--driver",
    "bridge",
    "--opt",
    `${ICC_OPTION}=false`,
    "--label",
    `${EGRESS_LABEL}=1`,
    "--label",
    `${EGRESS_NETWORK_ROLE_LABEL}=shared`,
    name,
  ];
}

export const egressNetworkInspectArgs = (name: string): string[] => ["network", "inspect", "--format", "{{json .}}", name];

// Pure: the reasons an inspected network must not be used as the egress network (empty when it is ours and correct).
export function egressNetworkProblems(inspected: string): string[] {
  let n: { Driver?: unknown; Internal?: unknown; Options?: Record<string, unknown> | null; Labels?: Record<string, unknown> | null };
  try {
    n = JSON.parse(inspected);
  } catch {
    return ["docker network inspect output is not JSON"];
  }
  if (!n || typeof n !== "object" || Array.isArray(n)) return ["docker network inspect output is not an object"];
  const problems: string[] = [];
  if (n.Driver !== "bridge") problems.push(`driver is ${JSON.stringify(n.Driver)}, not "bridge"`);
  if (n.Internal !== false) problems.push("it is internal (no outbound route for the sidecar)");
  if (n.Options?.[ICC_OPTION] !== "false") problems.push(`${ICC_OPTION} is ${JSON.stringify(n.Options?.[ICC_OPTION] ?? "unset")}, not "false"`);
  if (n.Labels?.[EGRESS_LABEL] !== "1" || n.Labels?.[EGRESS_NETWORK_ROLE_LABEL] !== "shared")
    problems.push("it does not carry the pomtree egress network labels");
  return problems;
}

async function inspect(exec: NetExec, name: string): Promise<string | undefined> {
  try {
    return await exec(egressNetworkInspectArgs(name));
  } catch (e) {
    if (NOT_FOUND.test(errmsg(e))) return undefined;
    throw e;
  }
}

function assertUsable(name: string, inspected: string): void {
  const problems = egressNetworkProblems(inspected);
  if (problems.length)
    throw new EgressNetworkMismatchError(
      `docker network ${name} exists but is not a pomtree egress network (${problems.join("; ")}); refusing to attach sidecars to it. Remove or rename it (docker network rm ${name}) and retry.`,
    );
}

// Idempotent and race-safe: inspect first; create when missing; a concurrent creator (another start in this daemon or
// another daemon on the engine) surfaces as "already exists", after which the winner's network is validated like any
// pre-existing one. A same-named network with the wrong driver, options or labels is a hard error, never reused.
export async function ensureEgressNetwork(exec: NetExec, name: string = EGRESS_NETWORK): Promise<"created" | "existing"> {
  let inspected = await inspect(exec, name);
  if (inspected === undefined) {
    try {
      await exec(egressNetworkCreateArgs(name));
      return "created";
    } catch (e) {
      if (!ALREADY_EXISTS.test(errmsg(e))) throw e;
      inspected = await inspect(exec, name);
      if (inspected === undefined) throw e;
    }
  }
  assertUsable(name, inspected);
  return "existing";
}

// Explicit operator/test removal. Refuses a same-named network that is not ours; Docker refuses while containers are
// attached ("has active endpoints"), which propagates. Returns false when it is already gone.
export async function removeEgressNetwork(exec: NetExec, name: string = EGRESS_NETWORK): Promise<boolean> {
  const inspected = await inspect(exec, name);
  if (inspected === undefined) return false;
  assertUsable(name, inspected);
  try {
    await exec(["network", "rm", name]);
  } catch (e) {
    if (NOT_FOUND.test(errmsg(e))) return false;
    throw e;
  }
  return true;
}
