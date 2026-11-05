import type { ModelCallErrorClass, ModelCallRoute, ModelPriceBasis } from "./ports.ts";
import type { AgentId, ApprovalId, JsonValue } from "./types.ts";
import { auditUrl, CAPTURE_PURPOSE_MAX, stripControl } from "./capture.ts";
import type { AcquisitionSource, CaptureFailureClass, CaptureId, CaptureJobId, CaptureKeyRender, CaptureRung } from "./capture.ts";

// The single registry of daemon-private journal kinds (`ext.pomtreed.*`). Producers (pomtreed) and matchers (core waiting/settle,
// observe) import these names; no `ext.pomtreed.` literal may be written anywhere else in a file that can import core.
export const POMTREED_KIND_PREFIX = "ext.pomtreed." as const;

export const POMTREED_KINDS = {
  approval: "ext.pomtreed.approval",
  awaitUser: "ext.pomtreed.await_user",
  budget: "ext.pomtreed.budget",
  budgetDenied: "ext.pomtreed.budget_denied",
  budgetEscalated: "ext.pomtreed.budget_escalated",
  budgetGranted: "ext.pomtreed.budget_granted",
  budgetOverage: "ext.pomtreed.budget_overage",
  budgetTopUp: "ext.pomtreed.budget_topup",
  budgetWithdrawal: "ext.pomtreed.budget_withdrawal",
  captureRequested: "ext.pomtreed.capture_requested",
  captureSettled: "ext.pomtreed.capture_settled",
  captureStep: "ext.pomtreed.capture_step",
  deadline: "ext.pomtreed.deadline",
  escalationExpired: "ext.pomtreed.escalation_expired",
  escalationHop: "ext.pomtreed.escalation_hop",
  fork: "ext.pomtreed.fork",
  holdTtlDeferred: "ext.pomtreed.hold_ttl_deferred",
  hostHealth: "ext.pomtreed.host_health",
  interrupt: "ext.pomtreed.interrupt",
  interruptDone: "ext.pomtreed.interrupt_done",
  mergeSkipped: "ext.pomtreed.merge_skipped",
  merged: "ext.pomtreed.merged",
  modelSettlement: "ext.pomtreed.model_settlement",
  op: "ext.pomtreed.op",
  passiveSettle: "ext.pomtreed.passive_settle",
  pendingReason: "ext.pomtreed.pending_reason",
  providerDegraded: "ext.pomtreed.provider_degraded",
  providerFallback: "ext.pomtreed.provider_fallback",
  published: "ext.pomtreed.published",
  quarantined: "ext.pomtreed.quarantined",
  result: "ext.pomtreed.result",
  resultSaveApproved: "ext.pomtreed.result_save_approved",
  sandbox: "ext.pomtreed.sandbox",
  stateOp: "ext.pomtreed.state_op",
  steered: "ext.pomtreed.steered",
  userEsc: "ext.pomtreed.user_esc",
  waiting: "ext.pomtreed.waiting",
  watchdogNudge: "ext.pomtreed.watchdog_nudge",
  watchdogRestart: "ext.pomtreed.watchdog_restart",
  workflowFetch: "ext.pomtreed.workflow_fetch",
  workflowReport: "ext.pomtreed.workflow_report",
  workflowState: "ext.pomtreed.workflow_state",
  yieldCtx: "ext.pomtreed.yield_ctx",
  yieldInbox: "ext.pomtreed.yield_inbox",
} as const;

export type PomtreedKind = (typeof POMTREED_KINDS)[keyof typeof POMTREED_KINDS];

// One `ext.pomtreed.model_settlement` entry per upstream model call, keyed by (agent, requestId, settlement) so a replay is
// idempotent. Metadata only: never bodies, headers, prompt content, raw paths or error messages. The debit ledger stays the
// spend authority; this entry never charges anything. `settlement` is how the charge was decided: "priced" from usable usage
// the response reported, "estimated" from sizes, "reserve" the whole reservation, "failed" nothing billable (micros 0). `basis`
// says where a billed figure came from: for "priced", the provider's own cost (`reported`) or the local rate card applied to its
// reported tokens (`catalog`); present on "priced", "estimated" and "reserve", absent on "failed". The remaining fields mirror
// ModelCallMeta (`errorClass` only on "failed"; `route` on every entry).
export interface ModelSettlementJournalPayload {
  kind: typeof POMTREED_KINDS.modelSettlement;
  settlement: "priced" | "estimated" | "reserve" | "failed";
  micros: number;
  requestId: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  upstreamStatus?: number;
  latencyMs?: number;
  finishReason?: string;
  route?: ModelCallRoute;
  errorClass?: ModelCallErrorClass;
  // The provider's response id (ModelCallMeta.responseId): the exact key a harness usage event joins on.
  responseId?: string;
  basis?: ModelPriceBasis;
}

// Which figure a journaled `usage` event's `costMicros` is. "settled": the model proxy's settlement of the same call (same
// `requestId` as its model_settlement entry; the one authoritative cost of that request, which the debit ledger charged).
// "harness": the harness's own estimate, no settlement joined (no proxy in the path, or none matched the event's tokens).
// "catalog": the daemon's catalog price for a zero-cost harness event, no settlement joined. Only "settled" is a charge.
export type UsageCostSource = "settled" | "harness" | "catalog";

// One `ext.pomtreed.workflow_fetch` entry per `ctx.workflow.fetch` call, journaled on the root by workflow and instance, with
// `execution` the task that made it (and its generation). Metadata only: never the body, headers or the URL's query or
// fragment. `url` is the requested URL as scheme, host and path (query dropped, token-shaped path segments masked, at most
// 300 characters of path); `finalUrl` is the same rendering of the URL that answered, present when a redirect moved it.
// `requests` is how many requests this call sent (each redirect hop is one), `redirects` how many hops it followed, and
// `requestsUsed`/`maxRequests` the task's request budget after the call. `status` is the last HTTP status seen (absent when no
// response arrived), `bytes` the body size on success, `durationMs` the call's wall time. On success `contentType` is the
// answering response's Content-Type header (absent when it sent none; at most 200 characters) and `sha256` the hex digest of the
// body bytes received (the same digest the handler's WorkflowFetchResult carries). `maxBytes` is the declared body cap the call ran under. `ok: false` carries `error`, the
// refusal or failure reason (at most 200 characters, journal-redacted). Bounded: a call that sent nothing (denied or budget
// exhausted up front) is journaled only for the first `maxRequests` such calls of a task, so a refusal loop cannot flood it.
export interface WorkflowFetchJournalPayload {
  kind: typeof POMTREED_KINDS.workflowFetch;
  workflow: string;
  instance: string;
  execution: AgentId;
  generation: number;
  url: string;
  finalUrl?: string;
  ok: boolean;
  status?: number;
  bytes?: number;
  contentType?: string;
  sha256?: string;
  maxBytes: number;
  durationMs: number;
  requests: number;
  redirects: number;
  requestsUsed: number;
  maxRequests: number;
  error?: string;
}

// The capture broker's journal rows, following the workflow_fetch precedent: metadata only,
// `url` rendered by auditUrl (scheme, host and masked path, no query), every string bounded. They link each requester to the capture
// it received, which the requester-neutral manifest leaves out. Build them with the capture*Payload functions, which apply the bounds.
// `capture_requested`: journaled on the requester per admitted request.
export interface CaptureRequestedJournalPayload {
  kind: typeof POMTREED_KINDS.captureRequested;
  requester: AgentId;
  generation: number;
  job: CaptureJobId;
  key: string; // the cache key
  render: CaptureKeyRender;
  url: string;
  purpose: string; // at most CAPTURE_PURPOSE_MAX characters, control characters removed
}

// `capture_step`: one per rung entered or finished. `status`, `durationMs` and `bytes` only on "finished"; `failureClass`/`reason`
// when the rung failed.
export interface CaptureStepJournalPayload {
  kind: typeof POMTREED_KINDS.captureStep;
  job: CaptureJobId;
  rung: CaptureRung;
  phase: "entered" | "finished";
  status?: number;
  durationMs?: number;
  bytes?: number;
  failureClass?: CaptureFailureClass;
  reason?: string;
}

// `capture_settled`: one per requester the outcome reaches. `capture` and `servedFrom` on ok; `failureClass`, `reason` and `cached`
// (served from the negative cache) on failed.
export interface CaptureSettledJournalPayload {
  kind: typeof POMTREED_KINDS.captureSettled;
  job: CaptureJobId;
  state: "ok" | "failed";
  url: string;
  capture?: CaptureId;
  servedFrom?: AcquisitionSource;
  failureClass?: CaptureFailureClass;
  reason?: string;
  cached?: boolean;
}

const bounded = (s: string, max: number): string => stripControl(s).slice(0, max);

export function captureRequestedPayload(p: Omit<CaptureRequestedJournalPayload, "kind">): CaptureRequestedJournalPayload {
  return {
    kind: POMTREED_KINDS.captureRequested,
    requester: p.requester,
    generation: p.generation,
    job: bounded(p.job, 80),
    key: bounded(p.key, 80),
    render: p.render,
    url: auditUrl(p.url),
    purpose: bounded(p.purpose, CAPTURE_PURPOSE_MAX),
  };
}

export function captureStepPayload(p: Omit<CaptureStepJournalPayload, "kind">): CaptureStepJournalPayload {
  return { ...p, kind: POMTREED_KINDS.captureStep, job: bounded(p.job, 80), ...(p.reason === undefined ? {} : { reason: bounded(p.reason, 40) }) };
}

export function captureSettledPayload(p: Omit<CaptureSettledJournalPayload, "kind">): CaptureSettledJournalPayload {
  return {
    ...p,
    kind: POMTREED_KINDS.captureSettled,
    job: bounded(p.job, 80),
    url: auditUrl(p.url),
    ...(p.reason === undefined ? {} : { reason: bounded(p.reason, 40) }),
  };
}

// One `ext.pomtreed.workflow_state` entry per accepted `ctx.workflow.setState`, journaled on the root (where getState reads it back)
// by workflow and instance, with `execution` the workflow task that wrote it (and its generation), as on workflow_fetch. `key` is
// the mutation idempotency key, `value` the whole state cell; `v` is the payload version (readers refuse any other).
export interface WorkflowStateJournalPayload {
  kind: typeof POMTREED_KINDS.workflowState;
  v: 1;
  workflow: string;
  instance: string;
  execution: AgentId;
  generation: number;
  key: string;
  value: JsonValue;
}

// Budget-raise outcomes, keyed by the budget approval id. `escalated`: an over-budget agent parked and asked for `requested`
// micros (absent when the approval target does not parse) with `spent` and its `budget` at that moment. `granted`: `payer`
// funded `amount` and the asker's budget is now `newBudget`. `denied`: no money moved; `reason` is a short fixed phrase or the
// decider's note.
export interface BudgetEscalatedJournalPayload {
  kind: typeof POMTREED_KINDS.budgetEscalated;
  approval: ApprovalId;
  requested?: number;
  spent: number;
  budget: number;
  // Only on an escalation raised by the model proxy's below-minimum refusal (a stall with spend under the cap): the remainder after
  // in-flight requests (null: none left), the minimum a call needs, and the text naming the cause and the action.
  remainingMicros?: number | null;
  minimumMicros?: number;
  message?: string;
}

export interface BudgetGrantedJournalPayload {
  kind: typeof POMTREED_KINDS.budgetGranted;
  approval: ApprovalId;
  amount: number;
  payer: AgentId;
  newBudget: number;
}

export interface BudgetDeniedJournalPayload {
  kind: typeof POMTREED_KINDS.budgetDenied;
  approval: ApprovalId;
  reason: string;
}

// Journaled on the parent when a reaped child's subtree consumed more than its carve (a provider bill past the reservation):
// the hierarchical ledger books `consumed` (max(carve, consumed)) against the parent, and `overage` = consumed - carve is the
// write-off the parent absorbs. Never journaled for a child that stayed within its carve.
export interface BudgetOverageJournalPayload {
  kind: typeof POMTREED_KINDS.budgetOverage;
  child: AgentId;
  carve: number;
  consumed: number;
  overage: number;
}

// Journaled on the root when the operator raised budget.rootMicros above the root pool's recorded total: the delta is an
// explicit operator injection (`from` -> `to`), written in the same store transaction as the raise (Registry.setRootPool).
export interface BudgetTopUpJournalPayload {
  kind: typeof POMTREED_KINDS.budgetTopUp;
  from: number;
  to: number;
  by: "operator";
}

// Journaled on the root when the operator lowered budget.rootMicros: the delta leaves the system (`from` -> `to`), in the same
// store transaction as the lowering. It takes at most the root's unheld remainder; a larger request is refused in full
// (RootWithdrawalError), never clipped, so the journaled figure is always what the operator asked for (docs/economy.md).
export interface BudgetWithdrawalJournalPayload {
  kind: typeof POMTREED_KINDS.budgetWithdrawal;
  from: number;
  to: number;
  by: "operator";
}

// The operator's injections into the root pool: the only journal kinds that change the conserved total
// (Σ balances + Σ provider spend = Σ top-ups − Σ withdrawals; docs/economy.md).
export const BUDGET_INJECTION_KINDS = [POMTREED_KINDS.budgetTopUp, POMTREED_KINDS.budgetWithdrawal] as const;

// Content-free record of a state operation (no values, no document bodies). `by` is the caller class that performed it; a workflow
// write also names the qualified workflow and its instance (the doc's writer), never the task. Both are absent only on workflow
// rows journaled before they were added, so readers treat them as optional.
export interface StateOpJournalPayload {
  kind: typeof POMTREED_KINDS.stateOp;
  op: "put" | "rm" | "export" | "import";
  owner: string;
  key?: string;
  prefix?: string;
  rev?: number;
  bytes?: number;
  count?: number;
  by: "operator" | "agent" | "workflow";
  workflow?: string;
  instance?: string;
}
