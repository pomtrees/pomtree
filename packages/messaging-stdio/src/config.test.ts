import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "./config.ts";

const dir = mkdtempSync(join(tmpdir(), "stdio-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const tokenFile = join(dir, "tok");
writeFileSync(tokenFile, "ht.stdio.abc\n");
const env = { POMTREED_MESSAGING_TOKEN: tokenFile, MESSAGING_STDIO_SENDER: "me" };

test("defaults: channel stdio, local pomtreed, 1s poll, token trimmed", () => {
  assert.deepEqual(loadConfig(env), { baseUrl: "http://127.0.0.1:8080", token: "ht.stdio.abc", channel: "stdio", sender: "me", pollMs: 1000 });
});

test("every override is read", () => {
  const c = loadConfig({ ...env, POMTREED_URL: "http://h:1", MESSAGING_STDIO_CHANNEL: "term", MESSAGING_STDIO_POLL_MS: "50" });
  assert.deepEqual([c.baseUrl, c.channel, c.pollMs], ["http://h:1", "term", 50]);
});

test("a missing token path, an empty token file, a missing sender and a bad poll interval each name the variable and the action", () => {
  assert.throws(() => loadConfig({ MESSAGING_STDIO_SENDER: "me" }), /POMTREED_MESSAGING_TOKEN .*required/);
  const empty = join(dir, "empty");
  writeFileSync(empty, " \n");
  assert.throws(() => loadConfig({ ...env, POMTREED_MESSAGING_TOKEN: empty }), new RegExp(`${empty} is empty; point POMTREED_MESSAGING_TOKEN`));
  assert.throws(() => loadConfig({ POMTREED_MESSAGING_TOKEN: tokenFile }), /MESSAGING_STDIO_SENDER is required.*POMTREED_MESSAGING_SENDERS as stdio:<id>/);
  assert.throws(() => loadConfig({ ...env, POMTREED_URL: "" }), /POMTREED_URL is set but empty/);
  assert.throws(() => loadConfig({ ...env, MESSAGING_STDIO_POLL_MS: "0" }), /MESSAGING_STDIO_POLL_MS must be a positive integer/);
});
