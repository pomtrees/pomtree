import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutboxEntry } from "@pomtree/core";
import { parseLine, renderEntry } from "./lines.ts";

const sender = { channel: "stdio", sender: "me" };
const parse = (line: string) => parseLine(line, sender, "k1");

test("#<escalation> <text> is an answer", () => {
  assert.deepEqual(parse("#es-1 yes please"), { channel: "stdio", sender, body: "yes please", replyTo: "es-1", idempotencyKey: "k1" });
});

test("@<agent> <text> is a signal to that agent", () => {
  assert.deepEqual(parse("@ag-1 stop the build"), { channel: "stdio", sender, body: "stop the build", to: "ag-1", intent: "signal", idempotencyKey: "k1" });
});

test("!status and !cancel are intents with the raw line as body", () => {
  assert.deepEqual(parse("!status ag-1"), { channel: "stdio", sender, body: "!status ag-1", to: "ag-1", intent: "status", idempotencyKey: "k1" });
  assert.deepEqual(parse("  !cancel ag-2  "), { channel: "stdio", sender, body: "!cancel ag-2", to: "ag-2", intent: "cancel", idempotencyKey: "k1" });
});

test("a blank line is ignored", () => {
  assert.equal(parse(""), null);
  assert.equal(parse("   "), null);
});

test("anything else is an error that names the grammar", () => {
  for (const bad of ["hello", "#es-1", "@ag-1", "!status", "!ps ag-1", "!status a b"]) {
    const r = parse(bad);
    assert.ok(r && "error" in r && r.error.includes("#<escalation>"), bad);
  }
});

const entry = (payload: Partial<OutboxEntry["payload"]>): OutboxEntry => ({
  seq: 3,
  ts: 1,
  agent: "ag-1",
  payload: { kind: "message_sent", channel: "stdio", purpose: "alert", subject: "disk low", ...payload },
});

test("renderEntry prints one line; an ask adds how to answer and the options", () => {
  assert.equal(renderEntry(entry({})), "[alert] ag-1: disk low");
  assert.equal(renderEntry(entry({ purpose: "ask", subject: "ship it?", replyTo: "es-1" })), "[ask] ag-1: ship it? (answer: #es-1 <text>)");
  assert.equal(
    renderEntry(entry({ purpose: "ask", subject: "ship it?", replyTo: "es-1", options: ["yes", "no"] })),
    "[ask] ag-1: ship it? (answer: #es-1 <text>; options: yes | no)",
  );
});
