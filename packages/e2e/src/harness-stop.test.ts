// Regression for the harness stop logic (stopChild in cli-scenarios-harness.ts): a child killed by an external signal has exitCode null and
// its 'exit' event already fired, so a stop that waits on exitCode alone would wait for that event forever. Offline; no Docker.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { after, test } from "node:test";
import { stopChild } from "./cli-scenarios-harness.ts";

const children: ChildProcess[] = [];
after(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});

const spawnIdle = () => {
  const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)"], { stdio: "ignore" });
  children.push(c);
  return c;
};
const exited = (c: ChildProcess) => new Promise<void>((r) => c.once("exit", () => r()));

// Rejects instead of hanging if `p` does not settle in `ms`.
const within = async <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${what} did not settle within ${ms}ms; stopChild waits for an 'exit' event that already fired`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
};

test("stopChild returns at once for a child already dead by an external SIGKILL", async () => {
  const c = spawnIdle();
  await new Promise<void>((r) => c.once("spawn", () => r()));
  const done = exited(c);
  process.kill(c.pid!, "SIGKILL");
  await done;
  assert.equal(c.exitCode, null);
  assert.equal(c.signalCode, "SIGKILL");
  await within(stopChild(c, "SIGTERM", 30_000), 5_000, "stopChild after external SIGKILL");
});

test("stopChild signals a live child and resolves after it exits", async () => {
  const c = spawnIdle();
  await new Promise<void>((r) => c.once("spawn", () => r()));
  await within(stopChild(c, "SIGTERM", 30_000), 10_000, "stopChild of a live child");
  assert.equal(c.signalCode, "SIGTERM");
});
