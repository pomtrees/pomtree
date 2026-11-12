// Registry entries for everything pomtreed reads from its environment. pomtreed resolves them through resolveConfig
// (pomtreed daemon-config.ts), so this is the one declaration of the values; e2e/src/config-registry-drift.test.ts keeps the
// importable old defaults that still exist equal to these.
//
// A path default of "" means "unset": the consumer derives the value (named in the doc).
import { denylistReason, freshnessRulesReason } from "../capture.ts";
import { DEFAULT_DENIED_PATHS } from "../merge.ts";
import { parseStateLimits } from "../state.ts";
import type { ParamDef } from "./registry.ts";
import {
  BUILTIN_SANDBOX_BACKEND_IDS,
  SANDBOX_BACKEND_AUTO,
  SANDBOX_BACKEND_ID_RE,
  reviewedBackendsReason,
  sandboxBackendShapeReason,
} from "./sandbox-manifest.ts";

const POMTREED = "@pomtree/pomtreed";
const POMTREE = "@pomtree/pomtree";
const HARNESS = "@pomtree/harness-pi";
const HN_DIGEST = "examples/hn-digest";

const isPlainObject = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);
const plainObject = (what: string) => (v: unknown) => (isPlainObject(v) ? null : `${what} must be a JSON object`);
const MAX_SESSIONS_RE = /^[1-9][0-9]*$/;
const CHAT_APPROVAL_ROUTES: readonly string[] = ["spawn", "cancel"];
const USER_AGENT_MAX = 256;
// The operator's User-Agent (decision C4): a header value set verbatim, so printable ASCII only (no CR/LF or other control byte can
// split or inject a header); free-form otherwise, but it must start with a product token (an app name, optionally "/version"). A
// contact (an email address or an http(s) URL) is optional but recommended, as sites such as SEC EDGAR ask. Empty means the
// default at resolution (blankIsDefault), so this check never sees "" (and refuses it if a caller passes one).
const USER_AGENT_PRODUCT_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:\/[\x21-\x7e]+)?(?:\s|$)/;
// The registry default only (no lower layer defaults): a bare product token, no version, since robots matching strips the version
// anyway and a version would change userAgentIdOf (the capture cache key) on every release.
export const DEFAULT_FETCH_USER_AGENT = "pomtree";
const USER_AGENT_EXAMPLE = 'Set it to a product token such as "pomtree", optionally followed by a contact, e.g. "pomtree (+https://example.org/contact)"';
export const userAgentReason = (v: string): string | null => {
  if (v === "") return `is empty. ${USER_AGENT_EXAMPLE}`;
  if (v.length > USER_AGENT_MAX) return `is ${v.length} characters; a User-Agent is at most ${USER_AGENT_MAX}. Shorten it. ${USER_AGENT_EXAMPLE}`;
  if (!/^[\x20-\x7e]+$/.test(v))
    return `must be printable ASCII (space through ~): control characters such as CR, LF and tab, and non-ASCII, are refused. ${USER_AGENT_EXAMPLE}`;
  if (v.trim() !== v) return "has leading or trailing whitespace, which a header value cannot carry. Remove it";
  if (!USER_AGENT_PRODUCT_RE.test(v)) return `must start with a product token (an app name, optionally /version, then a space). ${USER_AGENT_EXAMPLE}`;
  return null;
};

// `agent.egressProxyImage`: the same shapes sandbox-docker's DockerDeps.egressProxyImage accepts, a digest-pinned
// `name[:tag]@sha256:<64 hex>` or a local image id `sha256:<64 hex>`. Empty: unset (see the param's doc).
const PINNED_IMAGE_RE = /^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/;
export const egressProxyImageReason = (v: string): string | null =>
  v === "" || PINNED_IMAGE_RE.test(v)
    ? null
    : `${JSON.stringify(v)} is not digest-pinned: set it to name[:tag]@sha256:<64 hex> or a local image id sha256:<64 hex> (docker image inspect --format '{{.Id}}' <image> prints one)`;

// `agent.untemplatedEgress`: the egress kinds a spawn that names no template may run with. Empty: unset (pomtreed refuses to start).
const UNTEMPLATED_EGRESS = ["none", "registry"];
export const untemplatedEgressReason = (v: string): string | null =>
  v === "" || UNTEMPLATED_EGRESS.includes(v)
    ? null
    : `${JSON.stringify(v)} is not one of: none, registry (or leave it unset, which pomtreed refuses to start on)`;

// `test.fetchHosts`: hostname -> loopback port (pomtreed test-fetch.ts is the transport). One definition of the shape, used by the
// registry check and by pomtreed's parser. A port only, never an address: the seam can reach nothing but 127.0.0.1.
const TEST_FETCH_HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
export function testFetchHostsReason(v: unknown): string | null {
  if (!isPlainObject(v)) return 'must be a JSON object {"<hostname>": <loopback port>}';
  for (const [host, port] of Object.entries(v as Record<string, unknown>)) {
    if (!TEST_FETCH_HOSTNAME_RE.test(host)) return `key ${JSON.stringify(host)} must be a lowercase DNS hostname such as data.sec.gov (no scheme, port or IP)`;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
      return `${host} must map to a loopback port (an integer 1-65535); the fixture is always reached at 127.0.0.1`;
  }
  return null;
}

export const DAEMON_PARAMS = [
  // --- state dir and the state store ---------------------------------------------------------------------------------
  {
    path: "state.dir",
    kind: "path",
    default: "",
    doc: "The daemon's state directory (store, tokens, socket). Unset: ~/.pomtreed. The pomtree client reads it to find the socket and operator token.",
    scope: "operator",
    consumers: [POMTREED, POMTREE, HN_DIGEST],
  },
  {
    path: "state.grants",
    kind: "json",
    default: {},
    // Shape only here; pomtreed state-policy.ts parseStateGrants owns the semantics (drivers, templates, owners, modes).
    check: plainObject("state.grants"),
    doc: 'State-store grants: {"<driver or template id>": [{owner, prefix?, mode: "r"|"rw"}]}. Parsed by pomtreed parseStateGrants.',
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "state.limits",
    kind: "json",
    default: {},
    // Delegates to the one parser (core state.ts), so the registry and the daemon cannot disagree on what is valid.
    check: (v: unknown) => {
      parseStateLimits(JSON.stringify(v));
      return null;
    },
    doc: "State-store quotas: {default?: Limits, owners?: {name: Limits}}; unset fields inherit STATE_LIMITS_DEFAULT. Parsed by core parseStateLimits.",
    scope: "operator",
    consumers: [POMTREED, HN_DIGEST],
  },

  // --- directories under the state dir -------------------------------------------------------------------------------
  {
    path: "report.dir",
    kind: "path",
    default: "",
    doc: "Where agent reports are stored. Unset: <state.dir>/reports.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "templates.dir",
    kind: "path",
    default: "",
    doc: "Agent template directory. Unset: <state.dir>/templates.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "session.dir",
    kind: "path",
    default: "",
    doc: "Root of the per-agent Pi session directories. Unset: <state.dir>/sessions.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "envCache.dir",
    kind: "path",
    default: "",
    doc: "Environment layer cache (<dir>/<manifestHash>). Unset: <state.dir>/env-cache.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "extensions.dir",
    kind: "path",
    default: "",
    doc: "Extension host directory (realpathed at start). Unset: <state.dir>/extensions.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "extensions.approval",
    kind: "string",
    default: "",
    doc: "Extensions whose gated actions need an approval: none, all, or a comma list of extension names. Required: pomtreed refuses to start while it is unset.",
    scope: "operator",
    consumers: [POMTREED],
  },

  // --- sockets, listeners and serving --------------------------------------------------------------------------------
  {
    path: "socket.path",
    kind: "path",
    default: "",
    doc: "The daemon's operator unix socket. Unset: <state.dir>/pomtreed.sock (shortened when over the OS path limit). Clients use POMTREE_SOCKET.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "sandbox.socket",
    kind: "path",
    default: "/run/pomtreed.sock",
    doc: "The daemon socket's path inside an agent container.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    // Core accepts any well-formed id because a provider's id is unknown until its manifest is composed; composeRegistry (extend.ts)
    // closes the set to auto, the built-in ids and the composed backends' ids. The schema lists the built-ins and stays open.
    path: "sandbox.backend",
    kind: "string",
    default: "docker",
    check: sandboxBackendShapeReason,
    schema: { anyOf: [{ enum: [SANDBOX_BACKEND_AUTO, ...BUILTIN_SANDBOX_BACKEND_IDS] }, { type: "string", pattern: SANDBOX_BACKEND_ID_RE.source }] },
    doc: `Which sandbox backend runs agents: ${SANDBOX_BACKEND_AUTO}, ${BUILTIN_SANDBOX_BACKEND_IDS.join(", ")}, or the id an installed extension provides (that one also needs a pin in sandbox.reviewedBackends). auto picks an installed local engine (docker, then podman) and never a hosted or contributed backend. The backend's own keys are sandbox.<id>.*.`,
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "sandbox.secretsInEnv",
    kind: "bool",
    default: false,
    doc: "Allow a backend with no better channel to receive the daemon token in the sandbox's create-time environment, which the provider console and engine inspect output can show. Off: such a backend is refused for agents that need a token.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "sandbox.reviewedBackends",
    kind: "list",
    default: [],
    check: reviewedBackendsReason,
    doc: "Content-hash pins of reviewed extension-provided backends, entries <id>=sha256:<hex>. A contributed backend is constructed only when sandbox.backend names it and its directory hashes to its pin here; a changed byte refuses boot and prints the new hash.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "sandbox.maxDayMicros",
    kind: "micros",
    default: 0,
    doc: "Daily runtime spend ceiling across all backends together, in micro-dollars. 0 = a billed backend admits nothing until the operator sets it; local backends that bill nothing ignore it.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "agent.listen",
    kind: "string",
    default: "",
    doc: "Agent endpoint listener, host:port ([::1]:0 for IPv6; port 0 = ephemeral) or off. Unset: Linux binds the docker bridge gateway plus loopback, elsewhere 127.0.0.1:0. An explicit host other than loopback or the detected docker bridge gateway needs listen.allowNonloopback. Parsed by pomtreed parseListen.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "agent.probe",
    kind: "bool",
    default: true,
    doc: "On Linux with the gateway plan, prove agent-endpoint reachability from a real container at start.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "ui.listen",
    kind: "string",
    default: "off",
    doc: "Operator UI listener, host:port or off. Loopback only unless listen.allowNonloopback. Parsed by pomtreed parseListen.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "host.listen",
    kind: "string",
    default: "off",
    doc: "Host-read (adapter) listener, host:port or off. Loopback only unless listen.allowNonloopback. Parsed by pomtreed parseListen.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "listen.allowNonloopback",
    kind: "bool",
    default: false,
    doc: "Accept a non-loopback bind for the plain-HTTP UI and host listeners, and an agent listener on a host other than loopback or the docker bridge gateway (put TLS and auth in front).",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "readyz.allowSandboxDown",
    kind: "bool",
    default: false,
    doc: "Report ready while the sandbox (Docker) is down.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "accessLog.mode",
    kind: "enum",
    values: ["auto", "off", "errors", "all"],
    default: "auto",
    doc: "Access log on stdout, one line per request, for the daemon and the model proxy. auto: all on a TTY, else errors.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "drain.timeoutMs",
    kind: "ms",
    default: 10_000,
    doc: "How long shutdown waits for in-flight work to drain. Keep below the service manager's stop timeout.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "host.id",
    kind: "string",
    default: "",
    doc: "This daemon's host id, stamped on every record. Unset: os.hostname().",
    scope: "operator",
    consumers: [POMTREED],
  },

  // --- retention ------------------------------------------------------------------------------------------------------
  {
    path: "idempotency.retentionMs",
    kind: "ms",
    default: 30 * 24 * 3_600_000,
    min: 1,
    doc: "How long idempotency records are kept.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "audit.spoolVacuumGraceMs",
    kind: "ms",
    default: 24 * 3_600_000,
    max: 30 * 24 * 3_600_000,
    doc: "How long after its sandbox closed an egress audit spool is kept before it is deleted, once every row is acknowledged and journaled (the journal is the record; the spool is the raw copy). 0 = delete as soon as eligible. Each spool counts against the spool retention cap (AUDIT_MAX_SPOOLS) until then.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "journal.retentionMs",
    kind: "ms",
    default: 0,
    doc: "Journal pruning age; 0 = no pruning.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "journal.keepPerAgent",
    kind: "count",
    default: 1000,
    doc: "Newest journal entries kept per agent when pruning (journal.retentionMs > 0).",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "folder.retentionMs",
    kind: "ms",
    default: 7 * 24 * 3600 * 1000,
    doc: "Paused agents idle past this lose their folder; 0 = never.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "folder.reapedGraceMs",
    kind: "ms",
    default: 0,
    doc: "How long a reaped agent's folder is kept.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "folder.minFreeBytes",
    kind: "bytes",
    default: 0,
    doc: "Below this much free disk the cleanup sweep removes eligible folders early; 0 = off.",
    scope: "operator",
    consumers: [POMTREED],
  },

  // --- repository, merge and publish ---------------------------------------------------------------------------------
  {
    path: "repo.dir",
    kind: "path",
    default: "",
    doc: "The operator's repository agents clone from and merge into. Unset: the daemon's working directory.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "repo.defaultBranch",
    kind: "string",
    default: "",
    doc: "The branch agents start from and merge into. Unset: the repository's HEAD branch, else main.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "merge.deny",
    kind: "list",
    default: [...DEFAULT_DENIED_PATHS],
    doc: "Repo-relative path prefixes a merge may not touch. Empty = no denylist.",
    scope: "operator",
    consumers: [POMTREED],
  },
  // TODO(merge-checks): no production CheckRunner exists, so boot refuses while this is set (safety-boot.ts); a runner lands, drop that refusal.
  {
    path: "merge.check",
    kind: "string",
    default: "",
    doc: "Whitespace-separated command a merge must pass; empty = merges run with no check. No check runner is wired in this build, so pomtreed refuses to start while it is set.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "publish.targets",
    kind: "list",
    default: [],
    doc: "remote/branch targets the daemon may publish to (only the daemon pushes).",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "publish.deny",
    kind: "list",
    default: [...DEFAULT_DENIED_PATHS],
    doc: "Repo-relative path prefixes a publish may not touch. Empty = no denylist.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "publish.scan",
    kind: "bool",
    default: true,
    doc: "Scan a publish for credentials, commit messages and CI-file additions before pushing.",
    scope: "operator",
    consumers: [POMTREED],
  },

  // --- agents and sessions -------------------------------------------------------------------------------------------
  {
    path: "agent.image",
    kind: "string",
    default: "pomtree/agent:dev",
    doc: "The agent container image.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    // egress-image: the daemon, not the template author, chooses the image that enforces an agent's egress policy.
    path: "agent.egressProxyImage",
    kind: "string",
    default: "",
    check: egressProxyImageReason,
    doc: "The digest-pinned image the per-agent egress-proxy sidecar runs for every container spawn (name[:tag]@sha256:<64 hex>, or a local image id sha256:<64 hex>, e.g. the agent image's id from docker image inspect --format '{{.Id}}'), checked with docker image inspect before each sidecar starts. Required: pomtreed refuses to start while it is unset.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "agent.untemplatedEgress",
    kind: "string",
    default: "",
    check: untemplatedEgressReason,
    doc: "Egress of a spawn that names no template (the built-in code template): registry (the model proxy and the package registries only; use this for a first run) or none (no network at all: an untemplated agent cannot reach the model proxy, so its model calls fail; pomtreed warns at start). Required: pomtreed refuses to start while it is unset.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "agent.tokenTtlMs",
    kind: "ms",
    default: 24 * 60 * 60 * 1000,
    min: 1,
    doc: "Lifetime of the agent API token issued when a container starts.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "agent.maxDepth",
    kind: "count",
    default: 4,
    doc: "Deepest spawn depth allowed. The root supervisor is depth 0 and operator-spawned agents are depth 1; a spawn is refused when its depth exceeds this value, so 0 refuses all spawns and 1 permits only operator-spawned agents.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "agent.maxChildren",
    kind: "count",
    default: 8,
    doc: "Unreaped children one non-root parent may hold.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "agent.zombieMs",
    kind: "ms",
    default: 600_000,
    min: 1,
    doc: "How long an exited agent may stay unreaped before the zombie sweep raises an alert; the sweep never reaps it.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "agent.zombieSweepMs",
    kind: "ms",
    default: 30_000,
    min: 1,
    doc: "Interval of the zombie sweep, which also applies `--ttl` expiry on held children. Lower it only to make tests deterministic.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "agent.reconcileSweepMs",
    kind: "ms",
    default: 30_000,
    min: 1,
    doc: "Interval between reconcile passes (container and record drift, operator-token expiry). Lower it only to make tests deterministic.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "agent.rootCustodyMax",
    kind: "count",
    default: 32,
    min: 1,
    doc: "Exited results held for the operator because their parent chain is dead up to the root; past this many, each further delivery is also raised as an alert. Results are never dropped.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "agent.interruptGraceMs",
    kind: "ms",
    default: 5000,
    doc: "After an interrupt, how long Pi may take to exit before the container is killed.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "agent.adoptOrphans",
    kind: "bool",
    default: false,
    doc: "On start, adopt running agent containers this daemon has no record of.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "harness.steerExt",
    kind: "bool",
    default: true,
    doc: "Load the Pi mailbox (steer) extension, through which a waiting agent sees messages.",
    scope: "operator",
    consumers: [POMTREED, HARNESS],
  },
  {
    path: "harness.jobsExt",
    kind: "bool",
    default: false,
    doc: "Load the opt-in, unverified Pi background-jobs extension.",
    scope: "operator",
    consumers: [POMTREED, HARNESS],
  },
  {
    path: "session.maxMs",
    kind: "ms",
    default: 4 * 60 * 60 * 1000,
    min: 1,
    doc: "Longest session a spawn may request.",
    scope: "operator",
    consumers: [POMTREED],
    // The agent token is issued once per container start (lifecycle.ts agentToken) and never refreshed, so a longer session
    // would lose its API credential before its deadline.
    relations: [{ op: "lte", key: "agent.tokenTtlMs" }],
  },
  {
    path: "session.defaultMs",
    kind: "ms",
    default: 4 * 60 * 60 * 1000,
    min: 1,
    doc: "Session length of a spawn that names none.",
    scope: "run",
    consumers: [POMTREED],
    ceiling: "session.maxMs",
  },
  {
    path: "wait.yieldMs",
    kind: "ms",
    default: 20_000,
    doc: "A pomtree wait/inbox/ask wait longer than this yields the agent's container instead of long-polling. pomtreed delivers it to agent containers, so the in-container pomtree long-polls exactly as long as the daemon allows.",
    scope: "operator",
    consumers: [POMTREED, POMTREE],
    container: true,
  },

  // --- capacity (the session-cap formula inputs: autoMaxSessions) -------------------------------------------------------
  {
    path: "capacity.maxSessions",
    kind: "string",
    default: "auto",
    check: (v: string) => (v === "auto" || (MAX_SESSIONS_RE.test(v) && Number.isSafeInteger(Number(v))) ? null : 'expected "auto" or a positive integer'),
    doc: "Concurrent session cap: auto (min(memoryFraction*RAM/containerMemoryBytes, cpus/2*3, maxContainers, 16), at least 2) or a positive integer, which bypasses the 16 cap.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "capacity.maxContainers",
    kind: "count",
    default: 32,
    min: 1,
    doc: "Container limit enforced by the resource gate; also bounds the auto session cap.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "capacity.containerMemoryBytes",
    kind: "bytes",
    default: 2 * 1024 ** 3,
    min: 1,
    // pomtreed passes it as the real --memory limit of every container whose spec names none (daemon-util.ts specResources) and
    // reserves it per running container in the memory gate (host-guards.ts memoryGate, memoryHolders).
    doc: "Memory limit of a container whose spec names none, and the per-running-container reservation the memory gate and the auto session cap plan for.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "capacity.memoryFraction",
    kind: "ratio",
    default: 0.9,
    min: 0.01,
    doc: "Fraction of host RAM the memory gate and the auto session cap may plan for.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "capacity.minDiskFreeBytes",
    kind: "bytes",
    default: 1 << 30,
    doc: "Free disk below which the resource gate refuses new sessions.",
    scope: "operator",
    consumers: [POMTREED],
  },

  // --- budget (root and top-level are in params.ts) ------------------------------------------------------------------
  {
    path: "budget.defaultMicros",
    kind: "micros",
    default: 1_000_000,
    min: 1,
    doc: "Budget carved for an agent-spawned child that names none.",
    scope: "run",
    consumers: [POMTREED],
    relations: [{ op: "lte", key: "budget.topLevelMicros" }],
  },
  {
    path: "budget.raiseMs",
    kind: "ms",
    default: 86_400_000,
    min: 1,
    doc: "Per-rung window of a human rung on a budget_raise approval.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "budget.raisePct",
    kind: "count",
    default: 50,
    min: 1,
    doc: "Requested budget raise, as a percent of the agent's original budget.",
    scope: "operator",
    consumers: [POMTREED],
  },

  // --- sweeps and timers ---------------------------------------------------------------------------------------------
  {
    path: "watchdog.sweepMs",
    kind: "ms",
    default: 30_000,
    min: 1,
    doc: "Watchdog sweep interval.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "watchdog.stallMs",
    kind: "ms",
    default: 10 * 60_000,
    min: 1,
    doc: "Silence after which the watchdog judges an agent stalled.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "watchdog.blockedMs",
    kind: "ms",
    default: 30 * 60_000,
    min: 1,
    doc: "Time blocked after which the watchdog acts.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "watchdog.intensityWindowMs",
    kind: "ms",
    default: 60 * 60_000,
    min: 1,
    doc: "Window over which watchdog restart intensity is counted.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "watchdog.stableMs",
    kind: "ms",
    default: 30 * 60_000,
    min: 1,
    doc: "Run time after which a restarted agent counts as stable again.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "cron.tickMs",
    kind: "ms",
    default: 60_000,
    min: 1,
    doc: "Cron scheduler tick interval.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "cleanup.sweepMs",
    kind: "ms",
    default: 60_000,
    min: 1,
    doc: "Folder cleanup sweep interval.",
    scope: "operator",
    consumers: [POMTREED],
  },

  // --- approvals, asks, escalation and messaging ---------------------------------------------------------------------
  {
    path: "approval.timeoutMs",
    kind: "ms",
    default: 300_000,
    min: 1,
    doc: "Per-rung fail-closed window of a human approval rung (also the web_fetch approval window).",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "ask.timeoutMs",
    kind: "ms",
    default: 24 * 3_600_000,
    min: 1,
    doc: "How long an ask stays open.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "escalation.agentRungMs",
    kind: "ms",
    default: 600_000,
    min: 1,
    doc: "Per-hop window of an agent rung on a bubbled ask or approval.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "escalation.channels",
    kind: "list",
    default: ["ui"],
    doc: "Ordered channels asks and alerts go out on; the root broadcasts to every one.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "messaging.channels",
    kind: "list",
    default: [],
    doc: "Chat-rank messaging channels to enable (each needs the sender allowlist POMTREED_MESSAGING_SENDERS).",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "messaging.allowSpawn",
    kind: "bool",
    default: false,
    doc: "Allow chat-rank senders to spawn agents.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "chat.approval",
    kind: "list",
    default: [],
    check: (v: readonly string[]) => {
      const bad = v.filter((r) => !CHAT_APPROVAL_ROUTES.includes(r));
      return bad.length === 0 ? null : `unknown route ${bad.join(", ")}: expected spawn, cancel`;
    },
    doc: "Chat-initiated routes (spawn, cancel) that wait for a human approval.",
    scope: "operator",
    consumers: [POMTREED],
  },

  // --- workflows -------------------------------------------------------------------------------------------------------
  {
    path: "workflow.reviewedExtensions",
    kind: "list",
    default: [],
    doc: "Extensions whose workflow drivers are reviewed. Validated by pomtreed WorkflowRuntimePolicy.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "workflow.templates",
    kind: "json",
    default: {},
    check: plainObject("workflow.templates"),
    doc: 'Templates each reviewed workflow driver may spawn: {"<ext>/<driver>": ["<template>", ...]}. Parsed by pomtreed WorkflowRuntimePolicy.',
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    // Operator identity only: no workflow capability field can set or override it (a workflow cannot choose who it claims to be).
    // TODO(capture-broker): flag-day rename to fetch.userAgent with examples
    path: "workflow.fetch.userAgent",
    kind: "string",
    default: DEFAULT_FETCH_USER_AGENT,
    blankIsDefault: true,
    check: userAgentReason,
    doc: 'The one operator identity for every fetch path: sent on every request and redirect hop of agent web_fetch, the workflow fetch capability and every capture broker rung, and appended to Chromium\'s own User-Agent in browser captures (never a desktop-browser impersonation). Free-form, but it must start with a product token (an app name, optionally /version). A contact (an email address or an http(s) URL) is optional but recommended, e.g. "pomtree (+https://example.org/contact)"; some sites, such as SEC EDGAR, ask for one. Its product token is also the robots.txt token evaluated beside Claude-User. Blank or unset: the default "pomtree". pomtreed logs the effective identity at startup.',
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    // Operator pacing only, like the User-Agent: no workflow capability field can lower it.
    path: "workflow.fetch.minIntervalMs",
    kind: "ms",
    default: 0,
    max: 60_000,
    doc: "Minimum time between two requests the workflow fetch capability sends to the same host, across every workflow on this daemon; each redirect hop is a request. E.g. 100 keeps SEC EDGAR (sec.gov) under its 10 requests per second. 0: unpaced.",
    scope: "operator",
    consumers: [POMTREED],
  },

  // --- test-only seams (refused together unless test.mode; pomtreed daemon-config.ts) -----------------------------------------
  {
    path: "test.mode",
    kind: "bool",
    default: false,
    doc: "Test mode: the only switch that admits the test-only seams below. pomtreed prints a WARNING at start while it is on. Never set it in production.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "test.fetchHosts",
    kind: "json",
    default: {},
    check: testFetchHostsReason,
    doc: 'Test only, refused unless test.mode: route the workflow fetch capability for these hosts to a loopback fixture, {"data.sec.gov": 8443} -> http://127.0.0.1:8443 with the original Host header. The capability\'s allowlist, budget and caps still apply; other hosts use the network. Empty: off.',
    scope: "operator",
    consumers: [POMTREED],
  },

  // --- model proxy and Pi (model.upstreamKey is in params.ts) ----------------------------------------------------------
  {
    path: "model.baseUrl",
    kind: "string",
    default: "",
    doc: "The model provider's upstream base URL. Required: pomtreed refuses to start without it.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "model.upstreamTimeoutMs",
    kind: "ms",
    default: 120_000,
    min: 1,
    doc: "Upstream request timeout of the model proxy; also the stale-reservation reclaim age.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "model.proxy.port",
    kind: "count",
    default: 18080,
    min: 1,
    max: 65535,
    doc: "Model proxy TCP port.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "model.proxy.ttlMs",
    kind: "ms",
    default: 3_600_000,
    min: 1,
    // TODO(config-registry): the proxy key is issued once per container start (gateway.ts issueKey), so with the defaults a
    // session longer than 1 h (session.maxMs is 4 h) outlives its model credential; no relation is declared until that is
    // decided (SUSPECTED: refresh path not found).
    doc: "Lifetime of the scoped model-proxy key issued when a container starts.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "model.proxy.maxRequestMicros",
    kind: "micros",
    default: 50_000,
    min: 1,
    doc: "Reserved (and charged when cost cannot be read) per request to a model missing from the catalog. Not a per-request ceiling.",
    scope: "operator",
    consumers: [POMTREED, HN_DIGEST],
  },
  {
    path: "model.proxy.extraPaths",
    kind: "list",
    default: [],
    doc: "Upstream paths the proxy allows beyond its default allowlist.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "pi.provider",
    kind: "string",
    default: "",
    doc: "The provider the scoped proxy credential is written for (required; e.g. openrouter).",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "pi.catalogDir",
    kind: "path",
    default: "",
    doc: "Pi model catalog directory (pricing). Unset: found from the pi binary on PATH.",
    scope: "operator",
    consumers: [POMTREED],
  },

  // --- web tools ---------------------------------------------------------------------------------------------------------
  {
    path: "search.provider",
    kind: "string",
    default: "",
    doc: "web_search provider; empty = none.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "search.key",
    kind: "string",
    default: "",
    sensitive: true,
    // The derived name POMTREED_SEARCH_KEY is refused for a sensitive key ("set POMTREED_SEARCH_KEY_FILE to a file holding it").
    doc: "The web_search provider's API key.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "webfetch.enabled",
    kind: "bool",
    default: true,
    doc: "Offer web_fetch (runs on the host network, bypassing container egress).",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "webfetch.maxCalls",
    kind: "count",
    default: 60,
    min: 1,
    doc: "web_fetch and web_search calls allowed per agent per fixed window (one shared count). Windows are aligned to the Unix epoch, not sliding, so up to twice this many calls can pass in a short span across a window boundary.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "webfetch.windowMs",
    kind: "ms",
    default: 60_000,
    min: 1,
    doc: "Length of the web_fetch and web_search call-quota window. Fixed windows start at multiples of this since Unix time 0 (not sliding), so a burst can span a boundary (see webfetch.maxCalls).",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "webfetch.timeoutMs",
    kind: "ms",
    default: 30_000,
    min: 1000,
    max: 300_000,
    doc: "Whole-call deadline of one agent web_fetch call, every redirect hop included; past it the call is aborted and fails as a timeout.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "webfetch.maxTotalBytes",
    kind: "bytes",
    default: 32 * 1024 * 1024,
    // Each admitted call reserves ext-gateway's per-response cap (DEFAULT_MAX_BODY_BYTES, 1 MiB) until it settles, so a smaller
    // total would deny every call.
    min: 1024 * 1024,
    doc: "Total web_fetch bytes allowed per agent.",
    scope: "operator",
    consumers: [POMTREED],
  },

  // --- the capture broker -------------------------------------------------------------------------
  {
    path: "capture.waitMs",
    kind: "ms",
    default: 20_000,
    min: 0,
    max: 120_000,
    doc: "How long a capture request blocks before it returns pending (the requireApproval precedent); retrying with the same idempotency key, or waiting on the job, converges on the same job.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "capture.timeoutMs",
    kind: "ms",
    default: 30_000,
    min: 1000,
    max: 600_000,
    doc: "Whole-acquisition deadline of one capture rung (connect, first byte and body, every redirect hop included); past it the rung fails as a timeout.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    // 8 MiB: well above an EDGAR filing index or a long article, and below the egress proxy's 16 MiB per-connection relay cap
    // (audit finding relay-class), which an artifact upload carrying the body plus its archive overhead must fit under.
    path: "capture.maxBytes",
    kind: "bytes",
    default: 8 * 1024 * 1024,
    min: 1024,
    max: 16 * 1024 * 1024,
    doc: "Per-capture body cap; a larger body fails too_large. At most 16 MiB, the egress proxy's per-connection relay cap.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "capture.freshness.stableMs",
    kind: "ms",
    default: 7 * 86_400_000,
    min: 1,
    doc: "Maximum age of a cached capture of a stable page (DOI landing pages, documentation, reference pages).",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "capture.freshness.dailyMs",
    kind: "ms",
    default: 86_400_000,
    min: 1,
    relations: [{ op: "lte", key: "capture.freshness.stableMs" }],
    doc: "Maximum age of a cached capture of a daily page (articles, filing indexes, blog posts); the default class.",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "capture.freshness.liveMs",
    kind: "ms",
    default: 600_000,
    min: 1,
    relations: [{ op: "lte", key: "capture.freshness.dailyMs" }],
    doc: "Maximum age of a cached capture of a live page (feeds, front pages, prices).",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "capture.freshness.rules",
    kind: "json",
    default: [],
    check: freshnessRulesReason,
    doc: 'Operator freshness rules, first match wins: [{"host": "www.sec.gov", "pathPrefix": "/Archives/", "class": "immutable"}, ...]; class is immutable, stable, daily or live. A URL no acquirer classes and no rule matches is daily. Parsed by core parseFreshnessRules.',
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "capture.denylist",
    kind: "list",
    default: [],
    check: denylistReason,
    doc: "Hosts the broker never captures (blocked/policy): each entry matches the host and its subdomains (core denylistMatch).",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    // Per-agent defaults until Template.capture.quota (S4) can set them per template.
    path: "capture.quota.requests",
    kind: "count",
    default: 120,
    min: 1,
    doc: "Capture requests one agent may make per capture.quota.windowMs (cache hits included: the quota bounds the requester, not the origin).",
    scope: "operator",
    consumers: [POMTREED],
  },
  {
    path: "capture.quota.windowMs",
    kind: "ms",
    default: 3_600_000,
    min: 1000,
    doc: "The capture request quota window.",
    scope: "operator",
    consumers: [POMTREED],
  },

  // --- orchestration and telemetry ---------------------------------------------------------------------------------------
  {
    path: "otlp.endpoint",
    kind: "string",
    default: "",
    doc: "OTLP exporter endpoint; empty = no export.",
    scope: "operator",
    consumers: [POMTREED],
  },
] as const satisfies readonly ParamDef[];
