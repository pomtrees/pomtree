// The read-only periodic `strays` reconcile phase. A running, owned container that no agent on this
// host claims is alerted once, after being seen in two consecutive passes (a spawn mid-start is not yet recorded); nothing is
// ever killed, stopped or removed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxUnavailableError } from "@pomtree/core";
import type { AgentRecord, JournalEntry } from "@pomtree/core";
import { setup, spawnSpec } from "./test-setup.ts";

type T = ReturnType<typeof setup>;

const mk = () => setup(async (c) => void (await c.stopped), { escalationChannels: ["discord"] });

// Starts a container straight on the fake sandbox, labelled as this daemon's own, for `agent`.
async function container(t: T, agent: string, key: string) {
  const h = await t.sandbox.start({ agent, image: "img", env: {}, mounts: [], labels: { daemon_epoch: t.daemon.epoch } }, key);
  return h.id;
}

const strayEntries = async (t: T) => {
  const root = await t.daemon.root();
  const es = await t.journal.read({ agent: root.id });
  const errors = es.filter((e: JournalEntry) => e.payload.kind === "error" && (e.payload as { message: string }).message.startsWith("stray container"));
  const alerts = es.filter((e: JournalEntry) => e.payload.kind === "message_sent" && (e.payload as { subject: string }).subject.startsWith("stray container"));
  return { errors, alerts };
};

// Records every destructive call on the fake sandbox.
function spyDestructive(t: T) {
  const calls: string[] = [];
  for (const m of ["kill", "stop"] as const) {
    const orig = t.sandbox[m].bind(t.sandbox) as (...a: never[]) => Promise<void>;
    (t.sandbox as unknown as Record<string, unknown>)[m] = async (...a: never[]) => {
      calls.push(m);
      return orig(...a);
    };
  }
  return calls;
}

test("a stray seen once raises nothing; seen in two consecutive passes raises exactly one alert, a third changes nothing", async () => {
  const t = mk();
  const calls = spyDestructive(t);
  const id = await container(t, "ghost", "k1");
  await t.daemon.reconcile();
  assert.deepEqual(await strayEntries(t), { errors: [], alerts: [] });
  await t.daemon.reconcile();
  let r = await strayEntries(t);
  assert.equal(r.errors.length, 1);
  assert.equal(r.alerts.length, 1);
  assert.match((r.errors[0]!.payload as { message: string }).message, new RegExp(id));
  await t.daemon.reconcile();
  r = await strayEntries(t);
  assert.equal(r.errors.length, 1);
  assert.equal(r.alerts.length, 1);
  assert.deepEqual(calls, [], "read-only: no kill or stop");
  assert.equal((await t.sandbox.inspect(id))?.running, true, "the stray is left running");
});

test("a stray that vanishes between passes resets the two-pass memory", async () => {
  const t = mk();
  const id = await container(t, "ghost", "k1");
  await t.daemon.reconcile();
  t.sandbox.running.delete(id); // gone
  await t.daemon.reconcile();
  await container(t, "ghost", "k2"); // a new one: seen once only
  await t.daemon.reconcile();
  assert.deepEqual(await strayEntries(t), { errors: [], alerts: [] });
  await t.daemon.reconcile();
  assert.equal((await strayEntries(t)).alerts.length, 1);
});

test("an exited, a foreign-epoch and an unlabelled container are not strays", async () => {
  const t = mk();
  const exited = await container(t, "ghost", "k1");
  t.sandbox.exit(exited, 0);
  await t.sandbox.start({ agent: "g2", image: "img", env: {}, mounts: [], labels: { daemon_epoch: String(Number(t.daemon.epoch) + 1) } }, "k2");
  await t.sandbox.start({ agent: "g3", image: "img", env: {}, mounts: [] }, "k3");
  await t.daemon.reconcile();
  await t.daemon.reconcile();
  await t.daemon.reconcile();
  assert.deepEqual(await strayEntries(t), { errors: [], alerts: [] });
});

test("a container belonging to a known running agent is never flagged", async () => {
  const t = mk();
  const root = await t.daemon.root();
  const a0 = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "known",
    task: "t",
    host: "h1",
    budgetMicros: 1000,
    idempotencyKey: "known",
  });
  const a = await t.daemon.deps.registry.transition(a0.id, a0.generation, "running", { idempotencyKey: "known-run" });
  const id = await container(t, a.id, "k1");
  await t.daemon.deps.registry.setSandbox(a.id, a.generation, id, "known-sb");
  const calls = spyDestructive(t);
  for (let i = 0; i < 3; i++) await t.daemon.reconcile();
  assert.deepEqual(await strayEntries(t), { errors: [], alerts: [] });
  assert.equal(((await t.daemon.get(a.id)) as AgentRecord).sandbox, id, "registry untouched");
  assert.deepEqual(calls, []);
});

test("sandbox down skips the phase: no list call while the host is down, nothing alerted", async () => {
  const t = mk();
  await container(t, "ghost", "k1");
  await t.daemon.reconcile(); // seen once
  const orig = t.sandbox.list.bind(t.sandbox);
  let lists = 0;
  let down = true;
  t.sandbox.list = async (owner) => {
    lists++;
    if (down) throw new SandboxUnavailableError();
    return orig(owner);
  };
  await t.daemon.reconcile(); // list throws: marks the sandbox down, clears memory
  const afterFirst = lists;
  await t.daemon.reconcile(); // host down: the phase does not list at all
  assert.equal(lists, afterFirst);
  assert.deepEqual(await strayEntries(t), { errors: [], alerts: [] });
  down = false;
  await t.daemon.probeSandbox(); // back up
  await t.daemon.reconcile(); // memory was cleared: seen once again
  assert.equal((await strayEntries(t)).alerts.length, 0);
  await t.daemon.reconcile();
  assert.equal((await strayEntries(t)).alerts.length, 1);
});
