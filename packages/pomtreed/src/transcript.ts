// Pure transcript parsing for `pomtree logs` (TODO(transcript)): a Pi session is JSONL; only complete, parseable lines count
// (a torn tail or a corrupt line is skipped, never thrown), and the newest `limit` entries are returned.
export const MAX_TRANSCRIPT_ENTRIES = 5000;

export function parseTranscript(bytes: Uint8Array, limit = 500): { entries: unknown[]; skipped: number; total: number } {
  const n = Math.max(1, Math.min(limit, MAX_TRANSCRIPT_ENTRIES));
  const text = Buffer.from(bytes).toString("utf8");
  const lines = text.split("\n");
  // A final line without a newline is kept when it is complete JSON (a clean writer that omitted the newline); it is
  // dropped silently only when it fails to parse (a torn tail).
  const untermed = !text.endsWith("\n");
  const all: unknown[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (l.trim() === "") return;
    try {
      all.push(JSON.parse(l));
    } catch {
      if (!(untermed && i === lines.length - 1)) skipped++;
    }
  });
  return { entries: all.slice(-n), skipped, total: all.length };
}
