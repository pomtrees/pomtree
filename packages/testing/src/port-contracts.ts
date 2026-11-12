import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  AgentId,
  ApprovalStore,
  CaptureArtifact,
  CaptureIndex,
  CaptureOutcome,
  CaptureRecord,
  NewCaptureJob,
  HarnessEvent,
  HarnessSession,
  Harness,
  Journal,
  JournalEntry,
  Mailbox,
  ModelGateway,
  Placement,
  QuotaCounters,
  Registry,
  SandboxHandle,
  Signal,
  SpawnSpec,
  StateLimits,
  StateStore,
  SessionStore,
  Template,
  TemplateStore,
  WatchdogState,
  WatchdogStore,
} from "@pomtree/core";
import {
  POMTREED_KINDS,
  RootWithdrawalError,
  StaleGenerationError,
  StateError,
  boundToolDetails,
  captureFailure,
  captureJobIdOf,
  IdempotencyConflictError,
  negativeTtlMs,
} from "@pomtree/core";
import { ISSUE_REFUSAL } from "./fakes.ts";

// Shared contract bodies for the ports whose fakes lacked one. Each body is adapter-agnostic: run it through
// `contract(port, { fake, real? })` (see fakes.ts). A body asserts only what the port interface and core docs
// promise; where adapters legitimately differ (strict vs lenient, validation wording) it accepts either outcome.

const SPEC = { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" } } as SpawnSpec;

// ---- Registry root pool (setRootPool) and provider attempts -------------------------------------------------------

// TODO(conformance-suites): package the port and merge contract bodies as documented conformance suites. Current behavior:
// they are exported *ContractBody functions with no packaged suite wrapper (only messagingWireSuite is packaged).
// The operator's root-pool movement: applied and journaled together, a withdrawal capped at the unheld remainder and refused
// in full beyond it, an unchanged target a no-op. Runs over JournalAppendContractWorld (a registry and its journal).
export async function registryRootPoolContractBody(w: JournalAppendContractWorld): Promise<void> {
  const { journal: j, registry: r } = w;
  const root = await r.create({ parent: null, name: "root", task: "t", host: "h", budgetMicros: 1_000, idempotencyKey: "rp-root", spec: SPEC });
  const child = await r.create({ parent: root.id, name: "c", task: "t", host: "h", budgetMicros: 300, idempotencyKey: "rp-c", spec: SPEC });
  const moves = async () =>
    (await j.read({ agent: root.id }))
      .map((e) => e.payload as unknown as Record<string, unknown>)
      .filter((p) => p.kind === POMTREED_KINDS.budgetTopUp || p.kind === POMTREED_KINDS.budgetWithdrawal);

  const same = await r.setRootPool(root.id, 1_000, "rp-same");
  assert.equal(same.entry, null);
  assert.equal(same.record.budgetMicros, 1_000);

  const up = await r.setRootPool(root.id, 1_500, "rp-up");
  assert.equal(up.record.budgetMicros, 1_500);
  assert.deepEqual(up.entry?.payload, { kind: POMTREED_KINDS.budgetTopUp, from: 1_000, to: 1_500, by: "operator" });
  // An absolute set: repeating it after it applied changes and journals nothing.
  assert.equal((await r.setRootPool(root.id, 1_500, "rp-up-again")).entry, null);

  // 300 carved to the child: at most 1200 can leave. 1500 -> 300 asks for 1200, which fits exactly.
  const down = await r.setRootPool(root.id, 300, "rp-down");
  assert.equal(down.record.budgetMicros, 300);
  assert.deepEqual(down.entry?.payload, { kind: POMTREED_KINDS.budgetWithdrawal, from: 1_500, to: 300, by: "operator" });

  // Now nothing is unheld: any further withdrawal is refused in full, never clipped, and nothing changes or is journaled.
  const err = await r.setRootPool(root.id, 299, "rp-over").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof RootWithdrawalError, String(err));
  assert.equal(err.requestedMicros, 1);
  assert.equal(err.heldMicros, 300);
  assert.equal(err.availableMicros, 0);
  assert.match(err.message, /withdraws 1 micros.*300 are held.*only 0 are available.*nothing was withdrawn/);
  assert.equal((await r.get(root.id))?.budgetMicros, 300);
  assert.deepEqual(
    (await moves()).map((p) => p.kind),
    [POMTREED_KINDS.budgetTopUp, POMTREED_KINDS.budgetWithdrawal],
  );

  // A reaped child returns its unused carve, which can then be withdrawn.
  await r.transition(child.id, 0, "running", { idempotencyKey: "rp-c-run" });
  await r.transition(child.id, 0, "exited", { exit: "succeeded", idempotencyKey: "rp-c-exit" });
  await r.transition(child.id, 0, "reaped", { idempotencyKey: "rp-c-reap" });
  assert.equal((await r.setRootPool(root.id, 0, "rp-all")).record.budgetMicros, 0);

  // Only a root's pool moves, and only to a non-negative safe integer; neither throw writes anything.
  const kid = await r.create({ parent: root.id, name: "k", task: "t", host: "h", budgetMicros: 0, idempotencyKey: "rp-k", spec: SPEC });
  await assert.rejects(r.setRootPool(kid.id, 10, "rp-kid"), /not a root/);
  await assert.rejects(r.setRootPool(root.id, -1, "rp-neg"), /non-negative safe integer/);
  await assert.rejects(r.setRootPool(root.id, 1.5, "rp-frac"), /non-negative safe integer/);
  assert.equal((await moves()).length, 3);
}

// The provider retry ladder's durable count: bump adds one per key (a replayed key adds nothing), reset clears it, per agent.
export async function registryProviderAttemptsContractBody(w: JournalAppendContractWorld): Promise<void> {
  const { registry: r } = w;
  const a = await r.create({ parent: null, name: "pa", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "pa-a", spec: SPEC });
  const b = await r.create({ parent: null, name: "pb", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "pb-b", spec: SPEC });
  assert.equal(await r.bumpProviderAttempts(a.id, "pa:0"), 1);
  assert.equal(await r.bumpProviderAttempts(a.id, "pa:0"), 1, "a replayed key returns its first count and adds nothing");
  assert.equal(await r.bumpProviderAttempts(a.id, "pa:1"), 2);
  assert.equal(await r.bumpProviderAttempts(b.id, "pb:0"), 1, "counts are per agent");
  await r.resetProviderAttempts(a.id);
  await r.resetProviderAttempts(a.id);
  assert.equal(await r.bumpProviderAttempts(a.id, "pa:2"), 1, "a reset starts the ladder over");
  assert.equal(await r.bumpProviderAttempts(b.id, "pb:1"), 2);
  await assert.rejects(r.bumpProviderAttempts("nobody", "pn:0"));
  await assert.rejects(r.resetProviderAttempts("nobody"));
}

// ---- Idempotency-key conflicts -----------------------------------------------------------------------------------------

export interface IdempotencyConflictContractWorld {
  registry: Registry;
  mailbox: Mailbox;
  approvals: ApprovalStore;
}

// A key replayed with the same request returns the first result; replayed with a different request it rejects with IdempotencyConflictError
// (scope = the operation) and changes nothing. Covers the operations whose durable store fingerprints its keys: registry create and
// raiseBudget, mailbox send, approval decide.
export async function idempotencyConflictContractBody(w: IdempotencyConflictContractWorld): Promise<void> {
  const { registry, mailbox, approvals } = w;
  const conflict = (scope: string, key: string) => (e: unknown) => {
    assert.ok(e instanceof IdempotencyConflictError, `${scope}: expected IdempotencyConflictError, got ${String(e)}`);
    assert.equal(e.scope, scope);
    assert.equal(e.key, key);
    return true;
  };

  // registry.create
  const req = { parent: null, name: "ic", task: "t", host: "h", budgetMicros: 100, idempotencyKey: "ic-create", spec: SPEC };
  const made = await registry.create(req);
  assert.equal((await registry.create({ ...req })).id, made.id, "registry.create: same key and body returns the first agent");
  await assert.rejects(() => registry.create({ ...req, task: "other" }), conflict("registry.create", "ic-create"));
  assert.equal((await registry.list()).filter((a) => a.name === "ic").length, 1, "registry.create: a conflicting replay creates nothing");

  // registry.raiseBudget
  assert.equal((await registry.raiseBudget(made.id, 10, "ic-raise")).budgetMicros, 110);
  assert.equal((await registry.raiseBudget(made.id, 10, "ic-raise")).budgetMicros, 110, "registry.raiseBudget: same key and body returns the first result");
  await assert.rejects(() => registry.raiseBudget(made.id, 20, "ic-raise"), conflict("registry.raiseBudget", "ic-raise"));
  assert.equal((await registry.get(made.id))!.budgetMicros, 110, "registry.raiseBudget: a conflicting replay raises nothing");

  // mailbox.send
  const signal: Signal = { kind: "message", from: made.id, body: "one" };
  await mailbox.send(made.id, signal, "ic-send");
  await mailbox.send(made.id, { ...signal }, "ic-send"); // same key and body: accepted, queued once
  await assert.rejects(() => mailbox.send(made.id, { ...signal, body: "two" }, "ic-send"), conflict("mailbox", "ic-send"));
  const other = await registry.create({ ...req, name: "ic-other", idempotencyKey: "ic-create-2" });
  await assert.rejects(() => mailbox.send(other.id, signal, "ic-send"), conflict("mailbox", "ic-send"));
  assert.deepEqual(
    (await mailbox.peek(made.id)).map((x) => x.id),
    ["ic-send"],
    "mailbox: a conflicting replay queues nothing",
  );
  assert.deepEqual(await mailbox.peek(other.id), []);

  // approval.decide
  await approvals.create(
    { id: "ic-ap", requester: { id: made.id, rank: "agent", generation: 0 }, action: { kind: "extension", target: "x" }, host: "h", deadlineAt: 1000 },
    "ic-ap-create",
  );
  const decision = { who: "p", rank: "parent-agent" as const, decision: "approve" as const, why: "ok" };
  const decided = await approvals.decide("ic-ap", decision, "ic-decide");
  assert.equal(decided.state, "approved");
  assert.deepEqual(await approvals.decide("ic-ap", { ...decision }, "ic-decide"), decided, "approval.decide: same key and body returns the first result");
  await assert.rejects(() => approvals.decide("ic-ap", { ...decision, decision: "deny" }, "ic-decide"), conflict("approval.decide", "ic-decide"));
  await assert.rejects(() => approvals.decide("ic-ap", { ...decision, why: "changed my mind" }, "ic-decide"), conflict("approval.decide", "ic-decide"));
  assert.deepEqual(await approvals.get("ic-ap"), decided, "approval.decide: a conflicting replay changes nothing");
}

// ---- Journal (append / read / subscribe) -------------------------------------------------------------------------

export interface JournalAppendContractWorld {
  journal: Journal;
  registry: Registry;
}

const entryOf = (agent: AgentId, generation: number, key: string, text = key, traceparent?: string) => ({
  agent,
  host: "h",
  generation,
  idempotencyKey: key,
  ...(traceparent ? { traceparent } : {}),
  payload: { kind: "message" as const, role: "assistant" as const, text },
});

export async function journalAppendContractBody(w: JournalAppendContractWorld): Promise<void> {
  const { journal: j, registry } = w;
  const a = await registry.create({ parent: null, name: "ja", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "ja-a", spec: SPEC });
  const b = await registry.create({ parent: null, name: "jb", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "ja-b", spec: SPEC });
  const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const e1 = await j.append(entryOf(a.id, a.generation, "ja-1", "one", tp));
  const e2 = await j.append(entryOf(b.id, b.generation, "ja-2"));
  const e3 = await j.append(entryOf(a.id, a.generation, "ja-3"));
  // seq is strictly increasing in append order; ts is a number; the stored entry echoes what was appended.
  assert.ok(e1.seq < e2.seq && e2.seq < e3.seq);
  assert.equal(typeof e1.ts, "number");
  assert.equal(e1.agent, a.id);
  assert.equal(e1.host, "h");
  assert.equal(e1.generation, a.generation);
  assert.equal(e1.traceparent, tp);
  assert.deepEqual(e1.payload, { kind: "message", role: "assistant", text: "one" });
  assert.equal(e2.traceparent, undefined);
  // Idempotent: a repeated key returns the original entry and writes nothing.
  const again = await j.append(entryOf(a.id, a.generation, "ja-1", "different text"));
  assert.deepEqual(again, e1);
  assert.equal((await j.read({})).length, 3);
  // read: `from` is inclusive, `agent` filters, `limit` truncates from the front, results are in seq order.
  assert.deepEqual(
    (await j.read({ from: e2.seq })).map((e) => e.seq),
    [e2.seq, e3.seq],
  );
  assert.deepEqual(
    (await j.read({ agent: a.id })).map((e) => e.seq),
    [e1.seq, e3.seq],
  );
  assert.deepEqual(
    (await j.read({ agent: a.id, limit: 1 })).map((e) => e.seq),
    [e1.seq],
  );
  assert.deepEqual(await j.read({ agent: "nobody" }), []);
  assert.deepEqual(await j.read({ from: e3.seq + 1 }), []);
  // A returned entry is a copy: mutating it cannot change what is read back.
  const [r1] = await j.read({ agent: a.id, limit: 1 });
  (r1!.payload as { text: string }).text = "mutated";
  assert.equal(((await j.read({ agent: a.id, limit: 1 }))[0]!.payload as { text: string }).text, "one");
  // Negative: a stale or future generation is rejected and writes nothing; so is an unknown agent.
  await assert.rejects(() => j.append(entryOf(a.id, a.generation + 1, "ja-stale")), StaleGenerationError);
  await assert.rejects(() => j.append(entryOf("no-such-agent", 0, "ja-ghost")));
  assert.equal((await j.read({})).length, 3);
  // A rejected key is not consumed: the same key succeeds with a valid generation.
  const ok = await j.append(entryOf(a.id, a.generation, "ja-stale"));
  assert.ok(ok.seq > e3.seq);
  // spendFor: a null cost (none reported) is unpriced like a zero cost with tokens, never summed as a cost; a real cost is.
  const c = await registry.create({ parent: null, name: "jc", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "ja-c", spec: SPEC });
  const usage = (key: string, costMicros: number | null, inputTokens: number, outputTokens: number) =>
    j.append({ agent: c.id, host: "h", generation: c.generation, idempotencyKey: key, payload: { kind: "usage", inputTokens, outputTokens, costMicros } });
  assert.deepEqual(await j.spendFor(c.id), { costMicros: 0, unpricedInputTokens: 0, unpricedOutputTokens: 0, events: 0 });
  await usage("ja-u1", null, 3, 4);
  await usage("ja-u2", 5, 1, 1);
  await usage("ja-u3", 0, 2, 0);
  await usage("ja-u4", null, 0, 0);
  await usage("ja-u1", 999, 9, 9); // a replayed key adds nothing
  assert.deepEqual(await j.spendFor(c.id), { costMicros: 5, unpricedInputTokens: 5, unpricedOutputTokens: 4, events: 4 });
  const [u1] = await j.read({ agent: c.id, limit: 1 });
  assert.equal((u1!.payload as { costMicros: number | null }).costMicros, null, "an unknown cost reads back as null, not 0");
}

export async function journalUsageIdentityContractBody(w: JournalAppendContractWorld): Promise<void> {
  const { journal, registry } = w;
  const a = await registry.create({ parent: null, name: "usage-a", task: "t", host: "h", budgetMicros: 100, idempotencyKey: "usage-a", spec: SPEC });
  const b = await registry.create({ parent: null, name: "usage-b", task: "t", host: "h", budgetMicros: 100, idempotencyKey: "usage-b", spec: SPEC });
  const append = (agent: string, generation: number, key: string, requestId?: string) =>
    journal.append({
      agent,
      host: "h",
      generation,
      idempotencyKey: key,
      payload: { kind: "usage", inputTokens: 3, outputTokens: 2, costMicros: 7, responseId: "same-response", ...(requestId !== undefined && { requestId }) },
    });
  const first = await append(a.id, 0, "usage-first", "request-1");
  const sub = journal.subscribe({ agent: a.id, from: first.seq + 1 });
  const tail = sub[Symbol.asyncIterator]();
  try {
    assert.deepEqual(await append(a.id, 0, "usage-alias", "request-1"), first, "another append key is the same joined call");
    assert.deepEqual(await append(a.id, 0, "usage-alias", "different-request"), first, "the supplied key still replays its original answer");
    await registry.bumpGeneration(a.id, "h", "usage-generation");
    await assert.rejects(() => append(a.id, 0, "usage-stale", "request-1"), StaleGenerationError);
    assert.deepEqual(await append(a.id, 1, "usage-resumed", "request-1"), first, "resume does not recount the original call");
    const next = await append(a.id, 1, "usage-next", "request-2");
    await append(b.id, 0, "usage-other-agent", "request-1");
    const unjoined1 = await append(a.id, 1, "usage-unjoined-1");
    const unjoined2 = await append(a.id, 1, "usage-unjoined-2");
    assert.deepEqual(await journal.spendFor(a.id), { costMicros: 28, unpricedInputTokens: 0, unpricedOutputTokens: 0, events: 4 });
    assert.deepEqual(await journal.spendFor(b.id), { costMicros: 7, unpricedInputTokens: 0, unpricedOutputTokens: 0, events: 1 });
    assert.equal((await journal.read({ agent: a.id })).length, 4, "unjoined reports are not guessed to be duplicates by response id or token counts");
    for (const expected of [next, unjoined1, unjoined2])
      assert.deepEqual((await tail.next()).value, expected, "aliases publish no duplicate subscription entry");
  } finally {
    sub.close();
  }
  assert.equal((await tail.next()).done, true);
}

export async function journalSubscribeContractBody(w: JournalAppendContractWorld): Promise<void> {
  const { journal: j, registry } = w;
  const a = await registry.create({ parent: null, name: "js-a", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "js-a", spec: SPEC });
  const b = await registry.create({ parent: null, name: "js-b", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "js-b", spec: SPEC });
  const first = await j.append(entryOf(a.id, a.generation, "js-1"));
  await j.append(entryOf(b.id, b.generation, "js-2"));
  const sub = j.subscribe({ from: 0, agent: a.id });
  const it = sub[Symbol.asyncIterator]();
  const next = () => Promise.race([it.next(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("subscribe timed out")), 5000).unref())]);
  // Replays existing rows of the filtered agent, then tails new ones; other agents never appear.
  assert.equal((await next()).value.seq, first.seq);
  await j.append(entryOf(b.id, b.generation, "js-3"));
  const tail = await j.append(entryOf(a.id, a.generation, "js-4"));
  assert.equal((await next()).value.seq, tail.seq);
  // close() ends the stream.
  sub.close();
  const end = await next();
  assert.equal(end.done, true);
  // `from` past every row replays nothing and tails only later rows.
  const late = j.subscribe({ from: tail.seq + 1, agent: a.id });
  const lit = late[Symbol.asyncIterator]();
  const nxt = await j.append(entryOf(a.id, a.generation, "js-5"));
  const got: JournalEntry = (
    await Promise.race([lit.next(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("late subscribe timed out")), 5000).unref())])
  ).value;
  assert.equal(got.seq, nxt.seq);
  late.close();
}

// ---- QuotaCounters ----------------------------------------------------------------------------------------------

export interface QuotaCountersContractWorld {
  quota: QuotaCounters;
}

export async function quotaCountersContractBody(w: QuotaCountersContractWorld): Promise<void> {
  const q = w.quota;
  // Absent counters read 0; take adds only within the limit and returns the resulting count.
  assert.equal(q.peek("calls", "a1", 1_000), 0);
  assert.deepEqual(q.take("calls", "a1", 1_000, 2, 3), { ok: true, used: 2 });
  assert.deepEqual(q.take("calls", "a1", 1_000, 1, 3), { ok: true, used: 3 }, "reaching the limit exactly is allowed");
  // Negative: a refused take leaves the count unchanged and reports it.
  assert.deepEqual(q.take("calls", "a1", 1_000, 1, 3), { ok: false, used: 3 });
  assert.deepEqual(q.take("calls", "fresh", 1_000, 5, 4), { ok: false, used: 0 }, "a take larger than the limit is refused outright");
  assert.equal(q.peek("calls", "fresh", 1_000), 0);
  assert.equal(q.peek("calls", "a1", 1_000), 3);
  // Counters are independent per scope, key and window; window 0 is a lifetime counter like any other.
  assert.deepEqual(q.take("calls", "a1", 2_000, 1, 3), { ok: true, used: 1 });
  assert.deepEqual(q.take("bytes", "a1", 1_000, 1, 3), { ok: true, used: 1 });
  assert.deepEqual(q.take("calls", "a2", 1_000, 1, 3), { ok: true, used: 1 });
  assert.deepEqual(q.take("bytes", "a1", 0, 100, 1_000), { ok: true, used: 100 });
  assert.equal(q.peek("calls", "a1", 1_000), 3);
  // give returns up to `amount`, never below 0, and an absent counter stays 0.
  assert.equal(q.give("calls", "a1", 1_000, 2), 1);
  assert.equal(q.give("calls", "a1", 1_000, 5), 0);
  assert.equal(q.peek("calls", "a1", 1_000), 0);
  assert.equal(q.give("calls", "nobody", 1_000, 1), 0);
  assert.equal(q.peek("calls", "nobody", 1_000), 0);
  assert.deepEqual(q.take("calls", "a1", 1_000, 3, 3), { ok: true, used: 3 }, "returned capacity can be taken again");
  // A zero-amount take is a check: it succeeds within the limit without changing the count.
  assert.deepEqual(q.take("calls", "a1", 1_000, 0, 3), { ok: true, used: 3 });
  assert.deepEqual(q.take("calls", "a1", 1_000, 0, 2), { ok: false, used: 3 }, "a count already past a lowered limit refuses");
  // Amounts, limits and window starts are non-negative safe integers, else the call throws and changes nothing.
  assert.throws(() => q.take("calls", "a1", 1_000, -1, 3));
  assert.throws(() => q.take("calls", "a1", 1_000, 1.5, 3));
  assert.throws(() => q.take("calls", "a1", 1_000, 1, -1));
  assert.throws(() => q.take("calls", "a1", -1, 1, 3));
  assert.throws(() => q.give("calls", "a1", 1_000, -1));
  assert.throws(() => q.give("calls", "a1", Number.NaN, 1));
  assert.throws(() => q.peek("calls", "a1", 2 ** 60));
  assert.equal(q.peek("calls", "a1", 1_000), 3);
}

// QuotaCounters.take's opId: a take that succeeded under (scope, key, window, opId) is applied once; a replay returns its first
// result even after the count moved, and a refused take is not recorded, so its replay is evaluated afresh.
export async function quotaCountersOpIdContractBody(w: QuotaCountersContractWorld): Promise<void> {
  const q = w.quota;
  assert.deepEqual(q.take("cap", "a1", 1_000, 1, 5, "op-1"), { ok: true, used: 1 });
  assert.deepEqual(q.take("cap", "a1", 1_000, 1, 5, "op-1"), { ok: true, used: 1 }, "a replay charges nothing");
  assert.equal(q.peek("cap", "a1", 1_000), 1);
  assert.deepEqual(q.take("cap", "a1", 1_000, 2, 5, "op-2"), { ok: true, used: 3 });
  assert.deepEqual(q.take("cap", "a1", 1_000, 1, 5, "op-1"), { ok: true, used: 1 }, "the replay returns its first result, not the current count");
  assert.equal(q.peek("cap", "a1", 1_000), 3);
  // Negative: the same opId under another scope, key or window is a different take.
  assert.deepEqual(q.take("cap", "a2", 1_000, 1, 5, "op-1"), { ok: true, used: 1 });
  assert.deepEqual(q.take("cap", "a1", 2_000, 1, 5, "op-1"), { ok: true, used: 1 });
  assert.deepEqual(q.take("other", "a1", 1_000, 1, 5, "op-1"), { ok: true, used: 1 });
  assert.equal(q.peek("cap", "a1", 1_000), 3);
  // A take without an opId is never deduplicated.
  assert.deepEqual(q.take("cap", "a1", 1_000, 1, 5), { ok: true, used: 4 });
  assert.deepEqual(q.take("cap", "a1", 1_000, 1, 5), { ok: true, used: 5 });
  // Negative: a refused take is not recorded; once capacity returns, the same opId applies.
  assert.deepEqual(q.take("cap", "a1", 1_000, 1, 5, "op-3"), { ok: false, used: 5 });
  assert.equal(q.give("cap", "a1", 1_000, 2), 3);
  assert.deepEqual(q.take("cap", "a1", 1_000, 1, 5, "op-3"), { ok: true, used: 4 });
  assert.deepEqual(q.take("cap", "a1", 1_000, 1, 5, "op-3"), { ok: true, used: 4 });
  assert.equal(q.peek("cap", "a1", 1_000), 4);
  // A replay after its charge was given back still adds nothing.
  assert.equal(q.give("cap", "a1", 1_000, 4), 0);
  assert.deepEqual(q.take("cap", "a1", 1_000, 1, 5, "op-2"), { ok: true, used: 3 });
  assert.equal(q.peek("cap", "a1", 1_000), 0);
  // Arguments are still checked, and an empty opId is refused.
  assert.throws(() => q.take("cap", "a1", 1_000, -1, 5, "op-9"));
  assert.throws(() => q.take("cap", "a1", 1_000, 1, 5, ""));
  assert.equal(q.peek("cap", "a1", 1_000), 0);
}

// ---- CaptureIndex ------------------------------------------------------------------------------------------------

export interface CaptureIndexContractWorld {
  captures: CaptureIndex;
}

const capKey = (n: number): string => createHash("sha256").update(`key-${n}`).digest("hex");
const capJob = (key: string, over: Partial<NewCaptureJob> = {}): NewCaptureJob => ({
  key,
  request: { url: "https://www.example.com/a", render: "static", purpose: "contract" },
  acquirer: "web",
  render: "static",
  requester: "ag-1",
  generation: 1,
  host: "host-1",
  createdAt: 1_000,
  ...over,
});
const capArtifact = (sha: string): CaptureArtifact => ({
  role: "raw",
  mediaType: "text/html",
  sizeBytes: 3,
  sha256: sha,
  report: { agent: "ag-w", id: `r-${sha.slice(0, 8)}` },
});
const capRecord = (id: string, key: string, createdAt: number, shas: string[]): CaptureRecord => ({
  id,
  predicate: {
    key,
    source: "static",
    acquirer: "static",
    freshness: "daily",
    fetch: {
      requestedUrl: "https://www.example.com/a",
      finalUrl: "https://www.example.com/a",
      redirects: [],
      status: 200,
      contentType: "text/html",
      headers: {},
      fetchedAt: createdAt,
      userAgent: "pomtree-test ops@example.org",
    },
    robots: null,
    worker: { agent: "ag-w", generation: 1, host: "host-1", sandbox: "sb-1", imageDigest: "sha256:0", egressChainHead: null },
    controller: { host: "host-1", pomtreedVersion: "0.0.0" },
  },
  artifacts: shas.map(capArtifact),
  envelope: null,
  timestamp: null,
  createdAt,
});
const okOutcome = (rec: CaptureRecord): CaptureOutcome => ({ state: "ok", capture: rec, servedFrom: "static", ageMs: 0 });

// begin joins the open job for a key and is idempotent by key with a request fingerprint; advance appends steps; settle is
// first-wins and feeds the caches; the negative cache expires; pauses only extend; reads are newest first and are copies.
export async function captureIndexContractBody(w: CaptureIndexContractWorld): Promise<void> {
  const c = w.captures;
  const k1 = capKey(1);
  const sha = (ch: string) => ch.repeat(64);

  // begin creates a job with the documented id, open, with the creator as its first requester.
  const j1 = await c.begin(capJob(k1), "b-1");
  assert.equal(j1.id, captureJobIdOf(k1, 1_000));
  assert.equal(j1.state, "open");
  assert.equal(j1.outcome, null);
  assert.deepEqual(j1.requesters, [{ agent: "ag-1", generation: 1 }]);
  assert.equal(j1.host, "host-1");
  assert.equal(j1.generation, 1);
  assert.deepEqual(await c.job(j1.id), j1);
  assert.equal(await c.job("cj-nope"), null);
  // A second requester with a new key joins the open job (one fetch for many requesters), recorded once.
  const j1b = await c.begin(capJob(k1, { requester: "ag-2", generation: 4, createdAt: 2_000 }), "b-2");
  assert.equal(j1b.id, j1.id);
  assert.deepEqual(j1b.requesters, [
    { agent: "ag-1", generation: 1 },
    { agent: "ag-2", generation: 4 },
  ]);
  assert.deepEqual((await c.begin(capJob(k1, { requester: "ag-2", generation: 4, createdAt: 3_000 }), "b-3")).requesters.length, 2);
  // A replay of the same request under the same key returns the job as it is now.
  const replay = await c.begin(capJob(k1, { createdAt: 9_999, generation: 2 }), "b-1");
  assert.equal(replay.id, j1.id);
  assert.equal(replay.requesters.length, 2, "the replay sees the job's current state");
  // Negative: a different request under the same key throws IdempotencyConflictError and changes nothing.
  await assert.rejects(() => c.begin(capJob(capKey(2)), "b-1"), IdempotencyConflictError);
  await assert.rejects(() => c.begin(capJob(k1, { request: { url: "https://www.example.com/other", purpose: "x" } }), "b-1"), IdempotencyConflictError);
  assert.equal((await c.open()).length, 1, "the conflict created no job");

  // advance appends steps in order; a replayed key adds nothing; an unknown job throws.
  const entered = { kind: "rung_entered" as const, rung: "static" as const, at: 1_100 };
  const a1 = await c.advance(j1.id, entered, "a-1");
  assert.deepEqual(a1.steps, [entered]);
  assert.equal((await c.advance(j1.id, entered, "a-1")).steps.length, 1);
  const result = { kind: "rung_result" as const, rung: "static" as const, status: 200, durationMs: 12, bytes: 3, at: 1_200 };
  assert.deepEqual((await c.advance(j1.id, result, "a-2")).steps, [entered, result]);
  await assert.rejects(() => c.advance(j1.id, result, "a-1"), IdempotencyConflictError, "a key reused for another step conflicts");
  await assert.rejects(() => c.advance("cj-unknown", entered, "a-3"));

  // Negative: settle refuses pending, a record for another key, and an unknown job; none of these settles the job.
  await assert.rejects(() => c.settle(j1.id, { state: "pending", job: j1.id }, "s-0"));
  const r1 = capRecord("cap-1", k1, 5_000, [sha("a"), sha("b")]);
  await assert.rejects(() => c.settle(j1.id, okOutcome({ ...r1, predicate: { ...r1.predicate, key: capKey(9) } }), "s-0b"));
  await assert.rejects(() => c.settle("cj-unknown", okOutcome(r1), "s-0c"));
  assert.equal((await c.job(j1.id))?.state, "open");
  assert.equal(await c.latest(k1), null);

  // settle ok: first wins, the record is served by latest/get/list/byDigest; later settles and steps change nothing.
  const s1 = await c.settle(j1.id, okOutcome(r1), "s-1");
  assert.equal(s1.state, "settled");
  assert.deepEqual(s1.outcome, okOutcome(r1));
  assert.deepEqual(await c.latest(k1), r1);
  assert.deepEqual(await c.get("cap-1"), r1);
  assert.equal(await c.get("cap-nope"), null);
  assert.deepEqual(await c.byDigest(sha("a")), capArtifact(sha("a")));
  assert.equal(await c.byDigest(sha("f")), null);
  const late = await c.settle(j1.id, { state: "failed", job: j1.id, failure: captureFailure({ class: "timeout" }), cached: false }, "s-2");
  assert.deepEqual(late.outcome, okOutcome(r1), "first settle wins");
  assert.equal(await c.negative(k1, 0), null, "the losing failure wrote no negative entry");
  assert.equal((await c.advance(j1.id, entered, "a-4")).steps.length, 2, "a settled job takes no steps");
  assert.deepEqual(await c.open(), []);

  // With the job settled, a new request for the key creates a new job (no join), and a same-millisecond id never collides.
  const j2 = await c.begin(capJob(k1, { createdAt: 1_000 }), "b-4");
  assert.notEqual(j2.id, j1.id);
  assert.equal(j2.id, captureJobIdOf(k1, 1_001));
  // settle failed: the negative entry lives until now + negativeTtlMs, then expires; the job must match.
  const fail = captureFailure({ class: "upstream_error", reason: "http", status: 502 });
  await assert.rejects(() => c.settle(j2.id, { state: "failed", job: "cj-other", failure: fail, cached: false }, "s-3x"));
  const before = Date.now();
  await c.settle(j2.id, { state: "failed", job: j2.id, failure: fail, cached: false }, "s-3");
  const after = Date.now();
  const neg = await c.negative(k1, after);
  assert.ok(neg, "a negative entry");
  assert.deepEqual(neg.failure, fail);
  const ttl = negativeTtlMs(fail);
  assert.ok(neg.until >= before + ttl && neg.until <= after + ttl, `until ${neg.until} within [${before + ttl}, ${after + ttl}]`);
  assert.equal(await c.negative(k1, neg.until), null, "expired at until");
  assert.equal(await c.negative(capKey(3), 0), null);
  assert.deepEqual(await c.latest(k1), r1, "a later failure does not hide the earlier capture");
  // A failure the negative cache does not hold (requester-specific) writes nothing; a later success clears an entry.
  const k4 = capKey(4);
  const j4 = await c.begin(capJob(k4), "b-5");
  await c.settle(j4.id, { state: "failed", job: j4.id, failure: captureFailure({ class: "forbidden" }), cached: false }, "s-4");
  assert.equal(await c.negative(k4, 0), null);
  const j5 = await c.begin(capJob(k1, { createdAt: 6_000 }), "b-6");
  const r2 = capRecord("cap-2", k1, 7_000, [sha("a"), sha("c")]);
  await c.settle(j5.id, okOutcome(r2), "s-5");
  assert.equal(await c.negative(k1, after), null, "a success clears the key's negative entry");
  assert.deepEqual(await c.latest(k1), r2, "latest is the newest capture");
  assert.deepEqual(await c.byDigest(sha("a")), capArtifact(sha("a")), "the first artifact stored with a digest stays");

  // list: newest first, bounded by limit.
  const k6 = capKey(6);
  const j6 = await c.begin(capJob(k6, { createdAt: 6_500 }), "b-7");
  const r3 = capRecord("cap-3", k6, 6_500, [sha("d")]);
  await c.settle(j6.id, okOutcome(r3), "s-6");
  assert.deepEqual(
    (await c.list()).map((r) => r.id),
    ["cap-2", "cap-3", "cap-1"],
  );
  assert.deepEqual(
    (await c.list({ limit: 1 })).map((r) => r.id),
    ["cap-2"],
  );

  // open lists unsettled jobs oldest first.
  const o1 = await c.begin(capJob(capKey(7), { createdAt: 300 }), "b-8");
  const o2 = await c.begin(capJob(capKey(8), { createdAt: 200 }), "b-9");
  assert.deepEqual(
    (await c.open()).map((j) => j.id),
    [o2.id, o1.id],
  );

  // pauseDomain only ever extends; domainPause is null once passed; replays are idempotent.
  assert.equal(await c.domainPause("example.com", 0), null);
  await c.pauseDomain("example.com", 10_000, "p-1");
  assert.equal(await c.domainPause("example.com", 0), 10_000);
  await c.pauseDomain("example.com", 5_000, "p-2");
  assert.equal(await c.domainPause("example.com", 0), 10_000, "a shorter pause never shortens");
  await c.pauseDomain("example.com", 20_000, "p-3");
  assert.equal(await c.domainPause("example.com", 0), 20_000);
  await c.pauseDomain("example.com", 20_000, "p-3");
  assert.equal(await c.domainPause("example.com", 20_000), null, "expired at until");
  assert.equal(await c.domainPause("sec.gov", 0), null, "pauses are per domain");
  await assert.rejects(() => c.pauseDomain("example.com", 30_000, "p-1"), IdempotencyConflictError);

  // Reads are copies: mutating one never changes the store.
  const copy = (await c.latest(k1)) as CaptureRecord;
  copy.artifacts.length = 0;
  assert.equal((await c.latest(k1))?.artifacts.length, 2);
}

// ---- TemplateStore -----------------------------------------------------------------------------------------------

export interface TemplateStoreContractWorld {
  templates: TemplateStore;
  // The templates the store was built to hold (the world installs them however the adapter needs).
  known: Template[];
}

export async function templateStoreContractBody(w: TemplateStoreContractWorld): Promise<void> {
  const { templates: s, known } = w;
  assert.ok(known.length > 0, "world must seed at least one template");
  const listed = await s.list();
  const byId = (xs: Template[]) => [...xs].sort((x, y) => (x.id < y.id ? -1 : 1));
  assert.deepEqual(
    byId(listed).map((t) => t.id),
    byId(known).map((t) => t.id),
  );
  // resolve returns what list returns, and a template's id is its name.
  for (const t of listed) assert.deepEqual(await s.resolve(t.id), t);
  // Negative: an unknown (well-formed) name resolves to null, never a default or a throw.
  assert.equal(await s.resolve("no-such-template-xyz"), null);
  // Negative: a malformed name (path traversal, empty, separator) never yields a template. Adapters may reject or
  // return null; both are acceptable, a resolved template is not.
  for (const bad of ["../escape", "", "a/b", "a\0b", ".."]) {
    let got: Template | null = null;
    try {
      got = await s.resolve(bad);
    } catch {
      got = null;
    }
    assert.equal(got, null, `malformed name ${JSON.stringify(bad)} must not resolve`);
  }
  // Isolation: mutating a returned template never changes the next read.
  const first = await s.resolve(known[0]!.id);
  assert.ok(first);
  const snapshot = structuredClone(first);
  (first as { name?: string }).name = "mutated";
  (first as { extensions?: string[] }).extensions = ["mutated"];
  assert.deepEqual(await s.resolve(known[0]!.id), snapshot);
  const l2 = await s.list();
  (l2[0] as { name?: string }).name = "mutated";
  assert.deepEqual(byId(await s.list()), byId(listed));
}

// ---- ModelGateway ------------------------------------------------------------------------------------------------

export interface ModelGatewayContractWorld {
  gateway: ModelGateway;
  // Registers an agent in the half's own registry and returns its id (adapters read the budget from the registry).
  // `model: null` = a container agent with no model resolved; the default is a real model id.
  register(o: { budgetMicros: number; deterministic?: boolean; model?: string | null; exited?: boolean }): Promise<AgentId>;
}

// A world's `register` over any Registry adapter, so the fake and the real half register their agents the same way.
let gwRegistered = 0;
export const modelGatewayRegisterOn =
  (registry: Registry): ModelGatewayContractWorld["register"] =>
  async (o) => {
    const id = `gw-${++gwRegistered}`;
    const base = { id, parent: null, name: id, task: "t", host: "h1", budgetMicros: o.budgetMicros, idempotencyKey: `${id}:create` };
    const a = o.deterministic
      ? await registry.create({ ...base, executor: "deterministic", spec: { driver: "hn-content/story", input: {} } })
      : await registry.create({
          ...base,
          executor: "container",
          spec: {
            image: "fixture@sha256:abc",
            envManifestHash: null,
            extensions: [],
            systemPrompt: null,
            egress: { kind: "audited-public" },
            ...(o.model === null ? {} : { model: o.model ?? "p/m" }),
          },
        });
    if (o.exited) {
      const r = await registry.transition(a.id, a.generation, "running", { idempotencyKey: `${id}:start` });
      await registry.transition(r.id, r.generation, "exited", { exit: "succeeded", idempotencyKey: `${id}:exit` });
    }
    return id;
  };

export async function modelGatewayContractBody(w: ModelGatewayContractWorld): Promise<void> {
  const g = w.gateway;
  const B = 5_000;
  const a = await w.register({ budgetMicros: B });
  // (a) Negative: a non-integer, negative or unsafe budget is refused before any credential is issued.
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => g.issueKey(a, bad, `gw-bad-${String(bad)}`), /non-negative safe integer/, `budget ${String(bad)} must be rejected`);
  }
  // (b) a registered agent with a model gets a credential and a usable base url
  const k1 = await g.issueKey(a, B, "gw-k1");
  assert.equal(typeof k1.key, "string");
  assert.ok(k1.key.length > 0);
  assert.ok(k1.baseUrl.length > 0);
  assert.doesNotThrow(() => new URL(k1.baseUrl));
  // (c) replaying the same idempotency key for the same agent never re-issues
  assert.deepEqual(await g.issueKey(a, B, "gw-k1"), k1);
  // (d) an idempotency key is scoped to its agent, never shared across agents: a second agent replaying the first agent's key
  // gets its OWN credential. A gateway that cached by key alone would hand this agent a credential scoped to the other one.
  const b = await w.register({ budgetMicros: B });
  const k2 = await g.issueKey(b, B, "gw-k1");
  assert.notDeepEqual(k2, k1);
  assert.deepEqual(await g.issueKey(b, B, "gw-k1"), k2); // and it replays per agent
  // (e) nothing spent yet; the budget is the one registered and issued
  assert.deepEqual(await g.spend(a), { spentMicros: 0, budgetMicros: B });
  // (f) priceUsage is optional; when present, a model-less event is unpriced (null), never a guess.
  if (g.priceUsage) assert.equal(await g.priceUsage({ inputTokens: 100, outputTokens: 100 }), null);
  // (g) spend and revoke of an agent that holds no credential are answers, not errors: no credential means nothing spent and
  // nothing to take back. A read of a missing record returns zeros across this repo's ports (Journal.spendFor,
  // ModelDebitStore.spentFor/ledgerFor) and revocation is an idempotent cleanup (ModelDebitStore.revoke, WatchdogStore.clear).
  // The budget is the agent's registered cap, which exists before any credential does; an agent no registry knows reads as 0.
  const never = await w.register({ budgetMicros: B });
  assert.deepEqual(await g.spend(never), { spentMicros: 0, budgetMicros: B });
  assert.deepEqual(await g.spend("gw-ghost"), { spentMicros: 0, budgetMicros: 0 });
  assert.deepEqual(await g.revoke("gw-ghost"), { unusedMicros: 0 });
  // A credential-less REGISTERED agent's revoke returns its whole registered budget: every gateway reads the cap from the registry
  // (the sqlite debit ledger's ledgerView, the fake debit store given the registry, and journal metering), not from a debit bucket.
  assert.deepEqual(await g.revoke(never), { unusedMicros: B });
  // (h) revoking an agent that spent nothing returns the whole budget, and a second revoke answers the same (idempotent)
  assert.deepEqual(await g.revoke(a), { unusedMicros: B });
  assert.deepEqual(await g.revoke(a), { unusedMicros: B });
  // (i) the four issue refusals, by exact message: no key for an agent that cannot use one, refused at issue with the shared
  // message (cause and fix), not later per call.
  const issueFor = (id: AgentId) => g.issueKey(id, B, `gw-refuse-${id}`);
  await assert.rejects(() => issueFor("gw-nobody"), { message: ISSUE_REFUSAL.unregistered("gw-nobody") });
  const det = await w.register({ budgetMicros: B, deterministic: true });
  await assert.rejects(() => issueFor(det), { message: ISSUE_REFUSAL.deterministic(det) });
  const gone = await w.register({ budgetMicros: B, exited: true });
  await assert.rejects(() => issueFor(gone), { message: ISSUE_REFUSAL.terminal(gone, "exited") });
  const bare = await w.register({ budgetMicros: B, model: null });
  await assert.rejects(() => issueFor(bare), { message: ISSUE_REFUSAL.noModel(bare) });
}

// ---- Harness -----------------------------------------------------------------------------------------------------

export interface HarnessContractWorld {
  harness: Harness;
  agent: AgentId;
  sandbox: SandboxHandle;
  // Whether steer() is wired. An unwired adapter must reject rather than silently drop the message.
  steerSupported: boolean;
  // A sandbox that stays alive (no output, no exit) until the test ends. When set, the body also pins that stop() ends events()
  // while the sandbox lives. Omit it for a harness whose events() is a finite script (the fake). See hangingSandbox().
  liveSandbox?: () => SandboxHandle;
}

// A sandbox that never writes and never exits: the "container still alive" half of the stop-ends-events contract.
export function hangingSandbox(id = "sb-hanging"): SandboxHandle {
  return {
    id,
    async *output() {
      await new Promise<never>(() => {});
    },
    wait: () => new Promise<never>(() => {}),
  };
}

const HARNESS_KINDS = new Set(["message", "tool_call", "tool_result", "usage", "error", "user_input", "provider_error", "settled"]);

function assertWellFormedHarnessEvent(e: HarnessEvent): void {
  assert.ok(HARNESS_KINDS.has(e.kind), `unknown harness event kind ${String((e as { kind: unknown }).kind)}`);
  switch (e.kind) {
    case "message":
      assert.ok(e.role === "assistant" || e.role === "user");
      assert.equal(typeof e.text, "string");
      break;
    case "tool_call":
      assert.equal(typeof e.tool, "string");
      assert.equal(typeof e.callId, "string");
      break;
    case "tool_result":
      assert.equal(typeof e.callId, "string");
      assert.equal(typeof e.ok, "boolean");
      assert.equal(typeof e.output, "string");
      if (e.details !== undefined)
        assert.deepEqual(boundToolDetails(e.details), e.details, "tool_result details must be plain JSON within MAX_TOOL_DETAILS_BYTES");
      break;
    case "usage":
      for (const n of [e.inputTokens, e.outputTokens]) assert.ok(Number.isFinite(n) && n >= 0);
      // null is an unknown cost (the harness reported none), never a stand-in for 0.
      assert.ok(e.costMicros === null || (Number.isFinite(e.costMicros) && e.costMicros >= 0));
      break;
    case "error":
    case "provider_error":
      assert.equal(typeof e.message, "string");
      break;
    case "user_input":
      assert.equal(typeof e.text, "string");
      break;
    case "settled":
      break;
  }
}

async function checkSession(s: HarnessSession, w: HarnessContractWorld): Promise<void> {
  assert.equal(typeof s.session, "string");
  assert.ok(s.session.length > 0);
  assert.equal(typeof s.events, "function");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  timer.unref();
  try {
    for await (const e of s.events()) {
      assertWellFormedHarnessEvent(e);
      if (ac.signal.aborted) throw new Error("events() did not end");
    }
  } finally {
    clearTimeout(timer);
  }
  if (w.steerSupported) await s.steer("nudge");
  else await assert.rejects(() => s.steer("nudge"));
  await s.stop();
  await s.stop(); // stop is idempotent
}

// stop() ends events() while the sandbox is still alive, with no exit error: the daemon's stop paths (interrupt backstop,
// kill) rely on it, since only the container's exit would otherwise end the stream.
async function checkStopEndsEvents(w: HarnessContractWorld, open: (sandbox: SandboxHandle) => Promise<HarnessSession>): Promise<void> {
  const s = await open(w.liveSandbox!());
  const errors: HarnessEvent[] = [];
  let ended = false;
  const drain = (async () => {
    for await (const e of s.events()) {
      assertWellFormedHarnessEvent(e);
      if (e.kind === "error" || e.kind === "provider_error") errors.push(e);
    }
    ended = true;
  })();
  // Not unref'd: a pending drain alone would let the event loop exit mid-await. The timer is cleared once the race settles.
  const settledWithin = async (ms: number): Promise<"ended" | "timeout"> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([drain.then(() => "ended" as const), new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms)))]);
    } finally {
      clearTimeout(timer);
    }
  };
  // Negative control: without stop() the stream stays open while the sandbox lives, so the end below is stop()'s doing.
  assert.equal(await settledWithin(100), "timeout", "events() must not end while the sandbox lives and stop() was not called");
  assert.equal(ended, false);
  await s.stop();
  assert.equal(await settledWithin(2000), "ended", "stop() must end events() while the sandbox is still alive");
  assert.deepEqual(errors, [], "stop() must end events() without an exit error");
  await s.stop(); // idempotent after the stream has ended
}

export async function harnessContractBody(w: HarnessContractWorld): Promise<void> {
  // The world's sandbox has exited or been scripted so events() ends; the body only requires it to terminate.
  await checkSession(await w.harness.start({ agent: w.agent, sandbox: w.sandbox, prompt: "do the task" }), w);
  await checkSession(await w.harness.resume({ agent: w.agent, sandbox: w.sandbox, sessionRef: "ref-1", wake: "wake up" }), w);
  if (w.liveSandbox) {
    await checkStopEndsEvents(w, (sandbox) => w.harness.start({ agent: w.agent, sandbox, prompt: "do the task" }));
    await checkStopEndsEvents(w, (sandbox) => w.harness.resume({ agent: w.agent, sandbox, sessionRef: "ref-1", wake: "wake up" }));
  }
}

// ---- Placement ---------------------------------------------------------------------------------------------------

export interface PlacementContractWorld {
  placement: Placement;
  // The single local host the placement fronts, and its session cap (the cap the placement enforces).
  host: string;
  maxConcurrent: number;
}

export async function placementContractBody(w: PlacementContractWorld): Promise<void> {
  const p = w.placement;
  const row = async () => {
    const s = await p.status();
    const r = s.find((x) => x.host === w.host);
    assert.ok(r, "status has a row for the host");
    return r;
  };
  assert.equal((await row()).maxConcurrent, w.maxConcurrent);
  const ag = (i: number) => `pc-${i}`;
  // Fill to the cap: every admit returns the host and shows up as running.
  for (let i = 0; i < w.maxConcurrent; i++) assert.deepEqual(await p.admit({ agent: ag(i), priority: 1 }), { host: w.host });
  assert.deepEqual([...(await row()).running].sort(), Array.from({ length: w.maxConcurrent }, (_, i) => ag(i)).sort());
  // Re-admitting a running agent never double-books it.
  assert.deepEqual(await p.admit({ agent: ag(0), priority: 1 }), { host: w.host });
  assert.equal((await row()).running.filter((a) => a === ag(0)).length, 1);
  // Over the cap: queued with a non-empty reason, listed in the queue with its priority, not running.
  const over = await p.admit({ agent: "pc-over", priority: 3 });
  assert.ok("queued" in over && over.queued === true && typeof over.reason === "string" && over.reason.length > 0, "over-cap admit queues with a reason");
  let r = await row();
  assert.ok(!r.running.includes("pc-over"));
  assert.deepEqual(
    r.queue.find((q) => q.agent === "pc-over"),
    { agent: "pc-over", priority: 3 },
  );
  // Releasing a queued agent removes it from the queue and is harmless to the running set.
  await p.release("pc-over");
  r = await row();
  assert.ok(!r.queue.some((q) => q.agent === "pc-over"));
  assert.equal(r.running.length, w.maxConcurrent);
  // Releasing an unknown agent is a no-op.
  await p.release("pc-never-admitted");
  assert.equal((await row()).running.length, w.maxConcurrent);
  // Releasing a running agent frees its slot for a new admit.
  await p.release(ag(0));
  assert.ok(!(await row()).running.includes(ag(0)));
  assert.deepEqual(await p.admit({ agent: "pc-new", priority: 1 }), { host: w.host });
  // sync marks listed agents running even beyond the cap (they already hold a container), and releases the rest.
  const live = Array.from({ length: w.maxConcurrent + 1 }, (_, i) => `pc-live-${i}`);
  await p.sync(live);
  r = await row();
  assert.deepEqual([...r.running].sort(), [...live].sort());
  assert.ok(!r.queue.some((q) => live.includes(q.agent)));
  await p.sync([]);
  assert.deepEqual((await row()).running, []);
}

// ---- WatchdogStore -----------------------------------------------------------------------------------------------

export interface WatchdogStoreContractWorld {
  watchdogs: WatchdogStore;
}

const wdState = (rung: WatchdogState["rung"], over: Partial<WatchdogState> = {}): WatchdogState => ({ rung, lastActionAt: null, retries: 0, ...over });

export async function watchdogStoreContractBody(w: WatchdogStoreContractWorld): Promise<void> {
  const s = w.watchdogs;
  assert.equal(await s.get("wd-a"), null, "absent agent reads null");
  // Round-trip, including the optional fields when set (an unset `quarantined` may read absent or false, so it is not asserted).
  const full = wdState("quarantined", { lastActionAt: 123, retries: 2, restarts: [10, 20], quarantined: true });
  assert.deepEqual(await s.set("wd-a", full, "k1"), full);
  assert.deepEqual(await s.get("wd-a"), full);
  // Negative: the returned and read states are copies; mutating them never changes the stored state.
  const read = (await s.get("wd-a"))!;
  read.retries = 99;
  read.restarts!.push(999);
  assert.deepEqual(await s.get("wd-a"), full);
  // Idempotent by key: a replay returns the first result and applies nothing, even with a different state.
  const next = wdState("escalated", { lastActionAt: 200, retries: 3 });
  assert.deepEqual(await s.set("wd-a", next, "k1"), full);
  assert.deepEqual(await s.get("wd-a"), full);
  // A fresh key upserts by agent: the later state replaces the earlier one, and fields no longer set do not linger.
  const stored = await s.set("wd-a", next, "k2");
  assert.equal(stored.rung, "escalated");
  assert.equal(stored.lastActionAt, 200);
  assert.equal(stored.retries, 3);
  assert.deepEqual(stored.restarts ?? [], []);
  assert.ok(!stored.quarantined, "an unset quarantined does not keep the earlier true");
  assert.deepEqual(await s.get("wd-a"), stored);
  // Agents are independent.
  assert.equal(await s.get("wd-b"), null);
  await s.set("wd-b", wdState("nudged", { lastActionAt: 5 }), "k3");
  assert.equal((await s.get("wd-a"))?.rung, "escalated");
  // Clear removes only that agent, is idempotent, and a replayed set key does not resurrect it.
  await s.clear("wd-a");
  assert.equal(await s.get("wd-a"), null);
  assert.equal((await s.get("wd-b"))?.rung, "nudged");
  await s.clear("wd-a");
  await s.clear("never-written");
  await s.set("wd-a", full, "k2");
  assert.equal(await s.get("wd-a"), null, "a replayed key applies nothing after a clear");
}

// ---- SessionStore ------------------------------------------------------------------------------------------------

export interface SessionStoreContractWorld {
  sessions: SessionStore;
}

export async function sessionStoreContractBody(w: SessionStoreContractWorld): Promise<void> {
  const s = w.sessions;
  const bytes = new TextEncoder().encode("session bytes");
  const ref = await s.put(bytes);
  assert.equal(ref, createHash("sha256").update(bytes).digest("hex"), "the ref is the content's sha256 hex");
  assert.equal(await s.put(bytes), ref, "put is idempotent by content");
  const got = await s.get(ref);
  assert.ok(got instanceof Uint8Array);
  assert.deepEqual([...got], [...bytes]);
  // Negative: get returns a copy; mutating it (or the bytes given to put) never corrupts the stored blob.
  got[0] = 99;
  assert.deepEqual([...(await s.get(ref))!], [...bytes]);
  const mine = new Uint8Array([1, 2, 3]);
  const mineRef = await s.put(mine);
  mine[0] = 42;
  assert.deepEqual([...(await s.get(mineRef))!], [1, 2, 3]);
  // Every byte value survives (the real store keeps a BLOB).
  const binary = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual([...(await s.get(await s.put(binary)))!], [...binary]);
  // Distinct content gets a distinct ref; empty content is a valid session.
  const other = await s.put(new Uint8Array([9]));
  assert.notEqual(other, ref);
  const emptyRef = await s.put(new Uint8Array());
  assert.equal(emptyRef, createHash("sha256").update(new Uint8Array()).digest("hex"));
  assert.deepEqual([...(await s.get(emptyRef))!], []);
  // Negative: only an exact stored ref resolves.
  for (const bad of ["", "deadbeef", ref.toUpperCase(), ref.slice(0, 32), `${ref}0`, "../x"])
    assert.equal(await s.get(bad), null, `ref ${JSON.stringify(bad)}`);
}

// ---- StateStore --------------------------------------------------------------------------------------------------

export interface StateStoreContractWorld {
  state: StateStore;
  registry: Registry;
  // The limits the adapter was built with; the body sizes its values from them (needs maxOwnerBytes <= 2.5 * maxDocBytes, maxDocs >= 2).
  limits: StateLimits;
  // Advance the adapter's clock by ms (fake: script clock; real: sleep).
  age(ms: number): Promise<void>;
}

// Small enough to hit every quota with a few tiny documents. Build both halves with these (the real store via `stateLimits`).
export const STATE_CONTRACT_LIMITS: StateLimits = { maxDocs: 4, maxDocBytes: 64, maxOwnerBytes: 120, maxTombstones: 3 };

export async function stateStoreContractBody(w: StateStoreContractWorld): Promise<void> {
  const { state: st, registry, limits } = w;
  const op = { operator: true as const };
  let n = 0;
  const id = () => `sc-${++n}`;
  const kindOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (e) {
      assert.ok(e instanceof StateError, `expected StateError, got ${e instanceof Error ? e.name : String(e)}`);
      return e.kind;
    }
    assert.fail("expected a StateError");
  };
  // A JSON string whose encoding is exactly `bytes` bytes (two quotes plus content).
  const str = (bytes: number) => "x".repeat(bytes - 2);
  const put = (owner: string, key: string, value: unknown, expectRev?: number | null, idem = id()) =>
    st.put({ owner, key, value: value as never, ...(expectRev === undefined ? {} : { expectRev }), writer: op }, idem);
  const mustPut = async (owner: string, key: string, value: unknown, expectRev?: number | null) => {
    const r = await put(owner, key, value, expectRev);
    assert.ok(r.ok, "put succeeds");
    return r.doc;
  };
  const rm = (req: Record<string, unknown>, idem = id()) => st.remove({ owner: "rm", writer: op, ...req } as never, idem);

  // put / get / blind overwrite / bytes / writer.
  const d1 = await mustPut("pg", "k", { a: 1 });
  assert.equal(d1.rev, 1);
  assert.equal(d1.bytes, Buffer.byteLength(JSON.stringify({ a: 1 })));
  assert.deepEqual(d1.value, { a: 1 });
  assert.deepEqual(d1.writer, op);
  assert.equal(typeof d1.createdAt, "number");
  assert.deepEqual(await st.get("pg", "k"), d1);
  assert.equal(await st.get("pg", "missing"), null);
  assert.equal(await st.get("other-owner", "k"), null, "owners are isolated");
  const d2 = await mustPut("pg", "k", { a: 2 });
  assert.equal(d2.rev, 2);
  assert.equal(d2.createdAt, d1.createdAt);
  assert.ok(d2.updatedAt >= d1.updatedAt);
  assert.deepEqual((await st.get("pg", "k"))?.value, { a: 2 });
  for (const v of [null, true, 0, "s", [1, { b: [] }]]) assert.deepEqual((await mustPut("pg", "vals", v)).value, v);

  // compare-and-set.
  assert.equal((await mustPut("cas", "k", 1, null)).rev, 1);
  assert.equal((await mustPut("cas", "k", 2, 1)).rev, 2);
  assert.deepEqual(await put("cas", "k", 3, 1), { ok: false, reason: "conflict", currentRev: 2 });
  assert.deepEqual(await put("cas", "k", 3, null), { ok: false, reason: "conflict", currentRev: 2 });
  assert.deepEqual(await put("cas", "never", 3, 5), { ok: false, reason: "conflict", currentRev: 0 });
  assert.deepEqual((await st.get("cas", "k"))?.value, 2, "a conflict writes nothing");
  assert.equal(await st.get("cas", "never"), null);

  // idempotency: same key + same request replays the first result; same key + different request is refused.
  const first = await put("idem", "k", { v: 1 }, undefined, "idem-1");
  assert.deepEqual(await put("idem", "k", { v: 1 }, undefined, "idem-1"), first);
  assert.equal((await st.get("idem", "k"))?.rev, 1, "a replay is not a second write");
  assert.equal(await kindOf(put("idem", "k", { v: 2 }, undefined, "idem-1")), "idempotency-mismatch");
  assert.deepEqual((await st.get("idem", "k"))?.value, { v: 1 });
  const rmFirst = await rm({ owner: "idem", key: "k" }, "idem-rm");
  assert.deepEqual(rmFirst, { ok: true, removed: 1, keys: ["k"] });
  await mustPut("idem", "k", { v: 3 });
  assert.equal(await kindOf(rm({ owner: "idem", key: "other" }, "idem-rm")), "idempotency-mismatch");
  assert.deepEqual(await rm({ owner: "idem", key: "k" }, "idem-rm"), rmFirst, "a replayed remove does not remove the new doc");
  assert.deepEqual((await st.get("idem", "k"))?.value, { v: 3 });

  // remove: tombstone reads as absent everywhere, rev keeps climbing, repeated and unknown removes are no-ops.
  const r1 = await mustPut("rm", "k", "one");
  assert.deepEqual(await rm({ key: "k", expectRev: r1.rev + 1 }), { ok: false, reason: "conflict", currentRev: r1.rev });
  assert.deepEqual(await rm({ key: "never", expectRev: 1 }), { ok: false, reason: "conflict", currentRev: 0 });
  assert.deepEqual(await rm({ key: "k", expectRev: r1.rev }), { ok: true, removed: 1, keys: ["k"] });
  assert.equal(await st.get("rm", "k"), null);
  assert.deepEqual(await st.list("rm"), []);
  assert.deepEqual(await st.export("rm"), []);
  assert.deepEqual(await st.usage("rm"), { docs: 0, bytes: 0 });
  assert.deepEqual(await rm({ key: "k" }), { ok: true, removed: 0, keys: [] });
  assert.deepEqual(await rm({ key: "never" }), { ok: true, removed: 0, keys: [] });
  assert.deepEqual(
    await put("rm", "k", "x", r1.rev),
    { ok: false, reason: "conflict", currentRev: 0 },
    "CAS against a removed doc conflicts, reporting it as absent",
  );
  assert.deepEqual(await rm({ key: "k", expectRev: r1.rev }), { ok: false, reason: "conflict", currentRev: 0 });
  assert.deepEqual(await rm({ key: "k", expectRev: 0 }), { ok: true, removed: 0, keys: [] }, "expectRev 0 on an absent key removes nothing");
  const r2 = await mustPut("rm", "k", "two", 0);
  assert.ok(r2.rev > r1.rev, "rev never restarts after a remove; expectRev 0 means absent, like null");
  assert.deepEqual(await rm({ key: "k", expectRev: 0 }), { ok: false, reason: "conflict", currentRev: r2.rev }, "expectRev 0 on a live key conflicts");
  // A conflict's currentRev is always retryable: retrying with it succeeds, including against a removed doc (currentRev 0).
  await rm({ key: "k" });
  const retry = await put("rm", "k", "three", r1.rev);
  assert.ok(!retry.ok && retry.currentRev === 0);
  assert.ok(((await put("rm", "k", "three", retry.currentRev)) as { ok: boolean }).ok, "retrying with currentRev 0 succeeds");

  // list: key order, prefix, cursor, limit, metadata only.
  for (const k of ["b/1", "a/2", "c", "a/1"]) await mustPut("ls", k, { big: "value" });
  const all = await st.list("ls");
  assert.deepEqual(
    all.map((m) => m.key),
    ["a/1", "a/2", "b/1", "c"],
  );
  assert.ok(all.every((m) => !("value" in m) && m.owner === "ls" && m.rev === 1 && m.bytes > 0));
  assert.deepEqual(
    (await st.list("ls", { prefix: "a/" })).map((m) => m.key),
    ["a/1", "a/2"],
  );
  assert.deepEqual(
    (await st.list("ls", { after: "a/2" })).map((m) => m.key),
    ["b/1", "c"],
  );
  assert.deepEqual(
    (await st.list("ls", { prefix: "a/", after: "a/1" })).map((m) => m.key),
    ["a/2"],
  );
  const paged: string[] = [];
  for (let after: string | undefined; ; ) {
    const page = await st.list("ls", { limit: 3, ...(after ? { after } : {}) });
    assert.ok(page.length <= 3);
    if (page.length === 0) break;
    paged.push(...page.map((m) => m.key));
    after = page[page.length - 1]?.key;
  }
  assert.deepEqual(paged, ["a/1", "a/2", "b/1", "c"]);
  assert.deepEqual(await st.list("no-such-owner"), []);

  // export returns full documents in key order, optionally by prefix.
  const ex = await st.export("ls", { prefix: "a/" });
  assert.deepEqual(
    ex.map((d) => [d.key, d.value]),
    [
      ["a/1", { big: "value" }],
      ["a/2", { big: "value" }],
    ],
  );
  assert.equal((await st.export("ls")).length, 4);

  // remove by prefix, restricted by age.
  // TODO(load-flakes): the real store measures age with Date.now(), so a runner stall longer than the 600 ms window makes old/y removable too.
  // The exact fix is a clock seam on the store, openStateStore({ now }); until then the windows are sized at 10x the observed CI stall.
  for (const k of ["memo/a", "memo/b", "keep/c"]) await mustPut("rp", k, 1);
  assert.deepEqual(await rm({ owner: "rp", prefix: "memo/" }), { ok: true, removed: 2, keys: ["memo/a", "memo/b"] });
  assert.deepEqual(
    (await st.list("rp")).map((m) => m.key),
    ["keep/c"],
  );
  await mustPut("ro", "old/x", 1);
  await w.age(1200);
  await mustPut("ro", "old/y", 1);
  await mustPut("ro", "other", 1);
  assert.deepEqual(await rm({ owner: "ro", prefix: "old/", olderThanMs: 600 }), { ok: true, removed: 1, keys: ["old/x"] });
  assert.deepEqual(
    (await st.list("ro")).map((m) => m.key),
    ["old/y", "other"],
  );
  // malformed removals are refused.
  for (const bad of [{}, { key: "a", prefix: "a" }, { prefix: "a/", expectRev: 1 }, { key: "a", olderThanMs: 1 }, { prefix: "" }]) {
    assert.equal(await kindOf(rm(bad)), "invalid-key");
  }
  // a removal's expectRev is never null (it could not succeed): refused, writing nothing.
  await mustPut("rm", "nullrev", 1);
  assert.equal(await kindOf(rm({ key: "nullrev", expectRev: null })), "invalid-value");
  assert.ok(await st.get("rm", "nullrev"));

  // tombstones are capped per owner: the oldest are purged, and a key put after its tombstone was purged still gets a fresh, higher
  // rev (the owner's rev floor), so a stale CAS token from before the purge can never match again.
  assert.ok(limits.maxTombstones >= 1);
  const tk = (i: number) => `t${String(i).padStart(2, "0")}`;
  const rounds = limits.maxTombstones + 2;
  const lastRev: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const first = await mustPut("tb", tk(i), "a", null);
    lastRev[i] = (await mustPut("tb", tk(i), "b")).rev;
    assert.equal(lastRev[i], first.rev + 1);
    await rm({ owner: "tb", key: tk(i) });
    await w.age(2);
  }
  assert.deepEqual(await st.usage("tb"), { docs: 0, bytes: 0 }, "tombstones stay free");
  const purged = await put("tb", tk(0), "c", lastRev[0]);
  assert.deepEqual(purged, { ok: false, reason: "conflict", currentRev: 0 });
  const reborn = await mustPut("tb", tk(0), "c", 0);
  assert.ok(reborn.rev > (lastRev[0] as number), "a purged key restarts above its old revs");
  const kept = await mustPut("tb", tk(rounds - 1), "c", null);
  assert.equal(kept.rev, (lastRev[rounds - 1] as number) + 1, "a retained tombstone continues its own counter");
  // a never-written key on an owner with no purges starts at 1; the floor is per owner.
  assert.equal((await mustPut("tb2", "t00", "c", null)).rev, 1);

  // idempotency scope is per owner and per writer: the same key under another owner is independent, not a mismatch.
  const shared = await put("idem-a", "k", { v: 1 }, undefined, "shared-key");
  assert.ok(shared.ok);
  const other = await put("idem-b", "k", { v: 2 }, undefined, "shared-key");
  assert.ok(other.ok && other.doc.owner === "idem-b", "owner b's write is not blocked by owner a's key");
  assert.equal((await rm({ owner: "idem-a", key: "k" }, "shared-key")).ok, true, "put and rm scopes are separate too");
  const agentW = await registry.create({ parent: null, name: "iw", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "st-iw", spec: SPEC });
  const asAgent = { agent: agentW.id, host: "h", generation: agentW.generation };
  assert.equal(
    await kindOf(st.put({ owner: "idem-a", key: "k", value: { v: 1 }, writer: asAgent }, "shared-key")),
    "idempotency-mismatch",
    "the same key from a different writer is not a replay of another writer's result",
  );

  // writers: exactly the operator or a full agent shape.
  for (const bad of [
    undefined,
    null,
    {},
    { operator: false },
    { operator: true, agent: "x" },
    { agent: "a", host: "h" },
    { agent: "a", host: "h", generation: -1 },
    { agent: "a", host: "h", generation: 1.5 },
  ]) {
    assert.equal(await kindOf(st.put({ owner: "wr", key: "k", value: 1, writer: bad as never }, id())), "invalid-value", JSON.stringify(bad));
    assert.equal(await kindOf(st.remove({ owner: "wr", key: "k", writer: bad as never }, id())), "invalid-value", JSON.stringify(bad));
  }
  assert.equal(await st.get("wr", "k"), null);
  assert.equal(await kindOf(st.put({ owner: "wr", key: "k", value: 1, writer: { agent: "no-such-agent", host: "h", generation: 1 } }, id())), "unknown-writer");

  // quotas: document count (tombstones free their slot), per-document size, owner bytes; refusals write nothing.
  for (let i = 0; i < limits.maxDocs; i++) await mustPut("qd", `k${i}`, 1);
  assert.equal(await kindOf(put("qd", "extra", 1)), "quota-docs");
  assert.equal(await st.get("qd", "extra"), null);
  assert.equal((await mustPut("qd", "k0", 2)).rev, 2, "overwriting at the limit is allowed");
  await rm({ owner: "qd", key: "k1" });
  assert.equal((await mustPut("qd", "extra", 1)).rev, 1, "a removed doc no longer counts");
  assert.equal(await kindOf(put("qd", "k1", 1)), "quota-docs", "reviving a removed key counts as a new doc");
  assert.deepEqual(await st.usage("qd"), { docs: limits.maxDocs, bytes: limits.maxDocs });

  const half = Math.floor(limits.maxOwnerBytes / 2);
  assert.ok(half <= limits.maxDocBytes && limits.maxDocs >= 2);
  await mustPut("qb", "a", str(half));
  await mustPut("qb", "b", str(half));
  assert.equal(await kindOf(put("qb", "c", str(half))), "quota-owner-bytes");
  assert.equal(await kindOf(put("qb", "a", str(half + 2))), "quota-owner-bytes", "growing a doc counts only its delta");
  assert.equal((await mustPut("qb", "a", str(half))).rev, 2, "same-size overwrite is net zero");
  assert.deepEqual(await st.usage("qb"), { docs: 2, bytes: half * 2 });
  assert.equal(await kindOf(put("sz", "k", str(limits.maxDocBytes + 1))), "too-large");
  assert.equal((await mustPut("sz", "k", str(limits.maxDocBytes))).bytes, limits.maxDocBytes);

  // invalid keys, owners and values are refused with a typed error; valid edge cases are accepted.
  for (const key of ["", "A", "a//b", "/a", "a/", "../x", "a/../b", "a..b", "a b", "-a", "x".repeat(129)]) {
    assert.equal(await kindOf(put("iv", key, 1)), "invalid-key", `key ${JSON.stringify(key)}`);
  }
  for (const key of ["a.b-c_d/e", "x".repeat(128), "0"]) await mustPut("iv", key, 1);
  for (const owner of ["", "Bad Owner", "-x", "a/b"]) assert.equal(await kindOf(put(owner, "k", 1)), "invalid-key", `owner ${JSON.stringify(owner)}`);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const v of [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => 1, cyclic, { u: undefined }]) {
    assert.equal(await kindOf(put("iv", "val", v)), "invalid-value");
  }
  assert.equal(await st.get("iv", "val"), null);
  assert.equal(await kindOf(put("iv", "val", 1, -1)), "invalid-value");

  // stale agent writers are fenced; a current generation writes and is recorded.
  const a = await registry.create({ parent: null, name: "sw", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "st-a", spec: SPEC });
  const writer = { agent: a.id, host: "h", generation: a.generation };
  const wr = await st.put({ owner: "fence", key: "k", value: 1, writer }, id());
  assert.ok(wr.ok && JSON.stringify(wr.doc.writer) === JSON.stringify(writer));
  await registry.bumpGeneration(a.id, "h", "st-bump");
  await assert.rejects(() => st.put({ owner: "fence", key: "k", value: 2, writer }, id()), StaleGenerationError);
  await assert.rejects(() => st.remove({ owner: "fence", key: "k", writer }, id()), StaleGenerationError);
  await assert.rejects(() => st.remove({ owner: "fence", prefix: "k", writer }, id()), StaleGenerationError);
  assert.deepEqual((await st.get("fence", "k"))?.value, 1, "a stale writer changed nothing");
  const fresh = { ...writer, generation: writer.generation + 1 };
  assert.ok((await st.put({ owner: "fence", key: "k", value: 3, writer: fresh }, id())).ok);

  // A workflow writer must carry a well-formed fence (the task it runs as; core checkStateFence). The fence is checked against the
  // registry inside the write but left out of the fingerprint and the stored writer; the writer is fingerprinted by workflow +
  // instance (core stateWriterId), so a repaired task replays and every other principal reusing the key is a different request.
  const wf = { workflow: "ext/desk", instance: "daily" };
  const t1 = await registry.create({ parent: null, name: "wf1", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "st-wf1", spec: SPEC });
  const t2 = await registry.create({ parent: null, name: "wf2", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "st-wf2", spec: SPEC });
  const f1 = { agent: t1.id, generation: t1.generation };
  const f2 = { agent: t2.id, generation: t2.generation };
  assert.equal(await kindOf(st.put({ owner: "wf", key: "k", value: 1, writer: wf }, id())), "invalid-value", "a workflow put without a fence");
  assert.equal(await kindOf(st.remove({ owner: "wf", key: "k", writer: wf }, id())), "invalid-value", "a workflow rm without a fence");
  for (const fence of [null, { agent: "", generation: 1 }, { agent: t1.id }, { agent: t1.id, generation: -1 }, { ...f1, extra: 1 }])
    assert.equal(await kindOf(st.put({ owner: "wf", key: "k", value: 1, writer: wf, fence: fence as never }, id())), "invalid-value", JSON.stringify(fence));
  assert.equal(await st.get("wf", "k"), null, "a refused workflow write changed nothing");
  const wk = id();
  const wp = await st.put({ owner: "wf", key: "k", value: 1, writer: wf, fence: f1 }, wk);
  assert.ok(wp.ok);
  assert.deepEqual(wp.doc.writer, wf, "the fence is not stored");
  assert.deepEqual(await st.put({ owner: "wf", key: "k", value: 1, writer: { ...wf }, fence: f2 }, wk), wp, "a repaired task (another fence) replays");
  const t2Agent = { agent: t2.id, host: "h", generation: t2.generation };
  for (const other of [{ ...wf, instance: "other" }, { workflow: "ext/scan", instance: "daily" }, t2Agent, op])
    assert.equal(
      await kindOf(st.put({ owner: "wf", key: "k", value: 1, writer: other, ...("workflow" in other && { fence: f1 }) }, wk)),
      "idempotency-mismatch",
      JSON.stringify(other),
    );
  assert.equal(await kindOf(st.put({ owner: "wf", key: "k", value: 2, writer: wf, fence: { agent: "ghost", generation: 0 } }, id())), "unknown-writer");
  await registry.bumpGeneration(t1.id, "h", "st-wf-bump");
  await assert.rejects(() => st.put({ owner: "wf", key: "k", value: 2, writer: wf, fence: f1 }, id()), StaleGenerationError);
  await assert.rejects(() => st.remove({ owner: "wf", key: "k", writer: wf, fence: f1 }, id()), StaleGenerationError);
  assert.deepEqual((await st.get("wf", "k"))?.value, 1, "a stale fence changed nothing");
}
