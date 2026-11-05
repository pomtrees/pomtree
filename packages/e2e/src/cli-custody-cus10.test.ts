// CUS-10 of cli-custody.test.ts (same harness, helpers in cli-custody-kit.ts; a file of its own so node --test runs it in parallel).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelScript } from "@pomtree/testing";
import { showAgent } from "./cli-crash.ts";
import {
  answerAsk,
  callReply,
  doneRule,
  idsFromPs,
  kidRule,
  lateSignal,
  MODEL_FLAG,
  SETTINGS,
  SKIP,
  signalsOn,
  spawnAgent,
  spawnKidCmd,
  summaryOf,
  TEMPLATES,
  TIMEOUT,
  waitAllCmd,
  waitDone,
  withStack,
} from "./cli-custody-kit.ts";
import type { AgentJson } from "./cli-scenarios-harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// CUS-10: --ttl on a held child. The TTL sweep rides the zombie tick (agent.zombieSweepMs, default 30 s, set to 1 s here):
// the reap lands within one tick of the TTL. The custodian is told once (a message naming the branch and `pomtree pull --from`), then the child is
// reaped with its record and result readable; a hold without a TTL is untouched.
test("cli operator CUS-10: spawn --ttl reaps a held child after the TTL (within one sweep tick), tells the parent once, keeps the record", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const script: ModelScript = {
    name: "cus10",
    rules: [
      lateSignal,
      {
        id: "parent",
        when: { marker: "parent", lastUserIncludes: "[[scn:cus10parent]]", toolResults: 0 },
        reply: callReply(
          [
            `pomtree spawn --task '[[scn:cus10ttl]] go' --name cus10ttl --ttl 5s --budget 100000 --model ${MODEL_FLAG} > /tmp/cus10ttl; echo ttlkid=$(cat /tmp/cus10ttl)`,
            spawnKidCmd("cus10plain"),
            waitAllCmd("cus10ttl", "cus10plain"),
            'pomtree ask "children done; proceed?" --wait 600000 > /dev/null; echo ask-exit=$?',
            "pomtree reap $(cat /tmp/cus10plain) > /dev/null; echo plain-reap-rc=$?",
            "pomtree result --summary p10; echo result-exit=$?",
          ].join("; "),
        ),
      },
      kidRule("cus10ttl", "ttl-result"),
      kidRule("cus10plain", "plain-result"),
      doneRule("any-done"),
    ],
  };
  await withStack({ script, templates: TEMPLATES, set: { ...SETTINGS, "agent.zombieSweepMs": "1000" } }, async (s) => {
    const zero = await s.pomtree(["spawn", "--task", "x", "--ttl", "0"]);
    assert.equal(zero.code, 2, `--ttl 0 is a usage error: ${zero.out} ${zero.err}`);
    const parent = await spawnAgent(s, { task: "[[scn:cus10parent]] go", name: "parent", budget: 1_000_000, template: "scn-parent" });
    let ttl!: AgentJson;
    let plain!: AgentJson;
    await s.until(
      "both children exited",
      async () => {
        const kids = await idsFromPs(s, parent.id);
        if (!kids.cus10ttl || !kids.cus10plain) return false;
        ttl = kids.cus10ttl;
        plain = kids.cus10plain;
        return ttl.state !== "running" && plain.state === "exited";
      },
      120_000,
    );
    await s.until("the TTL reap", async () => (await showAgent(s, ttl.id)).state === "reaped", 100_000);
    const at = async (id: string, kind: string) => (await s.kinds(id, kind)).map((e) => (e as unknown as { ts?: number }).ts);
    const [exitedAt] = await at(ttl.id, "exited");
    const [reapedAt] = await at(ttl.id, "reaped");
    assert.ok(
      typeof exitedAt === "number" && typeof reapedAt === "number",
      `journal events need a numeric ts to check the TTL lower bound: exited ts ${exitedAt}, reaped ts ${reapedAt}; extend the harness's JournalEvent if the daemon stopped stamping them`,
    );
    t.diagnostic(`TTL 5000 ms: exited at ${exitedAt}, reaped at ${reapedAt} (${reapedAt - exitedAt} ms after the exit)`);
    assert.ok(reapedAt - exitedAt >= 5000, `reaped ${reapedAt - exitedAt} ms after the exit; the TTL is 5000`);
    const reapedRec = await showAgent(s, ttl.id);
    assert.equal(summaryOf(reapedRec), "ttl-result", "the record and result stay readable after the TTL reap");
    assert.equal((await showAgent(s, plain.id)).state, "exited", "a hold without a TTL is untouched");

    const notices = async () => (await signalsOn(s, parent.id)).filter((x) => x.kind === "message" && String(x.body).includes("hold expired"));
    const first = await notices();
    assert.equal(first.length, 1, `the parent is told once, got ${JSON.stringify(first)}`);
    assert.ok(
      String(first[0]!.body).includes(`branch agent/${ttl.id}`) && String(first[0]!.body).includes(`pomtree pull --from ${ttl.id}`),
      String(first[0]!.body),
    );
    assert.ok(first[0]!.seq < (await s.kinds(ttl.id, "reaped"))[0]!.seq, "told before the reap");
    await sleep(4_000); // a few more sweep ticks: no repeat notice, the plain hold is still held
    assert.equal((await notices()).length, 1, "still one notice after a later sweep");
    assert.equal((await showAgent(s, plain.id)).state, "exited");

    await answerAsk(s, parent.id, "children done", "go");
    const rec = await waitDone(s, parent.id, 90_000);
    assert.equal(rec.exit, "succeeded", JSON.stringify(rec));
    assert.deepEqual(s.stub.unmatched, []);
  });
});
