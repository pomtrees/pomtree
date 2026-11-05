import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionSpec } from "@pomtree/core";
import { effectiveExtKey, parseInput, renderExtCallResult, renderExtFetchResult, renderExtList, renderExtSearchResult, renderSearchItems } from "./ext.ts";

const spec = (o: Partial<ExtensionSpec> = {}): ExtensionSpec => ({
  name: "web_fetch",
  description: "fetch a url",
  inputSchema: { type: "object" },
  streaming: false,
  ...o,
});

test("effectiveExtKey prefers the explicit key and otherwise issues a fresh per-invocation key", () => {
  assert.equal(effectiveExtKey("k1"), "k1");
  assert.notEqual(effectiveExtKey(), effectiveExtKey()); // two identical calls are not deduplicated
  assert.match(effectiveExtKey(), /^[0-9a-f-]{36}$/);
});

test("parseInput parses JSON and rejects non-JSON with a message", () => {
  assert.deepEqual(parseInput('{"url":"https://x"}'), { url: "https://x" });
  assert.equal(parseInput('"hello"'), "hello");
  assert.equal(parseInput("5"), 5);
  assert.throws(() => parseInput("{nope"), /input must be valid JSON/);
});

test("renderExtList renders a NAME/DESCRIPTION table and the empty case", () => {
  const out = renderExtList([spec({ name: "web_search", description: "search" }), spec()]);
  assert.match(out, /^NAME\s+DESCRIPTION/);
  assert.match(out, /web_search\s+search/);
  assert.match(out, /web_fetch\s+fetch a url/);
  assert.equal(renderExtList([]), "no extensions");
});

test("renderExtCallResult prints the reason for a deny/failure and the result on success", () => {
  assert.equal(renderExtCallResult({ callId: "c", ok: false, denied: true, reason: "nope" }), "nope");
  assert.equal(renderExtCallResult({ callId: "c", ok: false, reason: "bad url" }), "bad url");
  assert.equal(renderExtCallResult({ callId: "c", ok: false }), "denied");
  assert.equal(renderExtCallResult({ callId: "c", ok: true, result: { items: [] } }), '{\n  "items": []\n}');
  assert.equal(renderExtCallResult({ callId: "c", ok: true, result: "plain" }), "plain");
  assert.equal(renderExtCallResult({ callId: "c", ok: true }), "ok");
});

test("renderSearchItems numbers items and renders the empty case", () => {
  const out = renderSearchItems([
    { title: "T", url: "https://x", snippet: "S" },
    { title: "U", url: "https://y", snippet: "" },
  ]);
  assert.equal(out, "1. T\n   https://x\n   S\n2. U\n   https://y");
  assert.equal(renderSearchItems([]), "no items");
});

test("renderExtSearchResult renders items or the reason", () => {
  const res = { callId: "c", ok: true, result: { items: [{ title: "T", url: "https://x", snippet: "" }] } };
  assert.equal(renderExtSearchResult(res), "1. T\n   https://x");
  assert.equal(renderExtSearchResult({ callId: "c", ok: false, denied: true, reason: "no provider" }), "no provider");
});

test("renderExtFetchResult renders the body or the reason", () => {
  assert.equal(renderExtFetchResult({ callId: "c", ok: true, result: { body: "hello" } }), "hello");
  assert.equal(renderExtFetchResult({ callId: "c", ok: true, result: { body: "" } }), "");
  assert.equal(renderExtFetchResult({ callId: "c", ok: false, reason: "upstream status 404" }), "upstream status 404");
});
