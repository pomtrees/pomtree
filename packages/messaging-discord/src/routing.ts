import type { DiscordInbound, InboundBody } from "./types.ts";
import { parseEscalationId } from "./render.ts";

// Builds the pomtreed inbound body from a Discord message. When the adapter knows the escalation id
// directly (the outbound message it sent carried `replyTo`, correlated via the Discord message id),
// that id is used as-is. Otherwise the escalation id is parsed only from the replied-to message's
// text — never from the sender's own body, so posting `es-<hex>` does not by itself answer an
// escalation (the adapter additionally verifies the reply target is bot-authored before
// forwarding a text-parsed `replyTo`).
export function inboundBody(msg: DiscordInbound, directReplyTo?: string): InboundBody {
  const replyTo = directReplyTo ?? parseEscalationId(msg.replyToText);
  return {
    channel: "discord",
    sender: {
      channel: "discord",
      sender: msg.authorId,
      ...(msg.authorName ? { name: msg.authorName } : {}),
    },
    body: msg.body,
    ...(replyTo ? { replyTo } : {}),
    idempotencyKey: msg.id,
  };
}
