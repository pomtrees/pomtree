import type { MESSAGING_API_VERSION } from "@pomtree/core";
import type { InboundBody, MessageReceipt, OutboxEntry, PomtreedClient } from "./types.ts";
import { httpJson } from "./transport.ts";
import type { HttpReply } from "./transport.ts";

// The wire-contract version this adapter speaks. Core owns the constant; this package keeps its imports type-only, so the
// value is declared here and typed as `typeof MESSAGING_API_VERSION` (the literal type): bumping core fails the typecheck
// until this adapter is updated. pomtreed names its version in this response header on every messaging route.
export const MESSAGING_API_HEADER = "x-pomtree-messaging-api";
export const EXPECTED_MESSAGING_API: typeof MESSAGING_API_VERSION = 1;

// A closed set of causes: the header was absent (a pomtreed that predates the handshake, or not a pomtreed) or named another version.
export type MessagingVersionCause = "missing" | "mismatch";

export class MessagingVersionError extends Error {
  declare readonly cause: MessagingVersionCause;
  readonly got: string | undefined;
  readonly route: string;
  constructor(cause: MessagingVersionCause, got: string | undefined, route: string) {
    super(
      cause === "missing"
        ? `pomtreed ${route}: response has no ${MESSAGING_API_HEADER} header; this adapter needs messaging API ${EXPECTED_MESSAGING_API}`
        : `pomtreed ${route}: messaging API ${JSON.stringify(got)} is not the ${EXPECTED_MESSAGING_API} this adapter speaks`,
    );
    this.name = "MessagingVersionError";
    Object.defineProperty(this, "cause", { value: cause, enumerable: true });
    this.got = got;
    this.route = route;
  }
}

// A different version is refused on any status. A missing header is refused on a 2xx only: pomtreed's transport layer answers
// 401/404/413 before the messaging handler runs and those carry no header, so the plain HTTP error stays the diagnosis.
export function assertMessagingApi(res: HttpReply, route: string): void {
  const got = res.headers[MESSAGING_API_HEADER];
  if (got === undefined) {
    if (res.status >= 200 && res.status < 300) throw new MessagingVersionError("missing", undefined, route);
    return;
  }
  if (got !== String(EXPECTED_MESSAGING_API)) throw new MessagingVersionError("mismatch", got, route);
}

// The real pomtreed client. Speaks `GET/POST /v1/messages` with the host token as a Bearer header
// (the exact header pomtreed's server.ts extracts and auth.ts verifies).
export function pomtreedClient(baseUrl: string, token: string): PomtreedClient {
  const base = new URL(baseUrl);
  const auth = { authorization: `Bearer ${token}` };
  return {
    async outbox(from) {
      const url = new URL("/v1/messages", base);
      url.searchParams.set("from", String(from));
      url.searchParams.set("channel", "discord");
      const res = await httpJson(url, { method: "GET", headers: auth });
      assertMessagingApi(res, "outbox");
      if (res.status !== 200) throw new Error(`pomtreed outbox HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      return res.body as OutboxEntry[];
    },
    async messageFailed(body) {
      const res = await httpJson(new URL("/v1/messages/failed", base), {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body,
      });
      assertMessagingApi(res, "message-failed");
      if (res.status !== 201) throw new Error(`pomtreed message-failed HTTP ${res.status}: ${JSON.stringify(res.body)}`);
    },
    async hostRead(path, sender) {
      const url = new URL(`/v1/host${path}`, base);
      url.searchParams.set("sender", sender);
      const res = await httpJson(url, { method: "GET", headers: auth });
      assertMessagingApi(res, "host read");
      return { status: res.status, body: res.body };
    },
    async postMessage(body: InboundBody) {
      const res = await httpJson(new URL("/v1/messages", base), {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body,
      });
      assertMessagingApi(res, "post");
      if (res.status !== 201) throw new Error(`pomtreed post HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      return res.body as MessageReceipt;
    },
  };
}
