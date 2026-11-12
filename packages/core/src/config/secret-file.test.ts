import assert from "node:assert/strict";
import test from "node:test";
import { CONFIG_REGISTRY, resolveConfig, secretFileModeReason } from "../index.ts";

test("secretFileModeReason refuses every group or other bit with the cause and the chmod action, and accepts owner-only modes", () => {
  for (const mode of [0o100644, 0o100640, 0o100604, 0o100660, 0o100666, 0o100607, 0o100670, 0o100601]) {
    const why = secretFileModeReason("/etc/pomtree/key", { mode });
    assert.match(why ?? "", /\/etc\/pomtree\/key is readable by group\/other; run chmod 600 \/etc\/pomtree\/key/, mode.toString(8));
  }
  for (const mode of [0o100600, 0o100400, 0o100200, 0o100000, 0o600, 0o400]) assert.equal(secretFileModeReason("/k", { mode }), null, mode.toString(8));
});

test("secretFileModeReason refuses a mode that is not a stat mode", () => {
  for (const mode of [Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY]) assert.match(secretFileModeReason("/k", { mode }) ?? "", /unreadable mode/);
});

test("a 0644 secret file is refused by resolveConfig through the shared rule, without reading it; 0600 is read", () => {
  let reads = 0;
  const input = (mode: number) => ({
    env: { POMTREED_MODEL_UPSTREAM_KEY_FILE: "/run/secrets/upstream" },
    readFile: () => {
      reads++;
      return "s3cret\n";
    },
    fileMode: () => mode,
  });
  const bad = resolveConfig(CONFIG_REGISTRY, input(0o100644));
  assert.ok(!bad.ok);
  assert.match(bad.errors.join(), /readable by group\/other; run chmod 600 \/run\/secrets\/upstream/);
  assert.equal(reads, 0, "a refused file is never read");
  const good = resolveConfig(CONFIG_REGISTRY, input(0o100600));
  assert.ok(good.ok);
  assert.equal(reads, 1);
});
