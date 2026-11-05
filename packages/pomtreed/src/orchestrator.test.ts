import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentId, Signal } from "@pomtree/core";
import { LocalOrchestrator, MAX_TIMER_MS } from "./orchestrator.ts";
import type { Driver } from "./orchestrator.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A scripted driver with a controllable clock; records timer wakes.
function driver(now: () => number, onWake: (agent: AgentId, signal: Signal) => void): Driver {
  return {
    now,
    async drive(_agent: AgentId, _generation: number) {},
    async runResumed(_agent: AgentId, _generation: number, _wake: string) {},
    async wakeResume(agent: AgentId, signal: Signal) {
      onWake(agent, signal);
    },
    async stop(_agent: AgentId, _graceMs: number) {},
    async deliver(_agent: AgentId, _signal: Signal) {},
    async isYielded(_agent: AgentId) {
      return true;
    },
  };
}

test("idle joins a superseded generation's teardown, not only the current run map", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const orch = new LocalOrchestrator();
  const scripted = driver(Date.now, () => {});
  scripted.drive = async () => gate;
  orch.bind(scripted);
  await orch.start("a", 0);
  await orch.resume("a", 1, "wake");
  let settled = false;
  const idle = orch.idle().then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false, "the old drive still owns teardown work");
  release();
  await idle;
  assert.equal(settled, true);
});

test("waitFor chunks a >24.8-day timer instead of firing it immediately", async () => {
  let now = 1_000_000;
  const wakes: string[] = [];
  const orch = new LocalOrchestrator();
  orch.bind(
    driver(
      () => now,
      (_a, s) => wakes.push(s.kind),
    ),
  );
  // 2^31-1 ms is the setTimeout ceiling (~24.8 days); +60s crosses it. A single oversized
  // setTimeout would wrap and fire ~immediately, which is the regression this guards against.
  await orch.waitFor("a", { kind: "timer", at: now + MAX_TIMER_MS + 60_000 });
  await sleep(30);
  assert.deepEqual(wakes, [], "a >24.8-day timer must not fire immediately");
});

test("waitFor fires a timeout once the deadline is reached", async () => {
  let now = 1_000_000;
  const wakes: string[] = [];
  const orch = new LocalOrchestrator();
  orch.bind(
    driver(
      () => now,
      (_a, s) => wakes.push(s.kind),
    ),
  );
  await orch.waitFor("a", { kind: "timer", at: now - 1 }); // already past
  await sleep(20);
  assert.deepEqual(wakes, ["timeout"], "an already-elapsed timer fires a timeout wake");
});
