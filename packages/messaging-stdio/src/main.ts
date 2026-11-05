#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { stdioClient } from "./client.ts";
import { loadConfig } from "./config.ts";
import { runStdio } from "./run.ts";

const cfg = loadConfig(process.env);
const stop = new AbortController();
const input = createInterface({ input: process.stdin });
// TODO(messaging-stdio-main-exit): this handler is untested because it runs at import; extract it into a pure function to test.
// A closed stdout (EPIPE) would otherwise lose every later line silently, or crash with an unhandled 'error'.
process.stdout.on("error", (e) => {
  process.stderr.write(`messaging-stdio: stdout closed (${e.message}); the adapter stops; restart it attached to a terminal or a live pipe\n`);
  process.exitCode = 1;
  stop.abort();
  input.close();
});
await runStdio({
  client: stdioClient(cfg.baseUrl, cfg.token, cfg.channel),
  channel: cfg.channel,
  sender: cfg.sender,
  input,
  write: (s) => void process.stdout.write(`${s}\n`),
  pollMs: cfg.pollMs,
  sessionId: randomUUID(),
  signal: stop.signal,
});
