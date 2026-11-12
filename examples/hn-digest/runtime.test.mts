// Probe for the real-stack runtime: a temporary extension (not HN) with a workflow declaring state + reports + send + submitResult.
// Launched through the real CLI, persisted across close+reopen on the same stateDir, with same-key replay and a conflicting 409.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { type DrainOptions, EXPIRED, raceUntil } from "../../packages/pomtreed/src/workflows.ts";
import { DirReportStore } from "../../packages/report-dir/src/index.ts";
import { openStore } from "../../packages/store-sqlite/src/index.ts";
import { boundedStep, type CloseLedger, openRuntime, type Runtime, runTeardown, type TeardownStep } from "./runtime.mts";

const PROBE_JS = `export default {
  init(host) {
    host.workflow({
      name: "echo",
      capabilities: { state: true, reports: { maxBytes: 4096 } },
      validate(input) {
        if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "input must be an object" };
        if (typeof input.run !== "string" || input.run === "") return { ok: false, error: "run is required" };
        return { ok: true, value: input };
      },
      async run(ctx) {
        const w = ctx.workflow;
        const run = ctx.input.run;
        await w.setState({ text: ctx.input.text, instance: w.instance }, "state-" + run);
        const report = await w.publishReport({ name: "probe-" + run + ".md", content: "# probe " + run + "\\n", mediaType: "text/markdown" }, "rep-" + run);
        await w.sendToUser("probe " + run + " done", "msg-" + run);
        await ctx.ops.submitResult({ summary: "probe " + run + " report " + report.id }, "res-" + run);
      },
    });
  },
};
`;

function fixtureExtensions(source = PROBE_JS): string {
  const dir = mkdtempSync(join(tmpdir(), "hn-probe-ext-"));
  const sub = join(dir, "probe");
  mkdirSync(sub);
  writeFileSync(
    join(sub, "manifest.json"),
    JSON.stringify({ apiVersion: 2, name: "probe", entry: "index.mjs", capabilities: { journalKinds: true, hooks: { journal: true } }, deps: ["record"] }),
  );
  writeFileSync(join(sub, "index.mjs"), source);
  return dir;
}

const TERMINAL = new Set(["exited", "reaped"]);
async function waitTerminal(rt: Runtime, agent: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const a = await rt.daemon.get(agent);
    if (a && TERMINAL.has(a.state)) return;
    if (Date.now() > end) throw new Error(`workflow ${agent} not terminal in ${ms}ms (state ${a?.state ?? "missing"})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const input = (run: string, text = "hi") => JSON.stringify({ instance: "a1", run, text });

test("probe: CLI launch persists state, report and outbox across close+reopen; same key converges; conflicting input is 409", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "hn-probe-state-"));
  const extDir = fixtureExtensions();
  const opts = { stateDir, extensionDir: extDir, reviewedOwners: ["probe"] };
  try {
    let rt = await openRuntime(opts);
    let agent: string;
    try {
      const launched = await rt.cli(["--json", "workflow", "launch", "probe/echo", "--input", input("r1"), "--key", "k1"]);
      assert.equal(launched.code, 0, launched.err.join("\n"));
      agent = (JSON.parse(launched.out.join("\n")) as { agent: string }).agent;
      await waitTerminal(rt, agent);
      const rec = await rt.daemon.get(agent);
      assert.ok(rec && TERMINAL.has(rec.state), "workflow task reached a terminal state");
      assert.equal(rec?.exit, "succeeded", "workflow task succeeded");
    } finally {
      await rt.close();
    }

    rt = await openRuntime(opts);
    try {
      const reports = await new DirReportStore({ root: join(stateDir, "reports"), registry: rt.stores.registry }).list(rt.root.id);
      assert.equal(reports.length, 1, "exactly one root report after reopen");
      assert.equal(reports[0]?.name, "probe-r1.md");

      const page = await rt.stores.journal.read({ from: 0, agent: rt.root.id, limit: 500 });
      const payloads = page.map((e) => e.payload as unknown as Record<string, unknown>);
      const state = payloads.filter((p) => p.kind === "ext.pomtreed.workflow_state");
      assert.equal(state.length, 1, "one state entry persisted");
      assert.equal(state[0]?.v, 1, "state envelope is v:1");
      assert.deepEqual(state[0]?.value, { text: "hi", instance: "a1" });
      assert.equal(payloads.filter((p) => p.kind === "ext.pomtreed.workflow_report").length, 1, "one provenance row");
      const sent = payloads.filter((p) => p.kind === "message_sent");
      assert.equal(sent.length, 1, `one outbox message persisted, got ${JSON.stringify(sent)}`);
      assert.ok(JSON.stringify(sent[0]).includes("probe r1 done"), `outbox carries the body: ${JSON.stringify(sent[0])}`);

      // Same launch key and same input: converges on the original task, no second run.
      const replay = await rt.cli(["--json", "workflow", "launch", "probe/echo", "--input", input("r1"), "--key", "k1"]);
      assert.equal(replay.code, 0, `replay: ${replay.err.join("\n")}`);
      assert.equal((JSON.parse(replay.out.join("\n")) as { agent: string }).agent, agent);

      // Same launch key, different input: refused with a conflict before any task starts.
      const conflict = await rt.cli(["--json", "workflow", "launch", "probe/echo", "--input", input("r1", "other"), "--key", "k1"]);
      assert.equal(conflict.code, 5, `expected conflict exit 5, got ${conflict.code}: ${conflict.err.join("\n")}`);

      // A fresh key is a fresh task with its own effect keys: a new report and a new state entry.
      const fresh = await rt.cli(["--json", "workflow", "launch", "probe/echo", "--input", input("r2"), "--key", "k2"]);
      assert.equal(fresh.code, 0, fresh.err.join("\n"));
      const freshAgent = (JSON.parse(fresh.out.join("\n")) as { agent: string }).agent;
      assert.notEqual(freshAgent, agent);
      await waitTerminal(rt, freshAgent);
      const reports2 = await new DirReportStore({ root: join(stateDir, "reports"), registry: rt.stores.registry }).list(rt.root.id);
      assert.equal(reports2.length, 2, "fresh launch adds one report");

      assert.deepEqual(rt.unusedCalls, [], "no sandbox, harness, model or workspace calls");
    } finally {
      await rt.close();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(extDir, { recursive: true, force: true });
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const publishingExtension = (detached: boolean) => `export default { init(host) { host.workflow({
  name: "echo", capabilities: { reports: { maxBytes: 4096 } }, validate(input) { return { ok: true, value: input }; },
  async run(ctx) {
    const publishing = ctx.workflow.publishReport({ name: "blocked.md", content: "report body" }, "blocked-report");
    ${detached ? 'void publishing.catch(() => {}); await ctx.ops.submitResult({ summary: "returned with effect pending" }, "returned");' : "await publishing;"}
  }
}); } };`;

test("runtime close joins the real workflow body blocked in publishAfterWrite before SQLite closes", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "hn-publish-join-"));
  const extDir = fixtureExtensions(publishingExtension(false));
  const published = deferred();
  const release = deferred();
  const joining = deferred();
  let closed = 0;
  const rt = await openRuntime({
    stateDir,
    extensionDir: extDir,
    reviewedOwners: ["probe"],
    publishAfterWrite: async () => {
      published.resolve();
      await release.promise;
    },
    openStore: (path) => {
      const store = openStore(path);
      const close = store.close.bind(store);
      store.close = () => {
        closed++;
        close();
      };
      return store;
    },
  });
  const idle = rt.host.idle.bind(rt.host);
  t.mock.method(rt.host, "idle", () => {
    const p = idle();
    joining.resolve();
    return p;
  });
  try {
    const launch = await rt.cli(["--json", "workflow", "launch", "probe/echo", "--input", "null", "--key", "blocked"]);
    assert.equal(launch.code, 0, launch.err.join("\n"));
    const agent = (JSON.parse(launch.out.join("\n")) as { agent: string }).agent;
    await published.promise;
    await rt.daemon.cancel(agent, 0); // logical cancellation must remain responsive, despite the actual handler still waiting
    assert.ok(TERMINAL.has((await rt.daemon.get(agent))?.state ?? ""));
    const closing = rt.close();
    void closing.catch(() => {});
    assert.notEqual(await raceUntil(joining.promise, Date.now() + 1_000), EXPIRED);
    assert.equal(closed, 0, "the body/effect join has started, but the report hook still holds SQLite");
    release.resolve();
    await closing;
    assert.equal(closed, 1);
    const reopened = openStore(join(stateDir, "pomtreed.sqlite"));
    try {
      const rows = await reopened.journal.read({ agent: rt.root.id, from: 0, limit: 500 });
      assert.equal(rows.filter((e) => e.payload.kind === "ext.pomtreed.workflow_report").length, 1, "late report provenance finished before store close");
    } finally {
      reopened.close();
    }
  } finally {
    release.resolve();
    await idle();
    await rt.close().catch(() => {});
    if (closed === 0) {
      await rt.extensions.stopForShutdown([]);
      await rt.extensions.finishShutdown();
      rt.stores.close();
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(extDir, { recursive: true, force: true });
  }
});

for (const detached of [false, true]) {
  test(`runtime close retains owner and SQLite for a pending ${detached ? "unawaited effect after body return" : "cancelled workflow body"}; late provenance remains safe`, async (t) => {
    const stateDir = mkdtempSync(join(tmpdir(), "hn-publish-retain-"));
    const extDir = fixtureExtensions(publishingExtension(detached));
    const published = deferred();
    const release = deferred();
    let closed = 0;
    const rt = await openRuntime({
      stateDir,
      extensionDir: extDir,
      reviewedOwners: ["probe"],
      publishAfterWrite: async () => {
        published.resolve();
        await release.promise;
      },
      openStore: (path) => {
        const store = openStore(path);
        const close = store.close.bind(store);
        store.close = () => {
          closed++;
          close();
        };
        return store;
      },
    });
    // Lower only the inner drain deadline, leaving the runtime's existing absolute deadline enough budget to close listeners.
    const drain = rt.host.drainSafe.bind(rt.host);
    t.mock.method(rt.host, "drainSafe", (o: DrainOptions) => {
      const deadlineAt = Math.min(o.deadlineAt, Date.now() + 30);
      return drain({ ...o, deadlineAt, race: (p) => raceUntil(p, deadlineAt) });
    });
    try {
      const launch = await rt.cli(["--json", "workflow", "launch", "probe/echo", "--input", "null", "--key", "blocked"]);
      assert.equal(launch.code, 0, launch.err.join("\n"));
      const agent = (JSON.parse(launch.out.join("\n")) as { agent: string }).agent;
      await published.promise;
      await rt.daemon.cancel(agent, 0);
      await assert.rejects(rt.close(), (e: Error) => {
        assert.match(e.message, /drain: incomplete.*probe/);
        assert.match(e.message, /store close: skipped/);
        return true;
      });
      assert.equal(closed, 0);
      assert.ok(rt.host.executors.has("probe/echo"), "the unresolved effect's owner must not be stopped or withdrawn");
      await assert.rejects(rt.extensions.stopAll({ throwOnStopFailure: true }), /workflow executor\/effect\(s\) still unsettled/);
      release.resolve();
      await rt.host.idle();
      const rows = await rt.stores.journal.read({ agent: rt.root.id, from: 0, limit: 500 });
      assert.equal(
        rows.filter((e) => e.payload.kind === "ext.pomtreed.workflow_report").length,
        1,
        "retained SQLite admits the already-started effect's late audit continuation",
      );
    } finally {
      release.resolve();
      await rt.host.idle();
      await rt.close().catch(() => {});
      await rt.extensions.stopForShutdown([], { throwOnStopFailure: true });
      await rt.extensions.finishShutdown();
      if (closed === 0) rt.stores.close();
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(extDir, { recursive: true, force: true });
    }
  });
}

test("runtime stop releases its own journal callback before joining it and closing SQLite", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "hn-hook-stop-"));
  const extDir = fixtureExtensions(`let release;
    const gate = new Promise((r) => { release = r; });
    let entered;
    export const started = new Promise((r) => { entered = r; });
    export let finished = false;
    export default { init(host) {
      host.journalKind({ kind: "finished", validate: () => true });
      host.onJournal(async (entry) => { if (entry.payload.kind !== "started") return; entered(); await gate;
        await host.deps.record(entry.agent, "finished", {}, "hook-finished"); finished = true;
      });
    }, stop() { release(); } };`);
  const rt = await openRuntime({ stateDir, extensionDir: extDir, reviewedOwners: [] });
  try {
    const fixture = await import(pathToFileURL(realpathSync(join(extDir, "probe", "index.mjs"))).href);
    await rt.stores.journal.append({
      agent: rt.root.id,
      host: rt.root.host,
      generation: rt.root.generation,
      payload: { kind: "started" },
      idempotencyKey: "hook-start",
    });
    await fixture.started;
    await rt.close();
    assert.equal(fixture.finished, true, "stop released the callback and its final SQLite write was joined");
  } finally {
    await rt.close().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(extDir, { recursive: true, force: true });
  }
});

const ledger = (): CloseLedger => ({ failures: [], unjoined: false });

test("close teardown: reverse order, a failing step is ledgered with redaction and later steps still run", async () => {
  const order: string[] = [];
  const l = ledger();
  const steps: TeardownStep[] = [
    { label: "store close", store: true, run: async () => void order.push("store") },
    { label: "a", run: async () => void order.push("a") },
    {
      label: "b",
      run: async () => {
        throw new Error("boom sekret");
      },
    },
  ];
  await runTeardown(steps, l, Date.now() + 1_000, ["sekret"]);
  assert.deepEqual(order, ["a", "store"]);
  assert.equal(l.failures.length, 1);
  assert.match(l.failures[0] ?? "", /b: boom \[redacted\]/);
});

test("close teardown: a hung step is bounded, marks unjoined, and the store is not closed under it", async () => {
  const order: string[] = [];
  const l = ledger();
  const t0 = Date.now();
  await runTeardown(
    [
      { label: "store close", store: true, run: async () => void order.push("store") },
      { label: "hung", run: () => new Promise<void>(() => {}) },
    ],
    l,
    Date.now() + 50,
  );
  assert.ok(Date.now() - t0 < 1_000);
  assert.equal(l.unjoined, true);
  assert.deepEqual(order, []);
  assert.ok(l.failures.some((f) => /hung: timed out/.test(f)));
  assert.ok(l.failures.some((f) => /store close: skipped/.test(f)));
});

test("boundedStep: success returns the value and records nothing", async () => {
  const l = ledger();
  const v = await boundedStep("ok", async () => 7, Date.now() + 1_000, l);
  assert.equal(v, 7);
  assert.deepEqual(l, { failures: [], unjoined: false });
});

test("boundedStep: a failed step is recorded with redaction, not a silent empty result", async () => {
  const l = ledger();
  const v = await boundedStep(
    "list sandboxes",
    async () => {
      throw new Error("docker down for k-test");
    },
    Date.now() + 1_000,
    l,
    ["k-test"],
  );
  assert.equal(v, undefined);
  assert.equal(l.failures.length, 1);
  assert.match(l.failures[0] ?? "", /^list sandboxes: /);
  assert.ok(!(l.failures[0] ?? "").includes("k-test"), "failure text must be redacted");
  assert.equal(l.unjoined, false);
});

test("boundedStep: a step past the shared deadline times out, is recorded, and marks the ledger unjoined", async () => {
  const l = ledger();
  const v = await boundedStep("hung kill", () => new Promise<never>(() => {}), Date.now() + 20, l);
  assert.equal(v, undefined);
  assert.deepEqual(l.failures, ["hung kill: timed out"]);
  assert.equal(l.unjoined, true);
});

test("boundedStep: a synchronous throw and a late rejection are both absorbed into the ledger", async () => {
  const l = ledger();
  await boundedStep(
    "sync",
    () => {
      throw new Error("x");
    },
    Date.now() + 100,
    l,
  );
  await boundedStep("late", () => new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 80)), Date.now() + 10, l);
  await new Promise((r) => setTimeout(r, 120)); // would surface as an unhandled rejection if not absorbed
  assert.equal(l.failures.length, 2);
});

test("partial-open failure sanitizes the original diagnostic after clean teardown and closes the actual store once", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "hn-probe-state-"));
  let closed = 0;
  try {
    await assert.rejects(
      () =>
        openRuntime({
          stateDir,
          extensionDir: join(stateDir, "missing-extensions"),
          reviewedOwners: [],
          openStore: (path) => {
            const store = openStore(path);
            const close = store.close.bind(store);
            store.close = () => {
              closed++;
              close();
            };
            return store;
          },
        }),
      (e: Error) => {
        assert.match(e.message, /ENOENT/);
        assert.ok(!e.message.includes(stateDir), "catch-path errors must not expose the caller's local path");
        assert.doesNotMatch(e.message, /teardown failures/);
        return true;
      },
    );
    assert.equal(closed, 1, "observe closure, not a second SQLite open (which permits multiple live handles)");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("partial-open teardown: a rejected resource stop keeps SQLite open while later teardown still runs", async () => {
  const l = ledger();
  const order: string[] = [];
  await runTeardown(
    [
      {
        label: "store close",
        store: true,
        run: async () => {
          order.push("store");
        },
      },
      {
        label: "socket close",
        run: async () => {
          order.push("socket");
        },
      },
      {
        label: "extensions stop",
        retainStoreOnFailure: true,
        run: async () => {
          throw new Error("refused with live tasks");
        },
      },
    ],
    l,
    Date.now() + 1_000,
  );
  assert.deepEqual(order, ["socket"]);
  assert.equal(l.unjoined, true);
  assert.match(l.failures.join("; "), /extensions stop: refused with live tasks.*store close: skipped/);
});

test("boundedStep: an expired deadline does not start new work", async () => {
  const l = ledger();
  let started = false;
  await boundedStep(
    "expired",
    async () => {
      started = true;
    },
    Date.now() - 1,
    l,
  );
  assert.equal(started, false);
  assert.equal(l.unjoined, true);
  assert.match(l.failures[0] ?? "", /expired: skipped.*deadline expired/);
});

test("boundedStep: synchronous overruns are reported, not claimed interruptible", async (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const l = ledger();
  const value = await boundedStep(
    "sync fs",
    async () => {
      now = 102;
      return true;
    },
    101,
    l,
  );
  assert.equal(value, undefined);
  assert.equal(l.unjoined, true);
  assert.deepEqual(l.failures, ["sync fs: timed out"]);
});

test("runtime close: a throwing extension stop rejects the cached close and never logs its raw diagnostic", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "hn-probe-stop-"));
  const extDir = fixtureExtensions('export default { stop() { throw new Error("credential=STOP-SECRET /private/diagnostic"); } };');
  const logs: string[] = [];
  t.mock.method(console, "error", (line: string) => logs.push(line));
  try {
    const rt = await openRuntime({ stateDir, extensionDir: extDir, reviewedOwners: [] });
    const closing = rt.close();
    assert.equal(rt.close(), closing, "close is still idempotent");
    await assert.rejects(closing, (e: Error) => {
      assert.match(e.message, /extensions shutdown: extensions failed to stop: probe/);
      assert.match(e.message, /store close: skipped/);
      return true;
    });
    await rt.stores.registry.list(); // failed extension cleanup retained the store, visibly and conservatively
    rt.stores.close(); // the test extension only throws, so the test can explicitly release its retained fixture
    assert.doesNotMatch(logs.join("\n"), /STOP-SECRET|private\/diagnostic/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(extDir, { recursive: true, force: true });
  }
});
