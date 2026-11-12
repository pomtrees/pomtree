import type { SandboxCapability } from "./sandbox-capabilities.ts";
import type { AgentId, AgentState, SandboxBackendId, SandboxId } from "./types.ts";

// All error classes the ports and adapters share live here, re-exported through index.ts.
// Keep them dependency-free: they carry only fields, never behavior.

// Thrown when a compare-and-set operation's generation no longer matches the registry
// (fences stale senders and stale checkpoint/resume writes).
export class StaleGenerationError extends Error {
  agent: AgentId;
  got: number;
  current: number;
  constructor(agent: AgentId, got: number, current: number) {
    super(`stale generation for ${agent}: got ${got}, current ${current}`);
    this.name = "StaleGenerationError";
    this.agent = agent;
    this.got = got;
    this.current = current;
  }
}

export class IllegalTransitionError extends Error {
  agent: AgentId;
  from: AgentState;
  to: AgentState;
  constructor(agent: AgentId, from: AgentState, to: AgentState) {
    super(`illegal transition for ${agent}: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
    this.agent = agent;
    this.from = from;
    this.to = to;
  }
}

// Default text per reason: the cause and the action. No reason keeps the bare "sandbox unavailable".
const UNAVAILABLE_BY_REASON = {
  "engine-unreachable": "sandbox unavailable (engine-unreachable): the sandbox engine did not answer; start or restart it and check its socket permissions",
  auth: "sandbox unavailable (auth): the provider rejected the credential; check the configured sandbox credential and its permissions",
  "provider-outage": "sandbox unavailable (provider-outage): the provider is failing; wait and retry, or check the provider's status page",
  "not-found": "sandbox unavailable (not-found): the sandbox no longer exists; start a new one, or let reconcile find its successor",
} as const;

export class SandboxUnavailableError extends Error {
  kind = "unavailable" as const;
  // Why it is unavailable, when the adapter knows. Named `reason`: `Error.cause` is the standard chained-error field.
  reason: "engine-unreachable" | "auth" | "provider-outage" | "not-found" | undefined;
  constructor(reason?: SandboxUnavailableError["reason"], message?: string) {
    super(message ?? (reason === undefined ? "sandbox unavailable" : UNAVAILABLE_BY_REASON[reason]));
    this.name = "SandboxUnavailableError";
    this.reason = reason;
  }
}

// `Sandbox.start` timed out or lost its reply, so it is unknown whether the provider created the sandbox. The id is
// deterministic (sandboxIdForKey), so the caller retries `start` with the same key (idempotent by contract); if that cannot
// complete, boot reconcile finds the sandbox through `list(owner)`.
export class SandboxOutcomeUnknownError extends Error {
  id: SandboxId;
  idempotencyKey: string;
  constructor(id: SandboxId, idempotencyKey: string, cause?: unknown) {
    super(
      `the outcome of starting sandbox ${id} is unknown (no reply from the backend); retry start with the same idempotency key, which is safe, or let startup reconcile find the sandbox`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "SandboxOutcomeUnknownError";
    this.id = id;
    this.idempotencyKey = idempotencyKey;
  }
}

// A record's live sandbox belongs to a different backend than the one now selected. The pin lifecycle is a deliberate rule
// (state-validate.ts, sandboxBackendAfter): the backend is pinned for as long as the record holds a sandbox id, and clearing the
// sandbox clears the pin, so a run whose start failed definitively under one backend is not stuck on it, while a live sandbox
// keeps its backend. Resume, attach, reclaim and a second start refuse rather than look for the sandbox in the wrong place. At boot
// the daemon does not refuse to start for it: it holds the agent (reconcile.ts) and the operator either selects the recorded backend
// again or runs `pomtree abandon <agent>`. `agent` is the record's id when the throw site has it.
export class SandboxBackendMismatchError extends Error {
  sandbox: SandboxId | null;
  recorded: SandboxBackendId;
  selected: SandboxBackendId;
  agent?: string;
  constructor(sandbox: SandboxId | null, recorded: SandboxBackendId, selected: SandboxBackendId, agent?: string) {
    super(
      `agent${agent === undefined ? " record" : ` ${agent}`}${sandbox === null ? "" : ` (sandbox ${sandbox})`} was created under backend ${recorded}; the selected backend is ${selected}; the agent is held: select ${recorded} again (sandbox.backend), or run \`pomtree abandon ${agent ?? "<agent>"}\``,
    );
    this.name = "SandboxBackendMismatchError";
    this.sandbox = sandbox;
    this.recorded = recorded;
    this.selected = selected;
    if (agent !== undefined) this.agent = agent;
  }
}

// A capability the caller needs is declared false (or its facet is missing) on the active backend.
export class SandboxCapabilityError extends Error {
  backend: SandboxBackendId;
  capability: SandboxCapability;
  action: string;
  constructor(backend: SandboxBackendId, capability: SandboxCapability, action: string) {
    super(`sandbox backend ${backend} does not support ${capability}; ${action}`);
    this.name = "SandboxCapabilityError";
    this.backend = backend;
    this.capability = capability;
    this.action = action;
  }
}

// A probe reported something it may not: probes only narrow a declaration (a capability declared false cannot be withheld, a
// capability absent from the declaration cannot appear), and their result must be well formed. `widened` names every offence,
// widening or malformed.
export class SandboxProbeError extends Error {
  backend: SandboxBackendId;
  widened: string[];
  constructor(backend: SandboxBackendId, widened: string[]) {
    super(
      `sandbox backend ${backend} probe result is malformed or widens its declaration: ${widened.join(", ")}; a probe must return withheld, problems and account, and may only withhold capabilities the declaration marks true, so fix the adapter's probe or declaration`,
    );
    this.name = "SandboxProbeError";
    this.backend = backend;
    this.widened = widened;
  }
}

// 429, concurrency cap or plan limit: admission holds and backs off the budget named by `scope`; never a crash.
export class SandboxQuotaError extends Error {
  backend: SandboxBackendId;
  scope: "rate" | "concurrency" | "plan";
  retryAfterMs: number | null;
  constructor(backend: SandboxBackendId, scope: SandboxQuotaError["scope"], retryAfterMs: number | null) {
    super(
      `sandbox backend ${backend} refused the request over its ${scope} limit; ${
        scope === "plan" ? "raise the provider plan or stop other sandboxes" : "wait and retry"
      }${retryAfterMs === null ? "" : ` (retry after ${retryAfterMs} ms)`}`,
    );
    this.name = "SandboxQuotaError";
    this.backend = backend;
    this.scope = scope;
    this.retryAfterMs = retryAfterMs;
  }
}

// A file transfer into or out of a sandbox failed its integrity or size check. Nothing partial is kept by the caller.
export class SandboxTransferError extends Error {
  id: SandboxId;
  reason: "hash-mismatch" | "partial" | "too-large";
  constructor(id: SandboxId, reason: SandboxTransferError["reason"]) {
    super(
      `file transfer for sandbox ${id} failed: ${
        reason === "hash-mismatch"
          ? "sha256 did not match, so the data was discarded; retry the transfer"
          : reason === "partial"
            ? "the transfer ended early, so the data was discarded; retry the transfer"
            : "the data exceeds the allowed size; raise the limit or send less"
      }`,
    );
    this.name = "SandboxTransferError";
    this.id = id;
    this.reason = reason;
  }
}

// Typed failure for `Sandbox.start`. `kind` classifies the failure and `retryable`
// tells the caller whether a bounded retry can succeed (e.g. a transient pull/network
// failure) or whether retrying is futile (a bad image reference). See TODO(spawn-fail).
export class SandboxStartError extends Error {
  // `egress_start_failed`: the per-sandbox egress proxy or its socket volume could not be stood up (fail closed, before the worker exists).
  kind: "image_unavailable" | "pull_failed" | "endpoint_unreachable" | "egress_start_failed" | "unknown";
  retryable: boolean;
  constructor(kind: SandboxStartError["kind"], message: string, retryable: boolean) {
    super(message);
    this.name = "SandboxStartError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

// A template manifest could not be resolved or parsed. The id is carried on `templateId`,
// not `name`, so it does not shadow the standard `Error.name` field.
export class TemplateError extends Error {
  templateId: string;
  constructor(templateId: string) {
    super(`template error: ${templateId}`);
    this.name = "TemplateError";
    this.templateId = templateId;
  }
}

// A stored checkpoint is not in the current format (CHECKPOINT_FORMAT): it carries no `version` (`version` is undefined) or a different one.
export class UnsupportedCheckpointVersion extends Error {
  version: number | undefined;
  supported: number;
  constructor(version: number | undefined, supported: number) {
    super(
      version === undefined
        ? `checkpoint has no format version; it predates the baseline (this build reads version ${supported}): remove or re-create the agent`
        : `unsupported checkpoint version ${version} (this build reads version ${supported}): remove or re-create the agent, or run a build that reads it`,
    );
    this.name = "UnsupportedCheckpointVersion";
    this.version = version;
    this.supported = supported;
  }
}

// A state write was refused by policy, not by a conflict (conflicts are typed results on StateStore). `idempotency-mismatch`: an
// idempotency key was reused for a different request. `unknown-writer`: an agent writer the registry does not know (or a store with no registry lookup).
export type StateErrorKind = "invalid-key" | "invalid-value" | "too-large" | "quota-docs" | "quota-owner-bytes" | "idempotency-mismatch" | "unknown-writer";
export class StateError extends Error {
  kind: StateErrorKind;
  constructor(kind: StateErrorKind, message: string) {
    super(`state ${kind}: ${message}`);
    this.name = "StateError";
    this.kind = kind;
  }
}

// An idempotency key was replayed with a different request than the one it first answered (Stripe / IETF Idempotency-Key draft:
// 409 Conflict). The store records a fingerprint (a hash of the canonical request) beside each key; a replay with the same
// fingerprint returns the first result, a different one throws this and changes nothing. The caller must use a fresh key.
export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict" as const;
  scope: string;
  key: string;
  constructor(scope: string, key: string) {
    super(`idempotency key ${JSON.stringify(key)} was already used for a different ${scope} request; retry the original request unchanged, or use a new key`);
    this.name = "IdempotencyConflictError";
    this.scope = scope;
    this.key = key;
  }
}

// Lowering the root pool (Registry.setRootPool) asked for more than the root's unheld remainder: the pool minus everything its
// children hold (carves, and consumption past a carve) and the root's own settled and in-flight use. Refused in full, never
// clipped; nothing changed and nothing was journaled.
export class RootWithdrawalError extends Error {
  readonly root: AgentId;
  readonly requestedMicros: number;
  readonly heldMicros: number;
  readonly availableMicros: number;
  constructor(root: AgentId, fromMicros: number, toMicros: number, heldMicros: number) {
    const requested = fromMicros - toMicros;
    const available = Math.max(0, fromMicros - heldMicros);
    super(
      `budget.rootMicros ${toMicros} withdraws ${requested} micros from the root pool of ${fromMicros}, but ${heldMicros} are held (carved to agents or spent and in flight) and only ${available} are available; nothing was withdrawn. Lower the withdrawal (set budget.rootMicros to at least ${fromMicros - available}) or wait for holds to settle and stop or reap agents first`,
    );
    this.name = "RootWithdrawalError";
    this.root = root;
    this.requestedMicros = requested;
    this.heldMicros = heldMicros;
    this.availableMicros = available;
  }
}
