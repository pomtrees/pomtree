// Decouples reading an event stream from handling it: the producer drains
// `source` into an in-memory queue as fast as it yields, so a slow handler (a slow journal append) can
// no longer back-pressure the upstream byte-budgeted stream and drop its tail (e.g. `agent_settled`).
// The handler runs sequentially in arrival order; returning "stop" abandons the remaining queue.
export async function pumpBuffered<T>(source: AsyncIterable<T>, handle: (item: T) => Promise<"stop" | void>): Promise<void> {
  const queue: T[] = [];
  let done = false;
  let failure: { error: unknown } | null = null;
  let stopped = false;
  let wake: (() => void) | null = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const it = source[Symbol.asyncIterator]();
  let handlerFailed = false;
  void (async () => {
    try {
      for (;;) {
        const n = await it.next();
        if (n.done) break;
        if (handlerFailed) break; // the handler threw: stop pulling and release the upstream below
        if (stopped) continue; // keep draining so the upstream is never blocked, but discard
        queue.push(n.value);
        poke();
      }
    } catch (error) {
      failure = { error };
    } finally {
      done = true;
      poke();
    }
  })();
  try {
    for (;;) {
      const item = queue.shift();
      if (item !== undefined) {
        if ((await handle(item)) === "stop") {
          stopped = true;
          return;
        }
        continue;
      }
      if (done) break;
      await new Promise<void>((r) => (wake = r));
    }
  } catch (e) {
    // A throwing handler must not leave the producer filling an unbounded queue: stop, drop the backlog, release the source.
    handlerFailed = true;
    stopped = true;
    queue.length = 0;
    void it.return?.()?.catch?.(() => {});
    throw e;
  }
  if (failure) throw (failure as { error: unknown }).error;
}
