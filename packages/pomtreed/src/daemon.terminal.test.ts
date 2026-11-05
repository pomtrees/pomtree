import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup, until } from "./test-setup.ts";

const terminal = { size: { cols: 90, rows: 30 }, env: { TERM: "xterm-256color" }, sinkFile: "events.jsonl" };

test("terminal deps: sandbox starts with a tty and merged env, and a stale sink file is deleted first", async () => {
  const t = setup(
    async (c) => {
      await c.api("POST", "/v1/agents/self/result", { status: "succeeded", result: { summary: "ok", value: 1 } });
    },
    { terminal },
  );
  const gw = t.daemon.deps.gateway;
  const issue = gw.issueKey.bind(gw);
  let planted = "";
  gw.issueKey = async (id, budget) => {
    // Runs before sandbox.start: plant the previous run's sink file.
    const dir = join(t.daemon.deps.sessionRoot, id);
    mkdirSync(dir, { recursive: true });
    planted = join(dir, terminal.sinkFile);
    writeFileSync(planted, '{"type":"agent_settled"}\n');
    return issue(id, budget);
  };
  await t.spawn("k-term");
  await until(() => t.sandbox.started.length === 1);
  const spec = t.sandbox.started[0]!;
  assert.deepEqual(spec.tty, terminal.size);
  assert.equal(spec.env.TERM, "xterm-256color");
  assert.ok(spec.env.POMTREE_AGENT_ID);
  assert.ok(planted);
  assert.equal(existsSync(planted), false);
});

test("without terminal deps the sandbox is a plain non-tty container", async () => {
  const t = setup(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { status: "succeeded", result: { summary: "ok", value: 1 } });
  });
  await t.spawn("k-plain");
  await until(() => t.sandbox.started.length === 1);
  assert.equal(t.sandbox.started[0]!.tty, undefined);
  assert.equal(t.sandbox.started[0]!.env.TERM, undefined);
});
