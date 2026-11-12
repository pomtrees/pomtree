import { test } from "node:test";
import assert from "node:assert/strict";
import { scaled, testTimeoutScale, until } from "./timing.ts";

const VAR = "POMTREE_TEST_TIMEOUT_SCALE";

async function withScale<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env[VAR];
  if (value === undefined) delete process.env[VAR];
  else process.env[VAR] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[VAR];
    else process.env[VAR] = prev;
  }
}

const busy = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};

test("scale: unset is 1, valid numbers pass, scaled multiplies", async () => {
  await withScale(undefined, () => assert.equal(testTimeoutScale(), 1));
  await withScale("3", () => {
    assert.equal(testTimeoutScale(), 3);
    assert.equal(scaled(100), 300);
  });
  await withScale("1", () => assert.equal(testTimeoutScale(), 1));
});

test("scale: invalid values throw naming the variable, value and range", async () => {
  for (const bad of ["", "0.5", "abc", "NaN", "Infinity"]) {
    await withScale(bad, () => {
      assert.throws(
        () => testTimeoutScale(),
        (e: Error) => e.message.includes(VAR) && e.message.includes(JSON.stringify(bad)) && e.message.includes("a finite number >= 1"),
        `value ${JSON.stringify(bad)}`,
      );
    });
  }
});

test("scale multiplies the budget a timeout reports, and a late condition passes only with room", { timeout: 10000 }, async () => {
  const budgetOf = async (scale: string) => {
    let msg = "";
    await withScale(scale, () =>
      until(() => false, 50, { what: "never" }).catch((e: Error) => {
        msg = e.message;
      }),
    );
    return msg;
  };
  assert.match(await budgetOf("1"), /budget 50 ms \(50 ms x scale 1\)/);
  assert.match(await budgetOf("3"), /budget 150 ms \(50 ms x scale 3\)/);
  const t0 = performance.now();
  await withScale("3", () => until(() => performance.now() - t0 >= 75, 50, { what: "late flag" }));
});

test("lag credit: a slow condition does not consume the budget", { timeout: 10000 }, async () => {
  let calls = 0;
  await withScale("1", () =>
    until(
      () => {
        calls++;
        if (calls === 1) busy(150);
        return calls >= 2;
      },
      100,
      { what: "slow condition" },
    ),
  );
  assert.equal(calls, 2);
});

test("cap: a condition that blocks every poll ends at the wall-time cap, not later", { timeout: 20000 }, async () => {
  const msg = await withScale("1", () =>
    until(
      () => {
        busy(30);
        return false;
      },
      100,
      { what: "never" },
    ).then(
      () => assert.fail("resolved"),
      (e: Error) => e.message,
    ),
  );
  assert.match(msg, /wall-time cap/);
  const elapsed = Number(/elapsed (\d+) ms/.exec(msg)?.[1]);
  assert.ok(elapsed >= 300, `elapsed ${elapsed}`); // no upper bound: a hang is caught by the test timeout
});

test("sleep lag: an event-loop stall during the sleep is credited to the budget", { timeout: 10000 }, async () => {
  let calls = 0;
  setImmediate(() => busy(150));
  await withScale("1", () => until(() => ++calls >= 3, 100, { what: "stalled loop" }));
});

test("a routine small overshoot is not credited: a tiny interval still exhausts its budget", { timeout: 20000 }, async () => {
  // On a loaded machine a real stall can be credited legitimately and let the cap end the wait, so allow three attempts.
  for (const intervalMs of [0, 1]) {
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await withScale("1", () =>
        until(() => false, 100, { what: "never", intervalMs }).then(
          () => assert.fail("resolved"),
          (e: Error) => e.message,
        ),
      );
      if (/budget exhausted/.test(last)) break;
    }
    assert.match(last, /budget exhausted/, `intervalMs ${intervalMs}`);
  }
});

test("a huge intervalMs is bounded by the cap and does not hang", { timeout: 5000 }, async () => {
  await withScale("1", () =>
    assert.rejects(
      until(() => false, 20, { what: "huge interval", intervalMs: 1e9 }),
      /huge interval/,
    ),
  );
});

test("ms 0 with a false condition names the budget, not the cap", { timeout: 5000 }, async () => {
  await assert.rejects(
    until(() => false, 0, { what: "zero" }),
    /budget exhausted/,
  );
});

test("a frozen mocked Date does not freeze the budget", { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  await assert.rejects(
    until(() => false, 50, { what: "frozen clock" }),
    /frozen clock/,
  );
});

test("ms must be a finite number >= 0", async () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, "5" as unknown as number]) {
    await assert.rejects(
      until(() => true, bad),
      (e: Error) => e.message.includes("ms argument") && e.message.includes("finite number >= 0") && e.message.includes("Pass a duration"),
      String(bad),
    );
  }
  await until(() => true, 0);
});

test("a condition that never settles ends with the timeout error at the cap", { timeout: 5000 }, async () => {
  await withScale("1", () =>
    assert.rejects(
      until(() => new Promise<boolean>(() => {}), 50, { what: "hung" }),
      /hung.*did not settle/,
    ),
  );
});

test("until still resolves when mock.timers fakes setTimeout", { timeout: 3000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  await until(() => ++calls >= 4, 1000);
  assert.equal(calls, 4);
});

test("timeout error names what, the scaled budget, the scale and the elapsed time", { timeout: 10000 }, async () => {
  await withScale("2", () =>
    assert.rejects(
      until(() => false, 50, { what: "the widget" }),
      (e: Error) =>
        e.message.includes("the widget") && e.message.includes("budget 100 ms") && e.message.includes("scale 2") && /elapsed \d+ ms/.test(e.message),
    ),
  );
});
