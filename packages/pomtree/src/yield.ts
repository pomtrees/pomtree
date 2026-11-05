import { randomUUID } from "node:crypto";
import type { WaitCondition } from "@pomtree/core";

// The `--until` shorthand for `pomtree yield`, parsed into a `WaitCondition`.
//
//   message               -> { kind: "message" }
//   timer:MS              -> { kind: "timer", at: now + MS }  (MS a non-negative integer)
//   child_exited:A,B      -> { kind: "child_exited", children: ["A","B"], mode: "any" }
//   child_exited:any:A,B  -> mode "any" (explicit)
//   child_exited:all:A,B  -> mode "all"
//
// `child_exited` requires explicit child ids: there is no daemon-side "any child"
// wildcard, and an empty children list would mean "any -> never satisfied" or
// "all -> trivially satisfied" (see @pomtree/sched wait.ts). `now` is injectable
// so tests are deterministic; it defaults to Date.now().
export function parseYieldWait(raw: string, now: number = Date.now()): WaitCondition {
  if (raw === "message") return { kind: "message" };
  if (raw.startsWith("timer:")) return { kind: "timer", at: now + nonNegativeInt(raw.slice("timer:".length), "timer") };
  if (raw.startsWith("child_exited")) {
    const rest = raw.slice("child_exited".length);
    let mode: "any" | "all" = "any";
    let idsRaw: string;
    if (rest.startsWith(":any:")) {
      mode = "any";
      idsRaw = rest.slice(":any:".length);
    } else if (rest.startsWith(":all:")) {
      mode = "all";
      idsRaw = rest.slice(":all:".length);
    } else if (rest === ":any" || rest === ":all") {
      throw new Error("child_exited needs child ids (child_exited:a,b or child_exited:all:a,b)");
    } else if (rest.startsWith(":")) {
      idsRaw = rest.slice(1);
    } else {
      throw new Error("child_exited needs child ids (child_exited:a,b or child_exited:all:a,b)");
    }
    const children = idsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (children.length === 0) throw new Error("child_exited needs at least one child id (child_exited:a,b or child_exited:all:a,b)");
    return { kind: "child_exited", children, mode };
  }
  throw new Error(`unknown --until: ${raw}`);
}

// Idempotency key (every mutating call carries one): `--key` if given, to retry a yield whose reply
// was lost; else fresh per invocation, so identical intentional yields are not deduplicated.
export function effectiveYieldKey(key?: string): string {
  return key ?? randomUUID();
}

function nonNegativeInt(raw: string, what: string): number {
  const n = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what} must be a non-negative integer of ms, got "${raw}"`);
  return n;
}
