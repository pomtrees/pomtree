import type { AgentId, AgentRecord, Sandbox, SandboxBackendId } from "@pomtree/core";
import { sandboxOpKey } from "./daemon/sandbox-ops.ts";
import type { Daemon } from "./daemon.ts";
import { isDone, LifecycleError } from "./lifecycle.ts";

// `pomtree abandon <agent>`: the operator's way out of a run whose sandbox sits on a backend that is no longer selected or reachable
// (SandboxBackendMismatchError). It releases the sandbox on the backend the RECORD names, never the currently selected one; when that
// backend cannot be reached or built here it deletes nothing and says where the sandbox was left. Either way the run ends
// `cancelled` with cause `abandoned`, its sandbox id and backend pin are cleared, and the generation is bumped first, so a late write
// from the old generation is fenced. A repeat finds the abandoned record and returns without touching the sandbox again.
// The exit itself goes through the lifecycle (Daemon.abandonRun): parent notification, children, journal row, watchdog, reap or
// custody, and a live driver is stopped as kill stops it. Another backend's sandbox comes from DaemonDeps.sandboxFor.

export type AbandonResult =
  | { agent: AgentId; outcome: "released"; backend: SandboxBackendId; sandbox: string; message: string }
  | { agent: AgentId; outcome: "left"; backend: string; sandbox: string; cause: string; message: string }
  | { agent: AgentId; outcome: "no_sandbox"; message: string }
  | { agent: AgentId; outcome: "already_abandoned"; message: string };

export interface AbandonOptions {
  reason?: string;
}

const inflight = new WeakMap<Daemon, Map<AgentId, Promise<AbandonResult>>>();

// Concurrent abandons of one agent share a single run, so the sandbox is killed once.
export function abandonAgent(daemon: Daemon, agent: AgentId, o: AbandonOptions = {}): Promise<AbandonResult> {
  const m = inflight.get(daemon) ?? new Map<AgentId, Promise<AbandonResult>>();
  inflight.set(daemon, m);
  const running = m.get(agent);
  if (running) return running;
  const p = run(daemon, agent, o).finally(() => m.delete(agent));
  m.set(agent, p);
  return p;
}

// KNOWN GAP, in plain words: after a "left" outcome nothing remembers that backend X may still hold this sandbox. Boot reconcile lists
// the selected backend and every backend a non-terminal record names; the abandoned record names none and the journal has no
// by-kind read, so a left sandbox is found again only when X is the selected backend (sandbox.backend) at a later boot. If X is
// reachable only through sandboxFor and nothing else names it, its orphan is never listed.
// TODO(abandon-orphan-listing): remember left sandboxes per backend; current behavior as above.
const leftMessage = (agent: AgentId, backend: string, sandbox: string, cause: string) =>
  `agent ${agent} abandoned; sandbox ${sandbox} left on ${backend}: ${cause}; it may still run and bill, so remove it with ${backend}'s own tooling, or select ${backend} (sandbox.backend) and restart so boot reconcile lists it and stops it`;

async function release(daemon: Daemon, r: AgentRecord): Promise<AbandonResult> {
  const sandbox = r.sandbox as string;
  const backend = r.sandboxBackend;
  if (backend === null) {
    const cause = "its record names no sandbox backend (written by a build before the field existed, or damaged)";
    return { agent: r.id, outcome: "left", backend: "unknown", sandbox, cause, message: leftMessage(r.id, "unknown", sandbox, cause) };
  }
  const selected = daemon.deps.sandbox.declaration.backend;
  let sb: Sandbox | null;
  try {
    sb = backend === selected ? daemon.deps.sandbox : (daemon.deps.sandboxFor?.(backend) ?? null);
  } catch (e) {
    sb = null;
    const cause = `backend ${backend} could not be constructed (${e instanceof Error ? e.message : String(e)})`;
    return { agent: r.id, outcome: "left", backend, sandbox, cause, message: leftMessage(r.id, backend, sandbox, cause) };
  }
  if (sb === null) {
    const cause = `backend ${backend} is not the selected backend (${selected}) and cannot be constructed in this daemon`;
    return { agent: r.id, outcome: "left", backend, sandbox, cause, message: leftMessage(r.id, backend, sandbox, cause) };
  }
  try {
    await sb.kill(sandbox, sandboxOpKey("kill", sandbox));
  } catch (e) {
    const cause = `backend ${backend} did not accept the kill (${e instanceof Error ? e.message : String(e)})`;
    return { agent: r.id, outcome: "left", backend, sandbox, cause, message: leftMessage(r.id, backend, sandbox, cause) };
  }
  return { agent: r.id, outcome: "released", backend, sandbox, message: `agent ${r.id} abandoned; sandbox ${sandbox} killed on ${backend}` };
}

async function run(daemon: Daemon, agent: AgentId, o: AbandonOptions): Promise<AbandonResult> {
  const d = daemon.deps;
  const r = await d.registry.get(agent);
  if (!r) throw new LifecycleError(404, `no such agent: ${agent}`);
  if (r.parent === null) {
    throw new LifecycleError(
      409,
      `agent ${agent} is the root supervisor and cannot be abandoned; abandon the child agents that hold stuck sandboxes instead (pomtree ps lists them)`,
    );
  }
  if (isDone(r) && r.exitCause === "abandoned") {
    return { agent, outcome: "already_abandoned", message: `agent ${agent} is already abandoned; nothing to do` };
  }
  if (isDone(r) && r.sandbox === null) {
    throw new LifecycleError(409, `agent ${agent} already ${r.state} (${r.exit ?? "no exit"}) and holds no sandbox; there is nothing to abandon`);
  }
  const result: AbandonResult =
    r.sandbox === null ? { agent, outcome: "no_sandbox", message: `agent ${agent} abandoned; it held no sandbox` } : await release(daemon, r);

  let cur = r;
  if (!isDone(r)) {
    // Fence first: after the bump a late write from the old generation (a still-live container's token, a finishing driver) is stale.
    cur = await d.registry.bumpGeneration(agent, d.hostId, `${agent}:${r.generation}:abandon:bump`);
  }
  if (cur.sandbox !== null) cur = await d.registry.setSandbox(agent, cur.generation, null, `${agent}:${r.generation}:abandon:clear`);
  if (!isDone(cur)) {
    const why = o.reason === undefined || o.reason === "" ? "" : ` (${o.reason})`;
    const summary = `Child ${agent} was abandoned by the operator${why}; ${result.message}; only work it pushed is on branch agent/${agent}.`;
    const out = await daemon.abandonRun(agent, { summary, synthesized: true });
    if (!out.changed && out.record?.exitCause !== "abandoned") {
      throw new LifecycleError(
        409,
        `agent ${agent} changed state while it was being abandoned (now ${out.record?.state ?? "gone"}); run \`pomtree abandon ${agent}\` again`,
      );
    }
    cur = out.record ?? cur;
  }
  await d.journal
    .append({
      agent,
      host: cur.host,
      generation: cur.generation,
      payload: { kind: "error", message: result.message },
      idempotencyKey: `${agent}:${r.generation}:abandon`,
    })
    .catch((e: unknown) => {
      console.error(
        `pomtreed: agent ${agent}: could not journal the abandon (${e instanceof Error ? e.message : String(e)}); the outcome is in the reply and the exited row`,
      );
    });
  return result;
}
