import { readFileSync } from "node:fs";

export interface StdioConfig {
  baseUrl: string;
  token: string;
  channel: string;
  sender: string;
  pollMs: number;
}

// POMTREED_MESSAGING_TOKEN is the path to the host token file for the channel (pomtreed writes it at boot).
export function loadConfig(env: NodeJS.ProcessEnv = process.env): StdioConfig {
  const tokenPath = env.POMTREED_MESSAGING_TOKEN;
  if (!tokenPath) throw new Error("POMTREED_MESSAGING_TOKEN (path to the host token file) is required; set it to pomtreed's messaging.<channel>.token file");
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!token) throw new Error(`host token file ${tokenPath} is empty; point POMTREED_MESSAGING_TOKEN at the file pomtreed wrote`);
  const baseUrl = env.POMTREED_URL ?? "http://127.0.0.1:8080";
  if (!baseUrl) throw new Error("POMTREED_URL is set but empty; set it to pomtreed's host URL (for example http://127.0.0.1:8080) or unset it");
  const channel = env.MESSAGING_STDIO_CHANNEL || "stdio";
  const sender = env.MESSAGING_STDIO_SENDER;
  if (!sender)
    throw new Error(`MESSAGING_STDIO_SENDER is required: your sender id, which must also be on pomtreed's POMTREED_MESSAGING_SENDERS as ${channel}:<id>`);
  const pollMs = Number(env.MESSAGING_STDIO_POLL_MS ?? 1000);
  if (!Number.isInteger(pollMs) || pollMs <= 0)
    throw new Error(`MESSAGING_STDIO_POLL_MS must be a positive integer of milliseconds, got ${JSON.stringify(env.MESSAGING_STDIO_POLL_MS)}`);
  return { baseUrl, token, channel, sender, pollMs };
}
