import assert from "node:assert/strict";
import { test } from "node:test";
import { pumpBuffered } from "./pump.ts";

test("a slow handler does not back-pressure the source: every event is read before the handler finishes the first", async () => {
  let produced = 0;
  async function* src() {
    for (let i = 0; i < 5; i++) {
      produced++;
      yield i;
    }
  }
  const seen: number[] = [];
  let producedAtFirst = -1;
  await pumpBuffered(src(), async (n) => {
    if (seen.length === 0) {
      await new Promise((r) => setTimeout(r, 20));
      producedAtFirst = produced;
    }
    seen.push(n);
  });
  assert.equal(producedAtFirst, 5);
  assert.deepEqual(seen, [0, 1, 2, 3, 4]);
});

test("stop abandons the remaining queue; a source error surfaces after the queue drains", async () => {
  async function* src() {
    yield 1;
    yield 2;
    yield 3;
  }
  const seen: number[] = [];
  await pumpBuffered(src(), async (n) => {
    seen.push(n);
    if (n === 2) return "stop";
  });
  assert.deepEqual(seen, [1, 2]);
  async function* bad() {
    yield 1;
    throw new Error("boom");
  }
  const got: number[] = [];
  await assert.rejects(
    pumpBuffered(bad(), async (n) => {
      got.push(n);
    }),
    /boom/,
  );
  assert.deepEqual(got, [1]);
});

test("a throwing handler stops the producer, drops the backlog and releases the source", async () => {
  let produced = 0;
  let released = false;
  async function* src() {
    try {
      for (let i = 0; i < 1000; i++) {
        produced++;
        yield i;
        await new Promise((r) => setTimeout(r, 1));
      }
    } finally {
      released = true;
    }
  }
  await assert.rejects(
    pumpBuffered(src(), async () => {
      throw new Error("handler boom");
    }),
    /handler boom/,
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(released, true, "source iterator was returned");
  assert.ok(produced < 1000, `producer stopped early (${produced})`);
});
