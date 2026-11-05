import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SESSION_FILE } from "./daemon-util.ts";
import { get, setup, until } from "./test-setup.ts";

// TODO(session-fs) regressions: the session dir is agent-writable, so what the daemon finds at session.jsonl when it checkpoints (yield)
// or restores (resume) is the agent's choice. A symlink to a sibling's session, a FIFO, or a link to /dev/zero is refused (checkpoint)
// or replaced (resume), never followed, read whole, or blocked on.
type T = ReturnType<typeof setup>;
const sessionDir = (t: T, agent: string) => join(t.daemon.deps.sessionRoot, agent);

const PLANTS = [
  [
    "a symlink to a sibling agent's session",
    (t: T, dir: string) => {
      const sib = join(t.daemon.deps.sessionRoot, "sibling");
      mkdirSync(sib, { recursive: true });
      writeFileSync(join(sib, SESSION_FILE), '{"type":"session","secret":"sibling"}\n');
      symlinkSync(`../sibling/${SESSION_FILE}`, join(dir, SESSION_FILE));
    },
  ],
  ["a FIFO", (_t: T, dir: string) => execFileSync("mkfifo", [join(dir, SESSION_FILE)])],
  ["a symlink to /dev/zero", (_t: T, dir: string) => symlinkSync("/dev/zero", join(dir, SESSION_FILE))],
] as const;

const refusals = async (t: T, id: string) =>
  (await t.journal.read({ agent: id }))
    .map((e) => e.payload as { kind: string; message?: string })
    .filter((p) => p.kind === "error" && p.message?.startsWith("session-fs: refusing to open"));

// DECIDED (session-fs): a refused checkpoint keeps the previous checkpoint's session, journals the refusal, and does not fail the agent.
for (const [name, plant] of PLANTS) {
  test(`a yield over ${name} planted as session.jsonl keeps the previous checkpoint's session and journals the refusal`, { timeout: 20_000 }, async () => {
    let id = "";
    const t = setup(async (c) => {
      id = c.agent;
      const dir = sessionDir(t, c.agent);
      mkdirSync(dir, { recursive: true });
      if (!c.wake) {
        writeFileSync(join(dir, SESSION_FILE), '{"type":"session"}\n');
        return void (await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" }));
      }
      rmSync(join(dir, SESSION_FILE), { force: true });
      plant(t, dir);
      await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y2" });
    });
    await t.spawn();
    await until(async () => id !== "" && (await get(t, id)).state === "yielded", 10_000);
    const first = await t.daemon.deps.checkpoints.latest(id);
    assert.ok(first);
    const root = await t.daemon.root();
    await t.daemon.deps.mailbox.send(id, { kind: "message", from: root.id, body: "hi" }, "wake-1");
    await t.daemon.reconcile();
    await t.orchestrator.idle();
    await until(async () => (await t.daemon.deps.checkpoints.latest(id))?.id !== first.id && (await get(t, id)).state === "yielded", 10_000);
    const second = await t.daemon.deps.checkpoints.latest(id);
    assert.equal(second?.sessionRef, first.sessionRef, "the refused file is not checkpointed; the previous session is kept");
    const [r, ...more] = await refusals(t, id);
    assert.equal(more.length, 0);
    assert.match(r?.message ?? "", new RegExp(`keeps the session of the previous checkpoint ${first.id}.*remove the entry from the agent's session directory`));
  });
}

test("a refused session with no earlier checkpoint is checkpointed as an empty session, and the agent still yields", { timeout: 20_000 }, async () => {
  let id = "";
  const t = setup(async (c) => {
    id = c.agent;
    const dir = sessionDir(t, c.agent);
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, SESSION_FILE), { force: true });
    execFileSync("mkfifo", [join(dir, SESSION_FILE)]);
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await until(async () => id !== "" && (await get(t, id)).state === "yielded", 10_000);
  const cp = await t.daemon.deps.checkpoints.latest(id);
  assert.equal((await t.daemon.deps.sessions.get(cp?.sessionRef ?? ""))?.length, 0);
  assert.match((await refusals(t, id))[0]?.message ?? "", /it is a FIFO.*keeps an empty session \(there is no earlier checkpoint\)/);
});

test("resume replaces a symlink planted at session.jsonl instead of writing the checkpoint through it", { timeout: 20_000 }, async () => {
  let id = "";
  const t = setup(async (c) => {
    if (c.wake) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "woke" } }));
    id = c.agent;
    const dir = sessionDir(t, c.agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SESSION_FILE), '{"type":"session"}\n');
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await until(async () => id !== "" && (await get(t, id)).state === "yielded", 10_000);
  const sib = join(t.daemon.deps.sessionRoot, "sibling");
  mkdirSync(sib, { recursive: true });
  const sibFile = join(sib, SESSION_FILE);
  writeFileSync(sibFile, "sibling conversation\n");
  const link = join(sessionDir(t, id), SESSION_FILE);
  rmSync(link);
  symlinkSync(`../sibling/${SESSION_FILE}`, link);
  const root = await t.daemon.root();
  await t.daemon.deps.mailbox.send(id, { kind: "message", from: root.id, body: "hi" }, "wake-1");
  await t.daemon.reconcile();
  await t.orchestrator.idle();
  await until(async () => ["exited", "reaped"].includes((await get(t, id)).state), 10_000);
  assert.equal(readFileSync(sibFile, "utf8"), "sibling conversation\n", "the sibling's session is untouched");
  assert.ok(lstatSync(link).isFile(), "the link was replaced by the restored session");
  assert.equal(readFileSync(link, "utf8"), '{"type":"session"}\n');
});
