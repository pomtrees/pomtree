// YLD-3 (yield and wake, S1 lifecycle): message, timer, inbox and pomtree wait yields wake once.
// Docker-gated like cli-scenarios.test.ts (cliScenarioSkip); nothing here spends money. Helpers: cli-lifecycle-support.ts.
// Run one test at a time:
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=<image> node --test --test-name-pattern '<id>' packages/e2e/src/<this file>
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelScript } from "@pomtree/testing";
import { showAgent } from "./cli-crash.ts";
import { holdUntilReleased } from "./cli-hold.ts";
import {
  assertWokeOnce,
  callReply,
  childIds,
  hostPathFindings,
  kidRules,
  noStray,
  SKIP,
  spawnAgent,
  spawnKid,
  TEMPLATES,
  TIMEOUT,
  textReply,
  untilParked,
  withStack,
} from "./cli-lifecycle-support.ts";

// Explicit `--until` yields with no children: message, timer, and the implicit yield of `pomtree inbox --wait`. An explicit yield wakes with the
// raw signal text (message body, "timer elapsed"); only the implicit waits carry the documented "Resumed: ..." wording (docs/operating.md).
test("cli lifecycle YLD-3 (message, timer, inbox --wait): each wakes once in a new container at generation + 1; the checkpoint has no host path", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const script: ModelScript = {
    name: "yld3-single",
    rules: [
      { id: "msg-woken", when: { lastUserIncludes: "WAKE-MSG-1" }, times: 1, reply: callReply("sleep 300; echo woke-msg") },
      { id: "inbox-woken", when: { lastUserIncludes: "INBOX-MSG-1" }, times: 1, reply: callReply("sleep 300; echo woke-inbox") },
      { id: "timer-woken", when: { lastUserIncludes: "timer elapsed" }, times: 1, reply: callReply("sleep 300; echo woke-timer") },
      { id: "msg-yield", when: { lastUserIncludes: "[[scn:ymsg]]", toolResults: 0 }, reply: callReply(holdUntilReleased("pomtree yield --until message")) },
      {
        id: "timer-yield",
        when: { lastUserIncludes: "[[scn:ytimer]]", toolResults: 0 },
        reply: callReply(holdUntilReleased("pomtree yield --until timer:15000")),
      },
      {
        id: "inbox-park",
        when: { lastUserIncludes: "[[scn:yinbox]]", toolResults: 0 },
        reply: callReply(holdUntilReleased("pomtree inbox --wait 600000; echo inbox-exit=$?")),
      },
      { id: "stray", when: {}, reply: textReply("stray") },
    ],
  };
  await withStack({ script, set: { "capacity.maxSessions": "6" } }, async (s) => {
    const msg = await spawnAgent(s, { task: "[[scn:ymsg]] park", name: "ymsg", budget: 500_000 });
    const timer = await spawnAgent(s, { task: "[[scn:ytimer]] park", name: "ytimer", budget: 500_000 });
    const inbox = await spawnAgent(s, { task: "[[scn:yinbox]] park", name: "yinbox", budget: 500_000 });
    const [pm, pt, pi] = await Promise.all([untilParked(s, msg.id), untilParked(s, timer.id), untilParked(s, inbox.id)]);
    t.diagnostic(`checkpoint fields: ${JSON.stringify(pm.checkpoint)}`);
    assert.equal(pm.checkpoint.wait?.kind, "message");
    assert.equal(pt.checkpoint.wait?.kind, "timer");
    t.diagnostic(`checkpoint wait of the inbox park: ${JSON.stringify(pi.checkpoint.wait)}`);
    assert.equal(pi.checkpoint.wait?.kind, "any", "an implicit inbox wait is a message or a timer");

    for (const [p, body] of [
      [pm, "WAKE-MSG-1 go"],
      [pi, "INBOX-MSG-1 hello"],
    ] as const) {
      const sent = await s.pomtree(["send", p.id, body]);
      assert.equal(sent.code, 0, `send ${body}: exit ${sent.code}: ${sent.out} ${sent.err}`);
    }
    await Promise.all([
      assertWokeOnce(s, pm, "msg-woken", /^WAKE-MSG-1 go/, t, "message"),
      assertWokeOnce(s, pt, "timer-woken", /timer elapsed/, t, "timer"),
      assertWokeOnce(s, pi, "inbox-woken", /^Resumed: a message arrived: .*INBOX-MSG-1 hello/s, t, "inbox --wait"),
    ]);
    noStray(s);
  });
});

// The scanner is only evidence if it can find a path: a negative control.
test("cli lifecycle YLD-3 scanner: hostPathFindings flags a root-prefixed, /home/ and /tmp/ string and passes ids and hashes", () => {
  assert.deepEqual(hostPathFindings({ a: "/r/state/x", b: ["see /home/u/f"], c: { d: "x/tmp/y" } }, "/r"), [
    "checkpoint.a=/r/state/x",
    "checkpoint.b[0]=see /home/u/f",
    "checkpoint.c.d=x/tmp/y",
  ]);
  assert.deepEqual(hostPathFindings({ sessionRef: "ab".repeat(32), imageDigest: "sha256:abc", agent: "ag-1", n: 3, z: null }, "/r"), []);
});

test("cli lifecycle YLD-3 (pomtree wait): a long wait on a child yields; the child's exit resumes the parent once with the documented Resumed text", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const script: ModelScript = {
    name: "yld3-wait",
    rules: [
      { id: "parent-woken", when: { marker: "parent", lastUserIncludes: "Resumed: child" }, times: 1, reply: callReply("sleep 300; echo parent-woke") },
      {
        id: "parent-spawn",
        when: { marker: "parent", lastUserIncludes: "[[scn:waitparent]]", toolResults: 0 },
        reply: callReply(`${spawnKid("wait", 1)}; echo kid=$K1; ${holdUntilReleased("pomtree wait $K1 --timeout 600000; echo wait-exit=$?")}`),
      },
      ...kidRules("wait", 1),
      { id: "stray", when: {}, reply: textReply("stray") },
    ],
  };
  await withStack({ script, templates: TEMPLATES, set: { "capacity.maxSessions": "6" } }, async (s) => {
    const p = await spawnAgent(s, { task: "[[scn:waitparent]] wait for the kid", name: "waitparent", budget: 1_000_000, template: "scn-parent" });
    const parked = await untilParked(s, p.id);
    t.diagnostic(`checkpoint wait of the pomtree wait park: ${JSON.stringify(parked.checkpoint.wait)}`);
    assert.equal(parked.checkpoint.wait?.kind, "any", "an implicit child wait is the child's exit or a timer");
    const kid = (await childIds(s, p.id, ["wait1"])).wait1!;
    await s.until("the kid parked", async () => (await showAgent(s, kid)).state === "yielded", 120_000);
    assert.equal((await s.pomtree(["send", kid, "GO-wait1 finish"])).code, 0);
    await assertWokeOnce(s, parked, "parent-woken", new RegExp(`^Resumed: child ${kid} exited \\(succeeded\\)\\..*KIDDONE-wait1`, "s"), t, "pomtree wait");
    noStray(s);
  });
});
