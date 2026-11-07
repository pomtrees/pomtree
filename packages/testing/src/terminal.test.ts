import { test } from "node:test";
import assert from "node:assert/strict";
import { LOOPBACK_PORTS, SandboxUnavailableError, type LoopbackPort } from "@pomtree/core";
import { createFakes, FakeByteStream } from "./index.ts";

test("FakeSandbox.openTerminal: records writes/resizes/closes, scripted output, ends on sandbox exit", async () => {
  const f = createFakes();
  const h = await f.sandbox.start(
    { agent: "a", image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-a", containerPath: "/w" }], tty: { cols: 80, rows: 24 } },
    "k-term",
  );
  assert.deepEqual(f.sandbox.started[0]!.tty, { cols: 80, rows: 24 });
  const t = await f.sandbox.openTerminal(h.id, { cols: 80, rows: 24 });
  const fake = f.sandbox.terminals.get(h.id)![0]!;
  assert.equal(fake, t);
  await t.write("ls\r");
  await t.resize(100, 30);
  await t.redraw();
  assert.equal(fake.written, "ls\r");
  assert.deepEqual(fake.resizes, [
    { cols: 80, rows: 24 },
    { cols: 100, rows: 30 },
    { cols: 101, rows: 30 },
    { cols: 100, rows: 30 },
  ]);
  fake.emit("out");
  const it = t.output()[Symbol.asyncIterator]();
  assert.equal(new TextDecoder().decode((await it.next()).value), "out");
  const next = it.next();
  f.sandbox.exit(h.id, 0);
  assert.equal((await next).done, true);
  assert.deepEqual(await t.closed, { reason: "remote" });
  await assert.rejects(t.write("x"), /closed/);
  t.close();
  t.close();
  assert.equal(fake.closes, 2);
  await assert.rejects(() => f.sandbox.openTerminal(h.id), SandboxUnavailableError);
});

test("FakeSandbox.openLoopbackStream: records writes/closes, scripted output, ends on sandbox exit, scripted errors", async () => {
  const f = createFakes();
  const h = await f.sandbox.start({ agent: "a", image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-a", containerPath: "/w" }] }, "k-lb");
  const b = await f.sandbox.openLoopbackStream(h.id, LOOPBACK_PORTS[0]);
  const fake = f.sandbox.loopbackStreams.get(h.id)![0]!;
  assert.equal(fake, b);
  assert.deepEqual(f.sandbox.loopbackCalls, [{ id: h.id, port: 9222 }]);
  await b.write(new TextEncoder().encode("GET /"));
  assert.equal(fake.written, "GET /");
  fake.emit("pong");
  const it = b.output()[Symbol.asyncIterator]();
  assert.equal(new TextDecoder().decode((await it.next()).value), "pong");
  const next = it.next();
  f.sandbox.exit(h.id, 0);
  assert.equal((await next).done, true);
  assert.deepEqual(await b.closed, { reason: "remote" });
  await assert.rejects(b.write(new Uint8Array()), /closed/);
  b.close();
  assert.equal(fake.closes, 1);
  // Negative: not running, a port outside LOOPBACK_PORTS (also recorded), a scripted error.
  await assert.rejects(() => f.sandbox.openLoopbackStream(h.id, 9222), SandboxUnavailableError);
  const h2 = await f.sandbox.start({ agent: "b", image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-b", containerPath: "/w" }] }, "k-lb2");
  await assert.rejects(() => f.sandbox.openLoopbackStream(h2.id, 22 as LoopbackPort), RangeError);
  f.sandbox.loopbackErrors.push(new Error("scripted"), null);
  await assert.rejects(() => f.sandbox.openLoopbackStream(h2.id, 9222), /scripted/);
  await f.sandbox.openLoopbackStream(h2.id, 9222);
  assert.equal(f.sandbox.loopbackStreams.get(h2.id)!.length, 1);
});

test("FakeByteStream: fail() breaks output after the queue drains and resolves error; close() resolves local", async () => {
  const s = new FakeByteStream();
  s.emit("a");
  s.fail(new Error("broke"));
  const it = s.output()[Symbol.asyncIterator]();
  assert.equal(new TextDecoder().decode((await it.next()).value), "a");
  await assert.rejects(it.next(), /broke/);
  assert.equal((await s.closed).reason, "error");
  const t = new FakeByteStream();
  t.close();
  assert.deepEqual(await t.closed, { reason: "local" });
});
