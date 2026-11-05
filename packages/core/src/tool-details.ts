import type { JsonValue } from "./types.ts";

// Bound for `HarnessEvent.tool_result.details`: structured metadata beside a tool's text, journaled with the result.
export const MAX_TOOL_DETAILS_BYTES = 1024;
// A node count beyond which no value can fit the byte bound (every JSON node costs at least one byte), so a huge input is never walked in full.
const MAX_NODES = MAX_TOOL_DETAILS_BYTES;
const MAX_DEPTH = 16;

export type ToolDetailsDrop = "oversize" | "non_json";
// What replaces details that cannot be kept. Never a clipped fragment of the original: cutting JSON mid-structure would yield a value
// that looks valid and is wrong. A reader tells a drop from data by this one key.
export const TOOL_DETAILS_DROP_KEY = "pomtree_dropped";
const drop = (reason: ToolDetailsDrop): JsonValue => ({ [TOOL_DETAILS_DROP_KEY]: reason });

// True when `v` is plain JSON (null, boolean, finite number, string, array, plain object with JSON members), within the node and depth
// budgets. Cycles, Date/Map/class instances, undefined members, functions, bigint, symbols, NaN and Infinity are all rejected.
function walk(v: unknown, depth: number, budget: { n: number }): "ok" | "oversize" | "non_json" {
  if (++budget.n > MAX_NODES) return "oversize";
  if (v === null || typeof v === "boolean" || typeof v === "string") return "ok";
  if (typeof v === "number") return Number.isFinite(v) ? "ok" : "non_json";
  if (typeof v !== "object" || depth >= MAX_DEPTH) return "non_json";
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = walk(x, depth + 1, budget);
      if (r !== "ok") return r;
    }
    return "ok";
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return "non_json";
  for (const x of Object.values(v)) {
    const r = walk(x, depth + 1, budget);
    if (r !== "ok") return r;
  }
  return "ok";
}

// The one bound on tool-result details, applied wherever a harness event is normalised or journaled. Absent stays absent. Plain JSON of at most
// MAX_TOOL_DETAILS_BYTES (UTF-8) is kept as is; anything else becomes the closed marker `{pomtree_dropped: "oversize" | "non_json"}`.
// A cycle is caught by the depth bound before it can recurse unbounded. Idempotent: a marker is plain small JSON and passes unchanged.
export function boundToolDetails(details: unknown): JsonValue | undefined {
  if (details === undefined) return undefined;
  const verdict = walk(details, 0, { n: 0 });
  if (verdict !== "ok") return drop(verdict);
  return new TextEncoder().encode(JSON.stringify(details)).length > MAX_TOOL_DETAILS_BYTES ? drop("oversize") : (details as JsonValue);
}
