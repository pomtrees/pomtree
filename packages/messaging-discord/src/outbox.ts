import type { EscalationId, MessageKind } from "@pomtree/core";
import type { OutboxEntry } from "./types.ts";
import { renderAlertBatch, renderOutbound } from "./render.ts";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_ALERT_COALESCE_WINDOW_MS = 60_000;
// The dead-letter journal is capped so a run of permanent failures cannot grow the cursor file
// without bound; the oldest records are dropped first (newest failures kept).
export const MAX_DEAD_LETTERS = 1000;

// One planned Discord send: one or more journal entries (alerts for the same agent may coalesce)
// rendered into a single message.
export interface DeliveryUnit {
  seqs: number[];
  agent: string | null; // the entry's agent (used on the dead-letter record)
  purpose: MessageKind;
  content: string; // fully rendered text to send
  replyTo?: EscalationId; // carried only by single-entry units (asks)
  subjectKind?: "ask" | "approval"; // what replyTo names, when pomtreed says (render.ts askButtons)
  options?: string[]; // the ask's answer choices, when pomtreed lists them
}

// Plans the Discord sends for one outbox poll. Entries are consumed in seq order. `alert` entries
// for the same agent whose journal timestamps fall within `windowMs` of the previous one coalesce
// into a single message (subjects joined by newline), so a burst of alerts does not spam the
// channel; a non-alert entry or a gap past the window flushes the open group. Non-alert entries
// (`ask`, `status`, `report`) are delivered individually, each carrying its `replyTo`.
export function planOutbox(entries: OutboxEntry[], windowMs: number): DeliveryUnit[] {
  const units: DeliveryUnit[] = [];
  let group: { agent: string; seqs: number[]; subjects: string[]; lastTs: number } | null = null;
  const flush = () => {
    if (!group) return;
    units.push({
      seqs: group.seqs,
      agent: group.agent,
      purpose: "alert",
      content: renderAlertBatch(group.subjects),
    });
    group = null;
  };
  for (const e of entries) {
    if (e.payload.purpose === "alert") {
      if (group && group.agent === e.agent && e.ts - group.lastTs <= windowMs) {
        group.seqs.push(e.seq);
        group.subjects.push(e.payload.subject);
        group.lastTs = e.ts;
      } else {
        flush();
        group = { agent: e.agent, seqs: [e.seq], subjects: [e.payload.subject], lastTs: e.ts };
      }
    } else {
      flush();
      units.push({
        seqs: [e.seq],
        agent: e.agent,
        purpose: e.payload.purpose,
        content: renderOutbound(e.payload.purpose, e.payload.subject),
        ...(e.payload.replyTo ? { replyTo: e.payload.replyTo } : {}),
        ...(e.payload.subjectKind ? { subjectKind: e.payload.subjectKind } : {}),
        ...(e.payload.options ? { options: e.payload.options } : {}),
      });
    }
  }
  flush();
  return units;
}
