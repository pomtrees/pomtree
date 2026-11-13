import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxUnavailableError } from "@pomtree/core";
import { Daemon } from "./daemon.ts";
import { setup } from "./test-setup.ts";

// The sandbox-reachable flag is durable: a daemon booted on the same store after another recorded the sandbox down starts down
// (admission held, doctor reports it) without waiting for its own first probe.
const downSandbox = (t: ReturnType<typeof setup>) => {
  const raw = t.fakes.hooks.raw;
  let down = true;
  const sb = Object.create(raw.sandbox) as typeof raw.sandbox;
  sb.list = async (owner) => {
    if (down) throw new SandboxUnavailableError();
    return raw.sandbox.list(owner);
  };
  return {
    sb,
    up: () => {
      down = false;
    },
  };
};

test("sandbox down survives a restart: the next daemon holds admission before its first probe, and a probe that succeeds persists up", async () => {
  const t = setup(async () => {});
  const { sb, up } = downSandbox(t);
  const a = new Daemon({ ...t.daemon.deps, sandbox: sb, admitRetryMs: 5 });
  await a.probeSandbox();
  assert.equal((await a.doctor()).sandboxUp, false);

  // Daemon B: same store, working sandbox, no probe run.
  const b = new Daemon({ ...t.daemon.deps, admitRetryMs: 5 });
  await b.recover();
  assert.equal((await b.doctor()).sandboxUp, false, "restart restored the down flag from the store");
  const root = await b.root();
  const w = await b.spawn(root.id, { name: "w", task: "t", idempotencyKey: "k-held" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await b.get(w.id))!.state, "pending", "admission stays held until a probe succeeds");

  up();
  await b.probeSandbox();
  assert.equal((await b.doctor()).sandboxUp, true);

  // Daemon C: the recovery was persisted too, so the flag does not stay latched down.
  const c = new Daemon({ ...t.daemon.deps, admitRetryMs: 5 });
  await c.recover();
  assert.equal((await c.doctor()).sandboxUp, true, "an up transition clears the stored down state");
});

test("a store that never recorded the sandbox down boots with the sandbox up", async () => {
  const t = setup(async () => {});
  const b = new Daemon({ ...t.daemon.deps, admitRetryMs: 5 });
  await b.recover();
  assert.equal((await b.doctor()).sandboxUp, true);
});
