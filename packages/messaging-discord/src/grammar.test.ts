import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMessage } from "./grammar.ts";
import type { CommandIntent, ParsedMessage } from "./grammar.ts";

const cmd = (intent: CommandIntent): ParsedMessage => ({ kind: "command", intent });
const invalid = (command: string, reason: string): ParsedMessage => ({ kind: "invalid", command, reason });
const text = (body: string): ParsedMessage => ({ kind: "text", body });

test("parseMessage returns free text for a plain message", () => {
  assert.deepEqual(parseMessage("hello there"), text("hello there"));
  assert.deepEqual(parseMessage(""), text(""));
  assert.deepEqual(parseMessage("  wrap me  "), text("wrap me"));
  // A `!` not at the start of the message is not a command.
  assert.deepEqual(parseMessage("please !status"), text("please !status"));
});

test("parseMessage parses !spawn with the rest of the line as the task", () => {
  assert.deepEqual(parseMessage("!spawn build the widget"), cmd({ kind: "spawn", task: "build the widget" }));
  assert.deepEqual(parseMessage("!spawn x"), cmd({ kind: "spawn", task: "x" }));
  // Internal spacing is preserved; leading/trailing whitespace is not.
  assert.deepEqual(parseMessage("  !spawn  a  b  "), cmd({ kind: "spawn", task: "a  b" }));
});

test("parseMessage parses !tell into agent and body", () => {
  assert.deepEqual(parseMessage("!tell a1 please retry"), cmd({ kind: "tell", agent: "a1", body: "please retry" }));
  assert.deepEqual(parseMessage("!tell a1 one-word"), cmd({ kind: "tell", agent: "a1", body: "one-word" }));
  assert.deepEqual(parseMessage("!tell a1  spaced  body "), cmd({ kind: "tell", agent: "a1", body: "spaced  body" }));
});

test("parseMessage parses !workflow launch with a qualified name and instance", () => {
  assert.deepEqual(parseMessage("!workflow launch hn/digest daily"), cmd({ kind: "launch", workflow: "hn/digest", instance: "daily" }));
  assert.deepEqual(parseMessage("  !workflow   launch  a-b/c_d  x1  "), cmd({ kind: "launch", workflow: "a-b/c_d", instance: "x1" }));
});

test("parseMessage rejects !workflow launch with missing, extra or malformed arguments", () => {
  assert.deepEqual(parseMessage("!workflow"), invalid("workflow", "usage: !workflow launch NAME INSTANCE"));
  assert.deepEqual(parseMessage("!workflow run hn/digest daily"), invalid("workflow", "usage: !workflow launch NAME INSTANCE"));
  assert.deepEqual(parseMessage("!workflow launch"), invalid("workflow", "missing workflow"));
  assert.deepEqual(parseMessage("!workflow launch hn/digest"), invalid("workflow", "missing instance"));
  assert.deepEqual(parseMessage("!workflow launch hn/digest daily extra"), invalid("workflow", "takes exactly two arguments: NAME INSTANCE"));
  assert.deepEqual(parseMessage('!workflow launch hn/digest {"a":1}'), invalid("workflow", "bad instance name"));
  assert.deepEqual(parseMessage("!workflow launch digest daily"), invalid("workflow", "bad workflow name (use: owner/name)"));
  assert.deepEqual(parseMessage("!workflow launch Hn/digest daily"), invalid("workflow", "bad workflow name (use: owner/name)"));
  assert.deepEqual(parseMessage("!workflow launch a/b/c daily"), invalid("workflow", "bad workflow name (use: owner/name)"));
  assert.deepEqual(parseMessage("!workflow launch hn/digest Daily"), invalid("workflow", "bad instance name"));
  assert.deepEqual(parseMessage(`!workflow launch hn/digest ${"a".repeat(65)}`), invalid("workflow", "bad instance name"));
});

test("parseMessage parses the no-argument commands", () => {
  assert.deepEqual(parseMessage("!status"), cmd({ kind: "status" }));
  assert.deepEqual(parseMessage("!ps"), cmd({ kind: "ps" }));
  assert.deepEqual(parseMessage("!budget"), cmd({ kind: "budget" }));
  assert.deepEqual(parseMessage("!report"), cmd({ kind: "report" }));
  assert.deepEqual(parseMessage("!ps  "), cmd({ kind: "ps" }));
});

test("parseMessage parses !cancel with an agent", () => {
  assert.deepEqual(parseMessage("!cancel a1"), cmd({ kind: "cancel", agent: "a1" }));
  assert.deepEqual(parseMessage("!cancel  a1  "), cmd({ kind: "cancel", agent: "a1" }));
});

test("parseMessage rejects a bare or spaced exclamation mark", () => {
  assert.deepEqual(parseMessage("!"), invalid("", "missing command"));
  assert.deepEqual(parseMessage("!   "), invalid("", "missing command"));
  assert.deepEqual(parseMessage("! status"), invalid("", "missing command"));
});

test("parseMessage rejects a command missing its required argument", () => {
  assert.deepEqual(parseMessage("!spawn"), invalid("spawn", "missing task"));
  assert.deepEqual(parseMessage("!spawn   "), invalid("spawn", "missing task"));
  assert.deepEqual(parseMessage("!tell"), invalid("tell", "missing agent"));
  assert.deepEqual(parseMessage("!tell a1"), invalid("tell", "missing message"));
  assert.deepEqual(parseMessage("!tell a1   "), invalid("tell", "missing message"));
  assert.deepEqual(parseMessage("!cancel"), invalid("cancel", "missing agent"));
});

test("parseMessage takes at most one agent for status/budget/report and no argument for ps", () => {
  assert.deepEqual(parseMessage("!status a1"), cmd({ kind: "status", agent: "a1" }));
  assert.deepEqual(parseMessage("!status a b"), invalid("status", "takes at most one agent"));
  assert.deepEqual(parseMessage("!budget a1"), cmd({ kind: "budget", agent: "a1" }));
  assert.deepEqual(parseMessage("!report a1"), cmd({ kind: "report", agent: "a1" }));
  assert.deepEqual(parseMessage("!budget a b"), invalid("budget", "takes at most one agent"));
  assert.deepEqual(parseMessage("!report a b"), invalid("report", "takes at most one agent"));
  assert.deepEqual(parseMessage("!ps a1"), invalid("ps", "takes no argument"));
});

test("parseMessage rejects an unknown verb as invalid, not free text", () => {
  assert.deepEqual(parseMessage("!frobnicate a1"), invalid("frobnicate", "unknown command"));
});

test("parseMessage is case-sensitive on the verb", () => {
  assert.deepEqual(parseMessage("!Status"), invalid("Status", "unknown command"));
});
