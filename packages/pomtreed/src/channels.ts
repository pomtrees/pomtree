// The channel registry (TODO(msg-authz), TODO(channels-stage2)): ONE abstraction for every place a human talks to the daemon.
// `ui` (in-daemon operator UI), `cli` (the operator token / `pomtree` CLI / REST) and each messaging adapter (Discord, ...) are
// instances of the same entry type; the daemon asks the registry, never `channel === "ui"`. Built ONCE at boot from the env
// (POMTREED_MESSAGING_CHANNELS, POMTREED_ESCALATION_CHANNELS, POMTREED_UI_LISTEN); there is no runtime enable/disable (stage 2).
//
// RANK. `operator` rank (the operator token, the UI operator session cookie) is always allowed, always audited, and exempt from
// rate limits and POMTREED_CHAT_APPROVAL gating, so an emergency cancel is never throttled or held. `chat` rank (every adapter
// channel) keeps the sender allowlist, the rate limits and chat-approval gating. THE OPERATOR TOKEN MUST NEVER BE GIVEN TO AN
// ADAPTER: rank is a property of the channel entry, and adapters only ever hold a host token bound to their own chat channel.

import type { MessagingChannel } from "@pomtree/core";
import { CHANNEL_RE } from "./auth.ts";

export type ChannelKind = "in-daemon" | "adapter" | "operator";
export type ChannelRank = "operator" | "chat";

export interface ChannelEntry {
  name: MessagingChannel;
  kind: ChannelKind;
  rank: ChannelRank;
  /** May post inbound messages (answers, signals, spawn, ...). */
  inbound: boolean;
  /** Asks/alerts are sent OUT on it (ordered as POMTREED_ESCALATION_CHANNELS). */
  outbound: boolean;
}

export interface ChannelRegistry {
  entries(): readonly ChannelEntry[];
  get(name: string): ChannelEntry | undefined;
  /** Names that may post inbound. */
  inbound(): string[];
  /** Names asks/alerts go out on, in configured order. */
  outbound(): string[];
  hasOutbound(): boolean;
  /** Enabled (inbound or outbound) chat-rank channels: the ones that need a sender allowlist. */
  chat(): ChannelEntry[];
}

/** The in-daemon operator UI channel and the operator-token channel exist in every registry. */
export const UI_CHANNEL = "ui";
export const CLI_CHANNEL = "cli";
/** Names an adapter may not claim, compared case-insensitively (`operator` is the rank name; a channel called that would be confusable with it in audit lines). */
const RESERVED = new Set([CLI_CHANNEL, "operator"]);

export function buildChannelRegistry(messagingChannels: readonly string[], escalationChannels: readonly string[]): ChannelRegistry {
  for (const c of [...messagingChannels, ...escalationChannels]) {
    // The same charset the host tokens (`ht.<channel>.<hmac>`) and the token files use: a bad name must not reach issueToken.
    if (!CHANNEL_RE.test(c)) throw new Error(`invalid channel ${JSON.stringify(c)}: only letters, digits, "-" and "_" are allowed`);
    // `ui` is the in-daemon channel; any other case variant of ui, cli or operator would be confusable in audit lines.
    const lc = c.toLowerCase();
    if (RESERVED.has(lc) || (lc === UI_CHANNEL && c !== UI_CHANNEL))
      throw new Error(
        `channel name ${JSON.stringify(c)} is reserved for the operator (cli, operator, ui; case-insensitive) and cannot be configured as a channel`,
      );
  }
  const inboundSet = new Set([...messagingChannels, ...escalationChannels]);
  const outboundList = [...new Set(escalationChannels)];
  const entries: ChannelEntry[] = [
    { name: CLI_CHANNEL, kind: "operator", rank: "operator", inbound: true, outbound: false },
    { name: UI_CHANNEL, kind: "in-daemon", rank: "operator", inbound: inboundSet.has(UI_CHANNEL), outbound: outboundList.includes(UI_CHANNEL) },
  ];
  for (const name of inboundSet) {
    if (name === UI_CHANNEL) continue;
    entries.push({ name, kind: "adapter", rank: "chat", inbound: true, outbound: outboundList.includes(name) });
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    entries: () => entries,
    get: (name) => byName.get(name),
    inbound: () => entries.filter((e) => e.inbound).map((e) => e.name),
    outbound: () => [...outboundList],
    hasOutbound: () => outboundList.length > 0,
    chat: () => entries.filter((e) => e.rank === "chat" && (e.inbound || e.outbound)),
  };
}

/** Boot-time fail-closed check: any enabled chat-rank channel needs a non-empty POMTREED_MESSAGING_SENDERS. Null = fine. */
// Each entry must be `channel:sender` (empty entries are dropped by the caller before this check).
export function messagingSendersError(registry: ChannelRegistry, senders: ReadonlySet<string>): string | null {
  for (const s of senders)
    if (!/^[^:\s]+:\S.*$/.test(s))
      return `pomtreed: refusing to start: POMTREED_MESSAGING_SENDERS entry ${JSON.stringify(s)} must be of the form channel:sender`;
  const chat = registry.chat();
  if (chat.length === 0 || senders.size > 0) return null;
  return `pomtreed: refusing to start: POMTREED_MESSAGING_SENDERS is unset or empty while chat channel(s) ${chat.map((c) => c.name).join(", ")} are enabled: any sender the adapter admits could answer asks and approvals and spawn or cancel. Set POMTREED_MESSAGING_SENDERS=channel:sender,... (or remove the channel from POMTREED_MESSAGING_CHANNELS / POMTREED_ESCALATION_CHANNELS)`;
}
