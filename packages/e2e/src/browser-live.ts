import { createHash } from "node:crypto";

// Pure checks for a live browser run: they read Pi's `--mode json` event stream and the browser receipt, and decide whether the
// agent stayed on the article's site, what it cited, and what it cost. No I/O here, so every rule is unit-testable on the host;
// the live shell that reads files and runs Pi lives elsewhere.

type Json = Record<string, unknown>;

export interface ToolCall {
  callId: string;
  name: string;
  args: unknown;
  argsHash: string;
  ok: boolean | null;
  resultText: string;
  at: string | null; // ISO time from the session log (the start event's timestamp, else the issuing assistant message's), else null
  turn: number | null; // zero-based index of the assistant message that issued the call, else null
}

const MULTI_PART_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "co.nz", "com.br", "co.in", "com.cn"]);

const RECEIPT_KEYS = [
  "worker",
  "generation",
  "originalUrl",
  "finalUrl",
  "method",
  "status",
  "contentType",
  "rawBodyReport",
  "domReport",
  "textReport",
  "screenshotReport",
  "navigationReport",
];
const REPORT_KEYS = ["rawBodyReport", "domReport", "textReport", "screenshotReport", "navigationReport"];
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(text: string): boolean {
  try {
    const protocol = new URL(text).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// Heuristic, not the Public Suffix List: it knows only the suffixes in MULTI_PART_SUFFIXES. An unlisted multi-part suffix
// (for example example.com.xx) is reduced to its last two labels, so distinct sites under it compare as one. That can only
// make a same-site check looser on such hosts; the list is kept short on purpose and extended when a real host needs it.
export function registrableDomain(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    h = end >= 0 ? h.slice(1, end) : h.slice(1);
  } else if (h.split(":").length === 2) {
    // host:port. A bare IPv6 address has several colons and is left alone.
    h = h.slice(0, h.indexOf(":"));
  }
  if (h.endsWith(".")) h = h.slice(0, -1);
  // IPv6 and IPv4 literals have no registrable-domain structure; so do single-label names such as localhost.
  if (h.includes(":") || /^\d+(\.\d+){3}$/.test(h)) return h;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const last2 = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(last2) ? labels.slice(-3).join(".") : last2;
}

// Pi's stdout can carry Chromium stderr noise and other non-JSON lines; only JSON objects with a string `type` are events.
export function parsePiEvents(text: string): Json[] {
  const events: Json[] = [];
  for (const line of text.split("\n")) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(value) && typeof value.type === "string") events.push(value);
  }
  return events;
}

// Canonical JSON with object keys sorted at every depth, so two argument objects that differ only in key order hash alike.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hashArgs(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex").slice(0, 16);
}

// Concatenates the text blocks of a tool result. Image blocks carry no text and contribute nothing.
function resultTextOf(result: unknown): string {
  const content = isRecord(result) ? result.content : undefined;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

// ISO string from an epoch-millisecond number or a parsable date string; null for anything else.
function isoTime(value: unknown): string | null {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// A call opens at `tool_execution_start` and closes at the matching `tool_execution_end`. A call with no end stays
// `ok: null` with empty text, so an interrupted run is visible rather than counted as success.
export function extractToolCalls(events: Json[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  // Which assistant message (turn) issued each call, and when that message was stamped; the start event itself may carry no time.
  const issued = new Map<string, { turn: number; at: string | null }>();
  let turn = 0;
  for (const event of events) {
    const message = assistantMessage(event);
    if (!message) continue;
    if (Array.isArray(message.content))
      for (const block of message.content)
        if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") issued.set(block.id, { turn, at: isoTime(message.timestamp) });
    turn++;
  }
  for (const event of events) {
    if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
      calls.set(event.toolCallId, {
        callId: event.toolCallId,
        name: typeof event.toolName === "string" ? event.toolName : "",
        args: event.args,
        argsHash: hashArgs(event.args),
        ok: null,
        resultText: "",
        at: isoTime(event.timestamp) ?? issued.get(event.toolCallId)?.at ?? null,
        turn: issued.get(event.toolCallId)?.turn ?? null,
      });
    } else if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
      const call = calls.get(event.toolCallId);
      if (!call) continue;
      call.ok = event.isError !== true;
      call.resultText = resultTextOf(event.result);
    }
  }
  return [...calls.values()];
}

// Every http(s) string anywhere in the arguments, in first-seen order. Other schemes (about:, file:, data:) are not collected,
// so a caller that must reject them needs a separate scan of the arguments; checkNavigation alone does not see them here.
export function urlsInArgs(args: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (isHttpUrl(value)) found.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (isRecord(value)) {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(args);
  return [...found];
}

// Same-site test for one URL. Anything that is not http(s), or does not parse, is not the article's site.
function sameSite(url: string, articleDomain: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return registrableDomain(parsed.hostname) === articleDomain;
  } catch {
    return false;
  }
}

// Every navigation target must share the article's registrable domain. A lookalike such as evilexample.com does not match
// example.com, because the comparison is on whole labels, not string suffixes. An unparsable articleUrl throws (caller error).
export function checkNavigation(urls: string[], articleUrl: string): { ok: boolean; offending: string[] } {
  const articleDomain = registrableDomain(new URL(articleUrl).hostname);
  const offending = urls.filter((url) => !sameSite(url, articleDomain));
  return { ok: offending.length === 0, offending };
}

function assistantMessage(event: Json): Json | undefined {
  if (event.type !== "message_end" || !isRecord(event.message)) return undefined;
  return event.message.role === "assistant" ? event.message : undefined;
}

// Message content is either a plain string or an array of blocks; only text blocks count.
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

export function finalAssistantText(events: Json[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const message = assistantMessage(events[i] ?? {});
    if (message) return contentText(message.content);
  }
  return "";
}

// Cost is reported in USD by Pi and kept as integer micro-dollars so that per-turn amounts sum without float drift.
export function piCostMicros(events: Json[]): number[] {
  const costs: number[] = [];
  for (const event of events) {
    const message = assistantMessage(event);
    if (!message) continue;
    const usage = isRecord(message.usage) ? message.usage : undefined;
    const cost = usage && isRecord(usage.cost) ? usage.cost : undefined;
    const total = typeof cost?.total === "number" && Number.isFinite(cost.total) ? cost.total : 0;
    costs.push(Math.round(total * 1e6));
  }
  return costs;
}

function isStatus(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function reportProblems(key: string, report: unknown): string[] {
  if (!isRecord(report)) return [`${key} must be an object`];
  const problems: string[] = [];
  if (Object.keys(report).sort().join(",") !== "id,sha256") problems.push(`${key} must have exactly the keys id and sha256`);
  if (typeof report.id !== "string" || report.id === "") problems.push(`${key}.id must be a non-empty string`);
  if (typeof report.sha256 !== "string" || !SHA256_HEX.test(report.sha256)) problems.push(`${key}.sha256 must be 64 lowercase hex characters`);
  return problems;
}

// Mirror of parseCaptureReceipt in packages/agent-image/ext/pomtree-browser/browser.ts (the receipt contract;
// examples/hn-digest/content-authority.mts consumes it). Kept as a local copy because packages must not import examples or
// extension sources. Any change to the receipt contract must change both copies together.
export function receiptKeyProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["receipt must be an object"];
  const problems: string[] = [];
  for (const key of RECEIPT_KEYS) {
    if (!Object.hasOwn(value, key)) problems.push(`missing key ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!RECEIPT_KEYS.includes(key)) problems.push(`unexpected key ${key}`);
  }
  const present = (key: string): boolean => Object.hasOwn(value, key);
  const fail = (key: string, ok: boolean, message: string): void => {
    if (present(key) && !ok) problems.push(`${key} ${message}`);
  };
  fail("worker", typeof value.worker === "string" && value.worker !== "", "must be a non-empty string");
  fail("generation", typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation >= 0, "must be a safe integer >= 0");
  fail("originalUrl", typeof value.originalUrl === "string", "must be a string");
  fail("finalUrl", typeof value.finalUrl === "string", "must be a string");
  fail("method", value.method === "browser", 'must be "browser"');
  fail("status", isStatus(value.status), "must be an integer in 100..599");
  fail("contentType", typeof value.contentType === "string" && value.contentType.length <= 200, "must be a string of at most 200 characters");
  for (const key of REPORT_KEYS) {
    if (present(key)) problems.push(...reportProblems(key, value[key]));
  }
  return problems;
}

// Invisible characters are removed, and every Unicode space separator (plus tab and newlines) becomes a plain space. Models and
// page text differ in exactly these details, so a verbatim check must not fail on them.
export function normalizeText(s: string): string {
  return s
    .replace(/​|‌|‍|﻿/g, "")
    .replace(/[\p{Zs}\t\n\r]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Quoted spans from prose, straight ("...") or curly (“...”), normalized and kept when at least `minLen` characters long.
// The length floor drops short fragments such as "Yes" that would match almost any evidence.
const QUOTED = /"([^"]*)"|“([^”]*)”/g;

export function quotedSegments(text: string, minLen = 20): string[] {
  const segments: string[] = [];
  for (const match of text.matchAll(QUOTED)) {
    const normalized = normalizeText(match[1] ?? match[2] ?? "");
    if (normalized.length >= minLen) segments.push(normalized);
  }
  return segments;
}

// True when the quote appears verbatim in the evidence after normalization. An empty quote is never verbatim.
export function quoteVerbatim(quote: string, evidence: string): boolean {
  const needle = normalizeText(quote);
  return needle !== "" && normalizeText(evidence).includes(needle);
}
