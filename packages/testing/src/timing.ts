// One definition of test deadlines: a scale factor from the environment, a load-aware `until`,
// and a real timer that survives `mock.timers`.

// TODO(test-timing-fake-time): left to do: fake time (Node mock timers) for provider backoff, deadline firing, the watcher interval and orchestrator
// timer arming; proxy tests in sandbox-docker (proxy-relay-class, public-proxy); about 107 raw sleeps to mark `// timing-ok: <reason>`; and an e2e
// guard that flags new raw sleeps. Current behavior: only the scale and the load-aware `until` exist, and `pnpm test:lite` is load-sensitive.
const SCALE_VAR = "POMTREE_TEST_TIMEOUT_SCALE";

// Captured at module load, before any test can enable `mock.timers`; every poll sleep uses it.
export const realSetTimeout: typeof globalThis.setTimeout = globalThis.setTimeout;
const realClearTimeout: typeof globalThis.clearTimeout = globalThis.clearTimeout;

/** Multiplier for test deadlines, read on each call. Unset is 1; otherwise a finite number >= 1. */
export function testTimeoutScale(): number {
  const raw = process.env[SCALE_VAR];
  if (raw === undefined) return 1;
  const n = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`${SCALE_VAR} is ${JSON.stringify(raw)}, which is not valid; accepted: a finite number >= 1. Unset it or set a value such as 3.`);
  }
  return n;
}

/** `ms` multiplied by the current timeout scale. */
export function scaled(ms: number): number {
  return ms * testTimeoutScale();
}

/**
 * Poll `cond` until it is true. The budget is `scaled(ms)` of scheduled time: a slow condition or a stalled
 * event loop is credited back to the deadline, and total wall time is capped at `3 * scaled(ms)`.
 *
 * Time comes from `performance.now()` (monotonic), which `mock.timers` does not replace, so a mocked `Date`
 * cannot freeze the budget. Credit is given only when an iteration overshoots by more than a tolerance of
 * `max(2 * intervalMs, 10)` ms: a routine 1-2 ms timer overshoot is normal and, if credited, would cancel the
 * time it took, so a short interval could never exhaust its budget and only the cap would end the wait.
 */
export async function until(cond: () => boolean | Promise<boolean>, ms = 5000, opts: { what?: string; intervalMs?: number } = {}): Promise<void> {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    throw new Error(`until: the ms argument is ${String(ms)}; accepted: a finite number >= 0 (milliseconds). Pass a duration such as 5000.`);
  }
  const intervalMs = opts.intervalMs ?? 5;
  const tolerance = Math.max(2 * intervalMs, 10);
  const scale = testTimeoutScale();
  const budget = ms * scale;
  const cap = 3 * budget;
  const start = performance.now();
  let deadline = start + budget;
  const fail = (why: string): never => {
    const elapsed = Math.round(performance.now() - start);
    throw new Error(
      `timed out waiting for ${opts.what ?? "condition"}: ${why}; budget ${budget} ms (${ms} ms x scale ${scale}), elapsed ${elapsed} ms. ` +
        `Check the condition can become true, or raise ${SCALE_VAR} on a loaded machine.`,
    );
  };
  const credit = (lag: number) => {
    if (lag > tolerance) deadline += lag;
  };
  // A condition whose promise never settles must still end at the cap, so the wait races the remaining cap.
  const settle = async (r: Promise<boolean>): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<"cap">((resolve) => {
      timer = realSetTimeout(() => resolve("cap"), Math.max(0, start + cap - performance.now()));
    });
    try {
      const v = await Promise.race([r, capped]);
      if (v === "cap") return fail("the condition did not settle before the wall-time cap of 3x the budget");
      return v;
    } finally {
      realClearTimeout(timer);
    }
  };
  for (;;) {
    const polled = performance.now();
    const r = cond();
    if (typeof r === "boolean" ? r : await settle(r)) return;
    const now = performance.now();
    credit(now - polled); // a slow condition: credit its run time beyond the tolerance
    // At ms 0 the cap equals the budget; then the budget is the real cause, so only a larger cap is checked first.
    if (cap > budget && now - start > cap) fail("wall-time cap of 3x the budget reached");
    if (now > deadline) fail("budget exhausted");
    // Each sleep is bounded by the remaining cap, so a huge intervalMs cannot outlive the wait.
    const sleepMs = Math.min(intervalMs, Math.max(0, start + cap - now));
    const slept = performance.now();
    await new Promise<void>((resolve) => realSetTimeout(resolve, sleepMs));
    credit(performance.now() - slept - sleepMs); // event-loop lag during the sleep
  }
}
