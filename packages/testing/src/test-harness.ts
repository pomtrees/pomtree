import type { AgentId, Harness, HarnessEvent, HarnessSession, SandboxHandle } from "@pomtree/core";

export interface ScriptCtx {
  agent: AgentId;
  prompt: string;
  wake?: string; // set on resume (the wake text handed to the harness); undefined on a fresh start
  emit(ev: HarnessEvent): void;
  end(): void;
  stopped: Promise<void>;
}

// The script plays the agent: it emits events and may call the API (e.g. `pomtree result`) itself.
// One script serves both start and resume; the script branches on `ctx.wake` to distinguish them.
export class ScriptHarness implements Harness {
  private script: (ctx: ScriptCtx) => Promise<void>;
  constructor(script: (ctx: ScriptCtx) => Promise<void>) {
    this.script = script;
  }
  start(o: { agent: AgentId; prompt: string }): Promise<HarnessSession> {
    return this.open(o.agent, o.prompt);
  }
  resume(o: { agent: AgentId; sandbox: SandboxHandle; sessionRef: string; wake: string }): Promise<HarnessSession> {
    return this.open(o.agent, "", o.wake);
  }
  private async open(agent: AgentId, prompt: string, wake?: string): Promise<HarnessSession> {
    const queue: HarnessEvent[] = [];
    let ended = false;
    let waker = () => {};
    const poke = () => waker();
    let markStopped = () => {};
    const stopped = new Promise<void>((r) => (markStopped = r));
    const end = () => {
      ended = true;
      poke();
    };
    const ctx: ScriptCtx = { agent, prompt, ...(wake !== undefined ? { wake } : {}), emit: (e) => (queue.push(e), poke()), end, stopped };
    void this.script(ctx)
      .catch((e) => ctx.emit({ kind: "error", message: String(e) }))
      .finally(end);
    return {
      session: `sess-${agent}`,
      async *events() {
        for (;;) {
          while (queue.length) yield queue.shift()!;
          if (ended) return;
          await new Promise<void>((r) => (waker = r));
        }
      },
      steer: async () => {},
      stop: async () => {
        markStopped();
        end();
      },
    };
  }
}
