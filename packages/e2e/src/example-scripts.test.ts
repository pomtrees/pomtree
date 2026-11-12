// Offline guard for the model-stub scripts shipped under examples/: every example JSON with a top-level `rules` array must pass the stub's own validator,
// and the browse viewer script must keep its nav-then-hold sequence, so a format change in the stub cannot silently rot a shipped script.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { matchRule, type ModelScript, type RequestShape, recordUse, validateModelScript } from "@pomtree/testing";

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples");
const VIEWER = join(EXAMPLES, "browse-agent", "viewer-stub.json");

function jsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonFiles(p));
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

function scriptFiles(): string[] {
  return jsonFiles(EXAMPLES).filter((p) => Array.isArray((JSON.parse(readFileSync(p, "utf8")) as { rules?: unknown } | null)?.rules));
}

function shape(over: Partial<RequestShape>): RequestShape {
  return {
    wire: "openai-completions",
    model: null,
    stream: true,
    turn: 0,
    toolResults: 0,
    lastTool: null,
    lastToolIsError: null,
    offeredTools: ["browser_navigate", "capture_finish"],
    agentId: null,
    markers: [],
    lastUserText: null,
    maxTokens: null,
    ...over,
  };
}

test("every example model script passes the stub's validator", () => {
  const files = scriptFiles();
  assert.ok(files.some((f) => f.endsWith("viewer-stub.json")) && files.some((f) => f.endsWith("reporter.json")), "expected both shipped scripts to be found");
  for (const f of files) validateModelScript(JSON.parse(readFileSync(f, "utf8")), f);
});

test("the validator rejects a broken copy of a shipped script (negative control)", () => {
  const good = JSON.parse(readFileSync(VIEWER, "utf8")) as ModelScript;
  const badFault = structuredClone(good) as unknown as { rules: { reply: { fault?: { type: string } } }[] };
  const hold = badFault.rules.find((r) => r.reply.fault);
  assert.ok(hold?.reply.fault);
  hold.reply.fault.type = "no_such_fault";
  assert.throws(() => validateModelScript(badFault), /unknown fault type/);
  const badField = structuredClone(good) as unknown as { rules: { when: Record<string, unknown> }[] };
  badField.rules[0]!.when.bogus = 1;
  assert.throws(() => validateModelScript(badField), /unknown match field/);
});

test("browse viewer stub: ships, is documented, and holds then finishes with no secrets or paths", () => {
  assert.ok(existsSync(VIEWER), "examples/browse-agent/viewer-stub.json is missing");
  const readme = readFileSync(join(EXAMPLES, "browse-agent", "README.md"), "utf8");
  assert.ok(readme.includes("viewer-stub.json"), "examples/browse-agent/README.md must reference viewer-stub.json");
  assert.ok(!/\/home|\/tmp|key|token/i.test(readFileSync(VIEWER, "utf8")));
});

test("browse viewer stub: navigates first, holds the stream, then finishes", () => {
  const script = validateModelScript(JSON.parse(readFileSync(VIEWER, "utf8")), VIEWER);
  const used = new Map<string, number>();
  const pick = (s: RequestShape) => {
    const r = matchRule(script, s, used);
    assert.ok(r, "no rule matched");
    recordUse(used, r);
    return r;
  };
  const nav = pick(shape({}));
  assert.equal(nav.id, "nav");
  assert.equal(nav.reply.kind, "tool_calls");
  if (nav.reply.kind === "tool_calls") {
    assert.equal(nav.reply.calls[0]?.name, "browser_navigate");
    assert.match(String((nav.reply.calls[0]!.arguments as { url: string }).url), /^https:\/\//);
  }
  const after = shape({ turn: 1, toolResults: 1, lastTool: "browser_navigate", lastToolIsError: false });
  const holds: string[] = [];
  let next = pick(after);
  while (next.reply.kind === "fault" && holds.length < 50) {
    holds.push(next.id);
    next = pick(after);
  }
  assert.ok(holds.length >= 1 && holds.length < 50, "hold rule must fire a bounded number of times");
  assert.equal(next.reply.kind, "tool_calls");
  if (next.reply.kind === "tool_calls") assert.equal(next.reply.calls[0]?.name, "capture_finish");
});
