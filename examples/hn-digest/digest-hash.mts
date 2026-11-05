// The digest's one definition of lowercase sha256 hex, the sha256 helper and the canonical-JSON hash. Pure; imported by every module that
// validates or computes a digest hash.
//
// `canonical` is NOT core's `canonical` (packages/core/src/template.ts): core drops undefined-valued keys while this one hashes them as
// `null`, so the two differ on any value with an undefined property, and these hashes are persisted in receipts and compared across runs.
// Core's is the template-digest helper; this one is the evidence/receipt hash and keeps its bytes.
import { createHash } from "node:crypto";

export const SHA256_HEX = /^[a-f0-9]{64}$/;
export const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(o[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export const jsonHash = (value: unknown): string => hash(canonical(value));
