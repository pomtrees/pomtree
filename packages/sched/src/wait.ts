import type { AgentId, Signal, WaitCondition } from "@pomtree/core";

// True when the wait condition is satisfied by the given signal and the
// current child-done state. Pure; no I/O.
export function satisfied(cond: WaitCondition, ctx: { signal?: Signal; childDone(id: AgentId): boolean; now: number }): boolean {
  // An escalation addressed to this agent wakes it whatever it waits on.
  if (ctx.signal?.kind === "escalation") return true;
  // A custody hand-up (a dead child's exited descendant, delivered to this agent as its custodian) wakes a message, timer or
  // any-mode child wait: the custodian could not name the held agent in its wait. An all-mode child wait is a join and still
  // needs every listed child. Ask and budget parks are enforced by the daemon, not here.
  const custody = ctx.signal?.kind === "child_exited" && ctx.signal.custodyOf !== undefined;
  switch (cond.kind) {
    case "message":
      // A chat/answer to the agent is a message to it: operator chat delivers
      // `human_message` and escalation answers arrive as `human_answer`.
      return custody || ctx.signal?.kind === "message" || ctx.signal?.kind === "human_message" || ctx.signal?.kind === "human_answer";
    case "timer":
      return custody || ctx.signal?.kind === "timeout" || ctx.now >= cond.at;
    case "child_exited":
      return cond.mode === "any" ? custody || cond.children.some((id) => ctx.childDone(id)) : cond.children.every((id) => ctx.childDone(id));
    case "any":
      return cond.of.some((c) => satisfied(c, ctx));
  }
}

// Earliest absolute time (epoch ms) this condition can become satisfiable on
// its own (a `timer.at`), or null if it waits only on external signals.
export function nextDeadline(cond: WaitCondition): number | null {
  switch (cond.kind) {
    case "timer":
      return cond.at;
    case "any": {
      let min: number | null = null;
      for (const c of cond.of) {
        const d = nextDeadline(c);
        if (d !== null && (min === null || d < min)) min = d;
      }
      return min;
    }
    case "message":
    case "child_exited":
      return null;
  }
}
