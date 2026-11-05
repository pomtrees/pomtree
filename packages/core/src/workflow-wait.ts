import { isJsonValue } from "./executor.ts";
import type { AgentId, JsonValue, WaitCondition } from "./types.ts";

// Largest JSON-serialized task-local state a workflow may persist when it suspends.
export const WORKFLOW_STATE_MAX_BYTES = 65536;

// A suspension state is JSON and fits the cap. Pure, so the daemon and the in-memory fake apply the same rule.
export function validWorkflowState(state: unknown): state is JsonValue {
  return isJsonValue(state) && new TextEncoder().encode(JSON.stringify(state)).length <= WORKFLOW_STATE_MAX_BYTES;
}

// Bounded recursive validation before a reviewed handler's wait is persisted or armed.
export function validWorkflowWait(value: unknown, depth = 0): value is WaitCondition {
  if (depth > 16 || !value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "message":
      return true;
    case "timer":
      return typeof v.at === "number" && Number.isFinite(v.at) && v.at >= 0;
    case "child_exited":
      return (
        Array.isArray(v.children) &&
        v.children.length > 0 &&
        v.children.length <= 256 &&
        v.children.every((c) => typeof c === "string") &&
        (v.mode === "all" || v.mode === "any")
      );
    case "any":
      return Array.isArray(v.of) && v.of.length > 0 && v.of.length <= 32 && v.of.every((c) => validWorkflowWait(c, depth + 1));
    default:
      return false;
  }
}

// Every child id a condition can be satisfied by, through nested "any" conditions, for pre-checking done-state
// and ownership before calling the synchronous `satisfied`.
export function waitChildIds(cond: WaitCondition): AgentId[] {
  switch (cond.kind) {
    case "child_exited":
      return [...cond.children];
    case "any":
      return cond.of.flatMap(waitChildIds);
    case "message":
    case "timer":
      return [];
  }
}
