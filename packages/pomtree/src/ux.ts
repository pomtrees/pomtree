import { DOCKER_GROUP_ACTION } from "@pomtree/core";
import { stripControl } from "./sanitize.ts";

// Same format as @pomtree/observe's formatCost; pomtree does not depend on observe (thin client).
export const formatCost = (micros: number) => `$${(micros / 1e6).toFixed(4)}`;

// Dollars alongside raw micros (µ$ = micro-dollars, 1_000_000 = $1.00), e.g. `$0.99 (993706 µ$)`.
export const formatMoney = (micros: number) => `$${(micros / 1e6).toFixed(2)} (${micros} µ$)`;

// --budget: `$5` / `$0.50` are dollars; a bare number is raw µ$ (micro-dollars). Returns undefined when absent,
// null when malformed or not positive.
export function parseBudgetFlag(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t.startsWith("$")) {
    const body = t.slice(1);
    if (!/^(\d+\.?\d*|\.\d+)$/.test(body)) return null;
    const m = Math.round(Number(body) * 1e6);
    return Number.isSafeInteger(m) && m > 0 ? m : null;
  }
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const SMALL_BUDGET_MICROS = 500_000;
export const smallBudgetWarning = (micros: number) =>
  `warning: budget $${(micros / 1e6).toFixed(2)} is small for non-trivial work; children are stopped immediately when they exceed it`;

export interface Summary {
  agentsByState: Record<string, number>;
  waiting?: number; // running agents idle after a settled turn (a subset of agentsByState.running)
  totalSpendMicros: number;
  openEscalations: number;
  hosts?: { host?: string; maxConcurrent?: number; running?: unknown[]; queue?: unknown[] };
  sessions?: { used: number; max: number; mode?: string };
}

export const isSummary = (x: unknown): x is Summary => {
  const s = x as Summary | null;
  return (
    typeof s === "object" &&
    s !== null &&
    typeof s.agentsByState === "object" &&
    s.agentsByState !== null &&
    typeof s.totalSpendMicros === "number" &&
    typeof s.openEscalations === "number"
  );
};

export function renderSummaryLine(s: Summary): string {
  const states = Object.entries(s.agentsByState)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}${k === "running" && s.waiting ? ` (${s.waiting} waiting)` : ""}`);
  return `agents: ${states.length ? states.join(", ") : "none"} | spend: ${formatCost(s.totalSpendMicros)} | escalations: ${s.openEscalations} open`;
}

export function renderSummary(s: Summary): string {
  const h = s.hosts;
  return [
    renderSummaryLine(s),
    ...(h ? [`host:   ${h.host ?? "-"} running ${h.running?.length ?? 0}/${h.maxConcurrent ?? "-"}, queued ${h.queue?.length ?? 0}`] : []),
    ...(s.sessions ? [`sessions: ${s.sessions.used}/${s.sessions.max}${s.sessions.mode ? ` (${s.sessions.mode})` : ""}`] : []),
  ].join("\n");
}

// Colour only on a TTY, never with NO_COLOR (https://no-color.org) or --no-color.
export const colorEnabled = (o: { isTTY?: boolean; noColorFlag: boolean; env?: Record<string, string | undefined> }) =>
  o.isTTY === true && !o.noColorFlag && !(o.env?.NO_COLOR !== undefined && o.env.NO_COLOR !== "");

// The per-command usage lines (plus indented continuations) cut out of the full USAGE text.
export function usageFor(usage: string, cmd: string | undefined): string | null {
  if (!cmd) return null;
  const out: string[] = [];
  let on = false;
  for (const line of usage.split("\n").slice(1)) {
    const cont = /^\s{20,}\S/.test(line);
    if (cont && on) out.push(line);
    else {
      on = line.trimStart().split(/\s+/)[0] === cmd;
      if (on) out.push(line);
    }
  }
  return out.length
    ? `usage: pomtree ${out
        .map((l) => l.trim().replace(/\s{3,}.*$/, ""))
        .filter(Boolean)
        .join("\n       pomtree ")}`
    : null;
}

export function doctorReasons(d0: object): string[] {
  const r: string[] = [];
  const d = d0 as {
    sandboxUp?: boolean;
    journalFailed?: boolean;
    degraded?: boolean;
    sweepsStale?: boolean;
    agentEndpoint?: { bind?: string[]; containerReachable?: boolean; hostProbe?: boolean; message?: string };
  };
  if (d.sandboxUp === false) r.push("sandbox unavailable");
  if (d.journalFailed) r.push("journal writes failing");
  if (d.degraded) r.push("daemon degraded");
  if (d.sweepsStale) r.push("background sweeps stale");
  const ae = d.agentEndpoint;
  if (ae && (ae.hostProbe === false || ae.containerReachable === false))
    r.push(ae.message ?? `agent endpoint ${(ae.bind ?? []).join(",")} not reachable from containers`);
  return r;
}

// Next step per doctor problem, parallel to (and keyed by the same conditions as) doctorReasons; the reason labels stay stable.
export function doctorNextSteps(d0: object): string[] {
  const d = d0 as {
    sandboxUp?: boolean;
    journalFailed?: boolean;
    degraded?: boolean;
    sweepsStale?: boolean;
    agentEndpoint?: { containerReachable?: boolean; hostProbe?: boolean };
  };
  const n: string[] = [];
  if (d.sandboxUp === false)
    n.push(`sandbox unavailable: start Docker (Docker Desktop or the docker service); if the docker socket says permission denied, ${DOCKER_GROUP_ACTION}`);
  if (d.journalFailed) n.push("journal writes failing: check free disk space and write permissions on the pomtreed state dir (POMTREED_STATE_DIR)");
  if (d.degraded) n.push("daemon degraded: read pomtreed.log in the pomtreed state dir for the cause, then restart pomtreed");
  if (d.sweepsStale) n.push("background sweeps stale: read pomtreed.log in the pomtreed state dir; restart pomtreed if it persists");
  const ae = d.agentEndpoint;
  if (ae && (ae.hostProbe === false || ae.containerReachable === false))
    n.push(
      "agent api not reachable from containers: a host firewall is likely dropping container-to-host traffic; on Linux with ufw active run `sudo ufw allow in on docker0` and `sudo ufw allow in on br-+`, then restart pomtreed (deploy/INSTALL.md, Linux firewall)",
    );
  return n;
}

// Hint line for a TransportError, by failure class: each class has a different action.
export function transportHint(message: string, stateDir: string): string {
  if (message.startsWith("POMTREE_API must be"))
    return "set POMTREE_API to an http:// URL (e.g. http://host.docker.internal:PORT), or unset it to use the unix socket";
  if (message.includes("invalid JSON"))
    return "the daemon answered with something that is not pomtreed's API: the daemon and this pomtree are probably different versions, or POMTREE_API/POMTREE_SOCKET points at another service; rebuild and restart pomtreed (scripts/pomtree-up REPO --rebuild)";
  return `is pomtreed running? POMTREED_STATE_DIR=${stateDir}: nothing is listening on that socket/URL, or this shell points at the wrong state dir or socket; start it with scripts/pomtree-up REPO, or point this shell at the running one with eval "$(scripts/pomtree-up REPO --print-env)"`;
}

export function renderDoctor(
  d: { ok: boolean; host: string; agents: Record<string, number>; sandboxes: number; live: number } & Record<string, unknown>,
): string {
  const reasons = doctorReasons(d);
  const ae = (d as { agentEndpoint?: { bind?: string[]; containerReachable?: boolean; hostProbe?: boolean } }).agentEndpoint;
  const ms = (d as { maxSessions?: { value: number; mode: string } }).maxSessions;
  const rev = d as { revisionMismatch?: boolean; gitSha?: string; imageRevision?: string };
  const warning =
    rev.revisionMismatch === true
      ? `WARNING: client/server revision mismatch: pomtreed git ${rev.gitSha ?? "unknown"} vs agent image ${rev.imageRevision ?? "unknown"} (run scripts/pomtree-up --rebuild)`
      : null;
  const next = doctorNextSteps(d);
  const states =
    Object.entries(d.agents ?? {})
      .map(([k, n]) => `${n} ${k}`)
      .join(", ") || "none";
  return [
    ...(warning ? [warning] : []),
    d.ok ? "ok" : `FAIL: ${reasons.length ? reasons.join("; ") : "daemon reports unhealthy"}`,
    `  host:       ${d.host}`,
    ...(typeof d.version === "string" ? [`  pomtreed:      ${d.version}`] : []),
    `  agents:     ${states}`,
    `  sandboxes:  ${d.sandboxes}`,
    `  live:       ${d.live}`,
    ...(ms ? [`  max sessions: ${ms.value} (${ms.mode})`] : []),
    ...(ae
      ? [
          `  agent api:  ${(ae.bind ?? []).join(", ") || "off"} (${ae.containerReachable === false || ae.hostProbe === false ? "NOT reachable from containers" : "reachable from containers"})`,
        ]
      : []),
    ...next.map((x) => `  next: ${x}`),
  ].join("\n");
}

const textOf = (c: unknown): string => {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((p) => (typeof p === "string" ? p : typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : ""))
      .filter(Boolean)
      .join(" ");
  return "";
};

// One line per Pi session entry: kind/role plus a text snippet.
export function transcriptLine(e: unknown, n = 100): string {
  const o = (typeof e === "object" && e !== null ? e : {}) as Record<string, any>;
  const msg = (typeof o.message === "object" && o.message !== null ? o.message : o) as Record<string, any>;
  const kind = String(o.type ?? o.kind ?? "entry");
  const role = typeof msg.role === "string" ? msg.role : undefined;
  const text = (textOf(msg.content) || textOf(msg.text) || textOf(o.summary) || "").replace(/\s+/g, " ").trim();
  const head = role ? `${kind}(${role})` : kind;
  const clipped = text.length > n ? `${text.slice(0, n - 1)}…` : text;
  return stripControl(clipped ? `${head} ${clipped}` : head);
}
