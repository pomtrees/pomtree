import { randomUUID } from "node:crypto";
import { MESSAGING_API_VERSION } from "@pomtree/core";
import type { InboundMessage, MessageFailedBody } from "@pomtree/core";
import type { MessagingWireAdapter, MessagingWireClauseId, MessagingWireClient, MessagingWireDaemon } from "./messaging-wire-contract.ts";

// The reference messaging client over global fetch, and the fake for the wire-contract suite: correct by default, and with
// `broken` set it carries exactly one deliberate violation, so each clause has a subject that must fail it (negative control).
// Breaks: version-handshake skips the version-header check; host-token-scope returns error bodies instead of throwing;
// outbox-cursor always polls from 0; post-idempotent sends a random idempotencyKey per call; unknown-sender rewrites every
// sender to u1; outbox-redelivery reports a dead letter under a random key; host-read drops the sender query parameter.
export function stubWireAdapter(channel: string, broken?: MessagingWireClauseId): MessagingWireAdapter {
  return { name: broken ? `stub(broken:${broken})` : "stub", channel, connect: (baseUrl, token) => stubClient(baseUrl, token, channel, broken) };
}

function stubClient(baseUrl: string, token: string, channel: string, broken: MessagingWireClauseId | undefined): MessagingWireClient {
  const call = async (route: string, method: "GET" | "POST", path: string, ok: number, body?: unknown) => {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const got = res.headers.get("x-pomtree-messaging-api");
    if (broken !== "version-handshake" && (got === null ? res.ok : got !== String(MESSAGING_API_VERSION)))
      throw new Error(
        got === null
          ? `stub ${route}: response has no x-pomtree-messaging-api header; this stub needs messaging API ${MESSAGING_API_VERSION}`
          : `stub ${route}: messaging API ${JSON.stringify(got)} is not the ${MESSAGING_API_VERSION} this stub speaks`,
      );
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (ok !== 0 && res.status !== ok && broken !== "host-token-scope") throw new Error(`stub ${route} HTTP ${res.status}: ${text}`);
    return { status: res.status, body: parsed };
  };
  return {
    async outbox(from) {
      const r = await call("outbox", "GET", `/v1/messages?channel=${encodeURIComponent(channel)}&from=${broken === "outbox-cursor" ? 0 : from}`, 200);
      return r.status === 200 ? (r.body as never) : [];
    },
    async postMessage(body: InboundMessage) {
      const sent = {
        ...body,
        ...(broken === "post-idempotent" && { idempotencyKey: randomUUID() }),
        ...(broken === "unknown-sender" && { sender: { ...body.sender, sender: "u1" } }),
      };
      return (await call("post", "POST", "/v1/messages", 201, sent)).body as never;
    },
    async messageFailed(body: MessageFailedBody) {
      await call("message-failed", "POST", "/v1/messages/failed", 201, broken === "outbox-redelivery" ? { ...body, idempotencyKey: randomUUID() } : body);
    },
    // Any status is a result for a host read (ok = 0); only a transport or version failure throws.
    hostRead: (path, sender) => call("host read", "GET", `/v1/host${path}${broken === "host-read" ? "" : `?sender=${encodeURIComponent(sender)}`}`, 0),
  };
}

// sender-allowlist-boot is pomtreed's own check, which a client cannot break: this daemon claims every configuration boots.
export function brokenBootDaemon(d: MessagingWireDaemon): MessagingWireDaemon {
  return { start: (o) => d.start(o), bootError: () => null };
}
