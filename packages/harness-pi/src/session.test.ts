import assert from "node:assert/strict";
import test from "node:test";
import { sessionHash, sessionParses, trimTornTail, verifySession } from "./session.ts";

test("trimTornTail drops only an unterminated final line", () => {
  assert.deepEqual(trimTornTail('{"a":1}\n{"b"'), { text: '{"a":1}\n', dropped: 4 });
  assert.deepEqual(trimTornTail('{"a":1}\n'), { text: '{"a":1}\n', dropped: 0 });
  assert.deepEqual(trimTornTail('{"a"'), { text: "", dropped: 4 });
  assert.deepEqual(trimTornTail(""), { text: "", dropped: 0 });
});

test("sessionParses rejects torn and non-object lines", () => {
  assert.equal(sessionParses('{"a":1}\n{"b":2}\n'), true);
  assert.equal(sessionParses('{"a":1}\n{"b"'), false);
  assert.equal(sessionParses("[1]\n"), false);
});

test("verifySession checks hash then structure", () => {
  const good = Buffer.from('{"a":1}\n');
  assert.deepEqual(verifySession(good, sessionHash(good)), { ok: true });
  assert.deepEqual(verifySession(good, "0".repeat(64)), { ok: false, reason: "hash-mismatch" });
  const torn = Buffer.from('{"a":1}\n{"b"');
  assert.deepEqual(verifySession(torn, sessionHash(torn)), { ok: false, reason: "unparseable" });
});
