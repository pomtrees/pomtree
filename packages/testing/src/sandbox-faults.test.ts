import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SandboxOutcomeUnknownError, SandboxTransferError, SandboxUnavailableError, sandboxIdForKey } from "@pomtree/core";
import type { Sandbox, SandboxOwner, SandboxSpec } from "@pomtree/core";
import { FakeSandbox } from "./fakes.ts";
import { FaultPlan, assertStartIdempotent } from "./sandbox-faults.ts";

const OWNER: SandboxOwner = { host: "host-1", storeId: "store-1", epoch: 1 };
const spec = (agent = "a1"): SandboxSpec => ({ host: "host-test", generation: 0, agent, image: "img@sha256:x", env: {}, mounts: [] });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);
async function* body(...parts: Uint8Array[]) {
  yield* parts;
}
// What a caller of files.get does: read the body, then compare its sha256 with the reported one.
async function readVerified(got: { body: AsyncIterable<Uint8Array>; sha256: Promise<string> }, id: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of got.body) chunks.push(c);
  const data = Buffer.concat(chunks);
  if (sha(data) !== (await got.sha256)) throw new SandboxTransferError(id, "hash-mismatch");
  return data;
}
function remote(plan = new FaultPlan()) {
  return new FakeSandbox([], "graceful", { remote: true, faults: plan });
}

test("a fault planned for an operation that is never called makes assertSpent throw and name it", () => {
  const plan = new FaultPlan().add("files.put", { kind: "hash-mismatch" }).add("start", { kind: "error", error: new Error("boom") }, { key: "k1" });
  assert.throws(() => plan.assertSpent(), /2 planned sandbox fault\(s\) never fired: hash-mismatch on files\.put; error on start \(key k1\)/);
});

test("assertSpent passes after every planned fault fired", async () => {
  const plan = new FaultPlan().add("start", { kind: "error", error: new Error("boom") });
  const fake = new FakeSandbox([], "graceful", { faults: plan });
  await assert.rejects(fake.start(spec(), "k"), /boom/);
  assert.doesNotThrow(() => plan.assertSpent());
  assert.equal(plan.pending().length, 0);
  assert.equal(plan.fired().length, 1);
});

test("faults fire strictly in order and once each", async () => {
  const plan = new FaultPlan()
    .add("start", { kind: "error", error: new Error("first") })
    .add("start", { kind: "error", error: new Error("second") })
    .add("stop", { kind: "error", error: new Error("on stop") });
  const fake = new FakeSandbox([], "graceful", { faults: plan });
  await assert.rejects(fake.start(spec(), "k1"), /first/);
  assert.deepEqual(
    plan.pending().map((p) => p.op),
    ["start", "stop"],
  );
  await assert.rejects(fake.start(spec(), "k2"), /second/);
  const h = await fake.start(spec(), "k3"); // plan exhausted for start: the call succeeds
  assert.equal(fake.sandboxes.length, 1);
  await assert.rejects(fake.stop(h.id, 0, "s1"), /on stop/);
  await fake.stop(h.id, 0, "s2"); // one-shot: not fired again
  plan.assertSpent();
});

test("a keyed fault skips calls with another key and waits for its own", async () => {
  const plan = new FaultPlan().add("start", { kind: "error", error: new Error("only k2") }, { key: "k2" });
  const fake = new FakeSandbox([], "graceful", { faults: plan });
  await fake.start(spec("a1"), "k1");
  assert.equal(plan.pending().length, 1);
  await assert.rejects(fake.start(spec("a2"), "k2"), /only k2/);
  plan.assertSpent();
});

test("a fault kind planned on an operation it cannot affect is refused with the allowed operations", () => {
  assert.throws(() => new FaultPlan().add("files.put", { kind: "preempt" }), /cannot attach to operation "files\.put".*start, inspect, wait/);
  assert.throws(() => new FaultPlan().add("stop", { kind: "unknown-outcome", applied: true }), /cannot attach to operation "stop"/);
});

test("unknown-outcome applied:true leaves exactly one sandbox, applied:false leaves none", async () => {
  for (const [applied, expected] of [
    [true, 1],
    [false, 0],
  ] as const) {
    const plan = new FaultPlan().add("start", { kind: "unknown-outcome", applied });
    const fake = new FakeSandbox([], "graceful", { faults: plan });
    const err = await fake.start(spec(), "key-1").catch((e: unknown) => e);
    assert.ok(err instanceof SandboxOutcomeUnknownError, String(err));
    assert.equal(err.idempotencyKey, "key-1");
    assert.equal(fake.sandboxes.length, expected, `applied:${applied}`);
    assert.equal((await fake.list(OWNER)).length, expected, `reconcile list, applied:${applied}`);
    // retrying with the same key converges on exactly one sandbox either way
    const h = await fake.start(spec(), "key-1");
    assert.equal(fake.sandboxes.length, 1);
    assert.deepEqual(fake.sandboxes, [h.id]);
    if (applied) assert.equal(h.id, err.id, "the retry returns the sandbox the unknown outcome created");
    plan.assertSpent();
  }
});

test("the same idempotency key twice returns the same sandbox and creates one", async () => {
  const fake = new FakeSandbox();
  const h = await assertStartIdempotent(fake, spec(), "dup-key", OWNER);
  assert.deepEqual(fake.sandboxes, [h.id]);
  await fake.start(spec(), "other-key");
  assert.equal(fake.sandboxes.length, 2);
});

test("assertStartIdempotent fails a backend that ignores the key", async () => {
  // Negative control: an independent stub (not the fake) that creates a new sandbox on every start call.
  let n = 0;
  const ignoresKey = new FakeSandbox();
  const stub = {
    start: (s: SandboxSpec) => ignoresKey.start(s, `fresh-${++n}`),
    list: (o: SandboxOwner) => ignoresKey.list(o),
  } as unknown as Sandbox;
  await assert.rejects(assertStartIdempotent(stub, spec(), "dup-key", OWNER), /returned sandbox .* and then .*a repeated key must return the same sandbox/);
});

test("a duplicate-key fault delivers start twice and still leaves one sandbox", async () => {
  const plan = new FaultPlan().add("start", { kind: "duplicate-key" });
  const fake = new FakeSandbox([], "graceful", { faults: plan });
  const h = await fake.start(spec(), "k");
  assert.deepEqual(fake.sandboxes, [h.id]);
  assert.deepEqual(
    fake.ops.map((o) => [o.op, o.key]),
    [
      ["start", "k"],
      ["start", "k"],
    ],
  );
  plan.assertSpent();
});

test("a hash-mismatch fault on files.put and files.get raises SandboxTransferError and accepts nothing", async () => {
  const plan = new FaultPlan().add("files.put", { kind: "hash-mismatch" }).add("files.get", { kind: "hash-mismatch" });
  const fake = remote(plan);
  const h = await fake.start(spec(), "k");
  const data = bytes("hello");
  const err = await fake.files?.put(h.id, "/w/a.tar", body(data), sha(data), "p1").catch((e: unknown) => e);
  assert.ok(err instanceof SandboxTransferError, String(err));
  assert.equal(err.reason, "hash-mismatch");
  assert.match(err.message, /retry the transfer/);
  assert.equal(fake.fileStore.get(h.id)?.size ?? 0, 0, "nothing accepted");
  await fake.files?.put(h.id, "/w/a.tar", body(data), sha(data), "p2"); // the fault was one-shot
  // get() returns the body with a sha256 that does not match it; the caller's own verification raises the typed error.
  const got = await fake.files?.get(h.id, "/w/a.tar", 100);
  assert.ok(got);
  await assert.rejects(readVerified(got, h.id), (e: unknown) => e instanceof SandboxTransferError && e.reason === "hash-mismatch");
  plan.assertSpent();
});

test("put verifies the declared sha256 itself, not only when a fault is planned", async () => {
  const fake = remote();
  const h = await fake.start(spec(), "k");
  const err = await fake.files?.put(h.id, "/w/a", body(bytes("x")), sha(bytes("y")), "p1").catch((e: unknown) => e);
  assert.ok(err instanceof SandboxTransferError && err.reason === "hash-mismatch");
  assert.equal(fake.fileStore.get(h.id), undefined);
});

test("a partial upload records nothing and a partial download breaks after the prefix", async () => {
  const plan = new FaultPlan().add("files.put", { kind: "partial", afterBytes: 3 }).add("files.get", { kind: "partial", afterBytes: 2 });
  const fake = remote(plan);
  const h = await fake.start(spec(), "k");
  const data = bytes("abcdef");
  const err = await fake.files?.put(h.id, "/w/f", body(data.subarray(0, 4), data.subarray(4)), sha(data), "p1").catch((e: unknown) => e);
  assert.ok(err instanceof SandboxTransferError && err.reason === "partial");
  assert.equal(fake.fileStore.get(h.id)?.has("/w/f") ?? false, false);
  await fake.files?.put(h.id, "/w/f", body(data), sha(data), "p2");
  const got = await fake.files?.get(h.id, "/w/f", 100);
  const seen: string[] = [];
  const read = (async () => {
    for await (const c of got?.body ?? []) seen.push(new TextDecoder().decode(c));
  })();
  await assert.rejects(read, (e: unknown) => e instanceof SandboxTransferError && e.reason === "partial");
  assert.deepEqual(seen, ["ab"]);
  plan.assertSpent();
});

test("files put is idempotent by key and get returns the content with its sha256", async () => {
  const fake = remote();
  const h = await fake.start(spec(), "k");
  const data = bytes("payload");
  await fake.files?.put(h.id, "/w/f", body(data), sha(data), "p1");
  await fake.files?.put(h.id, "/w/f", body(bytes("ignored")), sha(bytes("ignored")), "p1");
  const got = await fake.files?.get(h.id, "/w/f", 100);
  const out: Uint8Array[] = [];
  for await (const c of got?.body ?? []) out.push(c);
  assert.equal(Buffer.concat(out).toString(), "payload");
  assert.equal(await got?.sha256, sha(data));
  await assert.rejects(fake.files?.get(h.id, "/w/f", 3) as Promise<unknown>, (e: unknown) => e instanceof SandboxTransferError && e.reason === "too-large");
});

test("a connect fault drops the stream after N bytes; an unfaulted channel loops everything back", async () => {
  const plan = new FaultPlan().add("connect", { kind: "drop", afterBytes: 4 });
  const fake = remote(plan);
  const h = await fake.start(spec(), "k");
  const dropping = await fake.connect?.open(h.id, "daemon-api");
  assert.ok(dropping);
  await dropping.write("abcdefgh");
  const seen: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const c of dropping.output()) seen.push(new TextDecoder().decode(c));
    })(),
    (e: unknown) => e instanceof SandboxUnavailableError && /dropped/.test(e.message),
  );
  assert.equal(seen.join(""), "abcd");
  assert.equal((await dropping.closed).reason, "error");
  await assert.rejects(dropping.write("more"), SandboxUnavailableError);
  const healthy = await fake.connect?.open(h.id, "workspace");
  assert.ok(healthy);
  await healthy.write("abcdefgh");
  const it = healthy.output()[Symbol.asyncIterator]();
  assert.equal(new TextDecoder().decode((await it.next()).value), "abcdefgh");
  healthy.close();
  assert.deepEqual(
    fake.ops.filter((o) => o.op === "connect").map((o) => o.channel),
    ["daemon-api", "workspace"],
  );
  plan.assertSpent();
});

test("a preempt fault makes wait() reject as unavailable, inspect report preempted and open channels error", async () => {
  const plan = new FaultPlan().add("wait", { kind: "preempt" });
  const fake = remote(plan);
  const h = await fake.start(spec(), "k");
  const ch = await fake.connect?.open(h.id, "daemon-api");
  assert.ok(ch);
  await assert.rejects(h.wait(), (e: unknown) => e instanceof SandboxUnavailableError && /preempted.*new idempotency key/.test(e.message));
  assert.equal((await fake.inspect(h.id))?.status, "preempted");
  assert.equal((await ch.closed).reason, "error");
  await assert.rejects(h.wait(), SandboxUnavailableError); // stays preempted
  plan.assertSpent();
});

test("a preempt fault on start ends the sandbox right after creating it", async () => {
  const plan = new FaultPlan().add("start", { kind: "preempt" });
  const fake = new FakeSandbox([], "graceful", { faults: plan });
  const h = await fake.start(spec(), "k");
  await assert.rejects(h.wait(), SandboxUnavailableError);
  assert.equal(fake.sandboxes.length, 1);
});

test("a timeout fault never settles until release() and then rejects as unreachable", async () => {
  const plan = new FaultPlan().add("list", { kind: "timeout" });
  const fake = new FakeSandbox([], "graceful", { faults: plan });
  let settled = false;
  const pending = fake.list(OWNER).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  assert.equal(plan.heldCount, 1);
  plan.release();
  await pending;
  assert.equal(plan.heldCount, 0);
  assert.equal((await fake.list(OWNER)).length, 0, "one-shot: the next list works");
});

test("a timeout error names cause and action", async () => {
  const plan = new FaultPlan().add("kill", { kind: "timeout" });
  const fake = new FakeSandbox([], "graceful", { faults: plan });
  const h = await fake.start(spec(), "k");
  const p = fake.kill(h.id, "kill-1");
  plan.release();
  await assert.rejects(p, (e: unknown) => e instanceof SandboxUnavailableError && e.reason === "provider-outage" && /timed out.*retry/.test(e.message));
});

test("an error fault on probe, inspect and connect passes the caller's error through", async () => {
  const boom = new SandboxUnavailableError("auth");
  const plan = new FaultPlan()
    .add("probe", { kind: "error", error: boom })
    .add("inspect", { kind: "error", error: boom })
    .add("connect", { kind: "error", error: boom });
  const fake = new FakeSandbox([], "graceful", { faults: plan, remote: true, probe: { withheld: [], problems: [], account: null } });
  const h = await fake.start(spec(), "k");
  await assert.rejects(fake.probe?.() as Promise<unknown>, (e) => e === boom);
  await assert.rejects(fake.inspect(h.id), (e) => e === boom);
  await assert.rejects(fake.connect?.open(h.id, "egress") as Promise<unknown>, (e) => e === boom);
  plan.assertSpent();
});

test("remote mode declares and installs connect and files; the default fake has neither", () => {
  const plain = new FakeSandbox();
  assert.equal(plain.connect, undefined);
  assert.equal(plain.files, undefined);
  const fake = remote();
  assert.ok(fake.connect && fake.files);
  assert.equal(fake.declaration.capabilities.connect, true);
  assert.equal(fake.declaration.capabilities["files.put"], true);
  assert.equal(plain.declaration.capabilities.connect, false);
});

test("every fault-injectable call is recorded in order with its key and sandbox id", async () => {
  const fake = remote();
  const h = await fake.start(spec(), "k");
  await fake.inspect(h.id);
  await fake.stop(h.id, 0, "s1");
  assert.deepEqual(
    fake.ops.map((o) => [o.op, o.key, o.id]),
    [
      ["start", "k", undefined],
      ["inspect", undefined, h.id],
      ["stop", "s1", h.id],
    ],
  );
});

test("a fault-free start, stop and kill take effect synchronously at call time", async () => {
  const fake = new FakeSandbox([3]);
  const pStart = fake.start(spec(), "k"); // not awaited
  assert.equal(fake.sandboxes.length, 1, "start created the sandbox before yielding");
  assert.equal(fake.started.length, 1);
  assert.equal(fake.exitCodes.length, 0, "the scripted exit code was consumed at call time");
  const h = await pStart;
  await h.wait();
  const fake3 = new FakeSandbox();
  const h3 = await fake3.start(spec(), "k");
  const pKill = fake3.kill(h3.id, "kill-1"); // not awaited
  assert.equal(fake3.running.get(h3.id)?.exitCode, 137, "kill finished the sandbox before yielding");
  await pKill;
  const fake2 = new FakeSandbox();
  const h2 = await fake2.start(spec(), "k");
  const pStop = fake2.stop(h2.id, 0, "stop-1"); // not awaited
  assert.equal(fake2.running.get(h2.id)?.exitCode, 0, "stop finished the sandbox before yielding");
  await pStop;
});

test("derivedIds mode: ids come from the key and an unknown outcome carries the id a retry gets", async () => {
  for (const applied of [true, false]) {
    const plan = new FaultPlan().add("start", { kind: "unknown-outcome", applied });
    const fake = new FakeSandbox([], "graceful", { faults: plan, derivedIds: true });
    const err = await fake.start(spec(), "key-1").catch((e: unknown) => e);
    assert.ok(err instanceof SandboxOutcomeUnknownError);
    assert.equal(err.id, sandboxIdForKey("key-1"), `applied:${applied}`);
    const h = await fake.start(spec(), "key-1");
    assert.equal(h.id, err.id, `retry returns the id the error named, applied:${applied}`);
    assert.equal(fake.sandboxes.length, 1);
  }
});

test("in the default id mode the unknown-outcome error id also matches the retry's handle", async () => {
  for (const applied of [true, false]) {
    const fake = new FakeSandbox([], "graceful", { faults: new FaultPlan().add("start", { kind: "unknown-outcome", applied }) });
    const err = await fake.start(spec(), "key-1").catch((e: unknown) => e);
    assert.ok(err instanceof SandboxOutcomeUnknownError);
    assert.equal((await fake.start(spec(), "key-1")).id, err.id, `applied:${applied}`);
  }
});

test("remote mode implies derived ids", async () => {
  const fake = remote();
  assert.equal((await fake.start(spec(), "key-1")).id, sandboxIdForKey("key-1"));
});

test("a transfer fault planned for a repeated put key still fires", async () => {
  const plan = new FaultPlan();
  const fake = remote(plan);
  const h = await fake.start(spec(), "k");
  const data = bytes("x");
  await fake.files?.put(h.id, "/w/f", body(data), sha(data), "p1");
  plan.add("files.put", { kind: "hash-mismatch" });
  // the fault fires on a repeat of p1; it must not be swallowed by the idempotent shortcut
  const err = await fake.files?.put(h.id, "/w/f", body(data), sha(data), "p1").catch((e: unknown) => e);
  assert.ok(err instanceof SandboxTransferError && err.reason === "hash-mismatch");
  plan.assertSpent();
});

test("the same put key on another path is a different upload", async () => {
  const fake = remote();
  const h = await fake.start(spec(), "k");
  const data = bytes("x");
  await fake.files?.put(h.id, "/w/a", body(data), sha(data), "p1");
  await fake.files?.put(h.id, "/w/b", body(data), sha(data), "p1");
  assert.deepEqual([...(fake.fileStore.get(h.id)?.keys() ?? [])].sort(), ["/w/a", "/w/b"]);
});

test("write after close, preempt or drop throws the port's unavailable error", async () => {
  const fake = remote();
  const h = await fake.start(spec(), "k");
  const closed = await fake.connect?.open(h.id, "daemon-api");
  assert.ok(closed);
  closed.close();
  await assert.rejects(closed.write("x"), SandboxUnavailableError);
  const preempted = await fake.connect?.open(h.id, "egress");
  assert.ok(preempted);
  await fake.inspect(h.id); // no fault: still running
  fake.faults.add("inspect", { kind: "preempt" });
  await fake.inspect(h.id);
  await assert.rejects(preempted.write("x"), SandboxUnavailableError);
});

test("a selector that can never match its operation is refused naming the allowed selectors", () => {
  assert.throws(
    () => new FaultPlan().add("inspect", { kind: "timeout" }, { key: "k" }),
    /selector "key" can never match operation "inspect" \(allowed selectors: id\)/,
  );
  assert.throws(
    () => new FaultPlan().add("start", { kind: "timeout" }, { id: "x" }),
    /selector "id" can never match operation "start" \(allowed selectors: key\)/,
  );
  assert.throws(() => new FaultPlan().add("list", { kind: "timeout" }, { id: "x" }), /allowed selectors: none/);
  assert.doesNotThrow(() => new FaultPlan().add("stop", { kind: "timeout" }, { key: "k", id: "x" }));
});
