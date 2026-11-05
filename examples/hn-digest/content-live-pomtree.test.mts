import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLiveArgs } from "./content-live.mts";
import {
  type ApprovalRow,
  type ChildResult,
  decideViaPomtree,
  pendingPublish,
  pomtreeChildEnv,
  pomtreeDecideArgv,
  pomtreeOutcomeProblem,
  scrub,
} from "./content-live-pomtree.mts";

const TOKEN = "op-token-SECRET-123";
const operator = { POMTREE_SOCKET: "/state/l-ab.sock", POMTREE_TOKEN: TOKEN };
const row = (id: string, state: string, kind = "publish"): ApprovalRow => ({ id, state, action: { kind } });

describe("pendingPublish", () => {
  it("picks the single pending publish approval", () => {
    assert.equal(pendingPublish([row("a", "approved"), row("b", "pending", "budget_raise"), row("c", "pending")])?.id, "c");
  });
  it("is null with none pending, or when more than one is pending (never guesses)", () => {
    assert.equal(pendingPublish([row("a", "approved")]), null);
    assert.equal(pendingPublish([row("a", "pending"), row("b", "pending")]), null);
  });
});

describe("pomtree child invocation", () => {
  it("argv names the approval and approve, and carries no token or socket", () => {
    const argv = pomtreeDecideArgv("apr-1");
    assert.deepEqual(argv.slice(0, 3), ["decide", "apr-1", "approve"]);
    assert.ok(!argv.join(" ").includes(TOKEN) && !argv.join(" ").includes(operator.POMTREE_SOCKET));
  });
  it("env carries the token and socket, no agent generation, and no unrelated variables", () => {
    const env = pomtreeChildEnv(operator, { PATH: "/bin", POMTREE_AGENT_GENERATION: "0", OPENROUTER_API_KEY: "k", HOME: "/h" });
    assert.deepEqual(env, { PATH: "/bin", NO_COLOR: "1", POMTREE_SOCKET: operator.POMTREE_SOCKET, POMTREE_TOKEN: TOKEN });
  });
  it("scrub removes every occurrence", () => {
    assert.equal(scrub(`a ${TOKEN} b ${TOKEN}`, [TOKEN]), "a [redacted] b [redacted]");
  });
});

describe("pomtreeOutcomeProblem", () => {
  it("accepts target approved and nothing else changed", () => {
    assert.equal(pomtreeOutcomeProblem([row("a", "pending"), row("b", "approved")], [row("a", "approved"), row("b", "approved")], "a"), null);
  });
  it("rejects a still-pending target, a denied target, a missing target and a changed bystander", () => {
    assert.match(pomtreeOutcomeProblem([row("a", "pending")], [row("a", "pending")], "a") ?? "", /still pending/);
    assert.match(pomtreeOutcomeProblem([row("a", "pending")], [row("a", "denied")], "a") ?? "", /not approved/);
    assert.match(pomtreeOutcomeProblem([row("a", "pending")], [], "a") ?? "", /missing/);
    assert.match(pomtreeOutcomeProblem([row("a", "pending"), row("b", "pending")], [row("a", "approved"), row("b", "denied")], "a") ?? "", /wrong approval: b/);
  });
});

describe("decideViaPomtree", () => {
  const run = async (child: ChildResult, after: ApprovalRow[]) => {
    const calls: { argv: string[]; env: Record<string, string>; timeoutMs: number }[] = [];
    let listed = 0;
    await decideViaPomtree("a", {
      operator,
      timeoutMs: 1234,
      settleMs: 20,
      pollMs: 5,
      list: async () => (listed++ === 0 ? [row("a", "pending")] : after),
      spawner: async (_c, argv, env, timeoutMs) => {
        calls.push({ argv, env, timeoutMs });
        return child;
      },
    });
    return calls;
  };
  it("passes the token only in env and succeeds once the daemon shows the approval", async () => {
    const [c] = await run({ code: 0, timedOut: false, output: "" }, [row("a", "approved")]);
    assert.ok(c);
    assert.equal(c.env.POMTREE_TOKEN, TOKEN);
    assert.ok(!c.argv.some((x) => x.includes(TOKEN)));
    assert.equal(c.timeoutMs, 1234);
  });
  it("fails on a nonzero exit, with the token scrubbed from the child's output", async () => {
    await assert.rejects(
      run({ code: 5, timedOut: false, output: `boom ${TOKEN}` }, []),
      (e: Error) => /exited 5: boom \[redacted\]/.test(e.message) && !e.message.includes(TOKEN),
    );
  });
  it("fails on a timeout, on a clean exit that left the approval pending, and on a deny", async () => {
    await assert.rejects(run({ code: null, timedOut: true, output: "" }, []), /timed out/);
    await assert.rejects(run({ code: 0, timedOut: false, output: "" }, [row("a", "pending")]), /still pending/);
    await assert.rejects(run({ code: 0, timedOut: false, output: "" }, [row("a", "denied")]), /not approved/);
  });
});

describe("--approval flag", () => {
  it("accepts pomtree and still rejects other values", () => {
    assert.equal(parseLiveArgs(["--output-dir", "o", "--approval", "pomtree"]).approval, "pomtree");
    assert.throws(() => parseLiveArgs(["--output-dir", "o", "--approval", "maybe"]), /approve, deny or pomtree/);
  });
});
