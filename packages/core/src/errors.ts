import type { AgentId, AgentState } from "./types.ts";

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

export class SandboxUnavailableError extends Error {
  kind = "unavailable" as const;
  constructor() {
    super("sandbox unavailable");
    this.name = "SandboxUnavailableError";
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
