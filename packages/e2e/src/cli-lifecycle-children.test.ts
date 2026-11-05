// YLD-3 child-exit waits (S1 lifecycle): child_exited any and all wake the parent once.
// Docker-gated like cli-scenarios.test.ts (cliScenarioSkip); nothing here spends money. Helpers: cli-lifecycle-support.ts.
// Run one test at a time:
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=<image> node --test --test-name-pattern '<id>' packages/e2e/src/<this file>
import assert from "node:assert/strict";
import { test } from "node:test";
import { showAgent } from "./cli-crash.ts";
import { assertWokeOnce, childWaitCase, SKIP, sleep, TIMEOUT } from "./cli-lifecycle-support.ts";

test("cli lifecycle YLD-3 (child_exited:A,B): one child's exit wakes the parent once; its handoff reaches the model; the other child is still parked", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  await childWaitCase(
    "any",
    (a, b) => `child_exited:${a},${b}`,
    async (s, ids, parked, tt) => {
      assert.equal(parked.checkpoint.wait?.kind, "child_exited");
      assert.equal(parked.checkpoint.wait?.mode, "any");
      for (const k of [ids.a, ids.b]) await s.until(`kid ${k} parked`, async () => (await showAgent(s, k)).state === "yielded", 120_000);
      const go = await s.pomtree(["send", ids.a, "GO-any1 finish"]);
      assert.equal(go.code, 0, `send: ${go.out} ${go.err}`);
      await assertWokeOnce(s, parked, "parent-woken", new RegExp(`child ${ids.a} exited succeeded.*KIDDONE-any1`, "s"), tt, "child_exited any");
      assert.equal((await showAgent(s, ids.b)).state, "yielded", "the other child is untouched");
    },
    t,
  );
});

test("cli lifecycle YLD-3 (child_exited:all:A,B): the first child's exit does not wake the parent; the second does, once", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  await childWaitCase(
    "all",
    (a, b) => `child_exited:all:${a},${b}`,
    async (s, ids, parked, tt) => {
      assert.equal(parked.checkpoint.wait?.kind, "child_exited");
      assert.equal(parked.checkpoint.wait?.mode, "all");
      for (const k of [ids.a, ids.b]) await s.until(`kid ${k} parked`, async () => (await showAgent(s, k)).state === "yielded", 120_000);
      assert.equal((await s.pomtree(["send", ids.a, "GO-all1 finish"])).code, 0);
      await s.until("the first child exited", async () => ["exited", "reaped"].includes((await showAgent(s, ids.a)).state), 60_000);
      await sleep(8000); // a wrong wake on the first exit would start the parent's resume by now
      assert.equal((await showAgent(s, parked.id)).state, "yielded", "one of two children exited: the parent must stay yielded");
      assert.equal(s.stub.calls.filter((c) => c.matched === "parent-woken").length, 0, "no wake before both children exited");
      assert.equal((await s.pomtree(["send", ids.b, "GO-all2 finish"])).code, 0);
      await assertWokeOnce(s, parked, "parent-woken", new RegExp(`child ${ids.b} exited succeeded.*KIDDONE-all2`, "s"), tt, "child_exited all");
    },
    t,
  );
});
