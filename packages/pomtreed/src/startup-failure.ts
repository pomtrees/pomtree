// How pomtreed reports an error thrown while it starts (before the drain handlers exist): one clear line naming the cause, on
// stderr, then exit 1. A deliberate refusal (a plain Error with a message, e.g. a bad setting) is the line alone; a programming
// fault (TypeError, ReferenceError, …) keeps its stack after the line, since only the stack can locate it. Pure: no process access.

const FAULT_NAMES = new Set(["TypeError", "ReferenceError", "RangeError", "SyntaxError", "EvalError", "URIError", "AssertionError"]);

export function formatStartupFailure(err: unknown): string[] {
  const e = err instanceof Error ? err : null;
  const message = (e ? e.message : String(err)).replace(/\s*\n\s*/g, " ").trim() || (e?.name ?? "unknown error");
  const line = `pomtreed: startup failed: ${e && FAULT_NAMES.has(e.name) ? `${e.name}: ` : ""}${message}`;
  if (!e || !FAULT_NAMES.has(e.name) || !e.stack) return [line];
  return [line, e.stack];
}
