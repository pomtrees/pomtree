import assert from "node:assert/strict";
import { test } from "node:test";
import type { JournalEntry } from "@pomtree/core";
import { capToolPayload, capText, journalRow, MAX_TOOL_FIELD_BYTES } from "./daemon-util.ts";
import { setup } from "./test-setup.ts";

test("capText: under cap untouched, over cap cut on a char boundary with original byte count", () => {
  assert.equal(capText("short"), "short");
  const out = capText("😀".repeat(MAX_TOOL_FIELD_BYTES / 4 + 1));
  assert.ok(out.startsWith("😀".repeat(MAX_TOOL_FIELD_BYTES / 4)));
  assert.ok(!out.includes("\ufffd"));
  assert.ok(out.endsWith(`[pomtree: truncated, ${MAX_TOOL_FIELD_BYTES + 4} bytes originally]`));
});

test("capToolPayload bounds tool output and oversize input; small payloads are returned as-is", () => {
  const small = { kind: "tool_call", tool: "bash", callId: "c", input: { command: "ls" } } as const;
  assert.equal(capToolPayload(small), small);
  const big = capToolPayload({ kind: "tool_call", tool: "write", callId: "c", input: { content: "x".repeat(40000) } });
  assert.ok(big.kind === "tool_call" && typeof big.input === "string" && big.input.includes("40"));
  const res = capToolPayload({ kind: "tool_result", callId: "c", ok: true, output: "y".repeat(50000) });
  assert.ok(res.kind === "tool_result" && res.output.length < MAX_TOOL_FIELD_BYTES + 100 && res.output.includes("50000 bytes originally"));
});

test("journalRow keeps the one-line summary and adds a structured tool view", () => {
  const e = (payload: JournalEntry["payload"]): JournalEntry => ({ seq: 1, ts: 2, agent: "a", host: "h", generation: 1, payload }) as JournalEntry;
  const call = journalRow(e({ kind: "tool_call", tool: "bash", callId: "c1", input: { command: "ls" } }));
  assert.equal(call.summary, "tool bash");
  assert.deepEqual(call.tool, { callId: "c1", tool: "bash", input: { command: "ls" } });
  const res = journalRow(e({ kind: "tool_result", callId: "c1", ok: false, output: "line1\nline2" }));
  assert.equal(res.summary, "result error: line1");
  assert.deepEqual(res.tool, { callId: "c1", ok: false, output: "line1\nline2" });
  assert.equal(journalRow(e({ kind: "error", message: "x" })).tool, undefined);
});

test("end to end: tool input/output reach the operator journal and events routes, capped", async () => {
  const t = setup(async (c) => {
    c.emit({ kind: "tool_call", tool: "bash", callId: "k1", input: { command: "cat big" } });
    c.emit({ kind: "tool_result", callId: "k1", ok: true, output: "z".repeat(40000) });
    await c.api("POST", "/v1/agents/self/result", { status: "succeeded", result: { summary: "ok", value: 1 } });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  const rows = (await t.operator("GET", `/v1/journal?agent=${a.id}`)).body as { kind: string; tool?: { callId: string; output?: string } }[];
  const res = rows.find((r) => r.kind === "tool_result")!;
  assert.equal(res.tool!.callId, "k1");
  assert.ok(res.tool!.output!.endsWith("40000 bytes originally]"));
  const ev = (await t.operator("GET", `/v1/agents/${a.id}/events`)).body as JournalEntry[];
  const call = ev.find((x) => x.payload.kind === "tool_call")!.payload as { input: unknown };
  assert.deepEqual(call.input, { command: "cat big" });
});
