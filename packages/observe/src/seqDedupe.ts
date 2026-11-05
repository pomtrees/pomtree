// Dedupes delivery by seq with bounded memory: journal seqs are monotonic and contiguous,
// so once every seq up to the low-water mark has been applied, anything at or below it can
// only ever arrive again as a duplicate. `#seen` holds only applied seqs above the mark
// (the out-of-order tail), so an in-order stream keeps it empty no matter how long it runs.
export class SeqDedupe {
  readonly #seen = new Set<number>();
  #lowWater = 0; // every seq <= #lowWater has been applied; a delivery at or below it is a dup

  // Number of applied seqs still retained above the low-water mark (bounded by reorder depth).
  get size(): number {
    return this.#seen.size;
  }

  // True the first time a seq is offered, false for a duplicate. Marks the seq applied, so call
  // it only when the caller will apply the entry.
  accept(seq: number): boolean {
    if (seq <= this.#lowWater) return false;
    if (this.#seen.has(seq)) return false;
    this.#seen.add(seq);
    // Retire the contiguous applied prefix: those seqs can never arrive as new again.
    while (this.#seen.delete(this.#lowWater + 1)) this.#lowWater += 1;
    return true;
  }
}
