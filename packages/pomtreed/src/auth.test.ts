import assert from "node:assert/strict";
import { test } from "node:test";
import { issueToken, issueUiCookie, tokenProblem, verifyToken, verifyUiCookie } from "./auth.ts";

const SECRET = "s";

test("host tokens round-trip and reject unsafe channel names", () => {
  assert.deepEqual(verifyToken(SECRET, issueToken(SECRET, { scope: "host", channel: "discord" })), { scope: "host", channel: "discord" });
  for (const bad of ["a.b", "a/b", "a\\b", "..", "a b", "a\nb", ""]) {
    assert.throws(() => issueToken(SECRET, { scope: "host", channel: bad }), /invalid messaging channel/);
  }
});

test("a forged host token with an unsafe channel verifies as null, not a throw", () => {
  assert.equal(verifyToken(SECRET, "ht.a/b.xyz"), null);
  assert.equal(verifyToken(SECRET, "ht.a.b.xyz"), null); // four parts: not a valid host token shape
});

test("agent tokens round-trip generation and expiry, and reject expiry and tampering", () => {
  const expiry = Date.now() + 60_000;
  const tok = issueToken(SECRET, { scope: "agent", agent: "a", generation: 3, expiry });
  assert.deepEqual(verifyToken(SECRET, tok), { scope: "agent", agent: "a", generation: 3, expiry });
  // An expired token never verifies.
  assert.equal(verifyToken(SECRET, issueToken(SECRET, { scope: "agent", agent: "a", generation: 3, expiry: Date.now() - 1 })), null);
  // A tampered generation or expiry breaks the HMAC and verifies as null.
  assert.equal(verifyToken(SECRET, `ag.a.4.${expiry}.${tok.split(".").at(-1)}`), null);
  assert.equal(verifyToken(SECRET, `ag.a.3.${expiry - 1}.${tok.split(".").at(-1)}`), null);
  // Malformed shapes (wrong part count, non-numeric generation/expiry) are rejected, not thrown.
  assert.equal(verifyToken(SECRET, "ag.a.3.xyz"), null);
  assert.equal(verifyToken(SECRET, "ag.a.3"), null);
  assert.equal(verifyToken(SECRET, "ag.a.-1.123.xyz"), null);
});

test("ui cookies round-trip and reject forgery, expiry, and wrong secrets", () => {
  const cookie = issueUiCookie(SECRET, 60_000);
  assert.ok(cookie.startsWith("pomtreed_ui="));
  assert.equal(verifyUiCookie(SECRET, cookie), true);
  // The full Cookie header form (other cookies around it) verifies too.
  assert.equal(verifyUiCookie(SECRET, `other=1; ${cookie}; x=2`), true);
  assert.equal(verifyUiCookie("other-secret", cookie), false);
  // An already-expired cookie never verifies.
  assert.equal(verifyUiCookie(SECRET, issueUiCookie(SECRET, -1)), false);
  // Tampered mac and malformed values are rejected, not thrown.
  assert.equal(verifyUiCookie(SECRET, `${cookie.slice(0, -1)}x`), false);
  assert.equal(verifyUiCookie(SECRET, "pomtreed_ui=not-a-cookie"), false);
  assert.equal(verifyUiCookie(SECRET, ""), false);
  assert.equal(verifyUiCookie(SECRET, "pomtreed_ui=.hmac"), false);
});

test("verifyUiCookie matches the cookie name exactly, not as a substring", () => {
  const cookie = issueUiCookie(SECRET, Date.now() + 60_000);
  assert.equal(verifyUiCookie(SECRET, `evil_${cookie}`), false);
  assert.equal(verifyUiCookie(SECRET, `x=1; not${cookie}`), false);
  assert.equal(verifyUiCookie(SECRET, `x=pomtreed_ui=1; ${cookie}`), true);
});

test("ui cookie expiry follows the injected clock: valid through its expiry instant, rejected one ms later", () => {
  let t = 1_000_000;
  const now = () => t;
  const cookie = issueUiCookie(SECRET, 60_000, now);
  assert.equal(cookie.split("=")[1]?.split(".")[0], "1060000"); // issued against the injected clock, not the wall clock
  assert.equal(verifyUiCookie(SECRET, cookie, now), true);
  t = 1_060_000;
  assert.equal(verifyUiCookie(SECRET, cookie, now), true); // the expiry instant itself is still valid
  t = 1_060_001;
  assert.equal(verifyUiCookie(SECRET, cookie, now), false);
  // Negative control: the same cookie against the wall clock (long past 1970) is expired, so the injected clock is what decided above.
  assert.equal(verifyUiCookie(SECRET, cookie), false);
});

test("agent token expiry and its 401 problem follow the injected clock", () => {
  const tok = issueToken(SECRET, { scope: "agent", agent: "a", generation: 1, expiry: 5_000 });
  assert.deepEqual(
    verifyToken(SECRET, tok, () => 4_999),
    { scope: "agent", agent: "a", generation: 1, expiry: 5_000 },
  );
  assert.equal(
    verifyToken(SECRET, tok, () => 5_000),
    null,
  );
  assert.equal(
    tokenProblem(SECRET, tok, () => 4_999),
    "invalid",
  ); // not expired yet
  assert.equal(
    tokenProblem(SECRET, tok, () => 5_000),
    "expired",
  );
  assert.equal(
    tokenProblem("other-secret", tok, () => 5_000),
    "invalid",
  ); // a token this daemon did not issue is never "expired"
});
