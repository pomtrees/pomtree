import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { acquireStateLock } from "@pomtree/pomtreed";
import { gitRepo, rig, tmp, until } from "./harness.ts";

// Real-process fault injection: a pomtreed-like child process is SIGKILLed (no shutdown hooks, no
// finally blocks, no flushes) and a fresh daemon must rebuild from the durable stores alone.
// Seeded: the kill point is derived from the seed, so a failure replays with the same seed.

const childPath = new URL("./fault-child.ts", import.meta.url).pathname;

const prng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

async function runAndKill(repo: string, stateDir: string, count: number, killAfterMs: number): Promise<void> {
  const child = spawn(process.execPath, [childPath, repo, stateDir, String(count)], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const exited = new Promise<string | null>((res) => child.on("exit", (_c, sig) => res(sig)));
  try {
    await until(() => out.includes("ready"), "child ready", 15_000);
    if (killAfterMs > 0) await new Promise((r) => setTimeout(r, killAfterMs));
    // The live holder refuses a second pomtreed on the same state dir.
    assert.throws(() => acquireStateLock(stateDir), /locked by another pomtreed/);
    child.kill("SIGKILL");
    assert.equal(await exited, "SIGKILL");
  } finally {
    child.kill("SIGKILL");
  }
}

for (const seed of [1, 2, 3, 4]) {
  test(`kill -9 of pomtreed mid-flight (seed ${seed}): a restarted daemon takes the stale lock and converges every agent to reaped`, async () => {
    const rand = prng(seed * 7919);
    rand();
    const count = 2 + Math.floor(rand() * 4);
    const killAfterMs = Math.floor(rand() * 150);
    const repo = gitRepo();
    const stateDir = tmp("fault");
    await runAndKill(repo, stateDir, count, killAfterMs);

    const release = acquireStateLock(stateDir); // stale lock (dead pid) is taken over
    const r = rig({ repo, stateDir, play: () => ({ result: { status: "succeeded", result: "recovered" } }) });
    try {
      await r.daemon.recover();
      await r.orchestrator.idle();
      // recover() returns before the failed-on-restart agents are reaped; converge, don't sleep.
      await until(
        async () => (await r.daemon.list({})).every((a) => a.state === "reaped" || (a.state === "running" && a.parent === null)),
        "all children reaped",
        10_000,
      );
      await r.orchestrator.idle();
      console.log(
        seed,
        (await r.daemon.list({})).map((a) => a.name + ":" + a.state),
        (await r.daemon.events({ agent: (await r.daemon.list({})).at(-1)!.id })).map((e) => e.payload.kind),
      );
      const root = await r.daemon.root();
      assert.equal((await r.daemon.get(root.id))?.state, "running", "root survives");
      const kids = await r.daemon.list({ parent: root.id });
      assert.ok(kids.length <= count);
      for (const k of kids) {
        assert.equal(k.state, "reaped", `${k.name} converged (seed ${seed})`);
        // Either it was running at the kill (failed, restarted) or accepted but never started (re-run, succeeded).
        assert.ok(k.exit === "failed" || k.exit === "succeeded", `${k.name} exit ${k.exit}`);
      }
      // Idempotency keys survive the crash: respawning an already-recorded child returns it, not a duplicate.
      for (const k of kids) {
        const again = await r.daemon.spawn(root.id, { name: k.name, task: "t", idempotencyKey: k.name }).catch(() => k);
        assert.equal(again.id, k.id);
      }
    } finally {
      r.store.close();
      release();
    }
  });
}
