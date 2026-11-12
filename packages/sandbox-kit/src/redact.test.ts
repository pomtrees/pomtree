import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTED, redact, redactError, redactHeaders, redactUrl } from "./redact.ts";

// Built at run time so no credential-shaped literal sits in the source.
const TOKEN = ["tok", "9f8e7d6c5b4a3210"].join("_");

test("redact: a token echoed in a provider error body is absent from the thrown message", () => {
  const body = `{"error":"invalid credentials","received":"${TOKEN}"}`;
  const err = redactError(new Error(`create failed: 401 ${body}`), { secrets: [TOKEN] });
  assert.ok(!err.message.includes(TOKEN), err.message);
  assert.ok(err.message.includes(REDACTED));
  assert.ok(err.message.includes("create failed: 401"), "the surrounding text survives");
});

test("redact: negative control, the same message is NOT stripped when the secret is not configured and has no known shape", () => {
  assert.ok(redact(`received ${TOKEN}`).includes(TOKEN));
});

test("redact: bearer tokens, authorization and api-key headers, provider-prefixed keys", () => {
  const key = ["sk", "ant", "abcdefghijkl123456"].join("-");
  const out = redact(`Authorization: Bearer abc.def-ghi\nx-api-key: ${TOKEN}\nBearer zzz999 and ${key}`);
  assert.ok(!/abc\.def-ghi|zzz999|tok_9f8e|abcdefghijkl123456/.test(out), out);
});

test("redact: the URL-encoded form of a configured secret is stripped too", () => {
  const secret = "p@ss word/1234";
  const out = redact(`GET /x?key=${encodeURIComponent(secret)} and ${secret}`, { secrets: [secret] });
  assert.ok(!out.includes(secret) && !out.includes(encodeURIComponent(secret)), out);
});

test("redact: values shorter than the floor are left alone (they would mangle ordinary text)", () => {
  assert.equal(redact("a bc d", { secrets: ["a", "bc", undefined, ""] }), "a bc d");
});

test("redact: PEM private key blocks are removed", () => {
  const pem = `${["-----BEGIN", "PRIVATE KEY-----"].join(" RSA ")}\nMIIabc\n-----END RSA PRIVATE KEY-----`;
  assert.ok(!redact(`key ${pem} done`).includes("MIIabc"));
});

test("redactHeaders: sensitive header values are replaced, others pass through", () => {
  const out = redactHeaders({ Authorization: `Bearer ${TOKEN}`, "X-Request-Id": "r1", "x-auth-token": "q" });
  assert.equal(out.Authorization, REDACTED);
  assert.equal(out["x-auth-token"], REDACTED);
  assert.equal(out["X-Request-Id"], "r1");
});

test("redactUrl: drops userinfo, query and fragment", () => {
  assert.equal(redactUrl("https://user:pw@api.example.com/v1/boxes?token=abc#f"), "https://api.example.com/v1/boxes");
  assert.equal(redactUrl("not a url?token=abc"), "not a url");
});

test("redact: sensitive field names in JSON and assignment forms, including prefixed names", () => {
  const v = ["v4lue", "x9y8z7"].join("");
  const cases = [
    `{"token":"${v}"}`,
    `{"access_token": "${v}", "ok": 1}`,
    `client_secret=${v}&grant=x`,
    `password: ${v}`,
    `passwd='${v}'`,
    `openai_api_key=${v}`,
    `{"x-api-key":"${v}"}`,
    `GET /x?api_key=${v}&b=1`,
  ];
  for (const c of cases) assert.ok(!redact(c).includes(v), `${c} -> ${redact(c)}`);
  assert.equal(redact(`{"name":"box","token":"${v}"}`), `{"name":"box","token":"${REDACTED}"}`, "other fields and JSON shape survive");
});

test("redact: an x-api-key header value containing a comma is stripped whole", () => {
  const out = redact("x-api-key: first1234,second5678 trailing");
  assert.ok(!out.includes("first1234") && !out.includes("second5678"), out);
});

test("redactUrl: unparseable URLs lose userinfo, query and a bot-token path segment too", () => {
  const out = redactUrl("//user:p4ss@host-without-scheme/bot123456789:AAEhBP0av28wdfghijklmnopqrstuvwx/send?x=1");
  assert.ok(!/p4ss|AAEhBP0av28/.test(out) && !out.includes("?"), out);
  assert.ok(!redactUrl("https://api.example.com/bot123456789:AAEhBP0av28wdfghijklmnopqrstuvwx/send").includes("AAEhBP0av28"));
});

test("redactError: cause text is kept for operators, redacted, cycle-safe and depth-capped", () => {
  const inner = new Error(`connect failed token=${TOKEN} host db.internal`);
  const outer = new Error("create failed", { cause: inner });
  const e = redactError(outer, { secrets: [TOKEN] });
  assert.ok(e.message.startsWith("create failed"));
  assert.ok(e.message.includes("db.internal"), e.message);
  assert.ok(!e.message.includes(TOKEN), e.message);
  const a = new Error("a");
  const b = new Error("b", { cause: a });
  a.cause = b;
  assert.equal(redactError(a).message.split("cause:").length - 1, 1, "cycle visited once");
  let chain: Error = new Error("e0");
  for (let i = 1; i < 50; i++) chain = new Error(`e${i}`, { cause: chain });
  assert.ok(redactError(chain).message.split("cause:").length - 1 <= 5, "depth capped");
});
