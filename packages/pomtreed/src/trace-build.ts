// Thin async shell for GET /v1/agents/:id/trace: gathers the agent, its FULL journal (paged), spend, children,
// checkpoint and daemon facts through the Daemon's read APIs, then hands them to the pure formatter (trace.ts).
import type { AgentRecord, JournalEntry } from "@pomtree/core";
import { CONFIG_DEFAULTS } from "@pomtree/core";

import type { Daemon } from "./daemon.ts";
import { DEFAULT_CONTAINER_CONFIG } from "./daemon-util.ts";
import { gitSha } from "./revision.ts";
import { DEFAULT_MAX_BYTES, formatTrace } from "./trace.ts";
import type { TraceFacts, TraceInput, TraceResult } from "./trace.ts";

export interface BuildOptions {
  raw?: boolean;
  short?: boolean;
  children?: boolean;
  maxBytes?: number;
}

async function allEvents(daemon: Daemon, agent: string): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for (let from = 1; ; ) {
    const page = await daemon.events({ agent, from, limit: 1000 });
    out.push(...page);
    const last = page.at(-1);
    if (!last || page.length < 1000) return out;
    from = last.seq + 1;
  }
}

async function facts(daemon: Daemon): Promise<TraceFacts> {
  let endpoint: TraceFacts["endpoint"];
  try {
    const d = await daemon.doctor();
    const e = d.agentEndpoint;
    if (e) endpoint = { bind: e.bind, containerReachable: e.containerReachable, hostProbe: e.hostProbe };
  } catch {
    /* doctor is best effort */
  }
  return {
    now: Date.now(),
    hostId: daemon.deps.hostId,
    gitSha: gitSha(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    endpoint,
    image: daemon.deps.image,
    steerExt: daemon.deps.harnessExtensions?.steerExt ?? CONFIG_DEFAULTS["harness.steerExt"],
    jobsExt: daemon.deps.harnessExtensions?.jobsExt ?? CONFIG_DEFAULTS["harness.jobsExt"],
    waitYieldMs: (daemon.deps.containerConfig ?? DEFAULT_CONTAINER_CONFIG)["wait.yieldMs"],
  };
}

async function inputFor(daemon: Daemon, a: AgentRecord, f: TraceFacts): Promise<TraceInput> {
  const kids = await daemon.list({ parent: a.id });
  const parent = a.parent ? await daemon.get(a.parent) : null;
  return {
    agent: a,
    events: await allEvents(daemon, a.id),
    spentMicros: (await daemon.deps.gateway.spend(a.id)).spentMicros,
    remainingMicros: await daemon.remainingMicros(a),
    parentName: parent?.name,
    children: kids.map((c) => ({ id: c.id, name: c.name, state: c.state, exit: c.exit })),
    checkpoint: await daemon.deps.checkpoints.latest(a.id).catch(() => null),
    facts: f,
  };
}

const CHILD_BYTES = [0, 24 * 1024, 12 * 1024]; // per-child cap by depth
const CHILDREN_TOTAL = 96 * 1024;

export async function buildTrace(daemon: Daemon, a: AgentRecord, o: BuildOptions = {}): Promise<TraceResult> {
  const f = await facts(daemon);
  const input = await inputFor(daemon, a, f);
  let redacted = 0;
  let omitted = 0;
  let events = 0;
  if (o.children) {
    const childTraces: { id: string; text: string }[] = [];
    let used = 0;
    const walk = async (parent: AgentRecord, depth: number): Promise<void> => {
      for (const c of await daemon.list({ parent: parent.id })) {
        if (used >= CHILDREN_TOTAL) return;
        const r = formatTrace(await inputFor(daemon, c, f), {
          raw: o.raw,
          short: true,
          tailEvents: 15,
          noFooter: true,
          maxBytes: Math.min(CHILD_BYTES[depth]!, CHILDREN_TOTAL - used),
        });
        used += r.bytes;
        redacted += r.redacted;
        childTraces.push({ id: c.id, text: r.text.trimEnd() });
        if (depth < 2) await walk(c, depth + 1);
      }
    };
    await walk(a, 1);
    input.childTraces = childTraces;
  }
  const r = formatTrace(input, { raw: o.raw, short: o.short, maxBytes: o.maxBytes ?? DEFAULT_MAX_BYTES });
  events = r.events;
  omitted = r.omitted;
  return { ...r, redacted: r.redacted + redacted, events, omitted };
}
