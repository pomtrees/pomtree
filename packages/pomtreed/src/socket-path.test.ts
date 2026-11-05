import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SOCKET_PATH, resolveSocketPath } from "./socket-path.ts";

test("a short path is used as given", () => {
  assert.deepEqual(resolveSocketPath("/tmp/x/pomtreed.sock", "/tmp"), { path: "/tmp/x/pomtreed.sock", fellBack: false });
});

test("a path over the limit falls back to a short, deterministic tmpdir path", () => {
  const long = `/${"a".repeat(MAX_SOCKET_PATH)}/pomtreed.sock`;
  const r = resolveSocketPath(long, "/tmp");
  assert.equal(r.fellBack, true);
  assert.match(r.path, /^\/tmp\/pomtreed-[0-9a-f]{10}\/pomtreed\.sock$/);
  assert.ok(Buffer.byteLength(r.path) <= MAX_SOCKET_PATH);
  assert.equal(resolveSocketPath(long, "/tmp").path, r.path);
  assert.notEqual(resolveSocketPath(`${long}2`, "/tmp").path, r.path);
});

test("fails clearly when even the fallback is too long", () => {
  const long = `/${"a".repeat(MAX_SOCKET_PATH)}/pomtreed.sock`;
  assert.throws(() => resolveSocketPath(long, `/${"t".repeat(MAX_SOCKET_PATH)}`), /also too long.*POMTREED_SOCKET_PATH/);
});

test("the limit is measured in bytes, not characters", () => {
  const wide = `/${"é".repeat(60)}/s`; // 60 chars, ~124 bytes
  assert.equal(resolveSocketPath(wide, "/tmp").fellBack, true);
});
