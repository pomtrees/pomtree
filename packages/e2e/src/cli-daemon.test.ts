import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Transport } from "@pomtree/pomtree";
import { run, socketTransport, TransportError } from "@pomtree/pomtree";
import { listen, issueToken } from "@pomtree/pomtreed";
import type { Rig } from "./harness.ts";
import { rig, SECRET, until } from "./harness.ts";

// The ~70 `pomtree` CLI tests use a fake transport, so route/body drift against pomtreed only shows up
// here. These drive the real CLI (`run` + a real unix-socket transport) against a real `listen()`ed
// daemon for cancel/kill.
const runCli = async (r: Rig, argv: string[]) => {
  const socketPath = join(r.stateDir, "pomtreed.sock");
  const server = await listen(r.daemon, socketPath);
  const out: string[] = [];
  const err: string[] = [];
  try {
    const code = await run(argv, {
      call: socketTransport(socketPath, issueToken(SECRET, { scope: "operator" })),
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      isTTY: false,
      version: "0.0.0",
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    server.close();
  }
};

test("pomtree cancel through the real daemon cancels a running agent", async () => {
  const r = rig({ play: () => ({ hold: new Promise(() => {}) }) });
  try {
    const root = await r.daemon.root();
    const a = await r.daemon.spawn(root.id, { name: "w", task: "t", idempotencyKey: "w" });
    await until(async () => (await r.daemon.get(a.id))?.state === "running", "agent running");

    const res = await runCli(r, ["cancel", a.id]);
    assert.equal(res.code, 0, `stderr: ${res.err}`);
    assert.equal(res.out.trim(), "cancel requested");
    await r.orchestrator.idle();

    const rec = (await r.daemon.get(a.id))!;
    assert.equal(rec.state, "reaped");
    assert.equal(rec.exit, "cancelled");
  } finally {
    r.store.close();
  }
});

test("pomtree kill through the real daemon force-stops a running agent", async () => {
  const r = rig({ play: () => ({ hold: new Promise(() => {}) }) });
  try {
    const root = await r.daemon.root();
    const a = await r.daemon.spawn(root.id, { name: "w", task: "t", idempotencyKey: "w" });
    await until(async () => (await r.daemon.get(a.id))?.state === "running", "agent running");

    const res = await runCli(r, ["kill", a.id]);
    assert.equal(res.code, 0, `stderr: ${res.err}`);
    assert.equal(res.out.trim(), "kill requested");
    await r.orchestrator.idle();

    const rec = (await r.daemon.get(a.id))!;
    assert.equal(rec.state, "reaped");
    assert.equal(rec.exit, "cancelled");
  } finally {
    r.store.close();
  }
});

test("pomtree logs -f surfaces a transport error when the stream breaks mid-follow", async () => {
  // The first poll goes through the real daemon (validating the `logs` route + `-f` query), then a
  // transport fault on the second poll stands in for a daemon dropping the connection mid-stream.
  const r = rig({
    play: () => ({ events: [{ kind: "message", role: "assistant", text: "hi" }], hold: new Promise(() => {}) }),
  });
  try {
    const root = await r.daemon.root();
    const a = await r.daemon.spawn(root.id, { name: "w", task: "t", idempotencyKey: "w" });
    await until(async () => (await r.daemon.events({ agent: a.id })).some((e) => e.payload.kind === "message"), "message emitted");

    const socketPath = join(r.stateDir, "pomtreed.sock");
    const server = await listen(r.daemon, socketPath);
    const real = socketTransport(socketPath, issueToken(SECRET, { scope: "operator" }));
    let calls = 0;
    const flaky: Transport = async (c) => {
      calls += 1;
      if (calls === 3) throw new TransportError("connection closed mid-stream");
      return real(c);
    };
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(["logs", a.id, "-f"], {
      call: flaky,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      isTTY: false,
      version: "0.0.0",
    });
    server.close();
    assert.equal(code, 6, `out=${out.join("\n")} err=${err.join("\n")}`);
    assert.ok(out.length >= 1, "first poll printed events before the stream broke");
  } finally {
    r.store.close();
  }
});
