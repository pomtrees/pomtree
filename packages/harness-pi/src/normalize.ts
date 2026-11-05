import type { HarnessEvent } from "@pomtree/core";
import { isSettled, normalizeRecord, unknownType } from "./pi-format.ts";

export function normalize(line: string): HarnessEvent[] {
  const s = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!s.trim()) return [];
  try {
    return normalizeRecord(JSON.parse(s));
  } catch {
    return [];
  }
}

export const MAX_LINE = 1024 * 1024;

// Splits on LF only; Pi's docs forbid readline because U+2028/2029 are legal inside strings.
// A line longer than `max` is dropped and reported as an `oversize` marker instead of buffered forever.
export async function* lines(chunks: AsyncIterable<string>, max = MAX_LINE): AsyncGenerator<string | { oversize: true }> {
  let buf = "";
  let skipping = false;
  for await (const c of chunks) {
    buf += c;
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (skipping || line.length > max) {
        skipping = false;
        yield { oversize: true };
      } else yield line;
      i = buf.indexOf("\n");
    }
    if (buf.length > max) {
      buf = "";
      skipping = true;
    }
  }
  if (skipping) yield { oversize: true };
  else if (buf) yield buf;
}

// Cap on per-stream inline `error` events for unparseable lines: a stream of garbage is reported,
// not silently dropped, but never floods the journal with one entry per line.
export const MAX_DRIFT_ERRORS = 5;
export const MAX_UNKNOWN_TYPES = 50;

function driftSummary(unknown: Map<string, number>): HarnessEvent | null {
  if (unknown.size === 0) return null;
  const counts = [...unknown.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([t, n]) => `"${t}" (x${n})`)
    .join(", ");
  return { kind: "error", message: `pi emitted unknown record type(s) (protocol drift?): ${counts}` };
}

// Normalized events for a whole stdout stream; ends at `agent_settled`. Oversize lines, unparseable
// lines (rate-limited) and unknown record types (one counted error at the end) surface as `error`
// events, never dropped silently. With `keepOpen` (interactive TTY, where Pi outlives the turn)
// `agent_settled` yields a `settled` event and the stream ends only when the source does.
export async function* events(
  chunks: AsyncIterable<string>,
  max = MAX_LINE,
  onSettled?: () => void,
  keepOpen = false,
  onStart?: () => void,
): AsyncGenerator<HarnessEvent> {
  let malformed = 0;
  const unknown = new Map<string, number>();
  for await (const l of lines(chunks, max)) {
    if (typeof l !== "string") {
      yield { kind: "error", message: `pi output line exceeded ${max} characters and was dropped` };
      continue;
    }
    const s = l.endsWith("\r") ? l.slice(0, -1) : l;
    if (!s.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(s);
    } catch {
      malformed++;
      if (malformed <= MAX_DRIFT_ERRORS) {
        yield { kind: "error", message: "pi emitted an unparseable (malformed JSON) line" };
      }
      continue;
    }
    if (isSettled(rec)) {
      onSettled?.();
      if (keepOpen) {
        yield { kind: "settled", ...((rec as { aborted?: unknown }).aborted === true && { aborted: true as const }) };
        continue;
      }
      const d = driftSummary(unknown);
      if (d) yield d;
      return;
    }
    if ((rec as { type?: unknown } | null)?.type === "agent_start") onStart?.();
    const t = unknownType(rec);
    if (t !== undefined) {
      // Bounded: a stream of distinct made-up types folds into one overflow bucket.
      const key = unknown.has(t) || unknown.size < MAX_UNKNOWN_TYPES ? t : "(other)";
      unknown.set(key, (unknown.get(key) ?? 0) + 1);
      continue;
    }
    yield* normalizeRecord(rec);
  }
  const d = driftSummary(unknown);
  if (d) yield d;
}
