import type { InboundBody, OutboxEntry } from "@pomtree/core";

export const GRAMMAR = "#<escalation> <text> answers, @<agent> <text> signals, !status <agent> and !cancel <agent> are commands";

// One typed line becomes one inbound body (the raw line is the body, which pomtreed requires non-empty); a blank line is null.
export function parseLine(line: string, sender: InboundBody["sender"], key: string): InboundBody | { error: string } | null {
  const text = line.trim();
  if (!text) return null;
  const base = { channel: sender.channel, sender, body: text, idempotencyKey: key };
  const answer = /^#(\S+)\s+(\S.*)$/.exec(text);
  if (answer) return { ...base, body: answer[2] as string, replyTo: answer[1] as string };
  const signal = /^@(\S+)\s+(\S.*)$/.exec(text);
  if (signal) return { ...base, body: signal[2] as string, to: signal[1] as string, intent: "signal" };
  const command = /^!(status|cancel)\s+(\S+)$/.exec(text);
  if (command) return { ...base, to: command[2] as string, intent: command[1] as "status" | "cancel" };
  return { error: `cannot parse ${JSON.stringify(text)}; ${GRAMMAR}` };
}

// One output line per outbox entry. An ask also shows how to answer it.
export function renderEntry(e: OutboxEntry): string {
  const { purpose, subject, replyTo, options } = e.payload;
  const answer = replyTo ? ` (answer: #${replyTo} <text>${options?.length ? `; options: ${options.join(" | ")}` : ""})` : "";
  return `[${purpose}] ${e.agent}: ${subject}${answer}`;
}
