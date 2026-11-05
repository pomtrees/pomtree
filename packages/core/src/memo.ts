import { createHash } from "node:crypto";
import type { JsonValue } from "./types.ts";
import { canonical } from "./template.ts";

// Memoization key for a workflow step: sha256 hex of the canonical JSON of [input, templateDigest, codeVersion]. Object key
// order in `input` is irrelevant; a changed template digest or code version yields a new key. Used as a StateKey (64 hex chars).
export function memoKey(input: JsonValue, templateDigest: string, codeVersion: string): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ input, templateDigest, codeVersion })))
    .digest("hex");
}
