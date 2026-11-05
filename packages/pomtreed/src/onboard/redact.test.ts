import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTED, redactSecrets } from "./redact.ts";

const S = "sk-test-0123456789abcdef";

test("env forms: a sensitive registry name, export, a unit Environment= line and a credential-named foreign variable are redacted", () => {
  const text = [
    `POMTREED_MODEL_UPSTREAM_KEY=${S}`,
    `export POMTREED_MODEL_UPSTREAM_KEY='${S}'`,
    `Environment=POMTREED_MODEL_UPSTREAM_KEY=${S}`,
    `Environment="OPENROUTER_API_KEY=${S}"`,
    `GITHUB_TOKEN=${S}`,
  ].join("\n");
  const out = redactSecrets(text);
  assert.ok(!out.includes(S));
  assert.deepEqual(out.split("\n"), [
    `POMTREED_MODEL_UPSTREAM_KEY=${REDACTED}`,
    `export POMTREED_MODEL_UPSTREAM_KEY=${REDACTED}`,
    `Environment=POMTREED_MODEL_UPSTREAM_KEY=${REDACTED}`,
    `Environment="OPENROUTER_API_KEY=${REDACTED}`,
    `GITHUB_TOKEN=${REDACTED}`,
  ]);
});

test("negative control: non-sensitive names, a _FILE path, comments and other lines are kept byte for byte", () => {
  const text = "POMTREED_PI_PROVIDER=openrouter\nPOMTREED_MODEL_UPSTREAM_KEY_FILE=/keys/k\nMONKEY=banana\n# KEY=comment\nExecStart=/usr/bin/node x\n";
  assert.equal(redactSecrets(text), text);
});

test("JSON: compact, pretty, and an unterminated value are redacted; a nested object is not swallowed; other members keep their values", () => {
  const compact = `{"model":{"upstreamKey":"${S}","baseUrl":"https://x.example.com"}}`;
  assert.equal(redactSecrets(compact), `{"model":{"upstreamKey":"${REDACTED}","baseUrl":"https://x.example.com"}}`);
  const pretty = `{\n  "model": {\n    "upstreamKey": "${S}"\n  },\n  "apiToken": 12345\n}\n`;
  assert.equal(redactSecrets(pretty), `{\n  "model": {\n    "upstreamKey": "${REDACTED}"\n  },\n  "apiToken": "${REDACTED}"\n}\n`);
  assert.ok(!redactSecrets(`{"model": {"upstreamKey": "${S}`).includes(S));
  assert.ok(!redactSecrets(`{"upstreamKey": "a\\"${S}"}`).includes(S), "an escaped quote does not end the value early");
  const plain = `{"pi": {"provider": "openrouter"}, "budget": {"defaultMicros": 5}}`;
  assert.equal(redactSecrets(plain), plain);
});
