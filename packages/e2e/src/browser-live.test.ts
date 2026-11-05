import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkNavigation,
  extractToolCalls,
  finalAssistantText,
  normalizeText,
  parsePiEvents,
  piCostMicros,
  quotedSegments,
  quoteVerbatim,
  receiptKeyProblems,
  registrableDomain,
  urlsInArgs,
} from "./browser-live.ts";

const SHA = "a".repeat(64);

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const report = { id: "rep-1", sha256: SHA };
  return {
    worker: "w-1",
    generation: 3,
    originalUrl: "https://example.com/a",
    finalUrl: "https://example.com/a",
    method: "browser",
    status: 200,
    contentType: "text/html",
    rawBodyReport: report,
    domReport: report,
    textReport: report,
    screenshotReport: report,
    navigationReport: report,
    ...overrides,
  };
}

test("registrableDomain reduces hosts to the registrable domain", () => {
  assert.equal(registrableDomain("news.example.com"), "example.com");
  assert.equal(registrableDomain("example.com"), "example.com");
  assert.equal(registrableDomain("a.b.example.com"), "example.com");
  assert.equal(registrableDomain("WWW.Example.COM"), "example.com");
});

test("registrableDomain keeps three labels under the listed multi-part suffixes", () => {
  assert.equal(registrableDomain("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("bbc.co.uk"), "bbc.co.uk");
  assert.equal(registrableDomain("news.abc.net.au"), "abc.net.au");
  assert.equal(registrableDomain("x.gov.uk"), "x.gov.uk");
});

test("registrableDomain strips trailing dots, ports and brackets", () => {
  assert.equal(registrableDomain("example.com."), "example.com");
  assert.equal(registrableDomain("news.example.com:8443"), "example.com");
  assert.equal(registrableDomain("[::1]:8080"), "::1");
  assert.equal(registrableDomain("[2001:db8::1]"), "2001:db8::1");
});

test("registrableDomain returns IP literals and single-label names as-is", () => {
  assert.equal(registrableDomain("127.0.0.1"), "127.0.0.1");
  assert.equal(registrableDomain("10.1.2.3:80"), "10.1.2.3");
  assert.equal(registrableDomain("::1"), "::1");
  assert.equal(registrableDomain("localhost"), "localhost");
  assert.equal(registrableDomain("intranet"), "intranet");
});

test("parsePiEvents keeps only JSON objects with a string type", () => {
  const text = [
    '{"type":"agent_start"}',
    "[chromium] WARNING: something on stderr",
    "",
    '{"noType":true}',
    '{"type":7}',
    "[1,2,3]",
    "42",
    '{"type":"message_end","message":{"role":"assistant"}}',
    "{not json",
  ].join("\n");
  const events = parsePiEvents(text);
  assert.deepEqual(
    events.map((e) => e.type),
    ["agent_start", "message_end"],
  );
});

test("extractToolCalls pairs start and end and concatenates text blocks only", () => {
  const events = parsePiEvents(
    [
      '{"type":"tool_execution_start","toolCallId":"c1","toolName":"browser_open","args":{"url":"https://example.com"}}',
      '{"type":"tool_execution_end","toolCallId":"c1","isError":false,"result":{"content":[{"type":"text","text":"part one "},{"type":"image","data":"xx"},{"type":"text","text":"part two"}]}}',
      '{"type":"tool_execution_start","toolCallId":"c2","toolName":"browser_text","args":{}}',
      '{"type":"tool_execution_end","toolCallId":"c2","isError":true,"result":{"content":[{"type":"text","text":"boom"}]}}',
    ].join("\n"),
  );
  const calls = extractToolCalls(events);
  assert.deepEqual(
    calls.map((c) => [c.callId, c.name, c.ok, c.resultText]),
    [
      ["c1", "browser_open", true, "part one part two"],
      ["c2", "browser_text", false, "boom"],
    ],
  );
  assert.deepEqual(calls[0]?.args, { url: "https://example.com" });
});

test("extractToolCalls leaves a call without an end as ok null with empty text", () => {
  const calls = extractToolCalls([{ type: "tool_execution_start", toolCallId: "open", toolName: "browser_open", args: {} }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.ok, null);
  assert.equal(calls[0]?.resultText, "");
});

test("extractToolCalls ignores an end without a matching start", () => {
  const calls = extractToolCalls([{ type: "tool_execution_end", toolCallId: "ghost", isError: false, result: { content: [] } }]);
  assert.deepEqual(calls, []);
});

test("extractToolCalls treats a missing isError as success", () => {
  const calls = extractToolCalls([
    { type: "tool_execution_start", toolCallId: "c", toolName: "t", args: {} },
    { type: "tool_execution_end", toolCallId: "c", result: { content: [{ type: "text", text: "ok" }] } },
  ]);
  assert.equal(calls[0]?.ok, true);
  assert.equal(calls[0]?.resultText, "ok");
});

test("argsHash is independent of object key order and sensitive to values", () => {
  const hashOf = (args: unknown): string => extractToolCalls([{ type: "tool_execution_start", toolCallId: "c", toolName: "t", args }])[0]?.argsHash ?? "";
  assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }));
  assert.equal(hashOf({ x: { p: 1, q: [1, { r: 2, s: 3 }] } }), hashOf({ x: { q: [1, { s: 3, r: 2 }], p: 1 } }));
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
  assert.notEqual(hashOf([1, 2]), hashOf([2, 1]));
  assert.match(hashOf({ a: 1 }), /^[0-9a-f]{16}$/);
});

test("urlsInArgs collects nested http(s) strings in order, deduped", () => {
  const args = {
    url: "https://example.com/a",
    list: ["http://example.com/b", "not a url", { deep: "https://example.com/a" }],
    n: 5,
    other: "about:blank",
    fileUrl: "file:///etc/passwd",
    dataUrl: "data:text/html,hi",
  };
  assert.deepEqual(urlsInArgs(args), ["https://example.com/a", "http://example.com/b"]);
  assert.deepEqual(urlsInArgs("https://example.com"), ["https://example.com"]);
  assert.deepEqual(urlsInArgs(null), []);
});

test("checkNavigation accepts the article domain and its subdomains", () => {
  const article = "https://www.example.com/story";
  assert.deepEqual(checkNavigation(["https://example.com/x", "https://cdn.example.com/y.js"], article), { ok: true, offending: [] });
});

test("checkNavigation rejects a lookalike domain", () => {
  const result = checkNavigation(["https://evilexample.com/", "https://example.com/"], "https://example.com/story");
  assert.equal(result.ok, false);
  assert.deepEqual(result.offending, ["https://evilexample.com/"]);
});

test("checkNavigation rejects non-http schemes and unparsable strings", () => {
  const urls = ["about:blank", "file:///etc/hosts", "data:text/html,x", "not a url", "https://example.com/ok"];
  const result = checkNavigation(urls, "https://example.com/story");
  assert.equal(result.ok, false);
  assert.deepEqual(result.offending, ["about:blank", "file:///etc/hosts", "data:text/html,x", "not a url"]);
});

test("checkNavigation compares multi-part suffixes at the right level", () => {
  assert.equal(checkNavigation(["https://a.bbc.co.uk/"], "https://www.bbc.co.uk/news").ok, true);
  assert.equal(checkNavigation(["https://other.co.uk/"], "https://www.bbc.co.uk/news").ok, false);
});

test("checkNavigation treats an empty URL list as ok", () => {
  assert.deepEqual(checkNavigation([], "https://example.com"), { ok: true, offending: [] });
});

test("finalAssistantText returns the last assistant message_end", () => {
  const events = parsePiEvents(
    [
      '{"type":"message_end","message":{"role":"user","content":"hi"}}',
      '{"type":"message_end","message":{"role":"assistant","content":"first"}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Second "},{"type":"tool_use"},{"type":"text","text":"answer"}]}}',
      '{"type":"message_end","message":{"role":"user","content":"later user"}}',
    ].join("\n"),
  );
  assert.equal(finalAssistantText(events), "Second answer");
});

test("finalAssistantText returns empty string when there is no assistant message", () => {
  assert.equal(finalAssistantText([]), "");
  assert.equal(finalAssistantText([{ type: "message_end", message: { role: "user", content: "x" } }]), "");
});

test("piCostMicros converts each assistant turn's cost to micro-dollars", () => {
  const events = [
    { type: "message_end", message: { role: "assistant", usage: { cost: { total: 0.0012345 } } } },
    { type: "message_end", message: { role: "user", usage: { cost: { total: 9 } } } },
    { type: "message_end", message: { role: "assistant" } },
    { type: "message_end", message: { role: "assistant", usage: { cost: { total: "0.5" } } } },
    { type: "message_end", message: { role: "assistant", usage: { cost: { total: 0.25 } } } },
    { type: "agent_start" },
  ];
  assert.deepEqual(piCostMicros(events), [1235, 0, 0, 250000]);
  assert.deepEqual(piCostMicros([]), []);
});

test("receiptKeyProblems accepts a valid receipt", () => {
  assert.deepEqual(receiptKeyProblems(receipt()), []);
});

test("receiptKeyProblems reports a missing key", () => {
  const value = receipt();
  delete value.navigationReport;
  assert.deepEqual(receiptKeyProblems(value), ["missing key navigationReport"]);
});

test("receiptKeyProblems reports an extra key", () => {
  assert.deepEqual(receiptKeyProblems(receipt({ extra: 1 })), ["unexpected key extra"]);
});

test("receiptKeyProblems reports a bad sha256 and a report with extra keys", () => {
  assert.deepEqual(receiptKeyProblems(receipt({ domReport: { id: "d", sha256: "ABC" } })), ["domReport.sha256 must be 64 lowercase hex characters"]);
  assert.deepEqual(receiptKeyProblems(receipt({ domReport: { id: "d", sha256: SHA, bytes: 1 } })), ["domReport must have exactly the keys id and sha256"]);
});

test("receiptKeyProblems reports a bad generation", () => {
  assert.deepEqual(receiptKeyProblems(receipt({ generation: -1 })), ["generation must be a safe integer >= 0"]);
  assert.deepEqual(receiptKeyProblems(receipt({ generation: 1.5 })), ["generation must be a safe integer >= 0"]);
  assert.deepEqual(receiptKeyProblems(receipt({ generation: "3" })), ["generation must be a safe integer >= 0"]);
});

test("receiptKeyProblems checks worker, method, status and contentType", () => {
  assert.deepEqual(receiptKeyProblems(receipt({ worker: "" })), ["worker must be a non-empty string"]);
  assert.deepEqual(receiptKeyProblems(receipt({ method: "fetch" })), ['method must be "browser"']);
  assert.deepEqual(receiptKeyProblems(receipt({ status: 99 })), ["status must be an integer in 100..599"]);
  assert.deepEqual(receiptKeyProblems(receipt({ status: 600 })), ["status must be an integer in 100..599"]);
  assert.deepEqual(receiptKeyProblems(receipt({ status: 200.5 })), ["status must be an integer in 100..599"]);
  assert.deepEqual(receiptKeyProblems(receipt({ contentType: "x".repeat(201) })), ["contentType must be a string of at most 200 characters"]);
});

test("receiptKeyProblems rejects non-objects and reports every violation", () => {
  assert.deepEqual(receiptKeyProblems(null), ["receipt must be an object"]);
  assert.deepEqual(receiptKeyProblems([]), ["receipt must be an object"]);
  const problems = receiptKeyProblems({ worker: "w", generation: 0 });
  assert.equal(problems.filter((p) => p.startsWith("missing key ")).length, 10);
  assert.ok(problems.includes("missing key rawBodyReport"));
});

test("normalizeText strips zero-width characters and maps spaces", () => {
  assert.equal(normalizeText("a​b‌c‍d﻿e"), "abcde");
  assert.equal(normalizeText("one two three　four"), "one two three four");
  assert.equal(normalizeText("  a \t\n\r b  "), "a b");
  assert.equal(normalizeText(" ​ "), "");
});

test("quotedSegments extracts straight and curly quotes at or above the length floor", () => {
  const text = 'He said "this is a long enough quote" and “another curly quote here” but "short" too.';
  assert.deepEqual(quotedSegments(text), ["this is a long enough quote", "another curly quote here"]);
  assert.deepEqual(quotedSegments(text, 5), ["this is a long enough quote", "another curly quote here", "short"]);
});

test("quotedSegments normalizes the segments it returns", () => {
  const text = "“spaced ​  out   quote text”";
  assert.deepEqual(quotedSegments(text, 10), ["spaced out quote text"]);
  assert.deepEqual(quotedSegments("no quotes at all here"), []);
});

test("quoteVerbatim matches after normalization and rejects empty quotes", () => {
  assert.equal(quoteVerbatim("the quick  brown fox", "Yesterday the quick​ brown fox jumped"), true);
  assert.equal(quoteVerbatim("the quick brown fox", "the slow brown fox"), false);
  assert.equal(quoteVerbatim("   ​ ", "anything at all"), false);
  assert.equal(quoteVerbatim("", ""), false);
});

test("extractToolCalls records the session-log time and the model turn that issued each call", () => {
  const calls = extractToolCalls([
    { type: "message_end", message: { role: "assistant", timestamp: 1791063665584, content: [{ type: "toolCall", id: "c1", name: "t", arguments: {} }] } },
    { type: "tool_execution_start", toolCallId: "c1", toolName: "t", args: {} },
    { type: "tool_execution_end", toolCallId: "c1", result: { content: [] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "t", arguments: {} }] } },
    { type: "tool_execution_start", toolCallId: "c2", toolName: "t", args: {}, timestamp: "2026-10-03T21:40:50.000Z" },
    { type: "tool_execution_start", toolCallId: "c3", toolName: "t", args: {} },
  ]);
  assert.deepEqual(
    calls.map((c) => [c.callId, c.at, c.turn]),
    [
      ["c1", new Date(1791063665584).toISOString(), 0],
      ["c2", "2026-10-03T21:40:50.000Z", 1],
      ["c3", null, null],
    ],
  );
});
