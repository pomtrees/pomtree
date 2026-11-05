import type { Gateway } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import type { RESTOptions, ResponseLike } from "@discordjs/rest";
import type { WebSocketShardEvents } from "@discordjs/ws";
import type { GatewayDispatchPayload, GatewaySendPayload } from "discord-api-types/v10";

// Offline fakes for the Discord gateway and REST API. They live in this package, not @pomtree/testing, on
// purpose: they depend on the Discord libraries this extension carries, and keeping them here keeps the package
// liftable into its own repo (an exception to the repo's "fakes live in @pomtree/testing" rule).

type DispatchListener = (payload: GatewayDispatchPayload, shardId: number) => unknown;

// A gateway that emits whatever dispatches a test scripts and records what the client sends.
export class FakeGateway implements Gateway {
  readonly sent: { shardId: number; payload: GatewaySendPayload }[] = [];
  connects = 0;
  destroys = 0;
  private readonly listeners: DispatchListener[] = [];
  getShardCount(): number {
    return 1;
  }
  on(_event: WebSocketShardEvents.Dispatch, listener: DispatchListener): this {
    this.listeners.push(listener);
    return this;
  }
  send(shardId: number, payload: GatewaySendPayload): void {
    this.sent.push({ shardId, payload });
  }
  connect(): void {
    this.connects += 1;
  }
  destroy(): void {
    this.destroys += 1;
  }
  // Emits one dispatch (`t` and `d` as Discord sends them) to the client.
  dispatch(t: string, d: unknown): void {
    const payload = { op: 0, s: 1, t, d } as unknown as GatewayDispatchPayload;
    for (const l of this.listeners) l(payload, 0);
  }
  ready(botUserId: string): void {
    this.dispatch("READY", {
      v: 10,
      user: { id: botUserId, username: "bot", bot: true },
      guilds: [],
      session_id: "s",
      resume_gateway_url: "wss://x",
      application: { id: "app" },
    });
  }
  message(m: {
    id: string;
    channel_id: string;
    content?: string;
    author: { id: string; username?: string; bot?: boolean };
    referenced_message?: unknown;
  }): void {
    this.dispatch("MESSAGE_CREATE", { content: "", ...m });
  }
  interaction(i: unknown): void {
    this.dispatch("INTERACTION_CREATE", i);
  }
}

export interface RestCall {
  method: string;
  path: string; // without the /api/v10 prefix, with the query string
  body: unknown;
}
export interface ScriptedReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

// A REST built on @discordjs/rest's `makeRequest` hook: it never touches the network, records every call and answers
// from `respond` (default 200 {}). `options` passes REST options through (e.g. rejectOnRateLimit for error mapping).
export function fakeRest(
  respond: (call: RestCall) => ScriptedReply | Promise<ScriptedReply> = () => ({ status: 200, body: {} }),
  options: Partial<RESTOptions> = {},
) {
  const calls: RestCall[] = [];
  const makeRequest = async (url: string, init: { method?: string; body?: unknown }): Promise<ResponseLike> => {
    const u = new URL(url);
    const call: RestCall = {
      method: (init.method ?? "GET").toUpperCase(),
      path: `${decodeURIComponent(u.pathname).replace(/^\/api\/v\d+/, "")}${u.search}`,
      body: typeof init.body === "string" && init.body ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    const r = await respond(call);
    const text = r.body === undefined ? "" : JSON.stringify(r.body);
    const headers = new Headers({ ...(r.body === undefined ? {} : { "content-type": "application/json" }), ...r.headers });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: String(r.status),
      headers,
      bodyUsed: false,
      body: null,
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
    };
  };
  const rest = new REST({ version: "10", retries: 0, ...options, makeRequest: makeRequest as RESTOptions["makeRequest"] }).setToken("fake-bot-token");
  return { rest, calls };
}
