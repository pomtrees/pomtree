import type { AgentId, Orchestrator, Signal, WaitCondition } from "@pomtree/core";
import { nextDeadline } from "@pomtree/sched";

export interface Driver {
  drive(agent: AgentId, generation: number): Promise<void>;
  // Post-transition segment for a resumed agent (checkout + session restore + sandbox + pump).
  runResumed(agent: AgentId, generation: number, wake: string): Promise<void>;
  // Re-check a yielded agent's checkpoint wait against an incoming signal; resume only when satisfied.
  wakeResume(agent: AgentId, signal: Signal): Promise<void>;
  stop(agent: AgentId, graceMs: number): Promise<void>;
  deliver(agent: AgentId, signal: Signal, source: string): Promise<void>;
  // The daemon's injectable clock, so timer arming uses the same clock as the stores.
  now(): number;
  // Whether the agent is currently yielded (durable orchestrators re-arm a wait
  // only while it remains unsatisfied).
  isYielded(agent: AgentId): Promise<boolean>;
}

export interface BindableOrchestrator extends Orchestrator {
  bind(driver: Driver): void;
  // Launch a resumed agent's segment, tracked like start() so idle() waits for it.
  resume(agent: AgentId, generation: number, wake: string): Promise<void>;
}

// setTimeout wraps above 2^31-1 ms (~24.8 days) and fires immediately, so long waits are
// re-armed in chunks no larger than this and re-checked on each fire.
export const MAX_TIMER_MS = 2_147_483_647;

// Single-node, in-process orchestrator.
export class LocalOrchestrator implements BindableOrchestrator {
  private driver: Driver | null = null;
  // Keyed by agent; each entry records the generation it is driving so a stale in-flight run
  // (a yield teardown still finishing when a resume lands) is replaced, never swallowed.
  private runs = new Map<AgentId, { generation: number; run: Promise<void> }>();
  // A newer generation can replace `runs` while an older segment is still tearing down. idle() joins both.
  private active = new Set<Promise<void>>();
  // In-process timers for `timer` waits; re-armed by recover() after a restart. Signal waits
  // (message/child_exited) need no arming: they are driven by wake().
  private timers = new Map<AgentId, ReturnType<typeof setTimeout>>();

  bind(driver: Driver): void {
    this.driver = driver;
  }

  private need(): Driver {
    if (!this.driver) throw new Error("orchestrator not bound to a driver");
    return this.driver;
  }

  private clearTimer(agent: AgentId): void {
    const t = this.timers.get(agent);
    if (t) {
      clearTimeout(t);
      this.timers.delete(agent);
    }
  }

  async start(agent: AgentId, generation: number): Promise<void> {
    if (this.runs.get(agent)?.generation === generation) return; // idempotent replay
    const run = this.need()
      .drive(agent, generation)
      .catch((e) => console.error(`drive ${agent} failed:`, e))
      .finally(() => {
        // A resume may have replaced this entry; only clear it if it is still current.
        if (this.runs.get(agent)?.generation === generation) this.runs.delete(agent);
        this.active.delete(run);
      });
    this.active.add(run);
    this.runs.set(agent, { generation, run });
  }

  async resume(agent: AgentId, generation: number, wake: string): Promise<void> {
    this.clearTimer(agent);
    const run = this.need()
      .runResumed(agent, generation, wake)
      .catch((e) => console.error(`resume ${agent} failed:`, e))
      .finally(() => {
        // A still-finishing prior run (same generation fence) must not swallow this resume:
        // the newer generation replaces the stale entry, and only it clears the map.
        if (this.runs.get(agent)?.generation === generation) this.runs.delete(agent);
        this.active.delete(run);
      });
    this.active.add(run);
    this.runs.set(agent, { generation, run });
  }

  // Arm a timer wait in chunks of MAX_TIMER_MS, re-checking the absolute deadline on each
  // fire. A single `setTimeout` past 2^31-1 ms would wrap and fire immediately, so a
  // `yield --until` more than ~24.8 days out must never be armed all at once.
  private armTimer(agent: AgentId, deadline: number): void {
    const driver = this.need();
    const ms = Math.max(0, deadline - driver.now());
    const t = setTimeout(
      () => {
        if (driver.now() < deadline) {
          this.armTimer(agent, deadline);
          return;
        }
        this.timers.delete(agent);
        driver.wakeResume(agent, { kind: "timeout" }).catch((e) => console.error(`timer wake ${agent} failed:`, e));
      },
      Math.min(ms, MAX_TIMER_MS),
    );
    t.unref?.();
    this.timers.set(agent, t);
  }

  async waitFor(agent: AgentId, cond: WaitCondition): Promise<void> {
    this.clearTimer(agent);
    const deadline = nextDeadline(cond);
    if (deadline === null) return;
    this.armTimer(agent, deadline);
  }

  async wake(agent: AgentId, signal: Signal): Promise<void> {
    await this.need().wakeResume(agent, signal);
  }

  async cancel(agent: AgentId, graceMs: number): Promise<void> {
    this.clearTimer(agent);
    await this.need().stop(agent, graceMs);
  }

  async idle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active]);
  }
}
