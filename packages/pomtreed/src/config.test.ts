import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertLoopbackOrAllowed,
  checkStateDir,
  isLoopbackHost,
  isLoopbackListenHost,
  parseListen,
  publishScanEnabled,
  publishScanWarning,
  shortHash,
  stamp,
  statePolicyFromEnv,
  uiChannelWarning,
} from "./config.ts";
import { buildChannelRegistry } from "./channels.ts";
import { evaluateReadiness } from "./health.ts";

test("parseListen is strict host:port with IPv6 brackets", () => {
  assert.deepEqual(parseListen("N", "127.0.0.1:8787"), { host: "127.0.0.1", port: 8787 });
  assert.deepEqual(parseListen("N", "[::1]:0"), { host: "::1", port: 0 });
  assert.equal(parseListen("N", "off", { allowOff: true }), null);
  for (const bad of ["off", "8787", "localhost", ":80", "host:", "host:abc", "host:70000", "::1:80", "[::1]", "[127.0.0.1]:80", "a:b:80"]) {
    assert.throws(() => parseListen("N", bad), /invalid N=/, bad);
  }
});

test("non-loopback binds are refused unless opted in", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("10.0.0.5"), false);
  assert.throws(() => assertLoopbackOrAllowed("POMTREED_UI_LISTEN", { host: "0.0.0.0", port: 1 }, false), /POMTREED_LISTEN_ALLOW_NONLOOPBACK/);
  assertLoopbackOrAllowed("POMTREED_UI_LISTEN", { host: "0.0.0.0", port: 1 }, true);
  assertLoopbackOrAllowed("POMTREED_UI_LISTEN", { host: "127.0.0.1", port: 1 }, false);
});

test("isLoopbackListenHost accepts bracketed and bare loopback, refuses the rest", () => {
  assert.equal(isLoopbackListenHost("[::1]"), true);
  assert.equal(isLoopbackListenHost("::1"), true);
  assert.equal(isLoopbackListenHost("127.0.0.1"), true);
  assert.equal(isLoopbackListenHost("10.0.0.5"), false);
  assert.equal(isLoopbackListenHost("[fe80::1]"), false);
  assert.equal(isLoopbackListenHost("[::]"), false);
});

test("checkStateDir requires an owned directory and asks for chmod when not 0700", () => {
  assert.deepEqual(checkStateDir("/s", { isDirectory: true, uid: 5, mode: 0o40700 }, 5), { chmod: false });
  assert.deepEqual(checkStateDir("/s", { isDirectory: true, uid: 5, mode: 0o40755 }, 5), { chmod: true });
  assert.throws(() => checkStateDir("/s", { isDirectory: true, uid: 6, mode: 0o40700 }, 5), /owned by uid 6/);
  assert.throws(() => checkStateDir("/s", { isDirectory: false, uid: 5, mode: 0o100600 }, 5), /not a directory/);
});

test("helpers: shortHash is bounded, stamp is ISO, ui warning only when ui channel has no listener", () => {
  assert.equal(shortHash("x".repeat(10000), (s) => `${"a".repeat(64)}${s.length}`).length, 16);
  assert.equal(stamp("m", new Date(0)), "1970-01-01T00:00:00.000Z m");
  const ui = buildChannelRegistry([], ["ui"]);
  assert.match(uiChannelWarning(ui, "off") ?? "", /POMTREED_UI_LISTEN is off/);
  assert.equal(uiChannelWarning(ui, "127.0.0.1:1"), null);
  assert.equal(uiChannelWarning(buildChannelRegistry([], ["discord"]), "off"), null);
  assert.equal(uiChannelWarning(buildChannelRegistry([], []), "off"), null);
});

test("evaluateReadiness: store, degraded latch and sandbox, with explicit sandbox-down allowance", () => {
  const ok = { storeOpen: true, sandboxUp: true, journalFailed: false, degraded: false };
  assert.equal(evaluateReadiness(ok).ready, true);
  assert.deepEqual(evaluateReadiness({ ...ok, storeOpen: false }).reasons, ["store unavailable"]);
  assert.equal(evaluateReadiness({ ...ok, degraded: true }).ready, false);
  assert.equal(evaluateReadiness({ ...ok, sandboxUp: false }).ready, false);
  assert.equal(evaluateReadiness({ ...ok, sandboxUp: false }, { allowSandboxDown: true }).ready, true);
  assert.equal(evaluateReadiness({ ...ok, sandboxUp: false, degraded: true }, { allowSandboxDown: true }).ready, false);
});

test('publish content scan is on by default and only the exact string "0" disables it', () => {
  assert.equal(publishScanEnabled({}), true);
  assert.equal(publishScanEnabled({ POMTREED_PUBLISH_SCAN: "1" }), true);
  assert.equal(publishScanEnabled({ POMTREED_PUBLISH_SCAN: "" }), true);
  assert.equal(publishScanEnabled({ POMTREED_PUBLISH_SCAN: "false" }), true);
  assert.equal(publishScanEnabled({ POMTREED_PUBLISH_SCAN: "0" }), false);
  assert.equal(publishScanWarning(false)?.includes("POMTREED_PUBLISH_SCAN"), true);
  assert.equal(publishScanWarning(true), null);
});

test("statePolicyFromEnv: unset or blank means no grants and default limits; malformed input throws", () => {
  assert.deepEqual(statePolicyFromEnv({}).grantsFor("x/y"), []);
  assert.deepEqual(statePolicyFromEnv({ POMTREED_STATE_GRANTS: " ", POMTREED_STATE_LIMITS: "" }).grantsFor("x/y"), []);
  const p = statePolicyFromEnv({ POMTREED_STATE_GRANTS: '{"x/y":[{"owner":"x","mode":"rw"}]}', POMTREED_STATE_LIMITS: '{"owners":{"x":{"maxDocs":5}}}' });
  assert.equal(p.grantsFor("x/y").length, 1);
  assert.equal(p.limitsFor("x").maxDocs, 5);
  assert.throws(() => statePolicyFromEnv({ POMTREED_STATE_GRANTS: "{" }), /POMTREED_STATE_GRANTS/);
});

// The boot wiring in main.ts is statePolicyFromEnv(env) then policy.validate(known): an unknown owner, driver or template refuses the start.
test("state policy boot: unknown owner, driver, template or limit owner fail closed; valid grants and blank env boot", async () => {
  const known = { owners: ["hn-digest"], drivers: ["hn-digest/flow"], template: async (id: string) => (id === "reader" ? { id } : null) };
  const boot = (env: Record<string, string>) => statePolicyFromEnv(env).validate(known);
  await boot({});
  await boot({ POMTREED_STATE_GRANTS: " ", POMTREED_STATE_LIMITS: "" });
  await boot({
    POMTREED_STATE_GRANTS: '{"hn-digest/flow":[{"owner":"hn-digest","mode":"rw"}],"reader":[{"owner":"operator","mode":"r"}]}',
    POMTREED_STATE_LIMITS: '{"owners":{"hn-digest":{"maxDocs":5}}}',
  });
  await assert.rejects(boot({ POMTREED_STATE_GRANTS: '{"hn-digest/flow":[{"owner":"ghost","mode":"r"}]}' }), /unknown owner/);
  await assert.rejects(boot({ POMTREED_STATE_GRANTS: '{"other/flow":[{"owner":"hn-digest","mode":"r"}]}' }), /unregistered driver/);
  await assert.rejects(boot({ POMTREED_STATE_GRANTS: '{"nope":[{"owner":"hn-digest","mode":"r"}]}' }), /unknown template/);
  await assert.rejects(boot({ POMTREED_STATE_LIMITS: '{"owners":{"ghost":{"maxDocs":5}}}' }), /unknown owner/);
});
