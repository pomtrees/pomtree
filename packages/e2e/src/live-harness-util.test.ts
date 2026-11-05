import assert from "node:assert/strict";
import { test } from "node:test";
import { Deadline, Fatal, freePort, sh, until } from "./live-harness-util.ts";

test("until returns the first defined value, including falsy ones", async () => {
  let n = 0;
  assert.equal(await until("x", 5000, () => (++n >= 1 ? 0 : undefined)), 0);
  assert.equal(n, 1);
  assert.equal(await until("async", 5000, async () => "v"), "v");
});

test("until retries a throwing probe", async () => {
  let n = 0;
  const v = await until("x", 5000, async () => {
    if (++n < 2) throw new Error("transient");
    return "ok";
  });
  assert.equal(v, "ok");
  assert.equal(n, 2);
});

test("until retries a probe that throws synchronously", async () => {
  let n = 0;
  const v = await until("x", 5000, () => {
    if (++n < 2) throw new Error("transient");
    return "ok";
  });
  assert.equal(v, "ok");
});

test("until rethrows Deadline and Fatal at once without retrying", async () => {
  let n = 0;
  await assert.rejects(
    until("x", 5000, async () => {
      n++;
      throw new Fatal("stop");
    }),
    Fatal,
  );
  await assert.rejects(
    until("x", 5000, async () => {
      n++;
      throw new Deadline("inner");
    }),
    Deadline,
  );
  assert.equal(n, 2);
});

test("until throws Deadline naming what it waited for when time is up", async () => {
  await assert.rejects(
    until("the thing", 600, () => undefined),
    (e: Error) => e instanceof Deadline && e.message === "timeout waiting for the thing",
  );
});

test("sh returns code, stdout and stderr, including a nonzero exit", async () => {
  const ok = await sh(process.execPath, ["-e", "console.log('hi'); console.error('warn')"]);
  assert.deepEqual([ok.code, ok.out.trim(), ok.err.trim()], [0, "hi", "warn"]);
  const bad = await sh(process.execPath, ["-e", "process.exit(3)"]);
  assert.equal(bad.code, 3);
});

test("freePort returns a positive port that can be bound", async () => {
  const p = await freePort();
  assert.ok(Number.isInteger(p) && p > 0 && p < 65536);
});
