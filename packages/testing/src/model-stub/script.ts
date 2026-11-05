// Scripted-policy model stub: types and the pure rule matcher. A script is a
// list of rules matched against the request's STRUCTURE (turn index, tool
// results, offered tools, agent id, system-prompt markers), never prompt
// hashes, so prompt wording can drift without breaking a test.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Wire = "openai-completions" | "anthropic-messages";

/** All fields optional; a rule matches when every given field matches. */
export interface RequestMatch {
  /** 0-based count of assistant messages already in the request. */
  turn?: number;
  /** Count of tool-result messages in the request. */
  toolResults?: number;
  /** Name of the tool whose result is last. */
  lastTool?: string;
  lastToolIsError?: boolean;
  /** A tool name present in the offered tools list. */
  offersTool?: string;
  /** Agent identity: an `x-pomtree-agent` header if present, else a `[[agent:<id>]]` system-prompt token. */
  agentId?: string;
  /** A `[[stub:<token>]]` token that must appear in the system prompt. */
  marker?: string;
  /** Substring of the last user message text (for steer tests). */
  lastUserIncludes?: string;
  model?: string;
}

export interface StubUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /**
   * The provider-reported cost in USD (OpenRouter's `usage.cost`), emitted verbatim when the key is present (presence, not truthiness: `0` is emitted).
   * Typed `unknown` on purpose so a test can script a malformed cost (a string such as "0.5") to prove the pricer rejects it.
   * Omitting the key means the provider reported no cost at all.
   */
  cost?: unknown;
}

/** The fault menu from the audit (FINDINGS.md `fake-model`). */
export type Fault =
  | {
      type: "status";
      status: 400 | 401 | 402 | 404 | 429 | 500 | 502 | 503;
      retryAfterS?: number;
      body?: string;
    }
  | { type: "reset_before_headers" }
  | { type: "cut_mid_stream"; afterChunks: number }
  | { type: "in_stream_error"; message: string }
  | { type: "missing_usage" }
  | { type: "oversize"; bytes: number }
  | { type: "slow_stream"; chunkDelayMs: number; chunks: number }
  | { type: "malformed_tool_json"; name: string }
  | { type: "empty" }
  | { type: "refusal"; text?: string };

export interface ToolCallSpec {
  name: string;
  arguments: string | Record<string, unknown>;
}

export type Reply =
  | {
      kind: "text";
      text: string;
      usage?: StubUsage;
      finish?: "stop" | "length";
    }
  | { kind: "tool_calls"; calls: ToolCallSpec[]; usage?: StubUsage }
  | { kind: "fault"; fault: Fault };

export interface ScriptRule {
  id: string;
  when: RequestMatch;
  reply: Reply;
  /** How many times the rule may fire; default unlimited. */
  times?: number;
}

export interface ModelScript {
  name: string;
  rules: ScriptRule[];
  /** Reply for unmatched requests; default {@link DEFAULT_FALLBACK}. */
  fallback?: Reply;
}

/** The structural shape of one request, extracted by a wire's shaper. */
export interface RequestShape {
  wire: Wire;
  model: string | null;
  stream: boolean;
  turn: number;
  toolResults: number;
  lastTool: string | null;
  lastToolIsError: boolean | null;
  offeredTools: string[];
  agentId: string | null;
  markers: string[];
  lastUserText: string | null;
  maxTokens: number | null;
}

/** One recorded request: shapes only, never full prompts. */
export interface RecordedCall extends RequestShape {
  index: number;
  path: string;
  /** Matched rule id; null means unmatched (fallback served). */
  matched: string | null;
  /** `text`, `tool_calls`, or `fault:<type>`. */
  replyKind: string;
}

export const DEFAULT_FALLBACK: Reply = {
  kind: "text",
  text: "STUB-UNMATCHED",
  usage: { input: 1, output: 1 },
};

/** Header a caller may set to name the agent; the pomtreed proxy does not forward one today. */
export const AGENT_HEADER = "x-pomtree-agent";

const AGENT_TOKEN = /\[\[agent:([^\]\s]+)\]\]/;
const MARKER_TOKEN = /\[\[stub:([^\]\s]+)\]\]/g;

/** Pure: agent id from the header, else the first `[[agent:<id>]]` system-prompt token. */
export function agentIdFrom(system: string, headers: Record<string, string | undefined>): string | null {
  const h = headers[AGENT_HEADER];
  if (h) return h;
  return AGENT_TOKEN.exec(system)?.[1] ?? null;
}

/** Pure: every `[[stub:<token>]]` in the system prompt, in order, deduplicated. */
export function markersFrom(system: string): string[] {
  const out: string[] = [];
  for (const m of system.matchAll(MARKER_TOKEN)) {
    if (m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function matches(when: RequestMatch, req: RequestShape): boolean {
  if (when.turn !== undefined && when.turn !== req.turn) return false;
  if (when.toolResults !== undefined && when.toolResults !== req.toolResults) return false;
  if (when.lastTool !== undefined && when.lastTool !== req.lastTool) return false;
  if (when.lastToolIsError !== undefined && when.lastToolIsError !== req.lastToolIsError) return false;
  if (when.offersTool !== undefined && !req.offeredTools.includes(when.offersTool)) return false;
  if (when.agentId !== undefined && when.agentId !== req.agentId) return false;
  if (when.marker !== undefined && !req.markers.includes(when.marker)) return false;
  if (when.lastUserIncludes !== undefined && !(req.lastUserText ?? "").includes(when.lastUserIncludes)) return false;
  if (when.model !== undefined && when.model !== req.model) return false;
  return true;
}

/**
 * Pure: the first rule (in script order) whose `when` matches and whose
 * `times` budget is not exhausted in `used`. Does not mutate `used`; the
 * caller records the firing with {@link recordUse}.
 */
export function matchRule(script: ModelScript, req: RequestShape, used: Map<string, number>): ScriptRule | null {
  for (const rule of script.rules) {
    if (rule.times !== undefined && (used.get(rule.id) ?? 0) >= rule.times) continue;
    if (matches(rule.when, req)) return rule;
  }
  return null;
}

export function recordUse(used: Map<string, number>, rule: ScriptRule): void {
  used.set(rule.id, (used.get(rule.id) ?? 0) + 1);
}

export function replyKind(reply: Reply): string {
  return reply.kind === "fault" ? `fault:${reply.fault.type}` : reply.kind;
}

/** Directory holding the built-in scripts (`<name>.json`). */
export const BUILTIN_SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "scripts");

/** Names are `[a-z0-9-]+`; anything else is treated as a file path. */
export function loadModelScript(nameOrPath: string): ModelScript {
  const path = /^[a-z0-9-]+$/.test(nameOrPath) ? join(BUILTIN_SCRIPTS_DIR, `${nameOrPath}.json`) : nameOrPath;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`model script ${JSON.stringify(nameOrPath)}: cannot read ${path} (${(e as Error).message}); built-in names live in ${BUILTIN_SCRIPTS_DIR}`);
  }
  return validateModelScript(JSON.parse(raw), path);
}

/** Structural validation so a typo in a script fails loudly, not as a silent unmatched rule. */
export function validateModelScript(value: unknown, source = "script"): ModelScript {
  const fail = (why: string): never => {
    throw new Error(`model script ${source}: ${why}`);
  };
  if (typeof value !== "object" || value === null) fail("not an object");
  const s = value as Record<string, unknown>;
  if (typeof s.name !== "string") fail("missing string `name`");
  if (!Array.isArray(s.rules)) fail("missing array `rules`");
  const known = new Set(["turn", "toolResults", "lastTool", "lastToolIsError", "offersTool", "agentId", "marker", "lastUserIncludes", "model"]);
  const ids = new Set<string>();
  for (const [i, r] of (s.rules as unknown[]).entries()) {
    const rule = r as Record<string, unknown>;
    if (typeof rule?.id !== "string") fail(`rule ${i}: missing string \`id\``);
    if (ids.has(rule.id as string)) fail(`rule ${i}: duplicate id ${rule.id}`);
    ids.add(rule.id as string);
    if (typeof rule.when !== "object" || rule.when === null) fail(`rule ${rule.id}: missing object \`when\``);
    for (const k of Object.keys(rule.when as object)) if (!known.has(k)) fail(`rule ${rule.id}: unknown match field ${k}`);
    checkReply(rule.reply, `rule ${rule.id}`, fail);
  }
  if (s.fallback !== undefined) checkReply(s.fallback, "fallback", fail);
  return value as ModelScript;
}

function checkReply(reply: unknown, where: string, fail: (why: string) => never): void {
  const r = reply as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null) fail(`${where}: missing reply`);
  const kind = (r as Record<string, unknown>).kind;
  if (kind === "text") {
    if (typeof (r as Record<string, unknown>).text !== "string") fail(`${where}: text reply needs string \`text\``);
  } else if (kind === "tool_calls") {
    if (!Array.isArray((r as Record<string, unknown>).calls)) fail(`${where}: tool_calls reply needs array \`calls\``);
  } else if (kind === "fault") {
    const f = (r as Record<string, unknown>).fault as Record<string, unknown>;
    if (typeof f?.type !== "string") fail(`${where}: fault needs \`type\``);
  } else {
    fail(`${where}: unknown reply kind ${String(kind)}`);
  }
}
