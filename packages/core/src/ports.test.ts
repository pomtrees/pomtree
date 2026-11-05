import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeGatewayCredential,
  encodeGatewayCredential,
  MODEL_CALL_ERROR_CLASSES,
  MODEL_PROXY_CREDENTIAL_EXPIRED,
  type ModelCallErrorClass,
  MODEL_PROXY_INVALID_CREDENTIAL,
  verifyGatewayCredential,
} from "./ports.ts";

test("the model call error classes are closed, unique and keep the fallbacks", () => {
  assert.equal(new Set(MODEL_CALL_ERROR_CLASSES).size, MODEL_CALL_ERROR_CLASSES.length);
  for (const c of ["upstream_4xx", "upstream_5xx", "transport", "not_found", "dns", "malformed_response", "redirect"])
    assert.ok(MODEL_CALL_ERROR_CLASSES.includes(c as never), c);
  const ok: ModelCallErrorClass = "not_found";
  assert.equal(ok, "not_found");
  // @ts-expect-error a class outside the list does not compile
  const bad: ModelCallErrorClass = "boom";
  assert.equal(MODEL_CALL_ERROR_CLASSES.includes(bad), false);
});

test("gateway credentials round-trip, reject tamper and expiry", () => {
  const credential = { agent: "a1", budgetMicros: 99, expiresAt: 1_001, issuedAt: 1, id: "a".repeat(32), models: ["m1"] };
  const token = encodeGatewayCredential("secret", credential);
  assert.deepEqual(decodeGatewayCredential("secret", token, 1_000), credential);
  assert.equal(decodeGatewayCredential("different", token, 1_000), null);
  assert.equal(decodeGatewayCredential("secret", `${token}x`, 1_000), null);
  assert.equal(decodeGatewayCredential("secret", token, 1_001), null);
});

test("verifyGatewayCredential tells an expired credential from an invalid one", () => {
  const credential = { agent: "a1", budgetMicros: 99, expiresAt: 1_001, issuedAt: 1, id: "a".repeat(32), models: ["m1"] };
  const token = encodeGatewayCredential("secret", credential);
  assert.deepEqual(verifyGatewayCredential("secret", token, 1_000), { ok: true, credential });
  assert.deepEqual(verifyGatewayCredential("secret", token, 1_001), { ok: false, reason: "expired" });
  // Only a verified signature can read as expired: a wrong secret or a tampered token is invalid, even past its expiry.
  assert.deepEqual(verifyGatewayCredential("different", token, 5_000), { ok: false, reason: "invalid" });
  assert.deepEqual(verifyGatewayCredential("secret", `${token}x`, 5_000), { ok: false, reason: "invalid" });
  assert.deepEqual(verifyGatewayCredential("secret", "pg1.e30.x", 0), { ok: false, reason: "invalid" });
  // A signed but malformed payload is invalid even when its expiry has passed.
  const malformed = encodeGatewayCredential("secret", { ...credential, id: "nothex" });
  assert.deepEqual(verifyGatewayCredential("secret", malformed, 5_000), { ok: false, reason: "invalid" });
  // The model allowlist is part of the signed payload: missing or non-string entries are invalid (fail closed), and an
  // empty list is a valid credential that allows no model.
  const noModels = encodeGatewayCredential("secret", { ...credential, models: undefined } as never);
  assert.deepEqual(verifyGatewayCredential("secret", noModels, 1_000), { ok: false, reason: "invalid" });
  const badModels = encodeGatewayCredential("secret", { ...credential, models: [""] });
  assert.deepEqual(verifyGatewayCredential("secret", badModels, 1_000), { ok: false, reason: "invalid" });
  const empty = encodeGatewayCredential("secret", { ...credential, models: [] });
  assert.deepEqual(verifyGatewayCredential("secret", empty, 1_000), { ok: true, credential: { ...credential, models: [] } });
  assert.equal(MODEL_PROXY_CREDENTIAL_EXPIRED, "credential-expired");
  assert.equal(MODEL_PROXY_INVALID_CREDENTIAL, "invalid-credential");
});
