// Pure session-trace formatter ("Copy trace"): turns an agent record plus its full journal into a compact,
// paste-friendly Markdown document for debugging in a chat. No fs, sockets or clocks: everything comes in
// through TraceInput, so output is deterministic. A redaction pass scrubs credential-looking text unless
// `raw` is set; redaction runs BEFORE truncation so a cut can never leave a partial secret behind.

import type { AgentRecord, Checkpoint, ExitCause, JournalEntry } from "@pomtree/core";
import { AGENT_STATE_WORDING, CONFIG_DEFAULTS, EXIT_CAUSE_WORDING, EXIT_STATUS_WORDING, POMTREED_KINDS } from "@pomtree/core";

export interface TraceChild {
  id: string;
  name: string;
  state: string;
  exit?: string | null;
}

export interface TraceFacts {
  now: number;
  hostId?: string;
  gitSha?: string;
  node?: string;
  platform?: string;
  // Agent endpoint from doctor data (never a token): bind addresses and reachability.
  endpoint?: { bind: string[]; containerReachable?: boolean; hostProbe?: boolean };
  image?: string;
  steerExt?: boolean;
  jobsExt?: boolean;
  waitYieldMs?: number;
}

export interface TraceInput {
  agent: AgentRecord;
  events: JournalEntry[];
  spentMicros?: number;
  remainingMicros?: number;
  parentName?: string;
  children?: TraceChild[];
  checkpoint?: Checkpoint | null;
  facts: TraceFacts;
  // Condensed child traces appended after the footer-less body (already formatted, already redacted).
  childTraces?: { id: string; text: string }[];
}

export interface TraceOptions {
  raw?: boolean;
  short?: boolean; // header + last SHORT_TAIL events + error events only
  maxBytes?: number; // overall cap, default DEFAULT_MAX_BYTES
  tailEvents?: number; // short-mode tail length (default SHORT_TAIL)
  noFooter?: boolean; // condensed child traces omit the footer
}

export interface TraceResult {
  text: string;
  bytes: number;
  events: number; // journal events considered
  omitted: number; // events dropped by size cap / short mode
  redacted: number; // values replaced (0 when raw)
}

export const DEFAULT_MAX_BYTES = 200 * 1024;
export const SHORT_TAIL = 40;
export const TOOL_FIELD_MAX = 4096;
const USAGE_GROUP = 10;

// ---------- redaction ----------

interface Rule {
  kind: string;
  re: RegExp;
  keep?: (m: string, ...g: string[]) => string | null;
}

const lastSegmentHasDigit = (m: string) => /\d/.test(m.slice(m.lastIndexOf(".") + 1));

// Order matters: private keys and JWTs first (they contain characters later rules would nibble at).
const RULES: Rule[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g },
  // Gateway model credentials (`pg1.<payload>.<mac>`, encodeGatewayCredential) get their own rule with no `keep`: the digit heuristic
  // below exists only to spare journal kinds such as ext.pomtreed.escalation_expired, and a 43-character base64url mac has no digit about
  // once in two thousand, which would leave a live credential unredacted.
  { kind: "token", re: /\bpg1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16,}/g },
  // op./ag./ht./ext. tokens (the issueToken family; pg1 is the rule above) end in a 64-hex mac; the digit check keeps journal kinds such as ext.pomtreed.escalation_expired.
  { kind: "token", re: /\b(?:op|ag|ht|ext)\.(?:[A-Za-z0-9_-]+\.)*[A-Za-z0-9_-]{16,}/g, keep: (m) => (lastSegmentHasDigit(m) ? null : m) },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { kind: "sk", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: "aws", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: "slack", re: /\bxox[bp]-[A-Za-z0-9-]{10,}/g },
];

// name = value assignments (env style, JSON, YAML); only the value is replaced. Short or purely numeric values are kept
// ("tokens: 1234", "max_tokens=4096").
const ASSIGN = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{16,})/gi;

export function redact(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const r of RULES) {
    out = out.replace(r.re, (m) => {
      const kept = r.keep?.(m);
      if (kept) return kept;
      count++;
      return `[REDACTED:${r.kind}]`;
    });
  }
  out = out.replace(ASSIGN, (m, name: string, sep: string, val: string) => {
    if (val.startsWith("[REDACTED") || !/[A-Za-z]/.test(val)) return m;
    count++;
    return `${name}${sep}[REDACTED:secret]`;
  });
  return { text: out, count };
}

// ---------- small helpers ----------

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

export function truncate(s: string, max = TOOL_FIELD_MAX): string {
  if (utf8(s) <= max) return s;
  const buf = Buffer.from(s, "utf8");
  const dec = (b: Buffer) => new TextDecoder("utf-8").decode(b).replace(/\uFFFD+$/, "");
  const head = dec(buf.subarray(0, Math.floor(max * 0.6)));
  const tailBuf = buf.subarray(buf.length - Math.floor(max * 0.4));
  const tail = new TextDecoder("utf-8").decode(tailBuf).replace(/^\uFFFD+/, "");
  const omitted = buf.length - utf8(head) - utf8(tail);
  return `${head}\n… ${omitted} bytes omitted …\n${tail}`;
}

// Head-only variant for tool input (the start of a command/path matters most).
function truncateHead(s: string, max = TOOL_FIELD_MAX): string {
  if (utf8(s) <= max) return s;
  const buf = Buffer.from(s, "utf8");
  const head = new TextDecoder("utf-8").decode(buf.subarray(0, max)).replace(/\uFFFD+$/, "");
  return `${head}… ${buf.length - utf8(head)} bytes omitted`;
}

export const dollars = (micros: number) => `$${(micros / 1e6).toFixed(micros % 10000 === 0 ? 2 : 4)}`;
const money = (micros: number | undefined) => (micros === undefined ? "n/a" : `${dollars(micros)} (${micros} µ$)`);
// A sum over usage events whose cost may be null (unpriced): unknown when none is priced, a lower bound when some are.
const costText = (knownMicros: number, priced: number, unpriced: number) =>
  unpriced === 0 ? money(knownMicros) : priced === 0 ? "unknown" : `>=${money(knownMicros)}, ${unpriced} unpriced`;
const iso = (ms: number | undefined) => (ms === undefined ? "n/a" : new Date(ms).toISOString());

export function relTime(deltaMs: number): string {
  const ms = Math.max(0, deltaMs);
  if (ms < 10_000) return `+${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `+${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `+${m}m${String(s % 60).padStart(2, "0")}s`;
  return `+${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function duration(ms: number): string {
  return relTime(ms).slice(1);
}

// Terminal control text in agent/tool output (spinner frames, colors, OSC titles/hyperlinks) is noise in a pasted trace and can
// rewrite a terminal that displays it. Removes OSC (ESC ] … BEL | ESC \\), CSI (ESC [ … final), other two-byte ESC sequences,
// then every remaining C0/C1 control and DEL; newline and tab are kept. Plain text is returned unchanged.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point
const TERMINAL_SEQ = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export function stripTerminal(text: string): string {
  return text.replace(TERMINAL_SEQ, "").replace(CONTROL, "");
}

// A code fence longer than any backtick run inside, so agent text cannot close it early.
function fence(body: string, lang = ""): string {
  let n = 3;
  for (const m of body.matchAll(/`+/g)) n = Math.max(n, m[0].length + 1);
  const f = "`".repeat(n);
  return `${f}${lang}\n${body}\n${f}`;
}

function pretty(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

const compact = (v: unknown, max = 1000): string => {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return utf8(s) > max ? `${truncateHead(s, max)}` : s;
};

// ---------- event blocks ----------

interface Block {
  text: string;
  events: number;
  seqFrom: number;
  seqTo: number;
  important: boolean; // kept by short mode regardless of position
}

// Header clause for a terminal agent: the exit status and cause in the core glossary's words (no second wording source here).
export function endedBecause(state: string, exit: string | null | undefined, cause: string | undefined): string | undefined {
  if (state !== "exited" && state !== "reaped") return undefined;
  const parts: string[] = [];
  if (exit) parts.push(`${exit}: ${EXIT_STATUS_WORDING[exit as keyof typeof EXIT_STATUS_WORDING] ?? "(unknown exit status)"}`);
  if (cause) parts.push(`cause ${cause}: ${EXIT_CAUSE_WORDING[cause as ExitCause] ?? "(unknown cause)"}`);
  if (state === "reaped") parts.push(`reaped is a lifecycle state; ${AGENT_STATE_WORDING.reaped}`);
  return parts.join("; ");
}

function describeExt(p: Record<string, unknown>): string {
  const { kind, ...rest } = p;
  const body = Object.keys(rest).length ? ` ${compact(rest)}` : "";
  return `${String(kind)}${body}`;
}

export function formatTrace(input: TraceInput, opts: TraceOptions = {}): TraceResult {
  const { agent, events, facts } = input;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const first = events[0];
  const t0 = Math.min(agent.createdAt, first?.ts ?? agent.createdAt);
  const rel = (ts: number) => relTime(ts - t0);

  // Pass 1: index results by callId, and mine header facts.
  const results = new Map<string, JournalEntry>();
  const calls = new Set<string>();
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let template: string | undefined;
  let deadlineAt: number | undefined;
  let resumes = 0;
  let inTok = 0;
  let outTok = 0;
  let costMicros = 0;
  let costPriced = 0;
  let costUnknown = 0; // usage events whose cost is null (unpriced): unknown, never counted as 0
  let healthOk = 0;
  let exitCause: string | undefined;
  for (const e of events) {
    const p = e.payload as { kind: string } & Record<string, any>;
    if (p.kind === "tool_call") calls.add(p.callId);
    else if (p.kind === "tool_result") results.set(p.callId, e);
    else if (p.kind === "started" && startedAt === undefined) startedAt = e.ts;
    else if (p.kind === "exited") {
      endedAt = e.ts;
      exitCause = p.cause;
    } else if (p.kind === "spawned" && p.template)
      template = String(p.template); // every spawn path journals it (spawnedPayload)
    else if (p.kind === POMTREED_KINDS.deadline && typeof p.at === "number") deadlineAt = p.at;
    else if (p.kind === "resumed") resumes++;
    else if (p.kind === "usage") {
      inTok += p.inputTokens;
      outTok += p.outputTokens;
      if (typeof p.costMicros === "number") {
        costMicros += p.costMicros;
        costPriced++;
      } else costUnknown++;
    }
  }

  // Pass 2: blocks.
  const blocks: Block[] = [];
  let usageBuf: JournalEntry[] = [];
  const flushUsage = () => {
    if (!usageBuf.length) return;
    const a = usageBuf[0]!;
    const z = usageBuf.at(-1)!;
    let i = 0;
    let o = 0;
    let c = 0;
    let unknown = 0;
    for (const u of usageBuf) {
      const p = u.payload as { inputTokens: number; outputTokens: number; costMicros: number | null };
      i += p.inputTokens;
      o += p.outputTokens;
      if (p.costMicros === null) unknown++;
      else c += p.costMicros;
    }
    blocks.push({
      text: `- ${rel(z.ts)} #${z.seq} usage ×${usageBuf.length}: ${i} in / ${o} out tokens, ${costText(c, usageBuf.length - unknown, unknown)}`,
      events: usageBuf.length,
      seqFrom: a.seq,
      seqTo: z.seq,
      important: false,
    });
    usageBuf = [];
  };
  const push = (e: JournalEntry, text: string, important = false, events = 1) => blocks.push({ text, events, seqFrom: e.seq, seqTo: e.seq, important });
  const head = (e: JournalEntry, label: string) => `- ${rel(e.ts)} #${e.seq}${e.agent !== agent.id ? ` [${e.agent}]` : ""} ${label}`;

  for (const e of events) {
    const p = e.payload as { kind: string } & Record<string, any>;
    if (p.kind === "usage") {
      usageBuf.push(e);
      if (usageBuf.length >= USAGE_GROUP) flushUsage();
      continue;
    }
    flushUsage(); // keep chronological position of the usage summary
    switch (p.kind) {
      case "message":
        push(e, `${head(e, `**${p.role}**`)}\n${fence(String(p.text))}`);
        break;
      case "tool_call": {
        const res = results.get(p.callId);
        let t = `${head(e, `**tool ${p.tool}** (call ${p.callId})`)}\n  input:\n${fence(truncateHead(pretty(p.input)), "json")}`;
        let imp = false;
        if (res) {
          const rp = res.payload as { ok: boolean; output: string };
          t += `\n  result ${rp.ok ? "ok" : "**ERROR**"} (${duration(res.ts - e.ts)} later, #${res.seq}):\n${fence(truncate(String(rp.output ?? "")))}`;
          imp = !rp.ok;
        } else t += "\n  result: (none recorded)";
        blocks.push({ text: t, events: res ? 2 : 1, seqFrom: e.seq, seqTo: res ? Math.max(e.seq, res.seq) : e.seq, important: imp });
        break;
      }
      case "tool_result":
        if (calls.has(p.callId)) continue; // printed with its call
        push(e, `${head(e, `**tool result** (call ${p.callId}) ${p.ok ? "ok" : "**ERROR**"}`)}\n${fence(truncate(String(p.output ?? "")))}`, !p.ok);
        break;
      case "error":
        push(e, `${head(e, "**ERROR**")}\n${fence(truncate(String(p.message)))}`, true);
        break;
      case "provider_error":
        push(e, `${head(e, `**PROVIDER ERROR** ${p.code}${p.retryable ? " (retryable)" : ""}`)}\n${fence(truncate(String(p.message)))}`, true);
        break;
      case "workspace_evicted":
        push(
          e,
          head(
            e,
            `**workspace evicted** ${p.workspace} (${p.reason}): the clone was deleted and any unpushed work in it is gone; for a live or paused agent, recover with \`pomtree pull --from ${agent.id}\` before eviction`,
          ),
          true,
        );
        break;
      case "host_error":
        push(e, `${head(e, `**HOST ERROR** ${p.component}`)}\n${fence(truncate(String(p.message)))}`, true);
        break;
      case "merge_failed":
        push(e, `${head(e, `**MERGE FAILED** child ${p.child} (${p.code})`)}\n${fence(truncate(String(p.message)))}`, true);
        break;
      case "message_failed":
        push(e, head(e, `**message delivery failed** ${p.channel}/${p.purpose}: ${compact(p.subject, 200)} — ${compact(p.reason, 300)}`), true);
        break;
      case "spawned":
        push(e, head(e, `spawned${p.template ? ` template=${p.template}` : ""}`));
        break;
      case "started":
      case "yielded":
      case "resumed":
      case "reaped":
        push(e, head(e, `**${p.kind}**`));
        break;
      case "exited":
        push(e, head(e, `**exited ${p.exit}**${p.cause ? ` (cause: ${p.cause})` : ""}`), true);
        break;
      case "report_published":
        push(e, head(e, `report published: ${p.name} (${p.sizeBytes} bytes)`));
        break;
      case "signal": {
        const s = p.signal as { kind: string } & Record<string, unknown>;
        push(e, head(e, `signal **${s.kind}**: ${compact(Object.fromEntries(Object.entries(s).filter(([k]) => k !== "kind")), 600)}`));
        break;
      }
      case "escalation_raised":
        push(e, `${head(e, `**ask** ${p.escalation}`)}\n${fence(truncate(String(p.question)))}`);
        break;
      case "escalation_answered":
        push(e, `${head(e, `**answer** ${p.escalation} by ${p.answeredBy?.channel}:${p.answeredBy?.sender}`)}\n${fence(truncate(String(p.answer)))}`);
        break;
      case "message_sent":
        push(e, head(e, `message sent → ${p.channel} (${p.purpose}): ${compact(p.subject, 300)}`));
        break;
      case "message_received":
        push(e, `${head(e, `message from ${p.from?.channel}:${p.from?.sender}${p.interrupt ? " **(interrupt)**" : ""}`)}\n${fence(truncate(String(p.body)))}`);
        break;
      case "provider_paused":
        push(e, head(e, `provider paused (${p.scope}): ${compact(p.reason, 300)}`), true);
        break;
      case "provider_resumed":
        push(e, head(e, `provider resumed (${p.scope})`));
        break;
      case "proxy_call":
        push(e, `${head(e, `**ext call ${p.extension}** (${p.callId})`)}\n${fence(truncateHead(pretty(p.input)), "json")}`);
        break;
      case "proxy_result":
        push(
          e,
          head(
            e,
            `ext result (${p.callId}) ${p.ok ? "ok" : `**ERROR**${p.denied ? " denied" : ""}${p.reason ? `: ${truncateHead(String(p.reason), 300)}` : ""}`}`,
          ),
          p.ok === false,
        );
        break;
      case POMTREED_KINDS.hostHealth:
        if (p.ok === true) healthOk++;
        else push(e, head(e, `host_health **not ok** ${compact(p, 300)}`), true);
        break;
      default:
        push(e, head(e, describeExt(p)), /watchdog|quarantine|over_budget|timed_out|merge_skipped|degraded|expired/.test(String(p.kind)));
    }
  }
  flushUsage();

  // Short mode / size cap: choose which blocks survive.
  const keep = new Array<boolean>(blocks.length).fill(true);
  if (opts.short) {
    const tail = opts.tailEvents ?? SHORT_TAIL;
    keep.fill(false);
    let n = 0;
    for (let i = blocks.length - 1; i >= 0 && n < tail; i--) {
      keep[i] = true;
      n += blocks[i]!.events;
    }
    blocks.forEach((b, i) => {
      if (b.important) keep[i] = true;
    });
  }

  // ----- header -----
  const redactOn = !opts.raw;
  const h: string[] = [];
  const end = endedAt ?? (agent.state === "exited" || agent.state === "reaped" ? agent.updatedAt : facts.now);
  const begin = startedAt ?? agent.createdAt;
  h.push(`# Trace: ${agent.name} (${agent.id})`);
  h.push("");
  h.push(
    `- state: ${agent.state}${agent.exit ? `, exit: ${agent.exit}` : ""}${(agent.exitCause ?? exitCause) ? ` (cause: ${agent.exitCause ?? exitCause})` : ""}`,
  );
  h.push(
    agent.executor === "container"
      ? `- model: ${agent.spec.provider ?? "default"}/${agent.spec.model ?? "default"}`
      : `- executor: deterministic (driver ${agent.spec.driver})`,
  );
  h.push(
    `- created: ${iso(agent.createdAt)}; started: ${iso(startedAt)}; ended: ${endedAt !== undefined || agent.state === "exited" || agent.state === "reaped" ? iso(end) : "(still " + agent.state + ")"}`,
  );
  const because = endedBecause(agent.state, agent.exit, agent.exitCause ?? exitCause);
  if (because) h.push(`- ended because: ${because}`);
  h.push(`- wall duration: ${duration(end - begin)}`);
  h.push(`- budget: ${money(agent.budgetMicros)}; spent: ${money(input.spentMicros)}; left: ${money(input.remainingMicros)}`);
  h.push(`- tokens: ${inTok} in / ${outTok} out, journaled cost ${costText(costMicros, costPriced, costUnknown)}`);
  h.push(`- parent: ${agent.parent ?? "none"}${input.parentName ? ` (${input.parentName})` : ""}`);
  const kids = input.children ?? [];
  h.push(`- children: ${kids.length ? kids.map((c) => `${c.id} (${c.name}: ${c.state}${c.exit ? `/${c.exit}` : ""})`).join(", ") : "none"}`);
  if (agent.executor === "container") h.push(`- workspace branch: agent/${agent.id}`);
  h.push(`- template: ${template ?? "none"}; deadline: ${deadlineAt !== undefined ? iso(deadlineAt) : "none"}`);
  h.push(`- generation: ${agent.generation}; resumes: ${resumes}; host: ${agent.host}`);
  if (agent.executor === "container") h.push(`- harness image: ${agent.spec.image || "unknown"}`);
  h.push(`- task: ${JSON.stringify(truncateHead(agent.task, 600))}`);
  if (input.checkpoint)
    h.push(
      `- latest checkpoint: ${input.checkpoint.id} (gen ${input.checkpoint.generation}, ingested ${input.checkpoint.ingested?.commit.slice(0, 12) ?? "none"}, remaining ${money(input.checkpoint.remainingBudgetMicros)}${input.checkpoint.wait ? `, wait ${compact(input.checkpoint.wait, 200)}` : ""})`,
    );
  if (opts.short) h.push("- view: SHORT (last events + errors only)");

  // ----- footer -----
  const f: string[] = [];
  if (!opts.noFooter) {
    f.push("---");
    const ep = facts.endpoint;
    f.push(
      `pomtree ${facts.gitSha ? `git ${facts.gitSha}` : "(git sha unknown)"}; node ${facts.node ?? "?"}; ${facts.platform ?? "?"}; host ${facts.hostId ?? agent.host}; generated ${iso(facts.now)}`,
    );
    f.push(
      `config: agent endpoint ${ep ? `${ep.bind.join(",") || "?"} (container ${ep.containerReachable === undefined ? "?" : ep.containerReachable ? "reachable" : "UNREACHABLE"}, host probe ${ep.hostProbe === undefined ? "?" : ep.hostProbe ? "ok" : "FAILED"})` : "n/a"}; image ${facts.image ?? (agent.executor === "container" ? (agent.spec.image ?? "?") : "n/a")}; POMTREED_HARNESS_STEER_EXT ${facts.steerExt ? "on" : "off"}; POMTREED_HARNESS_JOBS_EXT ${facts.jobsExt ? "on" : "off"}; wait-yield ${facts.waitYieldMs ?? CONFIG_DEFAULTS["wait.yieldMs"]}ms`,
    );
    if (healthOk) f.push(`(${healthOk} routine host_health ok rows not shown)`);
  }

  // Assemble with an overall size cap: keep head and tail blocks, drop the middle.
  const render = (b: Block) => stripTerminal(b.text);
  const marker = (n: number, a: number, z: number) => `- … ${n} events omitted (#${a}–#${z}) …`;
  const chosenIdx = blocks.map((_, i) => i).filter((i) => keep[i]);
  const overheadGuess = utf8(h.join("\n")) + utf8(f.join("\n")) + 1024 + utf8((input.childTraces ?? []).map((c) => c.text).join("\n"));
  const budget = Math.max(2048, maxBytes - overheadGuess);
  let sizeSum = 0;
  for (const i of chosenIdx) sizeSum += utf8(blocks[i]!.text) + 1;
  let shown = new Set(chosenIdx);
  if (sizeSum > budget) {
    shown = new Set();
    let hb = 0;
    let lo = 0;
    while (lo < chosenIdx.length) {
      const sz = utf8(blocks[chosenIdx[lo]!]!.text) + 1;
      if (hb + sz > budget / 2) break;
      hb += sz;
      shown.add(chosenIdx[lo]!);
      lo++;
    }
    let tb = 0;
    for (let hi = chosenIdx.length - 1; hi >= lo; hi--) {
      const sz = utf8(blocks[chosenIdx[hi]!]!.text) + 1;
      if (tb + sz > budget / 2) break;
      tb += sz;
      shown.add(chosenIdx[hi]!);
    }
  }
  const body: string[] = [];
  let omitted = 0;
  let gapN = 0;
  let gapA = 0;
  let gapZ = 0;
  const flushGap = () => {
    if (gapN) body.push(marker(gapN, gapA, gapZ));
    omitted += gapN;
    gapN = 0;
  };
  blocks.forEach((b, i) => {
    if (shown.has(i)) {
      flushGap();
      body.push(render(b));
    } else {
      if (!gapN) gapA = b.seqFrom;
      gapN += b.events;
      gapZ = b.seqTo;
    }
  });
  flushGap();

  const lines = [
    ...h,
    "",
    `## Events (${events.length}${omitted ? `, ${omitted} omitted` : ""})`,
    "",
    ...(body.length ? body : ["(no events)"]),
    ...(f.length ? ["", ...f] : []),
  ];
  let text = lines.join("\n");
  let count = 0;
  if (redactOn) {
    const r = redact(text);
    text = r.text;
    count = r.count;
  }
  // Header note goes in after the count is known (kept out of redaction on purpose: it is our own text).
  const note = redactOn ? `- redacted: ${count} values` : "- redacted: NO (raw output; may contain secrets)";
  const at = text.indexOf("\n\n## Events");
  text = `${text.slice(0, at)}\n${note}${text.slice(at)}\n`;
  // Child traces are pre-formatted (and pre-redacted unless raw) by the caller.
  for (const c of input.childTraces ?? []) text += `\n---\n\n${c.text.replace(/^# Trace:/, "## Child trace:")}\n`;
  return { text, bytes: utf8(text), events: events.length, omitted, redacted: count };
}
