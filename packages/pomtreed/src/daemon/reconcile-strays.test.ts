import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxUnavailableError } from "@pomtree/core";
import type { Sandbox } from "@pomtree/core";
import { FakeSandbox } from "@pomtree/testing";
import { setup, spawnSpec } from "../test-setup.ts";

// The periodic strays phase and the egress reclaim over the active set of backends: the selected one plus every backend a
// non-terminal record of this host names. A non-selected backend is judged by the strict ownership predicate (`ownedByUs`).

const spec = (agent: string, labels: Record<string, string | undefined> = {}) => {
  const l: Record<string, string> = { daemon_epoch: "0", store_id: "store-1" };
  for (const [k, v] of Object.entries(labels)) {
    if (v === undefined) delete l[k];
    else l[k] = v;
  }
  return { host: "h1", generation: 0, agent, image: "img", env: {}, mounts: [], labels: l };
};
// The real adapters report host and generation on the listing; the fake takes them from the `test_host` / `test_gen` labels.
const other = (backend = "other") => {
  const sb = new FakeSandbox([], "graceful", { declaration: { backend } });
  const list = sb.list.bind(sb);
  sb.list = async (owner) =>
    (await list(owner)).map((x) => ({
      ...x,
      host: x.labels?.test_host ?? "h1",
      generation: x.labels?.test_gen === "none" ? null : 0,
    }));
  return sb;
};
const make = () => setup(async () => {}, { storeId: "store-1" });
type T = ReturnType<typeof make>;
const wire = (t: T, backends: Record<string, Sandbox>) => {
  const d = t.daemon.deps;
  d.sandboxFor = (id) => (id === d.sandbox.declaration.backend ? d.sandbox : backends[id]);
};
// A running agent of this host holding a started sandbox of `sb` pinned to `backend`.
async function holder(t: T, name: string, sb: FakeSandbox, backend: string) {
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name, task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: name });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${name}-run` });
  const s = await sb.start(spec(a.id), `${name}-start`);
  await reg.setSandbox(a.id, a.generation, s.id, `${name}-sb`, backend);
  return { agent: a, sandbox: s.id };
}
const strayAlerts = async (t: T) => {
  const root = await t.daemon.root();
  const es = await t.journal.read({ agent: root.id });
  return es.flatMap((e) =>
    e.payload.kind === "error" && (e.payload as { message: string }).message.startsWith("stray container") ? [(e.payload as { message: string }).message] : [],
  );
};

test("strays: a running, provably ours sandbox with no record on a non-selected backend is alerted after two passes and never killed", async () => {
  const t = make();
  const o = other();
  wire(t, { other: o });
  await holder(t, "mine", o, "other"); // puts "other" in the active set
  const stray = await o.start(spec("ghost"), "ghost-start");
  await t.daemon.reconcile();
  assert.deepEqual(await strayAlerts(t), [], "seen once: nothing yet");
  await t.daemon.reconcile();
  const alerts = await strayAlerts(t);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, new RegExp(stray.id));
  assert.equal(o.running.get(stray.id)?.exitCode, null, "read-only: still running");
  assert.deepEqual(
    o.killCalls.filter((k) => JSON.stringify(k).includes(stray.id)),
    [],
  );
});

test("strays: a record's own sandbox on its own backend is not a stray", async () => {
  const t = make();
  const o = other();
  wire(t, { other: o });
  await holder(t, "mine", o, "other");
  await t.daemon.reconcile();
  await t.daemon.reconcile();
  assert.deepEqual(await strayAlerts(t), []);
});

const foreign: [string, Record<string, string | undefined>][] = [
  ["no store_id", { store_id: undefined }],
  ["another store_id", { store_id: "store-2" }],
  ["another host", { test_host: "h2" }],
  ["no generation", { test_gen: "none" }],
  ["a malformed epoch", { daemon_epoch: "abc" }],
  ["an epoch newer than ours", { daemon_epoch: "99999999999999" }],
];
for (const [why, labels] of foreign) {
  test(`strays: a non-selected backend's sandbox with ${why} is never reported; a fully matching one is`, async () => {
    const t = make();
    const o = other();
    wire(t, { other: o });
    await holder(t, "mine", o, "other");
    const theirs = await o.start(spec("peer", labels), "peer-start");
    const ours = await o.start(spec("ghost"), "ghost-start");
    await t.daemon.reconcile();
    await t.daemon.reconcile();
    const alerts = await strayAlerts(t);
    assert.equal(alerts.length, 1, "only the provably ours one");
    assert.match(alerts[0]!, new RegExp(ours.id));
    assert.doesNotMatch(alerts[0]!, new RegExp(theirs.id));
  });
}

test("strays: a non-selected backend that cannot be listed is skipped and the selected backend's strays are still reported", async () => {
  const t = make();
  const o = other();
  wire(t, { other: o });
  await holder(t, "mine", o, "other");
  o.list = async () => {
    throw new SandboxUnavailableError("engine-unreachable");
  };
  const stray = await t.fakes.hooks.raw.sandbox.start(spec("ghost"), "ghost-start");
  await t.daemon.reconcile();
  await t.daemon.reconcile();
  const alerts = await strayAlerts(t);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, new RegExp(stray.id));
});

test("egress-orphans: reclaim runs on every active backend; one failing does not skip the others", async () => {
  const t = make();
  const o = other();
  const third = other("third");
  wire(t, { other: o, third });
  await holder(t, "a", o, "other");
  await holder(t, "b", third, "third");
  const reclaimed: string[] = [];
  t.daemon.deps.sandbox.reclaim = async () => {
    reclaimed.push("fake");
    return [];
  };
  o.reclaim = async () => {
    reclaimed.push("other");
    throw new Error("reclaim exploded");
  };
  third.reclaim = async () => {
    reclaimed.push("third");
    return [];
  };
  const errors = console.error;
  const logged: string[] = [];
  console.error = (m: unknown) => void logged.push(String(m));
  try {
    await t.daemon.reclaimEgressOrphans();
  } finally {
    console.error = errors;
  }
  assert.deepEqual(reclaimed.sort(), ["fake", "other", "third"]);
  assert.ok(logged.some((m) => m.includes("egress orphan reclaim failed on other") && m.includes("reclaim exploded")));
});
