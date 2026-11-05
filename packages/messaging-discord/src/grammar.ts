import type { AgentId } from "@pomtree/core";

// The channel-agnostic inbound command grammar. This module is pure: it takes message text and
// returns a typed result, with no transport, Discord, or daemon coupling. Routing an intent to a
// daemon action (spawn/cancel/budget/...) is pomtreed's half, not this module's.

// A well-formed operator command. Commands are recognized only at the start of a message (after
// any leading whitespace) and only when the `!` is immediately followed by the verb — `!ps`, not
// `! ps`. Verbs are case-sensitive and match exactly the spellings below.
export type CommandIntent =
  | { kind: "spawn"; task: string }
  | { kind: "tell"; agent: AgentId; body: string }
  | { kind: "status"; agent?: AgentId }
  | { kind: "ps" }
  | { kind: "cancel"; agent: AgentId }
  | { kind: "budget"; agent?: AgentId }
  | { kind: "report"; agent?: AgentId }
  | { kind: "launch"; workflow: string; instance: string };

// Qualified workflow name (owner/name) and instance name, as the operator CLI and daemon accept them.
const WORKFLOW_RE = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/;
const INSTANCE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// The result of parsing one message. `text` is free text the adapter forwards as a plain message;
// `command` is a well-formed intent to route; `invalid` is command-shaped (starts with a known or
// unknown `!verb`) but malformed, so the adapter can reject it with a helpful reason instead of
// silently treating it as free text.
export type ParsedMessage = { kind: "command"; intent: CommandIntent } | { kind: "invalid"; command: string; reason: string } | { kind: "text"; body: string };

// `!<verb>` optionally followed by whitespace and the rest of the line. The verb is the token
// immediately after `!`; the rest preserves internal whitespace (the leading whitespace run is
// consumed by the `\s+`, and the whole message is trimmed before matching).
const COMMAND_RE = /^!(\S+)(?:\s+(.*))?$/;

export function parseMessage(message: string): ParsedMessage {
  const text = message.trim();
  if (!text.startsWith("!")) return { kind: "text", body: text };

  const match = COMMAND_RE.exec(text);
  if (!match) return { kind: "invalid", command: "", reason: "missing command" };

  const verb = match[1]!;
  const arg = match[2] ?? "";

  switch (verb) {
    case "spawn": {
      const task = arg.trim();
      return task.length === 0 ? { kind: "invalid", command: verb, reason: "missing task" } : { kind: "command", intent: { kind: "spawn", task } };
    }
    case "tell": {
      const agent = arg.split(/\s/, 1)[0] ?? "";
      const body = arg.slice(agent.length).trim();
      if (agent.length === 0) return { kind: "invalid", command: verb, reason: "missing agent" };
      if (body.length === 0) return { kind: "invalid", command: verb, reason: "missing message" };
      return { kind: "command", intent: { kind: "tell", agent, body } };
    }
    case "cancel": {
      const agent = arg.trim();
      return agent.length === 0 ? { kind: "invalid", command: verb, reason: "missing agent" } : { kind: "command", intent: { kind: "cancel", agent } };
    }
    case "status": {
      const agent = arg.trim();
      if (/\s/.test(agent)) return { kind: "invalid", command: verb, reason: "takes at most one agent" };
      return { kind: "command", intent: agent ? { kind: "status", agent } : { kind: "status" } };
    }
    case "budget":
    case "report": {
      const agent = arg.trim();
      if (/\s/.test(agent)) return { kind: "invalid", command: verb, reason: "takes at most one agent" };
      return { kind: "command", intent: agent ? { kind: verb, agent } : { kind: verb } };
    }
    case "workflow": {
      // `!workflow launch OWNER/NAME INSTANCE`: exactly three words. No JSON or options from chat.
      const parts = arg.trim() === "" ? [] : arg.trim().split(/\s+/);
      if (parts[0] !== "launch") return { kind: "invalid", command: verb, reason: "usage: !workflow launch NAME INSTANCE" };
      const [, workflow, instance, ...extra] = parts;
      if (workflow === undefined) return { kind: "invalid", command: verb, reason: "missing workflow" };
      if (instance === undefined) return { kind: "invalid", command: verb, reason: "missing instance" };
      if (extra.length > 0) return { kind: "invalid", command: verb, reason: "takes exactly two arguments: NAME INSTANCE" };
      if (!WORKFLOW_RE.test(workflow)) return { kind: "invalid", command: verb, reason: "bad workflow name (use: owner/name)" };
      if (!INSTANCE_RE.test(instance)) return { kind: "invalid", command: verb, reason: "bad instance name" };
      return { kind: "command", intent: { kind: "launch", workflow, instance } };
    }
    case "ps":
      if (arg.length > 0) return { kind: "invalid", command: verb, reason: "takes no argument" };
      return { kind: "command", intent: { kind: "ps" } };
    default:
      return { kind: "invalid", command: verb, reason: "unknown command" };
  }
}
