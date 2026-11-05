import type { NewAgent } from "./ports.ts";
import type {
  AllowlistProfile,
  AgentId,
  AgentRecord,
  Approval,
  ApprovalId,
  ApprovalKind,
  EscalationId,
  WaitCondition,
  Delivered,
  DeterministicSpec,
  ExitCause,
  ExitStatus,
  Handoff,
  HostId,
  JsonValue,
  SignalId,
  SpawnSpec,
  TemplateId,
} from "./types.ts";

// Contract for a non-container (deterministic) agent. Reviewed driver code receives a DeterministicRunContext and
// touches the world only through DeterministicOps; the host owns identity, fencing, budget, deadlines and cleanup.
// This is a cooperative contract for reviewed code, not isolation: in-process driver code can use ambient daemon privileges
// and bypass these types. Only reviewed, promoted drivers are admitted; isolation is a separate, later decision.

const MAX_JSON_DEPTH = 64;

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

// Strict JSON data: no undefined, functions, NaN/Infinity, holes, class instances or cycles (depth-bounded).
export function isJsonValue(v: unknown, depth = 0): v is JsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (!(i in v) || !isJsonValue(v[i], depth + 1)) return false;
    return true;
  }
  if (isPlainObject(v)) return Object.keys(v).every((k) => isJsonValue(v[k], depth + 1));
  return false;
}

// Fails closed: exactly { driver, input }, a non-empty driver name and JSON-only input.
export function parseDeterministicSpec(v: unknown): DeterministicSpec {
  if (!isPlainObject(v)) throw new Error("deterministic spec must be an object");
  if (Object.keys(v).sort().join(",") !== "driver,input") throw new Error("deterministic spec must have exactly driver and input");
  if (typeof v.driver !== "string" || v.driver.trim() === "") throw new Error("deterministic spec driver must be a non-empty string");
  if (!isJsonValue(v.input)) throw new Error("deterministic spec input must be JSON data");
  return { driver: v.driver, input: v.input };
}

// The single authority for "which spec goes with which executor". Unknown executors and malformed specs throw.
export function checkExecutorSpec(
  executor: unknown,
  spec: unknown,
): { executor: "container"; spec: SpawnSpec } | { executor: "deterministic"; spec: DeterministicSpec } {
  if (executor === "container") {
    if (!isPlainObject(spec)) throw new Error("container spec must be an object");
    return { executor, spec: spec as unknown as SpawnSpec };
  }
  if (executor === "deterministic") return { executor, spec: parseDeterministicSpec(spec) };
  throw new Error(`unknown executor ${JSON.stringify(executor)}`);
}

// Validated executor and spec of a NewAgent. Only an omitted (undefined) executor means "container"; an explicit null or any
// other value goes to checkExecutorSpec and fails closed.
export const newAgentExecutor = (a: NewAgent) => checkExecutorSpec(a.executor === undefined ? "container" : a.executor, a.spec);

// Where a message goes. Only the sender's own addressable neighbours; the host stamps the sender and generation.
export type MessageTarget = { kind: "self" } | { kind: "parent" } | { kind: "child"; child: AgentId };

// Child spawn request. The host derives the parent (this agent), the host placement and the model; the driver never
// names them. A container child may name an optional template (the host validates it); `requireAllowlist` makes the host refuse the spawn
// unless the resolved template carries exactly that allowlist profile (the caller's guard that its worker never gets the default loadout); a deterministic child names a spec.
export type ExecutorSpawnRequest = {
  name: string;
  task: string;
  budgetMicros?: number; // carved from this agent's remaining budget by the host; never trusted beyond it
  deadlineMs?: number;
  idempotencyKey: string; // required; the host derives the child id from (this agent, key), so a replay returns the same child
} & (
  | { executor?: "container"; template?: TemplateId; model?: { provider: string; id: string }; requireAllowlist?: AllowlistProfile }
  | { executor: "deterministic"; spec: DeterministicSpec }
);

// Serializable reap receipt. `exit`/`exitCause`/`result` are the child's durable outcome as recorded by the host (the complete
// structured result, not the clipped handoff); `unusedMicros` is the budget returned to this agent on reap.
export interface ExecutorReapReceipt {
  child: AgentId;
  state: AgentRecord["state"];
  exit: ExitStatus | null;
  exitCause?: ExitCause;
  // Closed cause token (`[a-z_]{1,32}`) that the child's last failed tool reported in its error text, `(cause=<token> ...)`; set by the host
  // from the child's journal, absent when no tool failed that way. Metadata only: never tool output, a URL or page text. The meaning of
  // the tokens belongs to the tool (e.g. the browser worker's capture failure causes); consumers map it and treat unknown tokens as "other".
  toolFailureCause?: string;
  result: unknown;
  unusedMicros: number;
}

// Host-mediated operations. Each mutation takes an idempotency key. While the run's admitted generation is active, a repeated
// key returns the original result. Once the context is terminated, stale or aborted, every call is rejected, even a replay:
// locked late-operation fencing outranks idempotency after the context's lifetime. Effects admitted before termination may
// still complete; cancellation is not rollback, and delivery is not exactly-once.
export interface DeterministicOps {
  // Read this agent's inbox without consuming it.
  peek(): Promise<Delivered[]>;
  // Ack delivered signals by id after handling them; returns the ids actually removed.
  ack(ids: SignalId[], idempotencyKey: string): Promise<SignalId[]>;
  // Send a message body (never an arbitrary Signal) to self, parent or one of this agent's children.
  message(to: MessageTarget, body: string, idempotencyKey: string): Promise<void>;
  // Spawn a child; the request's idempotencyKey makes the call replay-safe. Resolves to the child id.
  spawn(child: ExecutorSpawnRequest): Promise<AgentId>;
  // Discover this owner's existing child, including exited/reaped rows, without spawning or carving again.
  findChild(spawnKey: string): Promise<AgentRecord | null>;
  // Reviewed opt-in workflows only. Persist a task-local snapshot and wait, then unwind this body. Never returns.
  // Catching the suspension does not release execution: the body and admitted effects must settle before a new generation.
  // Resume preserves task identity/custody and supplies `continuation`; callers must persist receipts before ack/spawn.
  // Message keys of continuation workflows must be unique per logical message: a replayed run re-sends under the same key,
  // so a reused key for a different message is deduplicated away rather than delivered.
  // A wake does not mean the awaited dependency is done: a message or timer wait, or an any-mode child_exited wait, also wakes on an
  // escalation or a custody hand-up. The body must re-check its preconditions after it resumes; only an all-mode child_exited join
  // guarantees that every listed child has exited.
  suspend(state: JsonValue, wait: WaitCondition, key: string): Promise<never>;
  answerEscalation(id: EscalationId, answer: string, key: string): Promise<void>;
  // Forward the SAME held ask or agent-approvable approval rung; the existing daemon policy checks holder authority.
  passEscalation(id: EscalationId, key: string): Promise<void>;
  // Publish targets must be the draft's sha256. Identity is bound to kind + target + key; a changed target opens a
  // different approval, never reuses authority over another draft. External-effect kinds require human approvers.
  openApproval(kind: ApprovalKind, target: string, key: string): Promise<Approval>;
  getApproval(id: ApprovalId): Promise<Approval | null>;
  // Reap an exited child this agent owns; returns the budget the host reclaimed.
  reap(child: AgentId, idempotencyKey: string): Promise<ExecutorReapReceipt>;
  // Submit the structured result. `summary` is required and non-empty (the Handoff convention).
  submitResult(result: Handoff, idempotencyKey: string): Promise<void>;
}

export interface DeterministicRunContext {
  agent: AgentId;
  generation: number; // fencing token; every op the host accepts is fenced to this generation
  host: HostId;
  input: JsonValue; // the spec's input, passed through unchanged
  continuation?: JsonValue; // last durable task-local suspension snapshot; absent on the initial segment
  signal: AbortSignal; // aborts on cancel, timeout or generation change; in-process adapter over the host message
  deadlineAt: number | null; // epoch ms, or null when the run has no deadline
  ops: DeterministicOps;
}

// run resolves when the driver is done. Success requires a submitted result: the host rejects a return without one.
// Only reviewed opt-in WorkflowDef adapters may instead suspend; arbitrary deterministic drivers cannot replay or resume.
export interface DeterministicExecutor {
  readonly driver: string;
  run(ctx: DeterministicRunContext): Promise<void>;
}
