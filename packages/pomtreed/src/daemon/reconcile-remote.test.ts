import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxUnavailableError } from "@pomtree/core";
import type { AgentRecord, SandboxListing, SandboxOwner } from "@pomtree/core";
import {
  type RemoteReconcileAction,
  type RemoteReconcilePlan,
  applyRemoteReconcile,
  planRemoteReconcile,
  planRemoteReconcileFromBackend,
  reconcileKillKey,
} from "./reconcile-remote.ts";

const owner = { host: "h1", storeId: "st1", epoch: 5 } as unknown as SandboxOwner;
const BACKEND = "fake-remote";
const GRACE = 1000;

function rec(o: Partial<AgentRecord> & { id: string }): AgentRecord {
  return { state: "running", host: "h1", generation: 2, sandbox: `sb-${o.id}`, sandboxBackend: BACKEND, ...o } as unknown as AgentRecord;
}
function sb(o: Partial<SandboxListing> & { id: string; agent: string }): SandboxListing {
  return {
    backend: BACKEND,
    host: "h1",
    generation: 2,
    state: "running",
    labels: { store_id: "st1", daemon_epoch: "5" },
    ...o,
  } as unknown as SandboxListing;
}
const plan = (records: AgentRecord[], listing: SandboxListing[], extra: { now?: number; alerted?: Map<string, number>; confirmed?: Set<string> } = {}) =>
  planRemoteReconcile({
    records,
    listing,
    owner,
    backend: BACKEND,
    now: extra.now ?? 10_000,
    graceMs: GRACE,
    ...(extra.alerted ? { alerted: extra.alerted } : {}),
    ...(extra.confirmed ? { confirmedAbsent: extra.confirmed } : {}),
  });
const one = (p: ReturnType<typeof plan>, id: string): RemoteReconcileAction => {
  const a = p.actions.find((x) => x.sandbox === id);
  assert.ok(a, `no action for ${id}`);
  return a;
};

test("attach: running record, live sandbox, same generation", () => {
  const p = plan([rec({ id: "a1" })], [sb({ id: "sb-a1", agent: "a1" })]);
  assert.equal(one(p, "sb-a1").kind, "attach");
  assert.deepEqual(p.lost, []);
});

test("kill: record terminal (exited, reaped, yielded) with the sandbox alive", () => {
  for (const state of ["exited", "reaped", "yielded"] as const) {
    const p = plan([rec({ id: "a1", state })], [sb({ id: "sb-a1", agent: "a1" })]);
    assert.equal(one(p, "sb-a1").kind, "kill", state);
  }
});

test("kill: an older-generation sandbox of ours is killed, never attached", () => {
  const p = plan([rec({ id: "a1", generation: 3 })], [sb({ id: "sb-a1", agent: "a1", generation: 2 })]);
  assert.equal(one(p, "sb-a1").kind, "kill");
});

test("ignore: a newer-generation sandbox is not attached or killed (the record may be behind)", () => {
  const p = plan([rec({ id: "a1", generation: 2 })], [sb({ id: "sb-a1", agent: "a1", generation: 3 })]);
  assert.equal(one(p, "sb-a1").kind, "ignore");
});

test("kill: a second sandbox for an agent whose record names another one is superseded", () => {
  const p = plan([rec({ id: "a1", sandbox: "sb-new" })], [sb({ id: "sb-old", agent: "a1" }), sb({ id: "sb-new", agent: "a1" })]);
  assert.equal(one(p, "sb-old").kind, "kill");
  assert.equal(one(p, "sb-new").kind, "attach");
});

test("attach: a running record with no sandbox id yet adopts the live same-generation sandbox (crash before setSandbox)", () => {
  const p = plan([rec({ id: "a1", sandbox: null })], [sb({ id: "sb-a1", agent: "a1" })]);
  assert.equal(one(p, "sb-a1").kind, "attach");
});

test("ignore: an ended (exited or stopped) sandbox of a running record is left to the exit path", () => {
  for (const state of ["exited", "stopped", "unknown"] as const) {
    const p = plan([rec({ id: "a1" })], [sb({ id: "sb-a1", agent: "a1", state })]);
    assert.equal(one(p, "sb-a1").kind, "ignore", state);
  }
});

test("ownership: unowned, foreign-store, newer-epoch, other-host and untagged sandboxes are ignored, even when they look killable", () => {
  const mismatched: SandboxListing[] = [
    sb({ id: "unowned", agent: "ghost", labels: undefined, host: null, generation: null }),
    sb({ id: "no-store", agent: "ghost", labels: { daemon_epoch: "5" } }),
    sb({ id: "foreign-store", agent: "ghost", labels: { store_id: "other", daemon_epoch: "5" } }),
    sb({ id: "newer-epoch", agent: "ghost", labels: { store_id: "st1", daemon_epoch: "6" } }),
    sb({ id: "bad-epoch", agent: "ghost", labels: { store_id: "st1", daemon_epoch: "x" } }),
    sb({ id: "other-host", agent: "ghost", host: "h2" }),
    sb({ id: "no-generation", agent: "ghost", generation: null }),
  ];
  const p = plan([], mismatched);
  for (const s of mismatched) assert.equal(one(p, s.id).kind, "ignore", s.id);
  // control: the same sandbox with proving tags and no record is acted on
  assert.equal(one(plan([], [sb({ id: "ours", agent: "ghost" })]), "ours").kind, "alert-and-kill");
});

test("ownership: a foreign sandbox stays untouched through the executor (control: skipping the ownership check kills it)", async () => {
  const calls: string[] = [];
  const deps = {
    kill: async (id: string) => void calls.push(`kill:${id}`),
    attach: async (id: string) => void calls.push(`attach:${id}`),
    alert: async (_m: string, id: string) => void calls.push(`alert:${id}`),
  };
  const foreign = sb({ id: "foreign", agent: "ghost", labels: { store_id: "other", daemon_epoch: "5" } });
  await applyRemoteReconcile(plan([], [foreign]), deps);
  assert.deepEqual(calls, []);
  // the control: the record-only decision for the same sandbox, had ownership passed, is a kill path
  const wouldBe = plan([], [{ ...foreign, labels: { store_id: "st1", daemon_epoch: "5" } }]);
  assert.equal(one(wouldBe, "foreign").kind, "alert-and-kill");
});

test("alert-and-kill: first sight alerts only; the kill waits for the grace window on the injected clock", () => {
  const listing = [sb({ id: "stray", agent: "ghost" })];
  const first = one(plan([], listing), "stray");
  assert.deepEqual(first.kind === "alert-and-kill" && [first.alert, first.kill], [true, false]);
  const alerted = new Map([["stray", 5000]]);
  const early = one(plan([], listing, { now: 5000 + GRACE - 1, alerted }), "stray");
  assert.deepEqual(early.kind === "alert-and-kill" && [early.alert, early.kill], [false, false]);
  const due = one(plan([], listing, { now: 5000 + GRACE, alerted }), "stray");
  assert.deepEqual(due.kind === "alert-and-kill" && [due.alert, due.kill], [false, true]);
});

test("lost is advisory: absent sandboxes are only suspected until the caller confirms them", () => {
  const unconfirmed = plan([rec({ id: "a1" })], []);
  assert.deepEqual(unconfirmed.lost, []);
  assert.deepEqual(unconfirmed.suspectedLost, [{ agent: "a1", sandbox: "sb-a1", cause: "sandbox_unavailable" }]);
  const confirmed = plan([rec({ id: "a1" })], [], { confirmed: new Set(["sb-a1"]) });
  assert.deepEqual(confirmed.lost, [{ agent: "a1", sandbox: "sb-a1", cause: "sandbox_unavailable" }]);
  assert.deepEqual(confirmed.suspectedLost, []);
});

test("lost: negative variants (not running, other host, other backend, no sandbox, still listed) are neither lost nor suspected", () => {
  const records = [
    rec({ id: "done", state: "exited" }),
    rec({ id: "far", host: "h2" }),
    rec({ id: "elsewhere", sandboxBackend: "other-backend" }),
    rec({ id: "none", sandbox: null }),
    rec({ id: "present" }),
  ];
  const everything = new Set(records.map((r) => `sb-${r.id}`));
  const p = plan(records, [sb({ id: "sb-present", agent: "present" })], { confirmed: everything });
  assert.deepEqual(p.lost, []);
  assert.deepEqual(p.suspectedLost, []);
});

test("listing errors produce no actions and a typed unavailable result", async () => {
  for (const err of [new SandboxUnavailableError("provider-outage"), new Error("boom")]) {
    const r = await planRemoteReconcileFromBackend(
      async () => {
        throw err;
      },
      { records: [rec({ id: "a1" })], owner, backend: BACKEND, now: 0, graceMs: GRACE },
    );
    assert.equal(r.kind, "unavailable");
    assert.ok(r.kind === "unavailable" && /nothing was attached or killed/.test(r.message) && /retry/.test(r.message));
    assert.ok(!("actions" in r));
  }
  const ok = await planRemoteReconcileFromBackend(async () => [], { records: [rec({ id: "a1" })], owner, backend: BACKEND, now: 0, graceMs: GRACE });
  assert.equal(ok.kind, "plan"); // control: an empty successful listing is a plan (suspecting the record lost), not unavailable
  assert.ok(ok.kind === "plan" && ok.suspectedLost.length === 1);
});

test("executor: a failure on one sandbox does not stop the others and is reported", async () => {
  const calls: string[] = [];
  const deps = {
    kill: async (id: string) => {
      calls.push(`kill:${id}`);
      if (id === "k1") throw new Error("api 500");
    },
    attach: async (id: string) => void calls.push(`attach:${id}`),
    alert: async (_m: string, id: string) => void calls.push(`alert:${id}`),
  };
  const p = plan(
    [rec({ id: "a1" }), rec({ id: "a2", state: "exited" }), rec({ id: "a3", state: "exited" })],
    [sb({ id: "k1", agent: "a2" }), sb({ id: "k2", agent: "a3" }), sb({ id: "sb-a1", agent: "a1" }), sb({ id: "stray", agent: "ghost" })],
  );
  const r = await applyRemoteReconcile(p, deps);
  assert.deepEqual(r.killed, ["k2"]);
  assert.deepEqual(r.attached, ["sb-a1"]);
  assert.deepEqual(r.alerted, ["stray"]);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0]?.sandbox, "k1");
  assert.match(r.failures[0]?.message ?? "", /api 500/);
  assert.match(r.failures[0]?.message ?? "", /next reconcile pass retries/);
});

test("executor: a failed alert withholds that sandbox's kill, and the others still run", async () => {
  const calls: string[] = [];
  const deps = {
    kill: async (id: string) => void calls.push(`kill:${id}`),
    attach: async () => {},
    alert: async (_m: string, id: string) => {
      if (id === "s1") throw new Error("notify down");
    },
  };
  const plan2: RemoteReconcilePlan = {
    backend: BACKEND,
    lost: [],
    suspectedLost: [],
    actions: [
      { kind: "alert-and-kill", sandbox: "s1", agent: "g1", alert: true, kill: true, reason: "forced" },
      { kind: "alert-and-kill", sandbox: "s2", agent: "g2", alert: false, kill: true, reason: "forced" },
    ],
  };
  const r = await applyRemoteReconcile(plan2, deps);
  assert.deepEqual(calls, ["kill:s2"]);
  assert.equal(r.failures[0]?.step, "alert");
});

test("executor: kill carries the deterministic idempotency key", async () => {
  const keys: string[] = [];
  const deps = { kill: async (_id: string, key: string) => void keys.push(key), attach: async () => {}, alert: async () => {} };
  const p = plan([rec({ id: "a1", state: "exited" })], [sb({ id: "sb-a1", agent: "a1" })]);
  await applyRemoteReconcile(p, deps);
  await applyRemoteReconcile(p, deps);
  assert.deepEqual(keys, [`${BACKEND}:sb-a1:reconcile-kill`, `${BACKEND}:sb-a1:reconcile-kill`]);
  assert.equal(reconcileKillKey(BACKEND, "sb-a1"), keys[0]);
});

test("generation fence first: our newer-generation sandbox is ignored under every record state", () => {
  for (const state of ["running", "exited", "reaped", "yielded", "pending"] as const) {
    const p = plan([rec({ id: "a1", state, generation: 2 })], [sb({ id: "sb-a1", agent: "a1", generation: 3 })]);
    assert.equal(one(p, "sb-a1").kind, "ignore", state);
  }
});

test("a record on another backend can neither kill nor attach", () => {
  const other = { sandboxBackend: "other-backend" };
  const killable = plan([rec({ id: "a1", state: "exited", ...other })], [sb({ id: "sb-a1", agent: "a1" })]);
  assert.equal(one(killable, "sb-a1").kind, "ignore");
  const superseded = plan([rec({ id: "a1", sandbox: "sb-x", ...other })], [sb({ id: "sb-a1", agent: "a1" })]);
  assert.equal(one(superseded, "sb-a1").kind, "ignore");
  const attachable = plan([rec({ id: "a1", ...other })], [sb({ id: "sb-a1", agent: "a1" })]);
  assert.equal(one(attachable, "sb-a1").kind, "ignore");
  // control: the same records on our backend act
  assert.equal(one(plan([rec({ id: "a1", state: "exited" })], [sb({ id: "sb-a1", agent: "a1" })]), "sb-a1").kind, "kill");
});

test("a record with no sandbox id: two same-generation sandboxes are ambiguous (alert only), exactly one attaches", () => {
  const two = plan([rec({ id: "a1", sandbox: null })], [sb({ id: "x1", agent: "a1" }), sb({ id: "x2", agent: "a1" })]);
  for (const id of ["x1", "x2"]) {
    const a = one(two, id);
    assert.equal(a.kind, "alert", id);
    assert.ok(a.kind === "alert" && a.alert && /ambiguous/.test(a.reason));
  }
  const again = plan([rec({ id: "a1", sandbox: null })], [sb({ id: "x1", agent: "a1" }), sb({ id: "x2", agent: "a1" })], {
    alerted: new Map([["x1", 1]]),
  });
  assert.ok(((a) => a.kind === "alert" && !a.alert)(one(again, "x1")));
  assert.equal(one(plan([rec({ id: "a1", sandbox: null })], [sb({ id: "x1", agent: "a1" })]), "x1").kind, "attach");
});

test("executor: an ambiguous sandbox is alerted once and never killed or attached", async () => {
  const calls: string[] = [];
  const deps = {
    kill: async (id: string) => void calls.push(`kill:${id}`),
    attach: async (id: string) => void calls.push(`attach:${id}`),
    alert: async (_m: string, id: string) => void calls.push(`alert:${id}`),
  };
  const p = plan([rec({ id: "a1", sandbox: null })], [sb({ id: "x1", agent: "a1" }), sb({ id: "x2", agent: "a1" })]);
  await applyRemoteReconcile(p, deps);
  assert.deepEqual(calls, ["alert:x1", "alert:x2"]);
});

test("a record on another host leaves our sandbox alone, even for a terminal record or an older generation", () => {
  const p = plan([rec({ id: "a1", host: "h2", generation: 3 })], [sb({ id: "sb-a1", agent: "a1", generation: 2 })]);
  assert.equal(one(p, "sb-a1").kind, "ignore");
  const term = plan([rec({ id: "a1", host: "h2", state: "exited", generation: 2 })], [sb({ id: "sb-a1", agent: "a1", generation: 2 })]);
  assert.equal(one(term, "sb-a1").kind, "ignore");
});

test("pending record: our same-generation sandbox is ignored (it may be mid-start)", () => {
  const p = plan([rec({ id: "a1", state: "pending", sandbox: null })], [sb({ id: "sb-a1", agent: "a1" })]);
  assert.equal(one(p, "sb-a1").kind, "ignore");
});

test("foreign-store and newer-epoch sandboxes are untouched under EVERY record state", () => {
  const foreign = { store_id: "other", daemon_epoch: "5" };
  const newer = { store_id: "st1", daemon_epoch: "6" };
  const states = ["running", "exited", "pending", "reaped", "yielded"] as const;
  for (const labels of [foreign, newer]) {
    for (const state of states) {
      const p = plan([rec({ id: "a1", state, generation: 3 })], [sb({ id: "x", agent: "a1", generation: 2, labels })]);
      assert.equal(one(p, "x").kind, "ignore", `${labels.store_id}/${labels.daemon_epoch} ${state}`);
    }
    assert.equal(one(plan([], [sb({ id: "x", agent: "ghost", labels })]), "x").kind, "ignore"); // no record
  }
});

test("ownership: malformed epoch and generation values are never ours", () => {
  for (const epoch of ["", " ", " 5", "5 ", "0x5", "5.0", "1e1", "-1", "NaN", "+5", "99999999999999999999"]) {
    const p = plan([], [sb({ id: "x", agent: "ghost", labels: { store_id: "st1", daemon_epoch: epoch } })]);
    assert.equal(one(p, "x").kind, "ignore", JSON.stringify(epoch));
  }
  for (const generation of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, 2 ** 60]) {
    const p = plan([], [sb({ id: "x", agent: "ghost", generation })]);
    assert.equal(one(p, "x").kind, "ignore", String(generation));
  }
  const nanOwner = { ...owner, epoch: Number.NaN } as SandboxOwner;
  const r = planRemoteReconcile({ records: [], listing: [sb({ id: "x", agent: "ghost" })], owner: nanOwner, backend: BACKEND, now: 0, graceMs: GRACE });
  assert.equal(one(r, "x").kind, "ignore");
  // control: a plain integer epoch at or below ours is accepted
  for (const epoch of ["0", "5"]) {
    assert.equal(one(plan([], [sb({ id: "x", agent: "ghost", labels: { store_id: "st1", daemon_epoch: epoch } })]), "x").kind, "alert-and-kill");
  }
});

test("a record with a NaN generation never attaches or kills", () => {
  const p = plan([rec({ id: "a1", generation: Number.NaN })], [sb({ id: "sb-a1", agent: "a1" })]);
  assert.equal(one(p, "sb-a1").kind, "ignore");
});

test("duplicate listing ids yield one action; a foreign-backend entry yields none", () => {
  const p = plan(
    [rec({ id: "a1" })],
    [sb({ id: "sb-a1", agent: "a1" }), sb({ id: "sb-a1", agent: "a1" }), sb({ id: "elsewhere", agent: "a1", backend: "other-backend" } as never)],
  );
  assert.deepEqual(
    p.actions.map((a) => a.sandbox),
    ["sb-a1"],
  );
});
