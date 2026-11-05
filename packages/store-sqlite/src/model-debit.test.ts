import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeGatewayCredential } from "@pomtree/core";
import type { ModelCallMeta } from "@pomtree/core";
import { contract, modelDebitContractBody, tmpDir } from "@pomtree/testing";
import type { ModelDebitContractWorld } from "@pomtree/testing";
import { openStore } from "./store.ts";

const secret = "controller-secret";
const now = () => 1_000;

// The ledger row's call-metadata columns as ModelCallMeta (NULL columns omitted), read over a separate connection.
const META_COLUMNS: [keyof ModelCallMeta, string][] = [
  ["model", "model"],
  ["tokensIn", "tokens_in"],
  ["tokensOut", "tokens_out"],
  ["cacheReadTokens", "cache_read_tokens"],
  ["cacheWriteTokens", "cache_write_tokens"],
  ["upstreamStatus", "upstream_status"],
  ["latencyMs", "latency_ms"],
  ["finishReason", "finish_reason"],
  ["route", "route"],
  ["errorClass", "error_class"],
];
const callMetaOf = (file: string, agent: string, requestId: string): ModelCallMeta | null => {
  const raw = new DatabaseSync(file);
  try {
    const row = raw.prepare("SELECT * FROM model_debit_requests WHERE agent=? AND request_id=?").get(agent, requestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return Object.fromEntries(META_COLUMNS.filter(([, c]) => row[c] !== null).map(([k, c]) => [k, row[c]])) as ModelCallMeta;
  } finally {
    raw.close();
  }
};

contract<ModelDebitContractWorld>("ModelDebitStore", {
  real: () => {
    let t = 1_000;
    const clock = () => t;
    // On disk (auto-removed at exit), so the contract reads the ledger row back over a second connection.
    const file = join(tmpDir("store-debit-contract-"), "s.sqlite");
    return {
      debits: openStore(file).modelDebit({ secret, now: clock }),
      secret,
      now: clock,
      advance: (ms) => {
        t += ms;
      },
      callMeta: (agent, requestId) => callMetaOf(file, agent, requestId),
    };
  },
})("reserve/settle/cancel/authorize/revoke", modelDebitContractBody);

test("model debit store survives a reopen: reservations, spend and revocations persist", () => {
  const dir = tmpDir("store-debit-");
  const file = join(dir, "s.sqlite");
  const key = encodeGatewayCredential(secret, { agent: "a", id: "a".repeat(32), budgetMicros: 100, expiresAt: 2_000, issuedAt: 1_000, models: [] });

  let s = openStore(file);
  const r = s.modelDebit({ secret, now }).reserve(key, "r1", 40);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  s.close();

  s = openStore(file);
  const d = s.modelDebit({ secret, now });
  assert.deepEqual(d.settle(r.reservation, 10), { ok: true, chargedMicros: 10, remainingMicros: 90 });
  d.revoke("a");
  assert.equal(d.authorize(key), null);
  assert.deepEqual(d.reserve(key, "r2", 1), { ok: false, reason: "invalid-credential" });
  s.close();
});

test("reservations survive a reopen and expire once older than the cutoff", () => {
  const dir = tmpDir("store-debit-col-");
  const file = join(dir, "s.sqlite");
  const key = encodeGatewayCredential(secret, { agent: "a", id: "a".repeat(32), budgetMicros: 100, expiresAt: 2_000, issuedAt: 1_000, models: [] });
  let s = openStore(file);
  assert.equal(s.modelDebit({ secret, now }).reserve(key, "old", 40).ok, true);
  s.close();

  s = openStore(file);
  const d = s.modelDebit({ secret, now });
  assert.equal(d.expireReservations(1), 0); // created at `now`, not yet older than 1ms
  assert.equal(d.reserve(key, "new", 100).ok, false); // 40 still reserved
  s.close();
});

// Atomic issuance (`issue`) with a clock that steps backwards: the revoke cutoff is never below the latest stamp
// handed out, so no credential issued before a revoke survives it, and a post-revoke stamp is valid.
const issuedKey = (agent: string, issuedAt: number, id = "a".repeat(32)) =>
  encodeGatewayCredential(secret, { agent, id, budgetMicros: 100, expiresAt: 1_000_000, issuedAt, models: [] });

test("a backward clock step cannot resurrect a credential issued before the revoke", () => {
  let t = 10_000;
  const clock = () => t;
  const s = openStore();
  const d = s.modelDebit({ secret, now: clock });
  const before = issuedKey("a", d.issue("a", t));
  assert.ok(d.authorize(before));
  t = 5_000;
  d.revoke("a");
  assert.equal(d.authorize(before), null, "issued at 10000, revoked at a clock of 5000: killed by the high-water cutoff");
  assert.equal(d.authorize(issuedKey("a", 9_000, "b".repeat(32))), null, "any stamp at or below the high-water is dead");
  const fresh = d.issue("a", t);
  assert.ok(fresh > 10_000, "a post-revoke issue is stamped above the high-water");
  assert.ok(d.authorize(issuedKey("a", fresh, "c".repeat(32))));
  s.close();
});

test("equal stamp and cutoff are dead; the next stamp is alive", () => {
  const t = 5_000;
  const s = openStore();
  const d = s.modelDebit({ secret, now: () => t });
  const stamp = d.issue("a", t);
  d.revoke("a");
  assert.equal(d.authorize(issuedKey("a", stamp)), null);
  assert.ok(d.authorize(issuedKey("a", stamp + 1, "b".repeat(32))));
  s.close();
});

test("the issuance high-water survives a reopen: a backward clock after restart still cannot undercut it", () => {
  const dir = tmpDir("store-debit-hw-");
  const file = join(dir, "s.sqlite");
  let s = openStore(file);
  const stamp = s.modelDebit({ secret, now: () => 10_000 }).issue("a", 10_000);
  const key = issuedKey("a", stamp);
  s.close();

  s = openStore(file);
  const d = s.modelDebit({ secret, now: () => 5_000 });
  d.revoke("a");
  assert.equal(d.authorize(key), null, "the pre-restart credential is dead after a revoke at a lower clock");
  const resumed = d.issue("a", 5_000);
  assert.ok(resumed > stamp, "a post-restart issue at a lower clock is still above the cutoff");
  assert.ok(d.authorize(issuedKey("a", resumed, "b".repeat(32))));
  s.close();
});

test("repeated synthetic issue and revoke cycles at one instant keep only the latest credential alive", () => {
  const t = 1_000;
  const s = openStore();
  const d = s.modelDebit({ secret, now: () => t });
  const keys: string[] = [];
  for (let i = 0; i < 25; i++) {
    const stamp = d.issue("a", t);
    keys.push(issuedKey("a", stamp, i.toString(16).padStart(32, "0")));
    assert.ok(d.authorize(keys.at(-1)!), `cycle ${i} alive before its revoke`);
    d.revoke("a");
    assert.equal(d.authorize(keys.at(-1)!), null, `cycle ${i} dead after its revoke`);
  }
  for (const k of keys) assert.equal(d.authorize(k), null);
  assert.equal(d.spentFor("a"), 0);
  s.close();
});

test("two handles on one file interleave issue and revoke without a stale floor", () => {
  const dir = tmpDir("store-debit-two-");
  const file = join(dir, "s.sqlite");
  const s1 = openStore(file);
  const s2 = openStore(file);
  const a = s1.modelDebit({ secret, now: () => 10_000 });
  const b = s2.modelDebit({ secret, now: () => 5_000 });
  const early = issuedKey("a", a.issue("a", 10_000));
  b.revoke("a"); // revoke from the other handle, at a lower clock
  assert.equal(a.authorize(early), null, "a stamp issued on the other handle before the revoke is dead");
  const late = a.issue("a", 5_000);
  assert.ok(b.authorize(issuedKey("a", late)), "the other handle sees the post-revoke stamp as alive");
  assert.equal(b.authorize(early), null);
  s1.close();
  s2.close();
});

test("a revoke at MAX_SAFE_INTEGER makes the next stamp unsafe: issue throws, persists nothing, other agents unaffected", () => {
  const dir = tmpDir("store-debit-max-");
  const file = join(dir, "s.sqlite");
  const s = openStore(file);
  const d = s.modelDebit({ secret, now: () => Number.MAX_SAFE_INTEGER });
  d.revoke("a"); // cutoff = MAX_SAFE_INTEGER
  assert.throws(() => d.issue("a", Number.MAX_SAFE_INTEGER), /safe integer/); // revoked_at + 1 is unsafe
  assert.equal(s.modelDebit({ secret, now: () => 1 }).authorize(issuedKey("a", Number.MAX_SAFE_INTEGER)), null, "no credential survives");
  const b = d.issue("b", 1_000);
  assert.equal(b, 1_000, "another agent still issues normally");
  const reader = s.modelDebit({ secret, now: () => 1 }); // decode clock below expiresAt
  assert.ok(reader.authorize(issuedKey("b", b)));
  assert.throws(() => d.issue("a", 1_000), /safe integer/, "the failed agent stays fail-closed");
  s.close();
  const reopened = openStore(file);
  assert.throws(() => reopened.modelDebit({ secret, now: () => 1 }).issue("a", 1_000), /safe integer/, "refusal persists across reopen");
  assert.equal(reopened.modelDebit({ secret, now: () => 1 }).issue("b", 2_000), 2_000);
  reopened.close();
});

test("issue rejects a non-integer clock", () => {
  const s = openStore();
  assert.throws(() => s.modelDebit({ secret, now: () => 1 }).issue("a", 1.5), /safe integer/);
  s.close();
});

test("recordCall joins model, tokens, status, latency and finish reason to the call's ledger row without changing spend", () => {
  const dir = tmpDir("store-debit-meta-");
  const file = join(dir, "s.sqlite");
  const key = encodeGatewayCredential(secret, { agent: "a", id: "a".repeat(32), budgetMicros: 100, expiresAt: 2_000, issuedAt: 1_000, models: [] });
  const s = openStore(file);
  const d = s.modelDebit({ secret, now });
  const r = d.reserve(key, "r1", 40);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(d.recordCall("a", "nope", { model: "m" }), false, "unknown request id");
  assert.deepEqual(d.settle(r.reservation, 10), { ok: true, chargedMicros: 10, remainingMicros: 90 });
  const meta = { model: "m1", tokensIn: 7, tokensOut: 3, cacheReadTokens: 5, cacheWriteTokens: 2, upstreamStatus: 200, latencyMs: 12, finishReason: "stop" };
  assert.equal(d.recordCall("a", "r1", meta), true);
  assert.equal(d.recordCall("a", "r1", meta), true, "replay rewrites the same values");
  assert.equal(d.spentFor("a"), 10, "metadata never moves spend");
  s.close();
  const raw = new DatabaseSync(file);
  const row = raw.prepare("SELECT * FROM model_debit_requests WHERE agent='a' AND request_id='r1'").get() as Record<string, unknown>;
  raw.close();
  assert.deepEqual(
    {
      model: row.model,
      in: row.tokens_in,
      out: row.tokens_out,
      st: row.upstream_status,
      ms: row.latency_ms,
      fr: row.finish_reason,
      cr: row.cache_read_tokens,
      cw: row.cache_write_tokens,
      at: row.settled_at,
      c: row.charged_micros,
    },
    { model: "m1", in: 7, out: 3, st: 200, ms: 12, fr: "stop", cr: 5, cw: 2, at: 1_000, c: 10 },
  );
});

test("recordCall stores the pricing basis on the call's ledger row, and a call recorded without one leaves it null", () => {
  const dir = tmpDir("store-debit-basis-");
  const file = join(dir, "s.sqlite");
  const key = encodeGatewayCredential(secret, { agent: "a", id: "a".repeat(32), budgetMicros: 100, expiresAt: 2_000, issuedAt: 1_000, models: [] });
  const s = openStore(file);
  const d = s.modelDebit({ secret, now });
  for (const id of ["r1", "r2"]) {
    const r = d.reserve(key, id, 10);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(d.settle(r.reservation, 5).ok, true);
  }
  assert.equal(d.recordCall("a", "r1", { model: "m", basis: "reported" }), true);
  assert.equal(d.recordCall("a", "r2", { model: "m" }), true);
  s.close();
  const raw = new DatabaseSync(file);
  const basisOf = (id: string) => (raw.prepare("SELECT basis FROM model_debit_requests WHERE agent='a' AND request_id=?").get(id) as { basis: unknown }).basis;
  const got = [basisOf("r1"), basisOf("r2")];
  raw.close();
  assert.deepEqual(got, ["reported", null]);
});

test("recordCall joins status and latency to a cancelled call's row, leaving tokens null and spend untouched", () => {
  const dir = tmpDir("store-debit-cancel-");
  const file = join(dir, "s.sqlite");
  const key = encodeGatewayCredential(secret, { agent: "a", id: "a".repeat(32), budgetMicros: 100, expiresAt: 2_000, issuedAt: 1_000, models: [] });
  const s = openStore(file);
  const d = s.modelDebit({ secret, now });
  const r = d.reserve(key, "r1", 40);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(d.cancel(r.reservation), true);
  assert.equal(d.recordCall("a", "r1", { model: "m1", upstreamStatus: 404, latencyMs: 12 }), true);
  assert.equal(d.spentFor("a"), 0);
  s.close();
  const raw = new DatabaseSync(file);
  const row = raw.prepare("SELECT * FROM model_debit_requests WHERE agent='a' AND request_id='r1'").get() as Record<string, unknown>;
  raw.close();
  assert.deepEqual(
    { status: row.status, model: row.model, in: row.tokens_in, out: row.tokens_out, st: row.upstream_status, ms: row.latency_ms, c: row.charged_micros },
    { status: "cancelled", model: "m1", in: null, out: null, st: 404, ms: 12, c: null },
  );
});

test("cancel stamps settled_at, so a cancelled or failed call's row carries when it ended", () => {
  const dir = tmpDir("store-debit-cancel-at-");
  const file = join(dir, "s.sqlite");
  let t = 1_000;
  const key = encodeGatewayCredential(secret, { agent: "a", id: "a".repeat(32), budgetMicros: 100, expiresAt: 5_000, issuedAt: 1_000, models: [] });
  const s = openStore(file);
  const d = s.modelDebit({ secret, now: () => t });
  const r = d.reserve(key, "r1", 40);
  assert.ok(r.ok);
  if (!r.ok) return;
  t = 1_250;
  assert.equal(d.cancel(r.reservation), true);
  t = 1_900;
  assert.equal(d.cancel(r.reservation), false, "a second cancel is refused");
  s.close();
  const raw = new DatabaseSync(file);
  const row = raw.prepare("SELECT status, settled_at, charged_micros FROM model_debit_requests WHERE agent='a' AND request_id='r1'").get() as Record<
    string,
    unknown
  >;
  raw.close();
  assert.deepEqual({ ...row }, { status: "cancelled", settled_at: 1_250, charged_micros: null }, "stamped at the cancel, not moved by the refused replay");
});
