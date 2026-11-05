import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChannelRegistry, messagingSendersError } from "./channels.ts";

test("zero channels is a valid registry: only cli and ui entries", () => {
  const r = buildChannelRegistry([], []);
  assert.deepEqual(
    r.entries().map((e) => e.name),
    ["cli", "ui"],
  );
  assert.deepEqual(r.get("cli"), { name: "cli", kind: "operator", rank: "operator", inbound: true, outbound: false });
  assert.deepEqual(r.get("ui"), { name: "ui", kind: "in-daemon", rank: "operator", inbound: false, outbound: false });
  assert.deepEqual(r.outbound(), []);
  assert.equal(r.hasOutbound(), false);
  assert.deepEqual(r.chat(), []);
});

test("default registry (ui escalation only) is ui inbound and outbound, no chat", () => {
  const r = buildChannelRegistry([], ["ui"]);
  assert.deepEqual(r.get("ui"), { name: "ui", kind: "in-daemon", rank: "operator", inbound: true, outbound: true });
  assert.deepEqual(r.outbound(), ["ui"]);
  assert.equal(r.hasOutbound(), true);
  assert.deepEqual(r.chat(), []);
});

test("adapter channel: chat rank, inbound and outbound, order preserved", () => {
  const r = buildChannelRegistry(["discord"], ["ui", "discord"]);
  assert.deepEqual(r.get("discord"), { name: "discord", kind: "adapter", rank: "chat", inbound: true, outbound: true });
  assert.deepEqual(r.outbound(), ["ui", "discord"]);
  for (const n of ["cli", "ui", "discord"]) assert.ok(r.inbound().includes(n), n);
  assert.deepEqual(
    r.chat().map((e) => e.name),
    ["discord"],
  );
});

test("messaging-only adapter is inbound, not outbound, and is chat", () => {
  const r = buildChannelRegistry(["slack"], []);
  const s = r.get("slack");
  assert.ok(s);
  assert.equal(s.inbound, true);
  assert.equal(s.outbound, false);
  assert.equal(r.hasOutbound(), false);
  assert.deepEqual(
    r.chat().map((e) => e.name),
    ["slack"],
  );
});

test("reserved channel names are rejected", () => {
  assert.throws(() => buildChannelRegistry(["cli"], []), /reserved/);
  assert.throws(() => buildChannelRegistry(["operator"], []), /reserved/);
  assert.throws(() => buildChannelRegistry([], ["cli"]), /reserved/);
});

test("messagingSendersError: null without chat channels, regardless of senders being empty", () => {
  const empty = new Set<string>();
  assert.equal(messagingSendersError(buildChannelRegistry([], []), empty), null);
  assert.equal(messagingSendersError(buildChannelRegistry([], ["ui"]), empty), null);
  assert.equal(messagingSendersError(buildChannelRegistry([], []), empty), null);
});

test("messagingSendersError: fails closed with empty senders when a chat channel is enabled", () => {
  const empty = new Set<string>();
  const asMessaging = messagingSendersError(buildChannelRegistry(["discord"], []), empty);
  assert.equal(typeof asMessaging, "string");
  assert.match(asMessaging as string, /POMTREED_MESSAGING_SENDERS/);
  assert.match(asMessaging as string, /discord/);
  const asEscalation = messagingSendersError(buildChannelRegistry([], ["discord"]), empty);
  assert.equal(typeof asEscalation, "string");
  assert.match(asEscalation as string, /discord/);
});

test("messagingSendersError: null once senders are non-empty", () => {
  assert.equal(messagingSendersError(buildChannelRegistry(["discord"], ["ui", "discord"]), new Set(["discord:u1"])), null);
});

test("reserved names are refused case-insensitively; ui is only the in-daemon channel", () => {
  for (const n of ["CLI", "Cli", "Operator", "OPERATOR", "oPeRaToR"]) assert.throws(() => buildChannelRegistry([n], []), /reserved/, n);
  for (const n of ["Ui", "UI"]) assert.throws(() => buildChannelRegistry([], [n]), /reserved/, n);
  assert.equal(buildChannelRegistry(["ui"], []).get("ui")?.kind, "in-daemon");
});

test("channel names must match the token charset; the error names the offending value", () => {
  for (const n of ["a b", "a:b", "a.b", "a/b", "", "é"])
    assert.throws(() => buildChannelRegistry([n], []), new RegExp(`invalid channel ${JSON.stringify(n).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`), n);
  assert.doesNotThrow(() => buildChannelRegistry(["discord-2_x"], []));
});

test("messagingSendersError: every entry must be channel:sender", () => {
  const r = buildChannelRegistry(["discord"], []);
  assert.match(messagingSendersError(r, new Set(["nocolon"])) ?? "", /refusing to start: .*"nocolon".*channel:sender/);
  assert.match(messagingSendersError(r, new Set([":u1"])) ?? "", /channel:sender/);
  assert.match(messagingSendersError(r, new Set(["discord:"])) ?? "", /channel:sender/);
  assert.equal(messagingSendersError(r, new Set(["discord:u1"])), null);
});
