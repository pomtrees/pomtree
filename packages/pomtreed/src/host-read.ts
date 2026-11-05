import type { AgentRecord, HostAgentView, HostReportBody } from "@pomtree/core";
import { handoffOf } from "./daemon-util.ts";
import { toUser } from "./to-user.ts";

// Read-only projections for the host-scope chat routes (`GET /v1/host/agents...`). A host token is the credential of a
// chat bridge that could leak, so these expose a fixed safe subset of an AgentRecord: never spec, task/prompt, env, mounts,
// sandbox, session contents, secrets or journal rows. Agent-authored text (name, result summary) is untrusted and goes through toUser.
//
// Exposure (no per-caller tree scoping, by design): a host token is chat rank. Any enabled chat channel requires
// POMTREED_MESSAGING_SENDERS (pomtreed refuses to start without it), so each read needs a sender the authorizeInbound hook allows.
// A leaked host token alone therefore still reads every agent in the projection, but only by naming an allowlisted sender
// itself (the sender id is vouched for by the messaging adapter, not by pomtreed): the same trust boundary as the message path
// (POST /v1/messages), which can already signal, spawn and cancel under the same condition. A token for a channel that is not a
// configured adapter is refused outright (api.ts `adapterChannel`).

export const HOST_LIST_MAX = 100; // newest first
export const HOST_NAME_MAX = 80;
export const HOST_REPORT_MAX = 1500; // chars of result text (the adapter adds its own framing under Discord's 2000 cap)
export const HOST_SENDER_MAX = 200;

// The wire shapes are core's (messaging.ts HostAgentView/HostAgentsBody/HostBudgetBody/HostReportBody/HostErrorBody).
export type { HostAgentView, HostAgentsBody, HostBudgetBody, HostErrorBody, HostReportBody } from "@pomtree/core";

export function hostAgentView(a: AgentRecord, spentMicros: number): HostAgentView {
  return {
    id: a.id,
    state: a.state,
    parent: a.parent,
    name: toUser(a.name, HOST_NAME_MAX),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    spentMicros,
    budgetMicros: a.budgetMicros,
  };
}

// The stored result as short sanitized text: only the handoff summary is exposed (extra agent-authored keys never are).
// null when the agent has no result yet; "no summary" when it has one without a summary.
export function hostReportText(result: unknown): HostReportBody["report"] {
  if (result === undefined || result === null) return null;
  const summary = handoffOf(result)?.summary;
  return summary === undefined ? "no summary" : toUser(summary, HOST_REPORT_MAX);
}

// A sender id is an opaque chat identity: bounded, printable, no control characters.
export function validHostSender(s: string | null): s is string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters
  return s !== null && s.length > 0 && s.length <= HOST_SENDER_MAX && !/[\u0000-\u001f\u007f]/.test(s);
}

// Runtime-only sliding-window limiter for the host read routes (the message path's limiter is private to the daemon):
// 30/min per sender, 100/min global. Only authorized requests reach it. A request is counted only when it is admitted, so
// a denied sender cannot use up the global budget. Empty windows are dropped, and the map is capped at HOST_LIMITER_KEYS_MAX.
const WINDOW_MS = 60_000;
export const HOST_LIMITER_KEYS_MAX = 1000; // tracked keys, the global key included

export class HostReadLimiter {
  private readonly times = new Map<string, number[]>();

  // The timestamps still inside the window; an empty window leaves no key behind.
  private recent(key: string, now: number): number[] {
    const kept = (this.times.get(key) ?? []).filter((t) => t > now - WINDOW_MS);
    if (kept.length > 0) this.times.set(key, kept);
    else this.times.delete(key);
    return kept;
  }

  limited(channel: string, sender: string, now: number): boolean {
    const senderKey = `sender:${channel}:${sender}`;
    for (const key of [...this.times.keys()]) this.recent(key, now); // evict fully elapsed windows (the map is capped, so this stays cheap)
    if (!this.times.has(senderKey) && this.times.size >= HOST_LIMITER_KEYS_MAX) return true;
    const senderTimes = this.recent(senderKey, now);
    const globalTimes = this.recent("global", now);
    if (senderTimes.length >= 30 || globalTimes.length >= 100) return true;
    this.times.set(senderKey, [...senderTimes, now]);
    this.times.set("global", [...globalTimes, now]);
    return false;
  }
}
