import type { AgentId, AgentRecord, JournalEntry } from "@pomtree/core";
import { SeqDedupe } from "./seqDedupe.ts";
import { applyEntry, rowsFrom, type AgentStats, type Row, type TreeOptions } from "./tree.ts";

export class LiveView {
  readonly #stats = new Map<AgentId, AgentStats>();
  readonly #dedupe = new SeqDedupe(); // bounded low-water-mark dedupe by seq
  readonly #includeContent: boolean;

  constructor(opts: { includeContent?: boolean } = {}) {
    this.#includeContent = opts.includeContent ?? false;
  }

  // Number of applied seqs still retained above the low-water mark (bounded by reorder depth).
  get seenSeqCount(): number {
    return this.#dedupe.size;
  }

  // Returns false for a duplicate delivery, which is ignored.
  apply(e: JournalEntry): boolean {
    if (!this.#dedupe.accept(e.seq)) return false;
    applyEntry(this.#stats, e, this.#includeContent);
    return true;
  }

  async consume(source: AsyncIterable<JournalEntry>, onUpdate?: (e: JournalEntry) => void): Promise<void> {
    for await (const e of source) if (this.apply(e)) onUpdate?.(e);
  }

  rows(agents: readonly AgentRecord[], opts: TreeOptions): Row[] {
    return rowsFrom(agents, this.#stats, opts);
  }
}
