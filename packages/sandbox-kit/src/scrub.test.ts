import assert from "node:assert/strict";
import { test } from "node:test";
import { assertScrubbed, scanText } from "./scrub.ts";

// Planted values are assembled at run time so this file itself holds no credential-shaped literal.
const bearer = (v: string) => `{"authorization": "${["Bear", "er"].join("")} ${v}"}`;
const rulesOf = (text: string) => scanText("f.jsonl", text).map((f) => f.rule);

test("scrub: a planted bearer token is rejected, and the message does not echo it", () => {
  const planted = ["live", "token", "value", "12345"].join("-");
  const text = `{"status":200}\n${bearer(planted)}\n`;
  assert.deepEqual(rulesOf(text), ["bearer-token"]);
  assert.throws(
    () => assertScrubbed("f.jsonl", text),
    (e: Error) => e.message.includes("f.jsonl:2 [bearer-token]") && !e.message.includes(planted),
  );
});

test("scrub: negative control, a placeholder bearer value is accepted", () => {
  assert.deepEqual(rulesOf(bearer("<BEARER_TOKEN>")), []);
  assert.doesNotThrow(() => assertScrubbed("f.jsonl", bearer("<BEARER_TOKEN>")));
});

test("scrub: each other class is rejected", () => {
  const key = `${["gh", "p_"].join("")}abcdefghijklmnop1234`;
  assert.deepEqual(rulesOf(`key ${key}`), ["provider-key-prefix"]);
  assert.deepEqual(rulesOf(`MY_API_TOKEN=${["real", "value", "9"].join("-")}`), ["token-env"]);
  assert.deepEqual(rulesOf(`"account_id": "acct-1234"`), ["account-id"]);
  assert.deepEqual(rulesOf(`password: hunter2hunter2`), ["secret-assignment"]);
  assert.deepEqual(rulesOf(`blob a1b2c3d4e5f60718293a4b5c6d7e8f9012345678`), ["high-entropy"]);
  assert.deepEqual(rulesOf(`cwd ${["/Us", "ers/alice/x"].join("")}`), ["absolute-path"]);
  assert.deepEqual(rulesOf(`-----BEGIN ${"PRIVATE"} KEY-----`), ["private-key-block"]);
});

test("scrub: hashes labelled as such, UUIDs and declared placeholders pass", () => {
  assert.deepEqual(rulesOf(`"sha256": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678aabbccdd"`), []);
  assert.deepEqual(rulesOf(`id 123e4567-e89b-12d3-a456-426614174000`), []);
  const blob = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  assert.deepEqual(rulesOf(`{"placeholders":["${blob}"]}\nid ${blob}`), []);
});
