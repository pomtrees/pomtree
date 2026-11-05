import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DeadLetter, OutboxState, OutboxStore } from "./types.ts";

// The cursor is the inclusive lower bound (journal seq) for the next outbox poll. After a
// successful send of entry `seq`, the next poll must start after it (pomtreed's `from` is inclusive).
export function nextCursor(current: number, sentSeq: number): number {
  return Math.max(current, sentSeq + 1);
}

export function emptyOutboxState(): OutboxState {
  return { cursor: 0, attempts: {}, retryAfter: null, deadLetters: [] };
}

function isDeadLetter(x: unknown): x is DeadLetter {
  if (typeof x !== "object" || x === null) return false;
  const d = x as Record<string, unknown>;
  return Array.isArray(d.seqs) && typeof d.agent === "string" && typeof d.subject === "string" && typeof d.reason === "string" && typeof d.at === "number";
}

// Parses the cursor file's JSON state; empty or malformed text yields the empty state.
export function parseOutboxState(text: string): OutboxState {
  const trimmed = text.trim();
  if (trimmed === "") return emptyOutboxState();
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    const cursor = typeof raw.cursor === "number" && Number.isInteger(raw.cursor) && raw.cursor >= 0 ? raw.cursor : 0;
    const attempts: Record<string, number> = {};
    if (typeof raw.attempts === "object" && raw.attempts !== null) {
      for (const [k, v] of Object.entries(raw.attempts as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isInteger(v) && v > 0) attempts[k] = v;
      }
    }
    const retryAfter = typeof raw.retryAfter === "number" && Number.isFinite(raw.retryAfter) && raw.retryAfter > 0 ? raw.retryAfter : null;
    const deadLetters: DeadLetter[] = Array.isArray(raw.deadLetters) ? (raw.deadLetters as unknown[]).filter(isDeadLetter) : [];
    return { cursor, attempts, retryAfter, deadLetters };
  } catch {
    return emptyOutboxState();
  }
}

export function formatOutboxState(state: OutboxState): string {
  return JSON.stringify(state);
}

// The real outbox store: a visible file holding the JSON outbox state (cursor + attempts +
// retryAfter + dead-letter journal), written 0600.
export function fileOutboxStore(path: string): OutboxStore {
  return {
    async read() {
      try {
        return parseOutboxState(await readFile(path, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyOutboxState();
        throw e;
      }
    },
    async write(state) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, formatOutboxState(state), { mode: 0o600 });
    },
  };
}
