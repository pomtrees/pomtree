import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { SandboxUnavailableError } from "@pomtree/core";
import { Daemon } from "./daemon.ts";
import { setup } from "./test-setup.ts";
import { HOST_HEALTH_KIND } from "./watchdog.ts";

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

type Recorder = { record(r: unknown, p: unknown, k: string): Promise<unknown> };
const downThenBoot = async (fillers: number) => {
  const t = setup(async () => {});
  const { sb } = downSandbox(t);
  const a = new Daemon({ ...t.daemon.deps, sandbox: sb, admitRetryMs: 5 });
  await a.probeSandbox();
  const root = await a.root();
  for (let i = 0; i < fillers; i++)
    await t.journal.append({
      agent: root.id,
      host: root.host,
      generation: root.generation,
      payload: { kind: "host_error", component: "daemon", message: "filler" },
      idempotencyKey: `fill-${i}`,
    });
  const b = new Daemon({ ...t.daemon.deps, admitRetryMs: 5 });
  await b.recover();
  return { a, b, t, root };
};

test("a later host-health heartbeat carries the flag, so the stored state stays current while the outage lasts", async () => {
  const { a, t, root } = await downThenBoot(0);
  await (a as unknown as Recorder).record(root, { kind: HOST_HEALTH_KIND, ok: false, sweepsStale: false }, "hb-1");
  const last = (await t.journal.read({ agent: root.id })).filter((e) => e.payload.kind === HOST_HEALTH_KIND).at(-1)!;
  assert.equal((last.payload as { sandboxUp?: boolean }).sandboxUp, false);
});

test("the reload reads a bounded tail: a down entry within the window cap is found, one beyond it is not (boots up)", async () => {
  const near = await downThenBoot(3000);
  assert.equal((await near.b.doctor()).sandboxUp, false, "within four windows of the tail");
  const far = await downThenBoot(4100);
  assert.equal((await far.b.doctor()).sandboxUp, true, "beyond the cap: not read, boots up and the first probe corrects it");
});

test("a failed write of the sandbox state is logged with its cause and the action, and the flag still holds admission", async () => {
  const t = setup(async () => {});
  const { sb } = downSandbox(t);
  const journal = Object.create(t.journal) as typeof t.journal;
  journal.append = async (e) => {
    if ((e.payload as { sandboxUp?: unknown }).sandboxUp !== undefined) throw new Error("disk exploded");
    return t.journal.append(e);
  };
  const log = mock.method(console, "error", () => {});
  try {
    const a = new Daemon({ ...t.daemon.deps, journal, sandbox: sb, admitRetryMs: 5 });
    await a.probeSandbox();
    assert.equal((await a.doctor()).sandboxUp, false);
    const msg = log.mock.calls.map((c) => String(c.arguments[0])).find((m) => /could not store the sandbox down state/.test(m));
    assert.match(msg ?? "", /disk exploded.*assume the sandbox is up until a probe fails.*check free disk space/);
  } finally {
    log.mock.restore();
  }
});
