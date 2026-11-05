import assert from "node:assert/strict";
import { test } from "node:test";
import { DRIVER_ERROR_CAUSES, DRIVER_ERROR_TEXT_MAX, describeDriverError } from "./driver-error.ts";
import { LifecycleError } from "./lifecycle.ts";

test("a secret-looking string is redacted and the useful text survives", () => {
  const err = new Error(
    "edgar fetch failed: upstream status 403 for https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json; " +
      "Authorization: Bearer abcdefghijklmnop1234 api_key=ZYXWVUTSRQPONMLK9876 sk-live0123456789abcdefXYZ ghp_abcdefghijklmnopqrstuvwxyz0123 " +
      "token op.h1.0123456789abcdef0123456789abcdef read from /Users/someone/.pomtreed/tokens/operator",
  );
  const d = describeDriverError(err);
  assert.equal(d.cause, "threw");
  for (const secret of [
    "abcdefghijklmnop1234",
    "ZYXWVUTSRQPONMLK9876",
    "sk-live0123456789",
    "ghp_abcdef",
    "0123456789abcdef0123456789abcdef",
    "/Users/someone",
  ])
    assert.ok(!d.text.includes(secret), `${secret} is redacted: ${d.text}`);
  assert.match(d.text, /^edgar fetch failed: upstream status 403 for https:\/\/data\.sec\.gov\/api\/xbrl\/companyfacts\/CIK0000320193\.json;/);
  assert.match(d.text, /\[REDACTED:bearer\]/);
  assert.match(d.text, /api_key=\[REDACTED:secret\]/);
  assert.match(d.text, /read from \[path\]$/);
  assert.equal(d.line, `deterministic driver failed [cause=threw]: ${d.text}`);
});

test("control and bidi characters are stripped, ANSI sequences removed, whitespace collapses to one line", () => {
  const d = describeDriverError(new Error("bad\u001b[31m row\r\n\tnext\u202eevil\u0000end\u200b!"));
  assert.equal(d.text, "bad row next evil end !");
  assert.doesNotMatch(d.line, /[\p{Cc}\p{Cf}]/u);
});

test("the text is capped by characters after redaction, saying how much was dropped", () => {
  const d = describeDriverError(new Error(`${"x".repeat(5000)} sk-abcdefghijklmnopqrstuvwxyz`));
  assert.ok(d.text.startsWith("x".repeat(DRIVER_ERROR_TEXT_MAX)));
  assert.match(d.text, /… \[\d+ characters omitted\]$/);
  assert.ok(!d.text.includes("sk-abc"));
  // A huge message is bounded before the regexes run, and the kept text is still the cap.
  assert.ok(describeDriverError(new Error("y".repeat(1_000_000))).text.length < DRIVER_ERROR_TEXT_MAX + 64);
});

test("the cause code is closed and comes from the thrown value's shape, never its text", () => {
  const cases: [unknown, boolean, string][] = [
    [new LifecycleError(400, "invalid workflow suspension"), false, "bad_request"],
    [new LifecycleError(403, "data.sec.gov is not allowlisted"), false, "denied"],
    [new LifecycleError(404, "no such report"), false, "not_found"],
    [new LifecycleError(409, "fetch request budget exhausted"), false, "conflict"],
    [new LifecycleError(502, "upstream status 500"), false, "upstream"],
    [new LifecycleError(503, "deterministic driver x is unavailable"), false, "unavailable"],
    [new LifecycleError(418, "teapot"), false, "op_failed"],
    [Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }), true, "store_down"],
    [new TypeError("cannot read properties of undefined"), false, "threw"],
    ["a thrown string", false, "non_error"],
    [{ secret: "sk-abcdefghijklmnopqrstuvwxyz" }, false, "non_error"],
  ];
  for (const [err, down, cause] of cases) {
    const d = describeDriverError(err, down);
    assert.equal(d.cause, cause, String(err));
    assert.ok((DRIVER_ERROR_CAUSES as readonly string[]).includes(d.cause));
  }
  assert.equal(describeDriverError("a thrown string").text, "a thrown string");
  assert.equal(describeDriverError({ secret: "sk-abcdefghijklmnopqrstuvwxyz" }).text, "a thrown object", "an object's fields are never printed");
  assert.equal(describeDriverError(null).text, "a thrown null");
  assert.equal(describeDriverError(new Error("")).text, "(empty error message)");
});

test("a system error code on the error or its cause is kept; a free-text code is not", () => {
  const refused = new Error("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }) });
  assert.equal(describeDriverError(refused).text, "fetch failed (code ECONNREFUSED)");
  assert.equal(describeDriverError(Object.assign(new Error("x"), { code: "not a code sk-abcdefghijklmnopqrstuvwxyz" })).text, "x");
});
