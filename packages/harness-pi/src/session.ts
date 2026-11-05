import { createHash } from "node:crypto";

// TODO(session-integrity) harness side: Pi may leave a torn final JSONL line if the container dies
// mid-write (UNVERIFIED). Pure helpers; the caller (pomtreed) decides when to apply them.

// Drops a trailing partial line (no terminating newline) and returns what was cut.
export function trimTornTail(text: string): { text: string; dropped: number } {
  if (text === "" || text.endsWith("\n")) return { text, dropped: 0 };
  const cut = text.lastIndexOf("\n") + 1;
  return { text: text.slice(0, cut), dropped: text.length - cut };
}

// True when every non-empty line parses as a JSON object (a complete, restorable session).
export function sessionParses(text: string): boolean {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export const sessionHash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export type SessionVerdict = { ok: true } | { ok: false; reason: "hash-mismatch" | "unparseable" };

// Verify content-address then structure before restoring a checkpointed session.
export function verifySession(bytes: Uint8Array, expectedHash: string): SessionVerdict {
  if (sessionHash(bytes) !== expectedHash) return { ok: false, reason: "hash-mismatch" };
  return sessionParses(Buffer.from(bytes).toString("utf8")) ? { ok: true } : { ok: false, reason: "unparseable" };
}
