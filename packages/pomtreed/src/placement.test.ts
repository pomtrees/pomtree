import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { HostId, HostStore, NewHost } from "@pomtree/core";
import { PRIORITY } from "@pomtree/sched";
import { openStore } from "@pomtree/store-sqlite";
import { FakeHostStore, tmpDir } from "@pomtree/testing";
import { HostPlacement, NO_HOST_REASON } from "./placement.ts";
import { setup } from "./test-setup.ts";

const host = (id: HostId, over: Partial<NewHost> & { maxSessions?: number } = {}): NewHost => ({
  id,
  labels: over.labels ?? {},
  capacity: { maxSessions: over.maxSessions ?? 4, ...over.capacity },
  images: [],
  state: over.state ?? "ready",
});

interface Rig {
  hosts: HostStore;
  close(): void;
}
const backends: { name: string; make: () => Rig }[] = [
  { name: "FakeHostStore", make: () => ({ hosts: new FakeHostStore(Date.now), close() {} }) },
  {
    name: "sqlite",
    make: () => {
      const s = openStore(join(tmpDir("hp-"), "p.sqlite"));
      return { hosts: s.hosts, close: () => s.close() };
    },
  },
];

for (const b of backends) {
  const setup = async (maxSessions = 1, extra: NewHost[] = []) => {
    const rig = b.make();
    await rig.hosts.upsertHost(host("h1", { maxSessions }), "h1");
    for (const h of extra) await rig.hosts.upsertHost(h, h.id);
    const p = new HostPlacement({ hosts: rig.hosts, host: "h1" });
    return { ...rig, p };
  };
  const slot = (used: number, max: number) => `waiting for a session slot (${used} of ${max} in use)`;

  test(`[${b.name}] admits up to the cap, then queues with a slot-full reason`, async () => {
    const { p } = await setup(2);
    assert.deepEqual(await p.admit({ agent: "a", priority: PRIORITY.scheduled }), { host: "h1" });
    assert.deepEqual(await p.admit({ agent: "b", priority: PRIORITY.scheduled }), { host: "h1" });
    assert.deepEqual(await p.admit({ agent: "c", priority: PRIORITY.scheduled }), { queued: true, reason: slot(2, 2) });
  });

  test(`[${b.name}] admit is idempotent for running and queued agents`, async () => {
    const { p } = await setup(1);
    await p.admit({ agent: "a", priority: 1 });
    assert.deepEqual(await p.admit({ agent: "a", priority: 1 }), { host: "h1" });
    await p.admit({ agent: "b", priority: 1 });
    assert.deepEqual(await p.admit({ agent: "b", priority: 1 }), { queued: true, reason: slot(1, 1) });
    const promoted: string[] = [];
    p.onAdmit((a) => promoted.push(a));
    await p.release("a");
    assert.deepEqual(promoted, ["b"]);
    assert.deepEqual((await p.status())[0]!.running, ["b"]);
  });

  test(`[${b.name}] release promotes by priority class, FIFO within class`, async () => {
    const { p } = await setup(1);
    const promoted: string[] = [];
    p.onAdmit((a) => promoted.push(a));
    await p.admit({ agent: "run", priority: PRIORITY.scheduled });
    await p.admit({ agent: "s1", priority: PRIORITY.scheduled });
    await p.admit({ agent: "i1", priority: PRIORITY.interactive });
    await p.admit({ agent: "s2", priority: PRIORITY.scheduled });
    await p.admit({ agent: "alert", priority: PRIORITY.alert });
    await p.admit({ agent: "i2", priority: PRIORITY.interactive });
    for (const a of ["run", "alert", "i1", "i2", "s1"]) await p.release(a);
    assert.deepEqual(promoted, ["alert", "i1", "i2", "s1", "s2"]);
  });

  test(`[${b.name}] releasing a queued agent removes it without promoting; unknown agents are a no-op`, async () => {
    const { p } = await setup(1);
    const promoted: string[] = [];
    p.onAdmit((a) => promoted.push(a));
    await p.admit({ agent: "a", priority: 1 });
    await p.admit({ agent: "b", priority: 1 });
    await p.release("b");
    await p.release("ghost");
    await p.release("a");
    assert.deepEqual(promoted, []);
    assert.deepEqual(await p.admit({ agent: "c", priority: 1 }), { host: "h1" });
  });

  test(`[${b.name}] status gives one row per host, queue ordered by priority then arrival, without leaking state`, async () => {
    const { p } = await setup(1, [host("h2", { maxSessions: 0 })]);
    await p.admit({ agent: "a", priority: PRIORITY.scheduled });
    await p.admit({ agent: "b", priority: PRIORITY.interactive });
    await p.admit({ agent: "c", priority: PRIORITY.alert });
    const queue = [
      { agent: "c", priority: PRIORITY.alert },
      { agent: "b", priority: PRIORITY.interactive },
    ];
    const want = [
      { host: "h1", maxConcurrent: 1, running: ["a"], queue },
      { host: "h2", maxConcurrent: 0, running: [], queue },
    ];
    assert.deepEqual(await p.status(), want);
    const s = await p.status();
    s[0]!.running.push("mutated");
    s[0]!.queue.push({ agent: "mutated", priority: 0 });
    assert.deepEqual(await p.status(), want);
  });

  test(`[${b.name}] a throwing onAdmit listener does not leak the slot (promotion is not committed)`, async () => {
    const { p } = await setup(1);
    let calls = 0;
    p.onAdmit(() => {
      if (++calls === 1) throw new Error("boom");
    });
    await p.admit({ agent: "a", priority: 1 });
    await p.admit({ agent: "b", priority: 1 });
    await assert.rejects(() => p.release("a"), /boom/);
    assert.deepEqual(await p.status(), [{ host: "h1", maxConcurrent: 1, running: [], queue: [{ agent: "b", priority: 1 }] }]);
    assert.deepEqual(await p.admit({ agent: "c", priority: 1 }), { host: "h1" });
    await p.release("c");
    assert.deepEqual(await p.status(), [{ host: "h1", maxConcurrent: 1, running: ["b"], queue: [] }]);
  });

  test(`[${b.name}] sync marks live agents running, drops stale ones, and keeps the cap for the queue`, async () => {
    const { p } = await setup(1);
    await p.admit({ agent: "a", priority: 1 });
    await p.admit({ agent: "q", priority: 1 });
    await p.sync(["x", "y"]); // hot restart: x,y adopted (exceeding the cap), a gone
    let st = (await p.status())[0]!;
    assert.deepEqual(st.running.sort(), ["x", "y"]);
    assert.deepEqual(
      st.queue.map((w) => w.agent),
      ["q"],
    );
    await p.sync(["x"]); // y released; still at cap so q stays queued
    assert.deepEqual((await p.status())[0]!.running, ["x"]);
    await p.sync(["q"]); // queued agent adopted: leaves the queue
    st = (await p.status())[0]!;
    assert.deepEqual(st.running, ["q"]);
    assert.deepEqual(st.queue, []);
  });

  test(`[${b.name}] sync promotes the queue when it frees a slot`, async () => {
    const { p } = await setup(1);
    const promoted: string[] = [];
    p.onAdmit((a) => promoted.push(a));
    await p.admit({ agent: "a", priority: 1 });
    await p.admit({ agent: "q", priority: 1 });
    await p.sync([]); // a's container is gone
    assert.deepEqual(promoted, ["q"]);
    assert.deepEqual((await p.status())[0]!.running, ["q"]);
  });

  test(`[${b.name}] template requires filters hosts by label; unsatisfiable requirements queue with a distinct reason`, async () => {
    const rig = b.make();
    await rig.hosts.upsertHost(host("h1", { maxSessions: 4 }), "h1");
    await rig.hosts.upsertHost(host("gpu1", { maxSessions: 4, labels: { gpu: "a100" } }), "gpu1");
    const p = new HostPlacement({ hosts: rig.hosts, host: "h1", requires: async (t) => (t === "gpu" ? ["gpu"] : t === "a10" ? ["gpu=a10"] : []) });
    assert.deepEqual(await p.admit({ agent: "g", priority: 1, template: "gpu" }), { host: "gpu1" });
    assert.deepEqual(await p.admit({ agent: "c", priority: 1, template: "code" }), { host: "h1" });
    assert.deepEqual(await p.admit({ agent: "n", priority: 1, template: "a10" }), { queued: true, reason: NO_HOST_REASON });
    // A queued agent that no host can ever satisfy does not block one that fits (no head-of-line blocking).
    await p.release("c");
    assert.deepEqual(await p.admit({ agent: "c2", priority: 1 }), { host: "h1" });
  });

  test(`[${b.name}] resources fit against capacity; draining hosts are skipped; affinity then fewest-running pick the host`, async () => {
    const rig = b.make();
    await rig.hosts.upsertHost(host("h1", { maxSessions: 4, capacity: { maxSessions: 4, cpus: 2, memoryBytes: 1000, shmBytes: 10 } }), "h1");
    await rig.hosts.upsertHost(host("h2", { maxSessions: 4, capacity: { maxSessions: 4, cpus: 8, memoryBytes: 8000, shmBytes: 100 } }), "h2");
    await rig.hosts.upsertHost(host("h3", { maxSessions: 4, state: "draining" }), "h3");
    const p = new HostPlacement({ hosts: rig.hosts, host: "h1" });
    assert.deepEqual(await p.admit({ agent: "big", priority: 1, resources: { cpus: 4 } }), { host: "h2" });
    assert.deepEqual(await p.admit({ agent: "shm", priority: 1, resources: { shmBytes: 50 } }), { host: "h2" });
    assert.deepEqual(await p.admit({ agent: "mem", priority: 1, resources: { memoryBytes: 9000 } }), { queued: true, reason: NO_HOST_REASON });
    assert.deepEqual(await p.admit({ agent: "fewest", priority: 1 }), { host: "h1" }); // h1 runs 0, h2 runs 2
    assert.deepEqual(await p.admit({ agent: "aff", priority: 1, affinity: { host: "h2" } }), { host: "h2" });
    assert.deepEqual(await p.admit({ agent: "aff-missing", priority: 1, affinity: { host: "h3" } }), { host: "h1" }); // draining affinity host is ignored
  });

  test(`[${b.name}] no host row means nothing satisfies the request`, async () => {
    const rig = b.make();
    const p = new HostPlacement({ hosts: rig.hosts, host: "h1" });
    assert.deepEqual(await p.admit({ agent: "a", priority: 1 }), { queued: true, reason: NO_HOST_REASON });
    assert.deepEqual(await p.status(), []);
  });
}

test("restart survival: a new HostPlacement over the same sqlite file sees the running set and the queue order", async () => {
  const path = join(tmpDir("hp-restart-"), "p.sqlite");
  const first = openStore(path);
  await first.hosts.upsertHost(host("h1", { maxSessions: 1 }), "h1");
  const p1 = new HostPlacement({ hosts: first.hosts, host: "h1" });
  await p1.admit({ agent: "run", priority: PRIORITY.scheduled });
  await p1.admit({ agent: "s1", priority: PRIORITY.scheduled });
  await p1.admit({ agent: "alert", priority: PRIORITY.alert });
  await p1.admit({ agent: "i1", priority: PRIORITY.interactive });
  first.close();

  const second = openStore(path);
  const p2 = new HostPlacement({ hosts: second.hosts, host: "h1" });
  assert.deepEqual(await p2.status(), [
    {
      host: "h1",
      maxConcurrent: 1,
      running: ["run"],
      queue: [
        { agent: "alert", priority: PRIORITY.alert },
        { agent: "i1", priority: PRIORITY.interactive },
        { agent: "s1", priority: PRIORITY.scheduled },
      ],
    },
  ]);
  assert.deepEqual(await p2.admit({ agent: "run", priority: 1 }), { host: "h1" }, "admit replays the running answer");
  const promoted: string[] = [];
  p2.onAdmit((a) => promoted.push(a));
  for (const a of ["run", "alert", "i1"]) await p2.release(a);
  assert.deepEqual(promoted, ["alert", "i1", "s1"], "promotion order survives the restart");
  second.close();
});

test("a failed readiness hook is retried by the next operation instead of being cached", async () => {
  const hosts = new FakeHostStore(Date.now);
  hosts.errors.push(new Error("register failed"));
  let calls = 0;
  const p = new HostPlacement({
    hosts,
    host: "h1",
    ready: async () => {
      calls++;
      await hosts.upsertHost(host("h1"), "reg");
    },
  });
  await assert.rejects(p.admit({ agent: "a", priority: 1 }), /register failed/);
  assert.deepEqual(await p.admit({ agent: "a", priority: 1 }), { host: "h1" });
  assert.equal(calls, 2);
  await p.status();
  assert.equal(calls, 2, "a successful readiness is still run once");
});

test("Daemon.placementStatus surfaces a missing host row as a 503 instead of inventing an empty row", async () => {
  const hosts = new FakeHostStore(Date.now);
  const t = setup(async () => {}, { placement: new HostPlacement({ hosts, host: "h1" }) });
  const missing = await t.operator("GET", "/v1/placement");
  assert.equal(missing.status, 503);
  assert.match((missing.body as { error: string }).error, /no host row/);
  await hosts.upsertHost(host("h1", { maxSessions: 3 }), "h1");
  const ok = await t.operator("GET", "/v1/placement");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { host: "h1", maxConcurrent: 3, running: [], queue: [] });
});
