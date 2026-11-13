import assert from "node:assert/strict";
import { test } from "node:test";
import { type LiveGateInput, liveSkip } from "./live-gate.ts";

const FILE = "/secrets/e2b.key";
const GOOD = { mode: 0o100600, size: 12, isFile: true };

// A scripted gate input plus a stub standing in for the vendor call; `act` runs only when the gate passes.
function rig(env: Record<string, string>, stat: ReturnType<LiveGateInput["stat"]> | null = GOOD) {
  const calls: string[] = [];
  const input: LiveGateInput = { env, credentials: ["API_KEY"], stat: (p) => (p === FILE ? (stat ?? undefined) : undefined) };
  const act = (provider: string, ceiling: number): string | false => {
    const skip = liveSkip(provider, ceiling, input);
    if (skip === false) calls.push(provider);
    return skip;
  };
  return { calls, act };
}

const ENABLED = { PTREE_LIVE_PROVIDERS: "e2b", PTREE_LIVE_MAX_MICROS: "500000", POMTREED_SANDBOX_E2B_API_KEY_FILE: FILE };

test("live gate control: opted in, 0600 file, cap at the ceiling passes and the stub is called", () => {
  const r = rig(ENABLED);
  assert.equal(r.act("e2b", 500000), false);
  assert.deepEqual(r.calls, ["e2b"]);
});

test("live gate control: contributed ids are accepted alongside built-ins, whitespace tolerated", () => {
  const r = rig({ ...ENABLED, PTREE_LIVE_PROVIDERS: "docker, acme-cloud", POMTREED_SANDBOX_ACME_CLOUD_API_KEY_FILE: FILE });
  assert.equal(r.act("acme-cloud", 1), false);
  assert.deepEqual(r.calls, ["acme-cloud"]);
});

test("live gate NEG: credentials alone do not enable; zero calls", () => {
  const { PTREE_LIVE_PROVIDERS: _omit, ...env } = ENABLED;
  const r = rig(env);
  assert.match(String(r.act("e2b", 1)), /credentials alone do not enable/);
  assert.equal(r.calls.length, 0);
});

test("live gate NEG: another provider listed does not enable this one", () => {
  const r = rig({ ...ENABLED, PTREE_LIVE_PROVIDERS: "modal" });
  assert.match(String(r.act("e2b", 1)), /does not list e2b/);
  assert.equal(r.calls.length, 0);
});

test("live gate NEG: credential file with mode 0644 is refused with cause and fix", () => {
  const r = rig(ENABLED, { ...GOOD, mode: 0o100644 });
  const why = String(r.act("e2b", 1));
  assert.match(why, /readable by group\/other/);
  assert.match(why, /chmod 600/);
  assert.equal(r.calls.length, 0);
});

test("live gate NEG: cap below the ceiling is refused with cause and fix", () => {
  const r = rig({ ...ENABLED, PTREE_LIVE_MAX_MICROS: "100" });
  const why = String(r.act("e2b", 500000));
  assert.match(why, /500000 micros exceeds PTREE_LIVE_MAX_MICROS=100/);
  assert.match(why, /raise the cap/);
  assert.equal(r.calls.length, 0);
});

test("live gate NEG: `all` is refused even with credentials and a cap", () => {
  const r = rig({ ...ENABLED, PTREE_LIVE_PROVIDERS: "all" });
  assert.match(String(r.act("e2b", 1)), /"all", which is not accepted/);
  assert.equal(r.calls.length, 0);
  assert.match(String(rig({ ...ENABLED, PTREE_LIVE_PROVIDERS: "e2b,all" }).act("e2b", 1)), /not accepted/);
});

test("live gate NEG: unset or malformed cap, missing, relative, empty or raw credentials fail closed and are listed together", () => {
  const { PTREE_LIVE_MAX_MICROS: _cap, ...noCap } = ENABLED;
  assert.match(String(rig(noCap).act("e2b", 1)), /PTREE_LIVE_MAX_MICROS is unset/);
  assert.match(String(rig({ ...ENABLED, PTREE_LIVE_MAX_MICROS: "$5" }).act("e2b", 1)), /not a whole number/);
  const { POMTREED_SANDBOX_E2B_API_KEY_FILE: _f, ...noFile } = ENABLED;
  assert.match(String(rig(noFile).act("e2b", 1)), /POMTREED_SANDBOX_E2B_API_KEY_FILE is unset/);
  assert.match(String(rig({ ...ENABLED, POMTREED_SANDBOX_E2B_API_KEY_FILE: "rel/key" }).act("e2b", 1)), /not an absolute path/);
  assert.match(String(rig(ENABLED, null).act("e2b", 1)), /not an existing regular file/);
  assert.match(String(rig(ENABLED, { ...GOOD, size: 0 }).act("e2b", 1)), /is empty/);
  assert.match(String(rig({ ...ENABLED, POMTREED_SANDBOX_E2B_API_KEY: "k" }).act("e2b", 1)), /raw key/);
  const both = String(rig({ ...ENABLED, PTREE_LIVE_MAX_MICROS: "1" }, { ...GOOD, mode: 0o100666 }).act("e2b", 9));
  assert.match(both, /exceeds/);
  assert.match(both, /group\/other/);
});

test("live gate NEG: a ceiling that is not a non-negative whole number is refused, never passed", () => {
  for (const bad of [Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY]) {
    const r = rig(ENABLED);
    const why = String(r.act("e2b", bad));
    assert.match(why, /declared ceiling .* is not a non-negative whole number of micros/, `ceiling ${bad}`);
    assert.match(why, /fix the test's ceiling/);
    assert.equal(r.calls.length, 0, `ceiling ${bad}`);
  }
});

test("live gate NEG: no declared credentials is a wiring bug and fails closed", () => {
  const calls: string[] = [];
  const skip = liveSkip("e2b", 1, { env: ENABLED, credentials: [], stat: () => GOOD });
  if (skip === false) calls.push("e2b");
  assert.match(String(skip), /declares no credentials/);
  assert.match(String(skip), /declare the credential names/);
  assert.equal(calls.length, 0);
});

test("live gate NEG: a directory or a mode 0777 file is refused", () => {
  assert.match(String(rig(ENABLED, { ...GOOD, isFile: false }).act("e2b", 1)), /not an existing regular file/);
  assert.match(String(rig(ENABLED, { ...GOOD, mode: 0o100777 }).act("e2b", 1)), /readable by group\/other/);
});

test("live gate NEG: the refusal never carries the credential file's size", () => {
  const why = String(rig(ENABLED, { mode: 0o100644, size: 987654, isFile: true }).act("e2b", 1));
  assert.match(why, /group\/other/);
  assert.doesNotMatch(why, /987654/);
});
