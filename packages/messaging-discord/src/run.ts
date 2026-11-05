import type { Config } from "./types.ts";
import { DiscordAdapter } from "./adapter.ts";
import { pomtreedClient } from "./client.ts";
import { fileOutboxStore } from "./cursor.ts";
import { gatewayTransport } from "./discord.ts";
import { filePairingStore } from "./pairings.ts";

export interface RunHandle {
  stop(): void;
}

// An in-flight guard for the poll loop: tryEnter succeeds only when no poll is running, so an
// interval tick that fires while the previous pollOnce is still pending is skipped. This keeps
// overlapping polls from reading the same cursor and double-sending.
export function createInFlightGate() {
  let inFlight = false;
  return {
    tryEnter(): boolean {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    leave(): void {
      inFlight = false;
    },
  };
}

// Wires the real pomtreed and Discord clients around the injected-boundary adapter. Tests inject
// fakes directly into DiscordAdapter; this shell is the only place the real clients are assembled.
export function run(config: Config, log: (line: string) => void = console.log): RunHandle {
  const discord = gatewayTransport({ token: config.discordToken, channelId: config.discordChannelId, log });
  const adapter = new DiscordAdapter({
    pomtreed: pomtreedClient(config.baseUrl, config.token),
    discord,
    outbox: fileOutboxStore(config.cursorPath),
    pairings: filePairingStore(config.pairingsPath),
    channelId: config.discordChannelId,
    allowedSenders: config.allowedSenders,
    ...(config.agentAllowlists ? { agentAllowlists: config.agentAllowlists } : {}),
    ...(config.passButton ? { passButton: true } : {}),
    log,
  });
  const offInbound = adapter.listen();
  const gate = createInFlightGate();
  const poll = () => {
    if (!gate.tryEnter()) return;
    adapter
      .pollOnce()
      .then((r) => {
        if (r.sent) log(`sent ${r.sent} outbound (cursor ${r.cursor})`);
      })
      .catch((e) => log(`poll failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => gate.leave());
  };
  const timer = setInterval(poll, config.pollIntervalMs);
  timer.unref?.();
  void poll();
  void (async () => {
    try {
      await discord.start?.();
    } catch (e) {
      log(`discord listener failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
  return {
    stop() {
      clearInterval(timer);
      offInbound();
      discord.stop?.();
    },
  };
}
