// Pure tail-follow over an append-only text source (the events sink). Injectable read/sleep, no fs.

// `read(offset)` returns text appended since `offset` and the new offset, or null when the source does not
// exist yet. A returned offset below the requested one means the source was truncated: reading restarts there.
export interface TailSource {
  read(offset: number): Promise<{ text: string; offset: number } | null>;
}

export interface TailOpts {
  // Settles when the producer is gone (container exited); the source is drained once more, then the tail ends.
  ended: Promise<unknown>;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function* tailFollow(src: TailSource, opts: TailOpts): AsyncGenerator<string> {
  const pollMs = opts.pollMs ?? 100;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let done = false;
  const wake = opts.ended.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  let offset = 0;
  for (;;) {
    const wasDone = done; // checked before the read so everything written before exit is drained
    const r = await src.read(offset);
    if (r) {
      offset = r.offset;
      if (r.text) {
        yield r.text;
        continue;
      }
    }
    if (wasDone) return;
    await Promise.race([sleep(pollMs), wake]);
  }
}
