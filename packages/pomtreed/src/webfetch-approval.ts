import {
  CAPTURE_HOST_KIND,
  StaleGenerationError,
  type AgentId,
  type AgentRecord,
  type Approval,
  type ApprovalStore,
  type HostId,
  type Registry,
} from "@pomtree/core";
import { approvalIdFor, settleApproval } from "./approvals.ts";

// Per-capture approval escalation (approval kind capture_host, core CAPTURE_HOST_KIND) for a host outside the requester's capture
// scope: agent web_fetch and `pomtree capture request` (L4). The broker dials on the host network, bypassing container egress, so an
// out-of-scope request must ask, not proceed. This module gates one fetch
// on the durable approval primitive (fixed authority ladder, journaled decisions, fail-closed timeout) the
// daemon already uses for extension/publish/merge approvals. The gateway stays pure: the daemon wires the
// store and the escalation-channel alert; without the wiring the gateway refuses, unchanged.

// Which egress policies may escalate an out-of-scope web_fetch to an approval. `registry` (one-off external
// fetch) and `allowlist` (a host off the list) may ask; `none` and any unknown kind stay refused outright.
export function webFetchEscalatable(egress: { kind: string } | undefined): boolean {
  return egress?.kind === "registry" || egress?.kind === "allowlist";
}

export interface WebFetchApprovalDeps {
  store: ApprovalStore;
  host: HostId;
  now?: () => number;
  // Rung deadline for a new approval (default 300s, the daemon's approvalTimeoutMs default) and the
  // real-time block bound before answering "pending" (default 20s, the daemon's approvalWaitMs default).
  timeoutMs?: number;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  // One escalation-channel alert per approval; the daemon wires a journaled `message_sent` (idempotent by
  // `${id}:sent`). A notify failure never blocks the approval itself.
  notify?: (a: Approval) => Promise<void>;
}

export type WebFetchApprovalVerdict =
  | { state: "approved"; approval: string }
  | { state: "denied"; approval: string; reason: string }
  | { state: "pending"; approval: string };

// Returns the escalation hook the extension gateway calls when an agent's web_fetch scope refuses a URL.
// The approval is scoped as small as the existing approval shape allows: the id hashes
// (agent, CAPTURE_HOST_KIND, `https://<host>`, the call's idempotency key), so one approval authorizes exactly
// the one call carrying that key, pinned to that host (the gateway re-checks the host on every redirect);
// a retry with the same key converges on the same record. `generation` fences the requester: the wiring
// (createWiredWebFetchApproval) passes the agent's current registry generation, so a create carrying a
// stale one is rejected by the store (fail closed). Fail closed: a store error, a denial and a
// rung timeout all refuse; a still-pending approval answers "pending" so the caller can retry with the
// same key.
export function createWebFetchApproval(
  deps: WebFetchApprovalDeps,
): (agent: AgentId, host: string, key: string, generation?: number) => Promise<WebFetchApprovalVerdict> {
  const store = deps.store;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 300_000;
  const waitMs = deps.waitMs ?? 20_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (agent: AgentId, host: string, key: string, generation?: number): Promise<WebFetchApprovalVerdict> => {
    const target = `https://${host}`;
    const id = approvalIdFor(agent, CAPTURE_HOST_KIND, target, key);
    let ap: Approval;
    try {
      ap = await store.create(
        {
          id,
          // Rank "agent" yields the full ladder above it; the generation (when the wiring supplies it)
          // fences the requester against the registry's current generation.
          requester: { id: agent, rank: "agent", ...(generation !== undefined && { generation }) },
          action: { kind: CAPTURE_HOST_KIND, target },
          host: deps.host,
          deadlineAt: now() + timeoutMs,
        },
        `${agent}:${key}:approval:${CAPTURE_HOST_KIND}:${id}`,
      );
    } catch (e) {
      return { state: "denied", approval: id, reason: e instanceof StaleGenerationError ? "stale requester generation" : "approval store unavailable" };
    }
    // A replayed create key returns the original (possibly stale pending) snapshot; refresh by id so a
    // retry after a decision sees the settled record (the daemon's requireApproval does the same in its loop).
    try {
      ap = (await store.get(id)) ?? ap;
    } catch {
      // keep the create snapshot
    }
    if (ap.state === "pending" && deps.notify) await deps.notify(ap).catch(() => {});
    const end = Date.now() + waitMs;
    for (;;) {
      try {
        ap = await settleApproval(store, ap, now());
      } catch {
        return { state: "denied", approval: id, reason: "approval store unavailable" };
      }
      if (ap.state !== "pending") break;
      if (Date.now() >= end) return { state: "pending", approval: id };
      await sleep(100);
      try {
        ap = (await store.get(id)) ?? ap;
      } catch {
        return { state: "denied", approval: id, reason: "approval store unavailable" };
      }
    }
    if (ap.state === "approved") return { state: "approved", approval: id };
    return { state: "denied", approval: id, reason: ap.journal.at(-1)?.why ?? "denied" };
  };
}

export interface WiredWebFetchApprovalDeps extends Omit<WebFetchApprovalDeps, "notify"> {
  // Registry lookup for the escalatable gate and the generation fence: only an agent whose egress
  // policy may escalate asks, and the ask carries the agent's current registry generation so the
  // store rejects a stale requester (StaleGenerationError, fail closed).
  registry: Registry;
  // One escalation-channel alert per approval; main.ts routes this to the daemon's journaled
  // `message_sent` (Daemon.notifyApprovalAsk, idempotent by `${id}:sent`).
  notify: (a: Approval) => Promise<void>;
}

// The daemon-side composition (main.ts) of the web_fetch approval hook: gates every ask through a
// registry lookup so only `webFetchEscalatable` policies ask (an unregistered agent, an unknown
// policy kind, or a lookup failure returns null — refuse without asking, fail closed), and fences
// the requester with the agent's current generation.
export function createWiredWebFetchApproval(
  deps: WiredWebFetchApprovalDeps,
): (agent: AgentId, host: string, key: string) => Promise<WebFetchApprovalVerdict | null> {
  const { registry, ...rest } = deps;
  const ask = createWebFetchApproval(rest);
  return async (agent, host, key) => {
    let rec: AgentRecord | null;
    try {
      rec = await registry.get(agent);
    } catch {
      return null; // a broken registry lookup refuses without asking (fail closed)
    }
    if (rec === null || rec.executor !== "container" || !webFetchEscalatable(rec.spec.egress)) return null; // deterministic: no approval path
    return ask(agent, host, key, rec.generation);
  };
}
