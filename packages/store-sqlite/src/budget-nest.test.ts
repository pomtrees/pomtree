import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetLedger, encodeGatewayCredential, ledgerFits, POMTREED_KINDS, RootWithdrawalError } from "@pomtree/core";
import type { AgentId, AgentRecord, RequestReservation } from "@pomtree/core";
import { openStore } from "./store.ts";
import type { Store } from "./store.ts";

const secret = "nest-secret";
const spec = { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" as const } };
const keyFor = (agent: string, budgetMicros: number) =>
  encodeGatewayCredential(secret, { agent, id: "c".repeat(32), budgetMicros, expiresAt: Date.now() + 3_600_000, issuedAt: 1, models: ["m"] });

async function agent(s: Store, id: string, parent: string | null, budgetMicros: number): Promise<AgentRecord> {
  const a = await s.registry.create({ id, parent, name: id, task: "t", host: "h1", budgetMicros, idempotencyKey: `create:${id}`, spec });
  return s.registry.transition(a.id, 0, "running", { idempotencyKey: `run:${id}` });
}
async function reap(s: Store, id: string): Promise<void> {
  await s.registry.transition(id, 0, "exited", { idempotencyKey: `exit:${id}`, exit: "ok" } as never);
  await s.registry.transition(id, 0, "reaped", { idempotencyKey: `reap:${id}` });
}

test("budget-nest: a $1 parent that carves $0.90 to a child cannot spend $1.90 between them", async () => {
  const s = openStore();
  const debits = s.modelDebit({ secret });
  await agent(s, "root", null, 10_000_000);
  await agent(s, "p", "root", 1_000_000);
  await agent(s, "c", "p", 900_000);
  // The child's carve is out of the parent's reach: the parent can reserve only the $0.10 it kept.
  assert.equal(debits.reserve(keyFor("p", 1_000_000), "p-1", 100_001).ok, false);
  const p1 = debits.reserve(keyFor("p", 1_000_000), "p-2", 100_000);
  assert.ok(p1.ok);
  debits.settle(p1.reservation, 100_000);
  const c1 = debits.reserve(keyFor("c", 900_000), "c-1", 900_000);
  assert.ok(c1.ok, "the child spends its whole carve");
  debits.settle(c1.reservation, 900_000);
  assert.equal(debits.reserve(keyFor("p", 1_000_000), "p-3", 1).ok, false);
  assert.equal(debits.reserve(keyFor("c", 900_000), "c-2", 1).ok, false);
  assert.equal(debits.spentFor("p") + debits.spentFor("c"), 1_000_000, "total spend is the parent's budget, never 1.9x");
  assert.deepEqual(debits.ledgerFor("p"), { budgetMicros: 1_000_000, committedMicros: 1_000_000, remainingMicros: 0, overageMicros: 0 });
  assert.deepEqual(debits.ledgerFor("root"), { budgetMicros: 10_000_000, committedMicros: 1_000_000, remainingMicros: 9_000_000, overageMicros: 0 });
  s.close();
});

test("overage-book: a reaped child's unused carve returns to the parent, and an overage beyond its carve stays booked", async () => {
  const s = openStore();
  const debits = s.modelDebit({ secret });
  await agent(s, "root", null, 10_000_000);
  await agent(s, "p", "root", 1_000_000);
  await agent(s, "c1", "p", 300_000);
  await agent(s, "c2", "p", 300_000);
  const a = debits.reserve(keyFor("c1", 300_000), "a", 100_000);
  assert.ok(a.ok);
  debits.settle(a.reservation, 100_000); // c1 uses 0.10 of its 0.30
  const b = debits.reserve(keyFor("c2", 300_000), "b", 300_000);
  assert.ok(b.ok);
  debits.settle(b.reservation, 450_000); // c2's provider bill overshoots its 0.30 carve by 0.15
  assert.equal(debits.ledgerFor("c2").overageMicros, 150_000);
  // Live: c1 holds its carve (0.30), c2 holds what it consumed (0.45).
  assert.equal(debits.ledgerFor("p").committedMicros, 750_000);
  await reap(s, "c1");
  await reap(s, "c2");
  // Reaped: c1 returns 0.20 and books 0.10; c2 books its 0.45 (max(carve, consumed)), the 0.15 a write-off against p.
  assert.equal(debits.ledgerFor("p").committedMicros, 550_000);
  assert.equal(debits.ledgerFor("p").remainingMicros, 450_000);
  s.close();
});

// Deterministic PRNG (mulberry32) so the property run is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("budget-nest invariant: sum of balances + provider spend = top-ups - withdrawals over random spawn/carve/spend/reap/raise/withdraw", async () => {
  for (const seed of [1, 2, 3, 0xc0ffee, 0xdecaf]) {
    const rnd = mulberry32(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const s = openStore();
    const debits = s.modelDebit({ secret });
    // The initial pool counts as the first top-up.
    let toppedUp = 5_000_000;
    let withdrawn = 0;
    await agent(s, "root", null, toppedUp);
    const live = new Set<AgentId>();
    const parentOf = new Map<AgentId, AgentId>();
    const inflight: { r: RequestReservation; max: number }[] = [];
    let overshootAllowed = 0;
    let n = 0;
    const view = async () => {
      const rows = await s.registry.list();
      return budgetLedger(
        rows.map((a) => ({
          id: a.id,
          parent: a.parent,
          budgetMicros: a.budgetMicros,
          live: a.state !== "reaped",
          usedMicros: a.parent === null ? 0 : debits.ledgerFor(a.id).committedMicros - childHeld(a.id, rows),
        })),
      );
    };
    // own use = committed - what the children hold, read back from the store's own ledger
    const childHeld = (id: AgentId, rows: AgentRecord[]): number =>
      rows
        .filter((c) => c.parent === id)
        .reduce(
          (x, c) => x + (c.state !== "reaped" ? Math.max(c.budgetMicros, debits.ledgerFor(c.id).committedMicros) : debits.ledgerFor(c.id).committedMicros),
          0,
        );
    for (let step = 0; step < 250; step++) {
      const op = rnd();
      const nodes = ["root", ...live];
      if (op < 0.2) {
        // spawn: carve from a live node (or the root) only when the ledger admits it, as the daemon's spawn check does
        const parent = pick(nodes);
        const carve = 1 + Math.floor(rnd() * 800_000);
        const v = await view();
        if (!ledgerFits(v, parent, carve).ok) continue;
        const id = `a${n++}`;
        await agent(s, id, parent, carve);
        live.add(id);
        parentOf.set(id, parent);
      } else if (op < 0.55 && live.size > 0) {
        const who = pick([...live]);
        const max = 1 + Math.floor(rnd() * 300_000);
        const r = debits.reserve(keyFor(who, 0), `r${step}`, max);
        if (r.ok) inflight.push({ r: r.reservation, max });
      } else if (op < 0.8 && inflight.length > 0) {
        const i = Math.floor(rnd() * inflight.length);
        const { r, max } = inflight.splice(i, 1)[0]!;
        const roll = rnd();
        if (roll < 0.15) debits.cancel(r);
        else {
          // occasionally the provider bills past the reservation (a true overage)
          const charge = roll > 0.95 ? max + Math.floor(rnd() * 50_000) : Math.floor(rnd() * (max + 1));
          overshootAllowed += Math.max(0, charge - max);
          debits.settle(r, charge);
        }
      } else if (op < 0.9) {
        // reap a live leaf whose own reservations are all settled
        const leaves = [...live].filter((id) => ![...live].some((c) => parentOf.get(c) === id) && !inflight.some((x) => x.r.agent === id));
        if (leaves.length === 0) continue;
        const id = pick(leaves);
        await reap(s, id);
        live.delete(id);
      } else {
        // An operator top-up or withdrawal of the root moves the conserved total (setRootPool, the daemon's one path); an
        // ancestor's raise of a child moves budget inside the tree.
        const r = rnd();
        if (r < 0.3) {
          const delta = 1 + Math.floor(rnd() * 500_000);
          const pool = (await s.registry.get("root"))!.budgetMicros;
          await s.registry.setRootPool("root", pool + delta, `topup${step}`);
          toppedUp += delta;
        } else if (r < 0.5) {
          // A withdrawal of up to the unheld remainder lands; one past it is refused in full and changes nothing.
          const pool = (await s.registry.get("root"))!.budgetMicros;
          const available = Math.max(0, debits.ledgerFor("root").remainingMicros);
          const ask = Math.min(pool, Math.floor(rnd() * (available + 200_000)));
          if (ask <= available) {
            await s.registry.setRootPool("root", pool - ask, `withdraw${step}`);
            withdrawn += ask;
          } else await assert.rejects(s.registry.setRootPool("root", pool - ask, `withdraw${step}`), RootWithdrawalError);
        } else if (live.size > 0) {
          const child = pick([...live]);
          const delta = 1 + Math.floor(rnd() * 100_000);
          if (!ledgerFits(await view(), parentOf.get(child)!, delta).ok) continue;
          await s.registry.raiseBudget(child, delta, `raise${step}`);
        }
      }
      // The invariant, from the store's own ledger.
      const rows = await s.registry.list();
      let balances = debits.ledgerFor("root").remainingMicros;
      let use = 0;
      for (const a of rows) {
        if (a.parent === null) continue;
        const l = debits.ledgerFor(a.id);
        if (a.state !== "reaped") balances += Math.max(0, l.remainingMicros);
        use += l.committedMicros - childHeld(a.id, rows);
      }
      const spend = rows.reduce((x, a) => x + debits.spentFor(a.id), 0);
      const reserved = inflight.reduce((x, f) => x + f.max, 0);
      assert.equal(use, spend + reserved, `seed ${seed} step ${step}: own use is settled spend plus in-flight reservations`);
      // Σ balances + Σ provider spend (settled and in flight) = Σ top-ups − Σ withdrawals, and the journal agrees with the counts.
      assert.equal(balances + use, toppedUp - withdrawn, `seed ${seed} step ${step}: balances + spend + reserved = top-ups - withdrawals`);
      // Without overshoot the tree never spends past what the operator injected.
      assert.ok(
        spend <= toppedUp - withdrawn + overshootAllowed,
        `seed ${seed} step ${step}: spend ${spend} within top-ups ${toppedUp} - withdrawals ${withdrawn} + overshoot ${overshootAllowed}`,
      );
    }
    let journaled = 5_000_000;
    for (const e of await s.journal.read({ agent: "root" })) {
      const p = e.payload as unknown as { kind: string; from: number; to: number };
      if (p.kind === POMTREED_KINDS.budgetTopUp || p.kind === POMTREED_KINDS.budgetWithdrawal) journaled += p.to - p.from;
    }
    assert.equal(journaled, toppedUp - withdrawn, `seed ${seed}: the journaled injections replay to the pool's total`);
    s.close();
  }
});
