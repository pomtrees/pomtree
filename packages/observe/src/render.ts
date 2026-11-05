import type { WaitCondition } from "@pomtree/core";
import type { Row } from "./tree.ts";

export function describeWait(w: WaitCondition): string {
  switch (w.kind) {
    case "child_exited":
      return `${w.mode} of ${w.children.length} child${w.children.length === 1 ? "" : "ren"}`;
    case "message":
      return "message";
    case "timer":
      return `timer ${new Date(w.at).toISOString().slice(11, 19)}Z`;
    case "any":
      return w.of.map(describeWait).join(" | ");
  }
}

export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d`;
}

export const formatCost = (micros: number) => `$${(micros / 1e6).toFixed(4)}`;

// A row's spend when some usage reported no cost: "unknown" if nothing is known, else the known sum as a bound
// (">=" for spend, "<=" for what is left). Unknown is never rendered as $0.
export function formatRowCost(r: Pick<Row, "costMicros" | "costPartial">): string {
  if (!r.costPartial) return formatCost(r.costMicros);
  return r.costMicros === 0 ? "unknown" : `>=${formatCost(r.costMicros)}`;
}
export function formatRowLeft(r: Pick<Row, "remainingBudgetMicros" | "costPartial">): string {
  return r.costPartial ? `<=${formatCost(r.remainingBudgetMicros)}` : formatCost(r.remainingBudgetMicros);
}

// A wall-clock session deadline for the tree column: remaining time, or "expired"; "" = none.
export function formatDeadline(at: number | null, now: number): string {
  if (at === null) return "";
  const remaining = at - now;
  if (remaining <= 0) return "expired";
  return `in ${formatAge(remaining)}`;
}

const HEADERS = ["AGENT", "ID", "STATE", "AGE", "ACTIVITY", "TOKENS", "COST", "LEFT", "WAIT", "HOST", "DEADLINE"];

function stateColor(r: Row): string {
  switch (r.state) {
    case "running":
      return "32";
    case "yielded":
      return "33";
    case "exited":
      return r.exit === "succeeded" ? "36" : "31";
    default:
      return "2";
  }
}

export function renderTree(rows: readonly Row[], opts: { color?: boolean; now?: number } = {}): string {
  if (rows.length === 0) return "(no agents)";
  const now = opts.now ?? Date.now();
  const cells = rows.map((r) => [
    `${"  ".repeat(r.depth)}${r.name}`,
    r.id.slice(0, 8),
    r.state === "exited" && r.exit ? `exited:${r.exit}` : r.state,
    formatAge(r.ageMs),
    r.pendingReason ? `queued \u2014 ${r.pendingReason}` : r.waitingSince !== null ? "waiting" : (r.activity ?? ""),
    String(r.tokens),
    formatRowCost(r),
    formatRowLeft(r),
    r.wait ? describeWait(r.wait) : "",
    r.host,
    formatDeadline(r.deadlineAt, now),
  ]);
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[], color?: string) =>
    c
      .map((v, i) => {
        const padded = v.padEnd(widths[i]!);
        return color && i === 2 ? `\x1b[${color}m${padded}\x1b[0m` : padded;
      })
      .join("  ")
      .trimEnd();
  return [line(HEADERS), ...cells.map((c, i) => line(c, opts.color ? stateColor(rows[i]!) : undefined))].join("\n");
}
