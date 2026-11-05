import type { Schedule } from "@pomtree/core";

// Minimal client-side cron gate: exactly 5 whitespace-separated fields. Field
// semantics (ranges, steps, names, `?`) are the daemon's job — `@pomtree/sched`
// validates fully via `parseCron` and rejects a bad expression with a 400 — so pomtree
// only checks the shape before making the call.
export function cronError(expr: string): string | null {
  const fields = expr
    .trim()
    .split(/\s+/)
    .filter((f) => f !== "");
  if (fields.length !== 5) return `cron needs 5 fields, got ${fields.length}: "${expr}"`;
  return null;
}

// ID | CRON | TZ | TASK | MISSED | OVERLAP | JITTER | TARGET (agent id, `(orphaned)` when it exited; `-` = spawns a root child)
export function renderScheduleTable(schedules: readonly Schedule[]): string {
  if (schedules.length === 0) return "no schedules";
  const header = ["ID", "CRON", "TZ", "TASK", "MISSED", "OVERLAP", "JITTER", "TARGET"];
  const rows = schedules.map((s) => [
    s.id,
    s.cron,
    s.tz ?? "-",
    s.task,
    s.missed,
    s.overlap,
    String(s.jitterMs),
    s.agent === undefined ? "-" : s.orphaned ? `${s.agent} (orphaned)` : s.agent,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [header, ...rows]
    .map((r) =>
      r
        .map((c, i) => c.padEnd(widths[i]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
