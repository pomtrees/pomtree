import { Client } from "@discordjs/core";
import type { Gateway } from "@discordjs/core";
import { DiscordAPIError, HTTPError, RateLimitError, REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import { ButtonStyle, ComponentType, GatewayDispatchEvents, GatewayIntentBits, InteractionType } from "discord-api-types/v10";
import type { APIActionRowComponent, APIButtonComponentWithCustomId, APIInteraction, APIMessage } from "discord-api-types/v10";
import type { DiscordButton, DiscordInbound, DiscordInteraction, DiscordTransport, EditOptions, SendOptions } from "./types.ts";
import { BUTTONS_PER_ROW, DiscordSendError, MAX_BUTTON_ROWS } from "./types.ts";

// Guild messages in the configured channel, with their text. MESSAGE_CONTENT is a privileged intent: it must be
// enabled for the application in the Discord developer portal. Button presses (interactions) need no intent. The
// adapter has one guild channel and no DM support, so DirectMessages is not requested.
export const GATEWAY_INTENTS = GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent;

const STYLES = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger } as const;
export function buttonJson(b: DiscordButton): APIButtonComponentWithCustomId {
  return { type: ComponentType.Button, style: STYLES[b.style ?? "secondary"], label: b.label, custom_id: b.customId };
}

// Lays buttons out in rows of BUTTONS_PER_ROW, at most MAX_BUTTON_ROWS rows; buttons past the limit are dropped.
export function buttonRows(buttons: readonly DiscordButton[]): APIActionRowComponent<APIButtonComponentWithCustomId>[] {
  const rows: APIActionRowComponent<APIButtonComponentWithCustomId>[] = [];
  for (let i = 0; i < buttons.length && rows.length < MAX_BUTTON_ROWS; i += BUTTONS_PER_ROW) {
    rows.push({ type: ComponentType.ActionRow, components: buttons.slice(i, i + BUTTONS_PER_ROW).map(buttonJson) });
  }
  return rows;
}

// The subset of a Discord message the inbound path reads (an APIMessage satisfies it).
export interface RawMessage {
  id: string;
  content?: string;
  author?: { id?: string; username?: string; bot?: boolean };
  referenced_message?: { id?: string; content?: string; author?: { id?: string; bot?: boolean } } | null;
}

function toInbound(m: RawMessage): DiscordInbound | null {
  if (!m.id || m.author?.bot) return null;
  return {
    id: m.id,
    authorId: m.author?.id ?? "unknown",
    ...(m.author?.username ? { authorName: m.author.username } : {}),
    body: m.content ?? "",
    ...(m.referenced_message?.content ? { replyToText: m.referenced_message.content } : {}),
    ...(m.referenced_message?.id ? { replyToId: m.referenced_message.id } : {}),
  };
}

// Delivers a batch of messages (newest-first, as Discord lists them) to the handlers in oldest-first order, advancing
// the cursor (`lastId`) only after a message is fully committed. A rejected handler aborts before the cursor advances,
// so the next catch-up (after=lastId) re-delivers the uncommitted message. Bot messages and messages that do not map
// to inbound advance the cursor unconditionally.
export async function deliverInbound(
  list: RawMessage[],
  lastId: string | null,
  handlers: readonly ((msg: DiscordInbound) => void | Promise<void>)[],
): Promise<string | null> {
  let next = lastId;
  for (const m of [...list].reverse()) {
    const msg = toInbound(m);
    if (!msg) {
      if (m.id) next = m.id;
      continue;
    }
    for (const h of handlers) await h(msg);
    if (m.id) next = m.id;
  }
  return next;
}

// Snowflakes are decimal strings without leading zeros, so a longer one is later and equal lengths compare lexically.
export function snowflakeAfter(a: string, b: string): boolean {
  return a.length !== b.length ? a.length > b.length : a > b;
}

// Maps a @discordjs/rest failure to DiscordSendError. REST queues and retries a 429 itself; a RateLimitError (raised
// only when the REST instance is configured to reject on rate limits) keeps the outbox Retry-After path as a fallback.
// `secret` (an interaction token) is scrubbed from the message, which must never carry a token.
export function toSendError(e: unknown, secret?: string): DiscordSendError {
  if (e instanceof DiscordSendError) return e;
  const scrub = (s: string) => (secret ? s.split(secret).join("[redacted]") : s);
  if (e instanceof RateLimitError) return new DiscordSendError(429, Math.max(0, e.retryAfter), "discord rate limited");
  if (e instanceof DiscordAPIError || e instanceof HTTPError) return new DiscordSendError(e.status, null, scrub(e.message));
  return new DiscordSendError(0, null, scrub(e instanceof Error ? e.message : String(e)));
}

// A gateway the transport can start and stop: the WebSocketManager, or a test fake (fakes.ts).
export type GatewayLike = Gateway & { connect?(): unknown; destroy?(): unknown };

// What the transport keeps per interaction, out of the adapter's reach (DiscordInteraction.handle is the key).
interface InteractionSecret {
  id: string;
  token: string;
  applicationId: string;
}

const CATCH_UP_LIMIT = 100;

function buttonLabelOf(message: { components?: unknown }, customId: string): string | undefined {
  const rows = Array.isArray(message.components) ? (message.components as { components?: unknown }[]) : [];
  for (const row of rows) {
    for (const c of Array.isArray(row.components) ? (row.components as { custom_id?: unknown; label?: unknown }[]) : []) {
      if (c.custom_id === customId && typeof c.label === "string") return c.label;
    }
  }
  return undefined;
}

// The real Discord transport: a gateway (WebSocket) connection for inbound messages and button presses, and the REST
// API for sends, edits and catch-up. Inbound delivery is serialised and at-least-once: a message is delivered at most
// once per cursor position (`lastId`), every READY (a fresh identify does not replay missed events) catches up from
// the cursor over REST, and a failed delivery stalls live delivery until a catch-up re-delivers from the cursor.
// `gateway` and `rest` are injectable (fakes.ts); by default they are built from the bot token, which is never logged.
export function gatewayTransport(opts: {
  token: string;
  channelId: string;
  gateway?: GatewayLike;
  rest?: REST;
  log?: (line: string) => void;
  retryMs?: number; // delay before re-running a failed catch-up (default 5 s)
  maxCatchUpPages?: number; // pages of CATCH_UP_LIMIT messages read per catch-up (default 20)
}): DiscordTransport & { idle(): Promise<void> } {
  const { token, channelId, log = () => {}, retryMs = 5_000, maxCatchUpPages = 20 } = opts;
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const gateway: GatewayLike = opts.gateway ?? new WebSocketManager({ token, intents: GATEWAY_INTENTS, rest });
  const client = new Client({ rest, gateway });
  const api = client.api;

  const messageHandlers = new Set<(msg: DiscordInbound) => void | Promise<void>>();
  const interactionHandlers = new Set<(i: DiscordInteraction) => void | Promise<void>>();
  const secrets = new WeakMap<object, InteractionSecret>();
  const inflight = new Set<Promise<unknown>>();
  let lastId: string | null = null;
  let stalled = false;
  let started = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let botUserId: string | null = null;

  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  };
  // Inbound delivery runs one job at a time, so a catch-up and live messages never interleave or double-deliver.
  const serial = (name: string, job: () => Promise<void>): Promise<void> => {
    const next = chain.then(job).catch((e) => log(`discord ${name} failed: ${errText(e)}`));
    chain = next;
    return track(next);
  };

  // The bot's own user id: from READY, else users/@me (cached). Null fails the ownership checks closed.
  const botId = async (): Promise<string | null> => {
    if (botUserId) return botUserId;
    try {
      botUserId = (await api.users.getCurrent()).id;
    } catch {
      // leave null
    }
    return botUserId;
  };

  const scheduleRetry = () => {
    if (!started || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void serial("catch-up", catchUp);
    }, retryMs);
    retryTimer.unref?.();
  };

  // Primes the cursor at the channel's newest message, so startup never replays history. An empty channel primes at
  // "0", so everything posted after startup is caught up.
  async function prime(): Promise<void> {
    const list = await api.channels.getMessages(channelId, { limit: 1 });
    lastId = list[0]?.id ?? "0";
  }

  async function catchUp(): Promise<void> {
    try {
      if (lastId === null) {
        await prime();
        stalled = false;
        return;
      }
      for (let page = 0; page < maxCatchUpPages; page++) {
        const after = lastId;
        if (after === null) break;
        const list = (await api.channels.getMessages(channelId, { after, limit: CATCH_UP_LIMIT })) as RawMessage[];
        const fresh = list.filter((m) => snowflakeAfter(m.id, after)).sort((a, b) => (snowflakeAfter(a.id, b.id) ? -1 : 1));
        if (fresh.length === 0) break;
        lastId = await deliverInbound(fresh, lastId, [...messageHandlers]);
        if (list.length < CATCH_UP_LIMIT) break;
      }
      stalled = false;
    } catch (e) {
      stalled = true;
      scheduleRetry();
      throw e;
    }
  }

  async function deliverLive(m: APIMessage): Promise<void> {
    if (stalled && lastId !== null) return catchUp();
    if (lastId !== null && !snowflakeAfter(m.id, lastId)) return; // already delivered (catch-up or a replayed event)
    try {
      lastId = await deliverInbound([m as RawMessage], lastId, [...messageHandlers]);
    } catch (e) {
      stalled = true;
      scheduleRetry();
      throw e;
    }
  }

  // A button press on a message this bot authored, in the configured channel; anything else is not ours to answer.
  async function toInteraction(data: APIInteraction): Promise<DiscordInteraction | null> {
    if (data.type !== InteractionType.MessageComponent || data.data.component_type !== ComponentType.Button) return null;
    if ((data.channel?.id ?? data.channel_id) !== channelId) return null;
    const me = await botId();
    if (!me || data.message.author.id !== me) return null;
    const user = data.member?.user ?? data.user;
    if (!user) return null;
    const handle = Object.freeze({});
    secrets.set(handle, { id: data.id, token: data.token, applicationId: data.application_id });
    const label = buttonLabelOf(data.message, data.data.custom_id);
    const name = user.global_name ?? user.username;
    return {
      id: data.id,
      userId: user.id,
      ...(name ? { userName: name } : {}),
      customId: data.data.custom_id,
      messageId: data.message.id,
      channelId,
      ...(label !== undefined ? { buttonLabel: label } : {}),
      messageContent: data.message.content,
      handle,
    };
  }

  client.on(GatewayDispatchEvents.Ready, ({ data }) => {
    botUserId = data.user.id;
    void serial("catch-up", catchUp);
  });
  client.on(GatewayDispatchEvents.MessageCreate, ({ data }) => {
    if (data.channel_id !== channelId) return;
    void serial("delivery", () => deliverLive(data));
  });
  client.on(GatewayDispatchEvents.InteractionCreate, ({ data }) => {
    void track(
      (async () => {
        const i = await toInteraction(data);
        if (!i) return;
        for (const h of [...interactionHandlers]) await h(i);
      })().catch((e) => log(`discord interaction ${data.id} failed: ${errText(e)}`)),
    );
  });

  const secretOf = (i: DiscordInteraction): InteractionSecret => {
    const s = secrets.get(i.handle);
    if (!s) throw new DiscordSendError(0, null, `unknown interaction ${i.id}`);
    return s;
  };

  return {
    async send(targetChannelId: string, content: string, sendOpts?: SendOptions) {
      try {
        const m = await api.channels.createMessage(targetChannelId, {
          content,
          allowed_mentions: { parse: [] },
          ...(sendOpts?.buttons?.length ? { components: buttonRows(sendOpts.buttons) } : {}),
        });
        return m.id;
      } catch (e) {
        throw toSendError(e);
      }
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
    onInteraction(handler) {
      interactionHandlers.add(handler);
      return () => {
        interactionHandlers.delete(handler);
      };
    },
    async deferUpdate(i: DiscordInteraction) {
      const s = secretOf(i);
      try {
        await api.interactions.deferMessageUpdate(s.id, s.token);
      } catch (e) {
        throw toSendError(e, s.token);
      }
    },
    async editInteraction(i: DiscordInteraction, content: string, editOpts?: EditOptions) {
      const s = secretOf(i);
      try {
        await api.interactions.editReply(s.applicationId, s.token, {
          content,
          allowed_mentions: { parse: [] },
          ...(editOpts?.buttons ? { components: buttonRows(editOpts.buttons) } : {}),
        });
      } catch (e) {
        throw toSendError(e, s.token);
      }
    },
    async isBotAuthored(targetChannelId: string, messageId: string) {
      try {
        const m = await api.channels.getMessage(targetChannelId, messageId);
        return !!m.author.bot && m.author.id === (await botId());
      } catch {
        return false;
      }
    },
    async start() {
      if (started) return;
      started = true;
      await serial("prime", async () => {
        try {
          await prime();
        } catch (e) {
          // READY's catch-up primes instead.
          log(`discord prime failed: ${errText(e)}`);
        }
      });
      await Promise.resolve(gateway.connect?.());
    },
    stop() {
      started = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      void Promise.resolve(gateway.destroy?.()).catch((e) => log(`discord gateway stop failed: ${errText(e)}`));
    },
    // Resolves once every in-flight delivery and press handler has settled (tests and shutdown).
    async idle() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}
