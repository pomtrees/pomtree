#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { stdioClient } from "./client.ts";
import { loadConfig } from "./config.ts";
import { onStdoutClosed, runStdio } from "./run.ts";

const cfg = loadConfig(process.env);
const stop = new AbortController();
const input = createInterface({ input: process.stdin });
process.stdout.on("error", (e) =>
  onStdoutClosed(e, {
    stderr: (s) => void process.stderr.write(s),
    setExitCode: (c) => {
      process.exitCode = c;
    },
    abort: () => stop.abort(),
    closeInput: () => input.close(),
  }),
);
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
