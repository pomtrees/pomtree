import type { InboundBody, MESSAGING_API_VERSION, MessageFailedBody, MessageReceipt, OutboxEntry } from "@pomtree/core";

// The wire-contract version this adapter speaks, typed as core's literal so a core bump fails the typecheck (type-only imports,
// as in messaging-discord). pomtreed names its version in this header on every messaging response.
export const MESSAGING_API_HEADER = "x-pomtree-messaging-api";
export const EXPECTED_MESSAGING_API: typeof MESSAGING_API_VERSION = 1;

export interface StdioClient {
  outbox(from: number): Promise<OutboxEntry[]>;
  postMessage(body: InboundBody): Promise<MessageReceipt<string, string, unknown>>;
  messageFailed(body: MessageFailedBody): Promise<void>;
}

// A different version is refused on any status; a missing header on a 2xx only (pomtreed's transport answers 401/404/413 without it).
function assertMessagingApi(got: string | null, ok: boolean, route: string): void {
  if (got === null ? !ok : got === String(EXPECTED_MESSAGING_API)) return;
  throw new Error(
    got === null
      ? `pomtreed ${route}: response has no ${MESSAGING_API_HEADER} header; this adapter needs messaging API ${EXPECTED_MESSAGING_API}; point POMTREED_URL at a pomtreed that speaks it`
      : `pomtreed ${route}: messaging API ${JSON.stringify(got)} is not the ${EXPECTED_MESSAGING_API} this adapter speaks; upgrade this adapter or pomtreed so the versions match`,
  );
}

// TODO(messaging-stdio-client-mutants): mutants here survive this package's own tests; the e2e messaging wire suite likely kills them, unconfirmed.
export function stdioClient(baseUrl: string, token: string, channel: string): StdioClient {
  const call = async (route: string, method: "GET" | "POST", path: string, ok: number, body?: unknown): Promise<unknown> => {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    assertMessagingApi(res.headers.get(MESSAGING_API_HEADER), res.ok, route);
    const text = await res.text();
    if (res.status !== ok) throw new Error(`pomtreed ${route} HTTP ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
  return {
    outbox: (from) => call("outbox", "GET", `/v1/messages?channel=${encodeURIComponent(channel)}&from=${from}`, 200) as Promise<OutboxEntry[]>,
    postMessage: (body) => call("post", "POST", "/v1/messages", 201, body) as Promise<MessageReceipt<string, string, unknown>>,
    messageFailed: async (body) => {
      await call("message-failed", "POST", "/v1/messages/failed", 201, body);
    },
  };
}
