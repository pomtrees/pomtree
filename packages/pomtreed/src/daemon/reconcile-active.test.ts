import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxUnavailableError } from "@pomtree/core";
import type { Sandbox } from "@pomtree/core";
import { FakeSandbox } from "@pomtree/testing";
import { setup, spawnSpec } from "../test-setup.ts";

// Boot sandbox reconcile over the active set: the selected backend plus every backend a live record of this host names.

// Every test daemon has store "store-1" and host "h1". A non-selected backend only reclaims what it can positively tie to this
// daemon (store, epoch, host and generation), so its fake stamps host and generation from the `test_host` / `test_gen` labels
// (defaults h1 and 0; "none" gives null); the real adapters report them on the listing.
const spec = (agent: string, labels: Record<string, string | undefined> = {}) => {
  const l: Record<string, string> = { daemon_epoch: "0", store_id: "store-1" };
  for (const [k, v] of Object.entries(labels)) {
    if (v === undefined) delete l[k];
    else l[k] = v;
  }
  return { agent, image: "img", env: {}, mounts: [], labels: l };
};
const stamped = (sb: FakeSandbox) => {
  const list = sb.list.bind(sb);
  sb.list = async (owner) =>
    (await list(owner)).map((x) => ({
      ...x,
      host: x.labels?.test_host ?? "h1",
      generation: x.labels?.test_gen === "none" ? null : 0,
    }));
  return sb;
};
const other = (backend = "other") => stamped(new FakeSandbox([], "graceful", { declaration: { backend } }));
const make = () => setup(async () => {}, { storeId: "store-1" });
type T = ReturnType<typeof setup>;
const reconcileSandboxes = (t: T) => (t.daemon as unknown as { reconcileSandboxes(): Promise<void> }).reconcileSandboxes();

// A running agent on `host` holding a started sandbox of `sb` pinned to `backend`.
async function holder(t: T, name: string, sb: FakeSandbox, backend: string, o: { host?: string; exited?: boolean } = {}) {
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name, task: "t", host: o.host ?? "h1", budgetMicros: 100_000, idempotencyKey: name });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${name}-run` });
  const s = await sb.start(spec(a.id), `${name}-start`);
  await reg.setSandbox(a.id, a.generation, s.id, `${name}-sb`, backend);
  if (o.exited) await reg.transition(a.id, a.generation, "exited", { exit: "succeeded", idempotencyKey: `${name}-x` });
  return { agent: a, sandbox: s.id };
}
const wire = (t: T, backends: Record<string, Sandbox>) => {
  const d = t.daemon.deps;
  d.sandboxFor = (id) => (id === d.sandbox.declaration.backend ? d.sandbox : backends[id]);
};
const alive = (sb: FakeSandbox, id: string) => sb.running.get(id)?.exitCode === null;

test("active-set: an orphan on each of two backends is reclaimed and the live record's sandbox is kept", async () => {
  const t = make();
  const main = t.fakes.hooks.raw.sandbox;
  const o = other();
  wire(t, { other: o });
  const kept = await holder(t, "mine", o, "other");
  const ghostMain = await main.start(spec("ghost-a"), "ghost-a-start");
  const ghostOther = await o.start(spec("ghost-b"), "ghost-b-start");
  await reconcileSandboxes(t);
  assert.equal(alive(main, ghostMain.id), false, "orphan on the selected backend reclaimed");
  assert.equal(alive(o, ghostOther.id), false, "orphan on the other backend reclaimed");
  assert.equal(alive(o, kept.sandbox), true, "the live record's sandbox is untouched");
  assert.equal((await t.daemon.deps.registry.get(kept.agent.id))?.sandbox, kept.sandbox);
});

test("active-set: the selected backend is reconciled even when no record names it", async () => {
  const t = make();
  const main = t.fakes.hooks.raw.sandbox;
  const o = other();
  wire(t, { other: o });
  await holder(t, "mine", o, "other");
  const ghost = await main.start(spec("ghost"), "ghost-start");
  await reconcileSandboxes(t);
  assert.equal(alive(main, ghost.id), false);
});

test("active-set: a record naming a backend that is not available refuses boot with the exact action text and reclaims nothing", async () => {
  const t = make();
  const main = t.fakes.hooks.raw.sandbox;
  const o = other();
  wire(t, { other: o });
  const lost = await holder(t, "lost", o, "gone");
  const ghost = await main.start(spec("ghost"), "ghost-start");
  await assert.rejects(
    () => reconcileSandboxes(t),
    (e: unknown) =>
      e instanceof Error &&
      e.name === "SandboxBackendUnavailableError" &&
      e.message ===
        `sandbox backend gone is not available, but agent(s) ${lost.agent.id} hold sandboxes on it; select it again (sandbox.backend) or run pomtree abandon <agent> for each of them, then restart`,
  );
  assert.equal(alive(main, ghost.id), true, "refusal comes before any reclaim");
});

test("active-set: a backend whose listing fails is reported and skipped; the others are still reclaimed and its records are left alone", async () => {
  const t = make();
  const main = t.fakes.hooks.raw.sandbox;
  const o = other();
  wire(t, { other: o });
  const held = await holder(t, "held", o, "other");
  const ghost = await main.start(spec("ghost"), "ghost-start");
  o.list = async () => {
    throw new SandboxUnavailableError("engine-unreachable");
  };
  const logged: string[] = [];
  const errors = console.error;
  console.error = (m: unknown) => void logged.push(String(m));
  try {
    await reconcileSandboxes(t);
  } finally {
    console.error = errors;
  }
  assert.equal(alive(main, ghost.id), false, "the healthy backend was reconciled");
  assert.equal(alive(o, held.sandbox), true);
  assert.equal((await t.daemon.deps.registry.get(held.agent.id))?.sandbox, held.sandbox, "the record it holds is not cleared");
  assert.ok(logged.some((m) => m.includes("sandbox backend other cannot be listed") && m.includes("pomtree abandon <agent>")));
  const root = await t.daemon.root();
  const entries = await t.journal.read({ agent: root.id });
  assert.ok(
    entries.some((e) => e.payload.kind === "host_error" && (e.payload as { message: string }).message.includes("sandbox backend other cannot be listed")),
  );
});

test("active-set: an unexpected listing error on one backend still reconciles the others, then fails boot with that error", async () => {
  const t = make();
  const main = t.fakes.hooks.raw.sandbox;
  const o = other();
  const third = other("third");
  wire(t, { other: o, third });
  await holder(t, "held", o, "other");
  await holder(t, "held3", third, "third");
  const ghost = await main.start(spec("ghost"), "ghost-start");
  const ghost3 = await third.start(spec("ghost3"), "ghost3-start");
  o.list = async () => {
    throw new Error("listing exploded");
  };
  await assert.rejects(() => reconcileSandboxes(t), /listing exploded/);
  assert.equal(alive(main, ghost.id), false);
  assert.equal(alive(third, ghost3.id), false, "a backend after the failing one is still reconciled");
});

test("active-set: a sandbox reachable under two backend ids is reclaimed once", async () => {
  const t = make();
  const main = t.fakes.hooks.raw.sandbox;
  wire(t, { alias: t.daemon.deps.sandbox }); // the daemon's own (guarded) handle, reached under a second id
  await holder(t, "aliased", main, "alias");
  await main.start(spec("ghost"), "ghost-start");
  await reconcileSandboxes(t);
  assert.equal(main.killCalls.length, 1, "one kill for the one orphan");
  assert.equal(main.listOwners.length, 1, "listed once");
});

test("active-set: records of another host or finished ones do not join the active set", async () => {
  const t = make();
  const o = other();
  wire(t, {}); // neither "gone" nor "other" is reachable
  await holder(t, "elsewhere", o, "gone", { host: "h2" });
  await holder(t, "finished", o, "other", { exited: true });
  await holder(t, "mine", t.fakes.hooks.raw.sandbox, "fake");
  await reconcileSandboxes(t);
  assert.equal(o.listOwners.length, 0, "no other backend was consulted");
});

test("active-set: without a per-backend accessor a record on another backend keeps the single-backend mismatch refusal", async () => {
  const t = make();
  await holder(t, "a", other(), "other");
  await assert.rejects(
    () => reconcileSandboxes(t),
    (e: unknown) => e instanceof Error && e.name === "SandboxBackendMismatchError",
  );
});

// Safety gate for shared hosted accounts: a peer daemon's sandbox on a non-selected backend must never be reclaimed.
const foreign: [string, Record<string, string | undefined>][] = [
  ["no store_id", { store_id: undefined }],
  ["another store_id", { store_id: "store-2" }],
  ["another host", { test_host: "h2" }],
  ["no generation", { test_gen: "none" }],
  ["a malformed epoch", { daemon_epoch: "abc" }],
  ["an epoch newer than ours", { daemon_epoch: "99999999999999" }],
];
for (const [why, labels] of foreign) {
  test(`active-set: a non-selected backend's sandbox with ${why} is not reclaimed; a fully matching one is`, async () => {
    const t = make();
    const o = other();
    wire(t, { other: o });
    await holder(t, "mine", o, "other");
    const theirs = await o.start(spec("peer", labels), "peer-start");
    const ours = await o.start(spec("ghost"), "ghost-start");
    await reconcileSandboxes(t);
    assert.equal(alive(o, theirs.id), true, "not provably ours: left alone");
    assert.equal(alive(o, ours.id), false, "provably ours: reclaimed");
  });
}

test("active-set: the selected backend keeps the Docker-era rule (an untagged, unstamped sandbox without store_id is still reclaimed)", async () => {
  const t = make();
  const main = t.fakes.hooks.raw.sandbox;
  const o = other();
  wire(t, { other: o });
  await holder(t, "mine", o, "other");
  const ghost = await main.start({ agent: "ghost", image: "img", env: {}, mounts: [], labels: { daemon_epoch: "0" } }, "ghost-start");
  await reconcileSandboxes(t);
  assert.equal(alive(main, ghost.id), false);
});

test("active-set: the registry-empty refusal on a non-selected backend keeps the sandboxes and journals under the backend's own key", async () => {
  const t = make();
  const o = other();
  wire(t, { other: o });
  const root = await t.daemon.root();
  const rs = await o.start(spec(root.id), "root-start");
  await t.daemon.deps.registry.setSandbox(root.id, root.generation, rs.id, "root-sb", "other"); // only the root holds anything
  const ghost = await o.start(spec("ghost"), "ghost-start");
  await reconcileSandboxes(t);
  assert.equal(alive(o, ghost.id), true, "refused: nothing killed");
  const entries = await t.journal.read({ agent: root.id });
  assert.ok(
    entries.some((e) => e.payload.kind === "host_error" && (e.payload as { message: string }).message.includes("registry is empty but 2 container(s) exist")),
  );
  assert.ok(
    t.fakes.calls.some((c) => c.port === "Journal" && JSON.stringify(c.args).includes("host:orphans:sandbox:other")),
    "key carries the backend id",
  );
});

test("active-set: the selected backend being unavailable latches sandbox-down and the other backends are still reconciled", async () => {
  const t = make();
  const main = t.fakes.hooks.raw.sandbox;
  const o = other();
  wire(t, { other: o });
  await holder(t, "mine", o, "other");
  const ghost = await o.start(spec("ghost"), "ghost-start");
  main.list = async () => {
    throw new SandboxUnavailableError("engine-unreachable");
  };
  await reconcileSandboxes(t);
  assert.equal(alive(o, ghost.id), false, "the other backend was reconciled");
  const entries = await t.journal.read({ agent: (await t.daemon.root()).id });
  assert.ok(entries.some((e) => e.payload.kind === "host_error" && (e.payload as { message: string }).message === "sandbox unavailable"));
});

// Later boot steps must not reach a sandbox through the wrong backend.
test("active-set: a running record on a non-selected backend is not inspected, attached, resumed or reclaimed through the selected one; a finding is journaled", async () => {
  const t = make();
  const main = t.fakes.hooks.raw.sandbox;
  const o = other();
  wire(t, { other: o });
  const held = await holder(t, "held", o, "other");
  const inspected: string[] = [];
  const inspect = main.inspect.bind(main);
  main.inspect = async (id) => {
    inspected.push(id);
    return inspect(id);
  };
  await t.daemon.recover();
  assert.deepEqual(inspected, [], "never inspected through the selected backend");
  assert.equal(alive(o, held.sandbox), true, "its sandbox was not stopped");
  const after = await t.daemon.deps.registry.get(held.agent.id);
  assert.equal(after?.state, "running", "not failed or resumed");
  assert.equal(after?.sandbox, held.sandbox);
  const entries = await t.journal.read({ agent: held.agent.id });
  const f = entries.find((e) => e.payload.kind === "error" && (e.payload as { message: string }).message.includes("backend other"));
  assert.ok(f, "finding journaled");
  const msg = (f!.payload as { message: string }).message;
  assert.ok(msg.includes("select other again (sandbox.backend)") && msg.includes(`pomtree abandon ${held.agent.id}`), msg);
});

test("active-set: reclaiming a record on a non-selected backend stops it on that backend and clears the sandbox and the pin together", async () => {
  const t = make();
  const main = t.fakes.hooks.raw.sandbox;
  const o = other();
  wire(t, { other: o });
  const held = await holder(t, "held", o, "other");
  const rec = (await t.daemon.deps.registry.get(held.agent.id))!;
  await (t.daemon as unknown as { reclaimSandbox(r: unknown): Promise<void> }).reclaimSandbox(rec);
  assert.equal(alive(o, held.sandbox), false, "stopped on its own backend");
  assert.equal(main.stopCalls.length, 0, "not asked of the selected backend");
  const after = await t.daemon.deps.registry.get(held.agent.id);
  assert.deepEqual([after?.sandbox, after?.sandboxBackend], [null, null], "clearing the sandbox clears the pin (sandboxBackendAfter)");
});
