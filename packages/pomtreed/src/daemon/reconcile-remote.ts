// Reconcile for REMOTE sandboxes (hosted providers): a pure decision over the backend's `list(owner)` result and the agent
// records, plus a thin executor over injected kill/attach/alert functions. Nothing here touches a port, a clock or a store; the
// integration task wires it into reconcile.ts. Ownership comes only from the tags the backend echoes (store_id, daemon_epoch,
// host, generation): a sandbox whose tags do not prove it is ours is never attached, killed or alerted about.
//
// Caller contracts. (1) `lost` is ADVISORY: a listing carries no completeness signal (pagination, eventual consistency), so a
// sandbox missing from it is only suspected gone. The caller confirms absence (two consecutive passes, or an `inspect`) and passes
// the confirmed ids as `confirmedAbsent`; only those appear in `lost`, the rest are `suspectedLost`. (2) The caller owns garbage
// collection of the `alerted` map it persists (drop ids no longer listed). (3) `kill` receives a deterministic idempotency key
// (`reconcileKillKey`), so a retried kill is a no-op on the provider. (4) `ownedByUs` is stricter than the Docker-era `ownsSandbox`
// in reconcile.ts (which accepts a missing store_id) and is the one predicate reconcile.ts applies to every non-selected backend (`provablyOurs`);
// the selected backend keeps the lenient `ownsSandbox`.

import { classifyExit } from "@pomtree/core";
import type { AgentId, AgentRecord, ExitCause, SandboxBackendId, SandboxId, SandboxListing, SandboxOwner } from "@pomtree/core";

export type RemoteReconcileAction =
  | { kind: "attach"; sandbox: SandboxId; agent: AgentId; reason: string }
  | { kind: "kill"; sandbox: SandboxId; reason: string }
  // An owned sandbox no record explains. `alert` is true until the sandbox has been alerted about once; `kill` becomes true once
  // the alert is `graceMs` old, so the operator has the grace window to adopt or inspect it.
  | { kind: "alert-and-kill"; sandbox: SandboxId; agent: AgentId; alert: boolean; kill: boolean; reason: string }
  // Ambiguous ownership of a live sandbox (never killed): alerted once (`alert` false once `alerted` holds it).
  | { kind: "alert"; sandbox: SandboxId; agent: AgentId; alert: boolean; reason: string }
  | { kind: "ignore"; sandbox: SandboxId; reason: string };

// A running record whose sandbox is gone from the listing: the provider ended it (lease expired, preempted, deleted). ADVISORY:
// absence from a listing is not proof (no completeness signal), so a run is ended only for sandboxes in `confirmedAbsent`.
export interface LostSandbox {
  agent: AgentId;
  sandbox: SandboxId;
  cause: ExitCause;
}

export interface RemoteReconcilePlan {
  backend: SandboxBackendId; // keys the kill idempotency key
  actions: RemoteReconcileAction[];
  lost: LostSandbox[]; // absent AND confirmed absent by the caller
  suspectedLost: LostSandbox[]; // absent from this listing only: confirm before ending the run
}

// The idempotency key a kill carries: deterministic, so a retried kill of the same sandbox is idempotent.
export const reconcileKillKey = (backend: SandboxBackendId, sandbox: SandboxId): string => `${backend}:${sandbox}:reconcile-kill`;

export interface PlanRemoteInput {
  records: readonly AgentRecord[];
  listing: readonly SandboxListing[];
  owner: SandboxOwner;
  backend: SandboxBackendId; // the backend `listing` came from: only records started under it can be judged absent
  now: number; // injected clock, epoch ms
  graceMs: number;
  alerted?: ReadonlyMap<SandboxId, number>; // sandbox id -> when the operator was alerted (persisted and pruned by the caller)
  confirmedAbsent?: ReadonlySet<SandboxId>; // sandbox ids the caller has confirmed gone; default none (so `lost` stays empty)
}

// The ownership check. Every condition must hold; an untagged, foreign-store, newer-epoch or other-host sandbox is not ours. Numbers
// are parsed strictly (digits only, safe integers) so a NaN can never pass a comparison.
export function ownedByUs(s: SandboxListing, owner: SandboxOwner): { owned: true } | { owned: false; why: string } {
  const labels = s.labels;
  if (labels?.store_id === undefined || labels.daemon_epoch === undefined) return { owned: false, why: "no pomtree owner tags" };
  if (labels.store_id !== owner.storeId || owner.storeId === "") return { owned: false, why: "tagged for another store" };
  if (!Number.isSafeInteger(owner.epoch)) return { owned: false, why: "the daemon's own epoch is not a safe integer" };
  if (!/^\d+$/.test(labels.daemon_epoch)) return { owned: false, why: "owner epoch tag is not a plain non-negative integer" };
  const epoch = Number(labels.daemon_epoch);
  if (!Number.isSafeInteger(epoch)) return { owned: false, why: "owner epoch tag is not a safe integer" };
  if (epoch > owner.epoch) return { owned: false, why: "owned by a newer daemon epoch" };
  if (s.host === null || s.generation === null) return { owned: false, why: "no host or generation tag" };
  if (!Number.isSafeInteger(s.generation)) return { owned: false, why: "generation tag is not a safe integer" };
  if (s.host !== owner.host) return { owned: false, why: `owned by host ${s.host}` };
  return { owned: true };
}

const ALIVE: ReadonlySet<SandboxListing["state"]> = new Set(["creating", "running", "paused"]);

export function planRemoteReconcile(input: PlanRemoteInput): RemoteReconcilePlan {
  const { records, listing, owner, backend, now, graceMs, alerted, confirmedAbsent } = input;
  const byAgent = new Map(records.map((r) => [r.id, r] as const));
  const actions: RemoteReconcileAction[] = [];
  const listed = new Set<SandboxId>();
  for (const s of listing) {
    if (s.backend !== backend) continue; // another backend's listing entry: not judged here
    if (listed.has(s.id)) continue; // a duplicate id (paged listing overlap): one action per sandbox, the first entry wins
    listed.add(s.id);
    const own = ownedByUs(s, owner);
    if (!own.owned) {
      actions.push({ kind: "ignore", sandbox: s.id, reason: `not ours (${own.why}); left untouched` });
      continue;
    }
    actions.push(decide(s, byAgent.get(s.agent), backend, owner, now, graceMs, alerted?.get(s.id)));
  }
  // A running record with no sandbox id yet adopts a same-generation sandbox, but a create retry after a lost response can leave
  // two: attaching either would be a guess, so with more than one candidate none attach and the operator is alerted.
  const candidates = new Map<AgentId, number>();
  for (const a of actions) if (a.kind === "attach") candidates.set(a.agent, (candidates.get(a.agent) ?? 0) + 1);
  const planned = actions.map((a): RemoteReconcileAction => {
    if (a.kind !== "attach" || (candidates.get(a.agent) ?? 0) < 2 || byAgent.get(a.agent)?.sandbox !== null) return a;
    return {
      kind: "alert",
      sandbox: a.sandbox,
      agent: a.agent,
      alert: alerted?.get(a.sandbox) === undefined,
      reason: `ambiguous: agent ${a.agent} has no recorded sandbox and ${candidates.get(a.agent)} live sandboxes at its generation; none attached or killed, pick one and delete the others`,
    };
  });
  const lost: LostSandbox[] = [];
  const suspectedLost: LostSandbox[] = [];
  for (const r of records) {
    if (r.state !== "running" || r.sandbox === null || r.host !== owner.host || r.sandboxBackend !== backend || listed.has(r.sandbox)) continue;
    // The list cannot say expired from preempted from deleted; both give the same retryable cause.
    const cause = classifyExit({ exitCode: null, reason: "expired" });
    if (cause !== undefined) (confirmedAbsent?.has(r.sandbox) ? lost : suspectedLost).push({ agent: r.id, sandbox: r.sandbox, cause });
  }
  return { backend, actions: planned, lost, suspectedLost };
}

function decide(
  s: SandboxListing,
  r: AgentRecord | undefined,
  backend: SandboxBackendId,
  owner: SandboxOwner,
  now: number,
  graceMs: number,
  alertedAt: number | undefined,
): RemoteReconcileAction {
  if (r === undefined) {
    const kill = alertedAt !== undefined && now - alertedAt >= graceMs;
    return { kind: "alert-and-kill", sandbox: s.id, agent: s.agent, alert: alertedAt === undefined, kill, reason: "our owner tag but no agent record" };
  }
  const ignore = (reason: string): RemoteReconcileAction => ({ kind: "ignore", sandbox: s.id, reason });
  // A record under another backend (or an unusable generation) cannot judge this backend's sandbox either way.
  if (r.sandboxBackend !== null && r.sandboxBackend !== backend)
    return ignore(`record was started under backend ${r.sandboxBackend}, not ${backend}; left untouched`);
  if (!Number.isSafeInteger(r.generation)) return ignore("record generation is not a safe integer; left untouched");
  // A record on another host is that host's to judge. Consequence: a stale sandbox of ours whose agent moved to another host stays
  // until that host's daemon (same store) reconciles it; this daemon never kills on a record it does not own.
  if (r.host !== owner.host) return ignore(`record lives on host ${r.host}; left to that host`);
  const gen = s.generation as number;
  // Fence first: a sandbox newer than the record is never killed whatever the record's state, since the record may be behind.
  if (gen > r.generation) return ignore(`generation ${gen} is newer than the record's ${r.generation}; the record may be behind, left untouched`);
  if (r.state === "exited" || r.state === "reaped" || r.state === "yielded") {
    return { kind: "kill", sandbox: s.id, reason: `agent is ${r.state}; its sandbox should not exist` };
  }
  if (gen < r.generation) return { kind: "kill", sandbox: s.id, reason: `generation ${gen} is older than the record's ${r.generation}` };
  if (r.state !== "running") return ignore(`agent is ${r.state}; it may be mid-start, left untouched`);
  if (r.sandbox !== null && r.sandbox !== s.id) return { kind: "kill", sandbox: s.id, reason: `superseded: the record names sandbox ${r.sandbox}` };
  if (!ALIVE.has(s.state)) return ignore(`sandbox is ${s.state}; the exit path classifies it`);
  return { kind: "attach", sandbox: s.id, agent: s.agent, reason: "record running, sandbox alive, same generation" };
}

export type RemotePlanResult = ({ kind: "plan" } & RemoteReconcilePlan) | { kind: "unavailable"; message: string };

// Lists through the injected function and plans. Any listing error means nothing listed can be trusted, so the result is
// `unavailable` with NO actions: an outage must never read as "every sandbox is a stray".
export async function planRemoteReconcileFromBackend(
  list: () => Promise<SandboxListing[]>,
  input: Omit<PlanRemoteInput, "listing">,
): Promise<RemotePlanResult> {
  let listing: SandboxListing[];
  try {
    listing = await list();
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    return {
      kind: "unavailable",
      message: `could not list sandboxes on backend ${input.backend} (${cause}); nothing was attached or killed, so check the provider's status and credentials and the next reconcile pass will retry`,
    };
  }
  return { kind: "plan", ...planRemoteReconcile({ ...input, listing }) };
}

export interface RemoteReconcileDeps {
  kill(sandbox: SandboxId, key: string): Promise<void>; // key: reconcileKillKey, idempotent on retry
  attach(sandbox: SandboxId, agent: AgentId): Promise<void>;
  alert(message: string, sandbox: SandboxId): Promise<void>;
}

export interface RemoteApplyResult {
  attached: SandboxId[];
  killed: SandboxId[];
  alerted: SandboxId[];
  failures: { sandbox: SandboxId; step: "attach" | "kill" | "alert"; message: string }[];
}

// Applies a plan one sandbox at a time. A failure on one is recorded and the rest still run; it never throws. A failed alert
// withholds that sandbox's kill: the operator must be told before it goes.
export async function applyRemoteReconcile(plan: RemoteReconcilePlan, deps: RemoteReconcileDeps): Promise<RemoteApplyResult> {
  const out: RemoteApplyResult = { attached: [], killed: [], alerted: [], failures: [] };
  const fail = (sandbox: SandboxId, step: "attach" | "kill" | "alert", e: unknown) => {
    const cause = e instanceof Error ? e.message : String(e);
    out.failures.push({
      sandbox,
      step,
      message: `${step} of sandbox ${sandbox} failed (${cause}); the next reconcile pass retries, and the operator can ${step === "kill" ? "delete it in the provider console" : "inspect it"} meanwhile`,
    });
  };
  for (const a of plan.actions) {
    if (a.kind === "ignore") continue;
    if (a.kind === "attach") {
      try {
        await deps.attach(a.sandbox, a.agent);
        out.attached.push(a.sandbox);
      } catch (e) {
        fail(a.sandbox, "attach", e);
      }
      continue;
    }
    if (a.kind === "alert" && !a.alert) continue; // already alerted; an ambiguous sandbox is never killed
    if ((a.kind === "alert-and-kill" || a.kind === "alert") && a.alert) {
      try {
        await deps.alert(
          a.kind === "alert"
            ? `sandbox ${a.sandbox} (agent ${a.agent}): ${a.reason}`
            : `unknown sandbox ${a.sandbox} carries our owner tags (agent ${a.agent}): ${a.reason}; it is killed after the grace window unless you adopt it`,
          a.sandbox,
        );
        out.alerted.push(a.sandbox);
      } catch (e) {
        fail(a.sandbox, "alert", e);
        continue;
      }
    }
    if (a.kind === "alert") continue;
    if (a.kind === "kill" || a.kill) {
      try {
        await deps.kill(a.sandbox, reconcileKillKey(plan.backend, a.sandbox));
        out.killed.push(a.sandbox);
      } catch (e) {
        fail(a.sandbox, "kill", e);
      }
    }
  }
  return out;
}
