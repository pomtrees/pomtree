import { readFileSync } from "node:fs";
import type { Config } from "./types.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_CURSOR_PATH = "./messaging.discord.cursor";
const DEFAULT_PAIRINGS_PATH = "./messaging.discord.pairings.json";
const DEFAULT_POLL_INTERVAL_MS = 1_000;

// Reads the adapter's configuration from the environment. POMTREED_MESSAGING_TOKEN is the path to
// the host token file (0600); its contents (the `ht.discord.<hmac>` token) are what get sent.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tokenPath = env.POMTREED_MESSAGING_TOKEN;
  if (!tokenPath) throw new Error("POMTREED_MESSAGING_TOKEN (path to the host token file) is required");
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!token) throw new Error(`host token file ${tokenPath} is empty`);
  // TODO(discord-token-file): the bot token is an env value; pomtreed's secrets are `<ENV>_FILE` paths. Current behavior: env only.
  const discordToken = env.DISCORD_TOKEN;
  if (!discordToken) throw new Error("DISCORD_TOKEN is required");
  const discordChannelId = env.DISCORD_CHANNEL_ID;
  if (!discordChannelId) throw new Error("DISCORD_CHANNEL_ID is required");
  const agentAllowlists = parseAgentAllowlists(env.DISCORD_AGENT_ALLOWLISTS);
  return {
    token,
    baseUrl: env.POMTREED_URL ?? DEFAULT_BASE_URL,
    discordToken,
    discordChannelId,
    cursorPath: env.DISCORD_CURSOR_FILE ?? DEFAULT_CURSOR_PATH,
    pairingsPath: env.DISCORD_PAIRINGS_FILE ?? DEFAULT_PAIRINGS_PATH,
    pollIntervalMs: Number(env.DISCORD_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS,
    allowedSenders: (env.DISCORD_ALLOWED_SENDERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    ...(agentAllowlists ? { agentAllowlists } : {}),
    // TODO(mainflow): off by default until the live check. pomtreed's POST /v1/messages reads `pass` (packages/pomtreed/src/api.ts),
    // so a press posts `pass: true` with `replyTo` and hands the ask or approval up one rung.
    ...(env.DISCORD_PASS_BUTTON === "1" ? { passButton: true } : {}),
  };
}

// DISCORD_AGENT_ALLOWLISTS: JSON object of agent id -> array of Discord user ids.
export function parseAgentAllowlists(raw: string | undefined): Record<string, string[]> | undefined {
  if (!raw) return undefined;
  const v: unknown = JSON.parse(raw);
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("DISCORD_AGENT_ALLOWLISTS must be a JSON object");
  const out: Record<string, string[]> = {};
  for (const [k, ids] of Object.entries(v)) {
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new Error(`DISCORD_AGENT_ALLOWLISTS[${k}] must be an array of strings`);
    out[k] = ids as string[];
  }
  return out;
}
