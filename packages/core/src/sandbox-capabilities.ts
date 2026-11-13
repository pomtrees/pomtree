import { createHash } from "node:crypto";
import { SandboxCapabilityError, SandboxProbeError } from "./errors.ts";
import type { ProbeResult, Sandbox, SandboxFacets } from "./ports.ts";
import type { HostId, SandboxBackendId, SandboxId } from "./types.ts";

// Pure, no I/O: the capability vocabulary, the declaration an adapter makes of it, and the boot-time decisions taken from that
// declaration. This module imports only types from ports.ts (no runtime cycle).

export const SANDBOX_CAPABILITIES = [
  "terminal", // interactive pty attach
  "connect", // daemon-initiated byte stream into the sandbox
  "loopback", // byte stream to a TCP port on the sandbox's own loopback (LOOPBACK_PORTS), no port published
  "files.put",
  "files.get",
  "files.volume",
  "mounts.host", // host-path realisation through MountProvider (local family only)
  "image.ociPull",
  "image.template",
  "image.digestAttest",
  "snapshot.disk",
  "snapshot.memory",
  "fork",
  "pause",
  "list.byTag", // server-side tag filter; list() itself is required
  "egress.denyAll",
  "egress.allowHost",
  "egress.allowCidr",
  "reach.outbound",
  "reach.exposedPort",
  "reach.hostAlias",
  "secrets.env", // create-time env not persisted into image/template (SandboxSpec.env is non-secret by contract)
  "secrets.proxySwap", // provider egress proxy substitutes a placeholder with the real secret (preferred where present)
  "resources.limits", // cpu/memory/pids enforced (lost on rootless Podman without cgroup v2 delegation)
  "isolation.gvisor", // ociRuntime.runsc; Kubernetes RuntimeClass
  // The sandbox runs in its own VM kernel (Kata, Firecracker RuntimeClass; hosted microVMs). A probe must confirm the selected
  // RuntimeClass handler or provider runtime is a VM type (e.g. the handler is in the adapter's VM allowlist), never by name alone
  // from the template; otherwise it withholds the capability.
  "isolation.microvm",
  // The provider's lifetime/idle deadline can be pushed out. Plain-Pod Kubernetes declares false (activeDeadlineSeconds can only
  // decrease); without it the daemon rotates the sandbox at 80% of its lease: checkpoint, start a successor, stop the old one.
  "lease.extend",
] as const;
export type SandboxCapability = (typeof SANDBOX_CAPABILITIES)[number];

export interface SandboxDeclaration {
  readonly backend: SandboxBackendId;
  readonly capabilities: Readonly<Record<SandboxCapability, boolean>>;
  readonly region: string | null; // resolved from sandbox.<id>.* config at construction; null = provider has no regions
  // "none" is expressible only so validateDeclaration can refuse it.
  readonly idempotency: "unique-name" | "native-token" | "tag-lookup" | "none";
  readonly idempotencyWindowMs: number | null; // native-token: minimum time the provider keeps keys; null = unbounded
  // How pomtree's tags are stored: provider metadata, or encoded into the resource name for providers with no metadata.
  // Name-encoded resources are found by list(owner) with a client-side name-prefix filter.
  readonly tagging: "metadata" | "name-encoded";
  readonly output: "stream" | "poll";
  readonly maxLifetimeMs: number | null; // provider-enforced hard limit (dead-man switch); null = none
  readonly preemptible: boolean;
  // Drives orphan-reclaim priority and the economy budget (docs/economy.md).
  readonly billing: { unit: "none" | "second" | "minute" | "hour"; whileStopped: boolean; whilePaused: boolean };
  readonly local?: { seccompProfile: boolean; sysctlIpv6Disable: boolean }; // the local family's hardening facts
}

// What the daemon's resolved configuration requires of the backend (built from config, pure).
export interface BackendNeeds {
  egress: boolean; // any template sets egress
  daemonReach: true; // the agent must reach the daemon API and model relay
  terminal: boolean;
  workspace: "mount" | "staged"; // staged = git bundle over connect "workspace", else files.put/get tarball
  isolation?: "gvisor" | "microvm"; // a template asks for this runtime; each needs its own capability, with no fallback
  // agentToken: the agent needs a credential delivered into the sandbox. envAllowed: the operator opted into create-time env
  // delivery (sandbox env is otherwise non-secret by contract).
  secrets: { agentToken: boolean; envAllowed: boolean };
}

export type AdmitResult =
  | { ok: true; degraded: { capability: SandboxCapability; fallback: string }[] }
  | { ok: false; refusals: { capability: SandboxCapability | null; cause: string; action: string }[] };

// Which facet realises which capability. A facet is present iff at least one of its capabilities is declared true (conformance
// case). Capabilities absent from this map have no facet: they change how a required method behaves (list.byTag, egress.*,
// reach.*, mounts.host, image.ociPull, image.digestAttest, secrets.*, resources.limits, isolation.*, files.volume) or qualify a
// facet (fork = a snapshot may be started more than once; snapshot.memory = snapshots.create accepts memory: true).
export const FACET_OF = {
  terminal: "terminal",
  connect: "connect",
  loopback: "loopback",
  "files.put": "files",
  "files.get": "files",
  "snapshot.disk": "snapshots",
  "snapshot.memory": "snapshots",
  fork: "snapshots",
  pause: "pause",
  "image.template": "images",
  "lease.extend": "lease",
} as const satisfies Partial<Record<SandboxCapability, keyof SandboxFacets>>;
export type FacetCapability = keyof typeof FACET_OF;

// The tag keys every hosted resource is stamped with (the codec lives in sandbox-kit).
export const SANDBOX_TAGS = {
  sandbox: "pomtree.sandbox",
  agent: "pomtree.agent",
  backend: "pomtree.backend",
  host: "pomtree.host",
  generation: "pomtree.generation",
} as const;

// The owner stamp every sandbox carries: the daemon host and the agent generation it was started for (SandboxSpec.host/generation).
export interface OwnerStamp {
  host: HostId;
  generation: number;
}

const hasControlChar = (v: string): boolean => [...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

// The tag map for a stamp. Refuses a value no provider could hold safely, before anything is created: an empty or control-character
// host (a newline would corrupt a label argument), or a generation that is not a non-negative safe integer.
export function ownerStampTags(stamp: OwnerStamp): Record<string, string> {
  if (typeof stamp.host !== "string" || stamp.host === "" || hasControlChar(stamp.host)) {
    throw new Error(
      `sandbox host id ${JSON.stringify(String(stamp.host).slice(0, 80))} must be a non-empty string without control characters, so it can be stamped on the sandbox; pass the daemon's host id in SandboxSpec.host`,
    );
  }
  if (!Number.isSafeInteger(stamp.generation) || stamp.generation < 0) {
    throw new Error(
      `sandbox generation ${String(stamp.generation)} must be a non-negative integer, so it can be stamped on the sandbox; pass the agent's generation in SandboxSpec.generation`,
    );
  }
  return { [SANDBOX_TAGS.host]: stamp.host, [SANDBOX_TAGS.generation]: String(stamp.generation) };
}

// Reads a stamp back from DECODED tags. A missing tag, a host with a control character (ownerStampTags never writes one), or a generation that is not plain digits naming a safe integer, reads as null
// (untagged or damaged: reconcile reports it and never adopts it); Number("") and Number(" 1") would otherwise read as numbers.
export function readOwnerStamp(tags: Readonly<Record<string, string | undefined>>): { host: HostId | null; generation: number | null } {
  const host = tags[SANDBOX_TAGS.host];
  const gen = tags[SANDBOX_TAGS.generation];
  const generation = gen !== undefined && /^\d+$/.test(gen) && Number.isSafeInteger(Number(gen)) ? Number(gen) : null;
  return { host: host === undefined || host === "" || hasControlChar(host) ? null : host, generation };
}

// Deterministic sandbox id for a caller's idempotency key (sha256 hex): repeating a start() key resolves to the same
// resource name (pomtree-<id>) and the same handle without launching a second sandbox. The key must be unique per logical start.
export function sandboxIdForKey(idempotencyKey: string): SandboxId {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

const BACKEND_ID = /^[a-z0-9-]+$/;
const IDEMPOTENCY = ["unique-name", "native-token", "tag-lookup"];
const BILLING_UNITS = ["none", "second", "minute", "hour"];

// Returns the reasons a declaration cannot be registered; [] = valid. Each reason names the cause and the action.
export function validateDeclaration(d: SandboxDeclaration): string[] {
  const out: string[] = [];
  const who = typeof d.backend === "string" ? d.backend : String(d.backend);
  if (typeof d.backend !== "string" || !BACKEND_ID.test(d.backend)) {
    out.push(`backend id ${JSON.stringify(d.backend)} is not lowercase [a-z0-9-]+ (":" is reserved for future named profiles); rename the backend`);
  }
  if (d.idempotency === "none") {
    out.push(
      `backend ${who} declares idempotency "none": after an unknown create outcome it can neither find nor prevent a duplicate sandbox; refuse this backend, or implement unique-name, native-token or tag-lookup`,
    );
  } else if (!IDEMPOTENCY.includes(d.idempotency)) {
    out.push(`backend ${who} declares idempotency ${JSON.stringify(d.idempotency)}; use unique-name, native-token or tag-lookup`);
  }
  const caps: Record<string, unknown> = d.capabilities ?? {};
  const missing = SANDBOX_CAPABILITIES.filter((c) => typeof caps[c] !== "boolean");
  if (missing.length > 0) {
    out.push(`backend ${who} does not answer capabilities ${missing.join(", ")} with true or false; declare every capability`);
  }
  const unknown = Object.keys(caps).filter((c) => !(SANDBOX_CAPABILITIES as readonly string[]).includes(c));
  if (unknown.length > 0) {
    out.push(`backend ${who} declares unknown capabilities ${unknown.join(", ")}; remove them or add them to SANDBOX_CAPABILITIES`);
  }
  if (caps.fork === true && caps["snapshot.disk"] !== true && caps["snapshot.memory"] !== true) {
    out.push(
      `backend ${who} declares fork without snapshot.disk or snapshot.memory: a fork starts from a snapshot; declare a snapshot capability or set fork to false`,
    );
  }
  if (d.tagging !== "metadata" && d.tagging !== "name-encoded") {
    out.push(`backend ${who} declares tagging ${JSON.stringify(d.tagging)}; use metadata or name-encoded`);
  }
  if (d.output !== "stream" && d.output !== "poll") {
    out.push(`backend ${who} declares output ${JSON.stringify(d.output)}; use stream or poll`);
  }
  if (!BILLING_UNITS.includes(d.billing?.unit)) {
    out.push(`backend ${who} declares billing unit ${JSON.stringify(d.billing?.unit)}; use none, second, minute or hour`);
  }
  for (const [name, v] of [
    ["idempotencyWindowMs", d.idempotencyWindowMs],
    ["maxLifetimeMs", d.maxLifetimeMs],
  ] as const) {
    if (v !== null && !(Number.isFinite(v) && v > 0)) {
      out.push(`backend ${who} declares ${name} ${String(v)}; use a positive number of milliseconds, or null for none`);
    }
  }
  return out;
}

// Boot-time admission. A security- or reach-bearing gap refuses (SPEC rule 8: deny, never allow); a convenience gap degrades to
// behaviour pomtree already has and names it. A capability the probe withholds counts as declared false; probe problems refuse.
// Fails closed: a malformed or widening probe throws SandboxProbeError (checkProbe) rather than reading as "all available".
export function admitBackend(d: SandboxDeclaration, probe: ProbeResult | null, needs: BackendNeeds): AdmitResult {
  if (probe !== null) checkProbe(d, probe);
  const withheld = new Set<string>(probe?.withheld ?? []);
  const has = (c: SandboxCapability) => d.capabilities[c] === true && !withheld.has(c);
  const refusals: { capability: SandboxCapability | null; cause: string; action: string }[] = [];
  const degraded: { capability: SandboxCapability; fallback: string }[] = [];
  const b = d.backend;
  const refuse = (capability: SandboxCapability | null, cause: string, action: string) => refusals.push({ capability, cause, action });
  const why = (c: SandboxCapability) => (withheld.has(c) ? "withheld by the backend's readiness probe" : "not declared");

  for (const p of probe?.problems ?? []) refuse(null, `backend ${b} is not ready: ${p.cause} (${p.code})`, p.action);

  if (needs.egress && !(has("egress.allowHost") || (has("egress.denyAll") && has("connect")))) {
    refuse(
      "egress.allowHost",
      `backend ${b} cannot enforce a default-deny egress allowlist (egress.allowHost ${why("egress.allowHost")}; egress.denyAll with connect is not available either)`,
      `use a backend that enforces egress, or remove egress from the templates`,
    );
  }
  if (!(has("connect") || has("reach.outbound") || has("mounts.host"))) {
    refuse(
      "connect",
      `backend ${b} gives the agent no route to the daemon API and model relay (none of connect, reach.outbound, mounts.host is available)`,
      `use a backend that declares one of them`,
    );
  }
  if (!has("resources.limits")) {
    refuse(
      "resources.limits",
      `backend ${b} does not enforce cpu, memory and pids limits (resources.limits ${why("resources.limits")}), and admission control assumes limits are enforced`,
      `use a backend that enforces resource limits, or fix the host (for rootless Podman, enable cgroup v2 delegation)`,
    );
  }
  if (needs.isolation !== undefined) {
    const runtime = needs.isolation === "gvisor" ? "gVisor" : "microVM";
    const cap = needs.isolation === "gvisor" ? "isolation.gvisor" : "isolation.microvm";
    if (!has(cap)) {
      refuse(
        cap,
        `a template asks for ${runtime} isolation but backend ${b} does not provide it (${cap} ${why(cap)}); pomtree never falls back to a weaker runtime, and gVisor and microVM do not substitute for each other`,
        `use a backend that declares ${cap}, or remove the runtime block from the template`,
      );
    }
  }
  if (needs.secrets.agentToken && !(has("connect") || (has("secrets.env") && needs.secrets.envAllowed))) {
    refuse(
      "secrets.env",
      `the agent needs a credential delivered but backend ${b} can neither deliver it after start over connect (${why("connect")}) nor take it as create-time env with the operator's opt-in (secrets.env ${why("secrets.env")}, env delivery ${needs.secrets.envAllowed ? "allowed" : "not allowed"})`,
      `use a backend that declares connect, or one that declares secrets.env and enable env credential delivery in the configuration`,
    );
  }
  if (!(has("image.ociPull") || has("image.template"))) {
    refuse(
      "image.ociPull",
      `backend ${b} can neither pull OCI images nor use prepared templates (image.ociPull and image.template ${why("image.ociPull")})`,
      `use a backend that supports one of them`,
    );
  } else if (!has("image.ociPull")) {
    degraded.push({ capability: "image.ociPull", fallback: "images.prepare builds a provider template before the first start of an image" });
  }

  const tarball = has("files.put") && has("files.get");
  if (needs.workspace === "mount") {
    if (!has("mounts.host")) {
      if (has("connect")) degraded.push({ capability: "mounts.host", fallback: 'workspace as a git bundle both ways over connect channel "workspace"' });
      else if (tarball) degraded.push({ capability: "mounts.host", fallback: "workspace as a sha256-checked tarball through files.put and files.get" });
      else {
        refuse(
          "mounts.host",
          `backend ${b} cannot mount the host workspace and has neither connect nor files.put with files.get to stage it`,
          `use a backend with host mounts, connect or file transfer`,
        );
      }
    }
  } else if (!(has("connect") || tarball || has("mounts.host"))) {
    refuse(
      "connect",
      `the workspace is configured as staged but backend ${b} has neither connect nor files.put with files.get`,
      `use a backend with connect or file transfer, or configure a mounted workspace`,
    );
  }

  if (needs.terminal && !has("terminal")) {
    degraded.push({ capability: "terminal", fallback: "the terminal route returns a typed error naming the backend; everything else runs" });
  }
  if (!has("snapshot.disk") && !has("snapshot.memory")) {
    degraded.push({
      capability: "snapshot.disk",
      fallback: "checkpoints stay workspace-level (git bundle) and resume starts a fresh sandbox under a new generation",
    });
  }
  // TODO(snapshot-memory-degrade): the admission table has no degrade entry for a backend with `snapshot.memory` only; current behavior: no entry is
  // added, so the gap is silent.
  if (!has("pause")) degraded.push({ capability: "pause", fallback: "stop, then resume fresh" });
  if (!has("lease.extend")) {
    degraded.push({
      capability: "lease.extend",
      fallback: "rotate at 80% of the lease: checkpoint, start a successor under a new generation, then stop the old sandbox",
    });
  }
  if (!has("list.byTag")) degraded.push({ capability: "list.byTag", fallback: "list everything and filter by the tag codec client-side" });
  if (!has("image.digestAttest")) degraded.push({ capability: "image.digestAttest", fallback: "the daemon resolves image identity from the registry" });

  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, degraded };
}

// A probe may only NARROW a declaration: it may withhold a capability declared true, nothing else. Throws SandboxProbeError
// naming every offence, including a malformed result.
export function checkProbe(d: SandboxDeclaration, r: ProbeResult): void {
  const bad: string[] = [];
  const probe: unknown = r;
  if (typeof probe !== "object" || probe === null) {
    throw new SandboxProbeError(d.backend, ["the probe result is not an object"]);
  }
  const { withheld, problems, account } = probe as Record<string, unknown>;
  if (!Array.isArray(withheld)) bad.push("withheld is not an array");
  else {
    for (const c of withheld) {
      if (typeof c !== "string" || !(SANDBOX_CAPABILITIES as readonly string[]).includes(c)) bad.push(`withheld names unknown capability ${JSON.stringify(c)}`);
      else if (d.capabilities[c as SandboxCapability] !== true) bad.push(`withheld ${c}, which is not declared true`);
    }
  }
  if (!Array.isArray(problems)) bad.push("problems is not an array");
  else {
    problems.forEach((p, i) => {
      const o = p as Record<string, unknown> | null;
      if (typeof o !== "object" || o === null || typeof o.code !== "string" || typeof o.cause !== "string" || typeof o.action !== "string") {
        bad.push(`problems[${i}] lacks a string code, cause and action`);
      }
    });
  }
  if (account !== null && typeof account !== "string") bad.push("account is neither a string nor null");
  if (bad.length > 0) throw new SandboxProbeError(d.backend, bad);
}

// The facet that realises `capability`, or SandboxCapabilityError when the backend declares it false or declares it true but
// provides no facet (an adapter bug the conformance case also catches). `need` reads only the static declaration: when a probe
// has withheld a capability, a call site must also consult the boot admission result (admitBackend), because `need` alone
// still returns the facet.
// TODO(sandbox-admission-probe): only the Podman egress probe (pomtreed's probeLocalBackend) feeds admitBackend; every other backend is
// admitted with a null probe result, so a capability a future probe withholds is not seen until that backend ships its probe.
export function need<C extends FacetCapability>(s: Sandbox, capability: C): NonNullable<Sandbox[(typeof FACET_OF)[C]]> {
  const backend = s.declaration.backend;
  if (s.declaration.capabilities[capability] !== true) {
    throw new SandboxCapabilityError(
      backend,
      capability,
      `choose a backend that declares ${capability} (sandbox.backend), or disable the feature that needs it`,
    );
  }
  const name = FACET_OF[capability];
  const facet = s[name];
  if (facet === undefined || facet === null) {
    throw new SandboxCapabilityError(
      backend,
      capability,
      `the adapter declares ${capability} but provides no ${name} facet; fix the adapter or declare it false`,
    );
  }
  return facet as NonNullable<Sandbox[(typeof FACET_OF)[C]]>;
}
