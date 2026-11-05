import { formatMoney } from "./ux.ts";
import { randomUUID } from "node:crypto";

// Idempotency key (every mutating call carries one): `--key` if given, to retry an ask whose reply
// was lost; else fresh per invocation, so identical intentional asks are not deduplicated. (The daemon derives `es-` + sha256(agent\0key) from it.)
export function effectiveAskKey(key?: string): string {
  return key ?? randomUUID();
}

// `--options a, b` -> ["a", "b"]; whitespace is trimmed and empty entries are dropped.
export function parseOptions(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// POMTREE_AGENT_GENERATION -> the fencing generation stamped on the ask, or null when
// unset or not a non-negative integer (the daemon rejects a missing or stale one).
export function parseGeneration(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null; // Number("") is 0, which would pass silently
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function renderBudget(b: { budgetMicros: number; remainingMicros: number }): string {
  return `budget: ${formatMoney(b.budgetMicros)}\nremaining: ${formatMoney(b.remainingMicros)}`;
}
