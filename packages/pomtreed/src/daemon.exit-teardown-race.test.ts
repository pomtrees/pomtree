import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeModelDebitStore } from "@pomtree/testing";
import { SANDBOX_LIFECYCLE_KIND } from "./daemon-util.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { get, SECRET, setup, until } from "./test-setup.ts";

// The exit teardown race (teardownExit): settleLocked fences the generation once, then unstages, revokes and releases with awaits
// between. A forced resume landing inside the revoke made the late release free the resumed generation's slot, and settleLocked then
// finish()ed the resumed generation. The fixture holds the exit teardown's revoke (the first revoke of the run) until `release`.
// `resumeDuring`: a forced resume runs while the revoke is held and gets as far as issuing, staging and admitting gen+1.
for (const resumeDuring of [true, false]) {
  test(`an exit teardown ${resumeDuring ? "overtaken by a forced resume leaves the resumed generation running with its credentials, key and slot" : "with no newer generation still unstages, revokes, releases and finishes (negative control)"}`, async () => {
    const staged = new Set<string>();
    const unstages: string[] = [];
    const credentials = {
      stage: (id: string) => {
        staged.add(id);
        return [];
      },
      unstage: (id: string) => {
        unstages.push(id);
        staged.delete(id);
      },
      providerIds: () => [],
    };
    let end!: () => void;
    const ended = new Promise<void>((r) => (end = r));
    const t = setup(
      async (c) => {
        if (c.wake !== undefined) return void (await c.stopped); // the resumed generation stays running
        await ended; // then the run exits with no result: the settle tears it down as an exit
      },
      { credentials: credentials as never },
    );
    const d = t.daemon;
    const gw = new ProxyCredentialGateway({
      journal: d.deps.journal,
      registry: d.deps.registry,
      secret: SECRET,
      proxyBaseUrl: "http://m",
      tokenTtlMs: 3_600_000,
      debits: new FakeModelDebitStore({ secret: SECRET }),
    });
    (d.deps as unknown as { gateway: typeof gw }).gateway = gw;
    const keys: string[] = [];
    const issue = gw.issueKey.bind(gw);
    gw.issueKey = async (agent, budget, idem) => {
      const k = await issue(agent, budget, idem);
      keys.push(k.key);
      return k;
    };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let revokes = 0;
    const revoke = gw.revoke.bind(gw);
    gw.revoke = async (agent) => {
      const r = revoke(agent); // the revocation itself lands now; the teardown is held after it
      if (revokes++ === 0) await held;
      return r;
    };
    const a = await t.spawn();
    await until(() => keys.length === 1 && staged.has(a.id));
    await d.deps.checkpoints.write(
      {
        agent: a.id,
        generation: a.generation,
        host: "h1",
        sessionRef: "sha256:fake",
        workspace: `ws-${a.id}`,
        node: "h1",
        ingested: null,
        wait: { kind: "message" },
        remainingBudgetMicros: 50_000,
        imageDigest: "img@sha256:x",
        envManifestHash: null,
        template: "code",
        templateDigest: null,
        resumeLevel: "session" as const,
      },
      "cp-key",
    );
    end();
    await until(() => revokes === 1).catch(() => {
      throw new Error("the exit teardown never reached its revoke");
    });
    assert.deepEqual(unstages, [a.id], "the exit teardown unstaged before its revoke");
    if (resumeDuring) {
      await d.resumeAgent(a.id, "wake", { forced: true });
      await until(async () => keys.length === 2 && staged.has(a.id) && (await t.fakes.hosts.getReservation(a.id))?.state === "running").catch(() => {
        throw new Error("the forced resume never issued, staged and admitted gen+1");
      });
    }
    release();
    if (resumeDuring) {
      await new Promise((r) => setTimeout(r, 50)); // the rest of the exit teardown and settle has run by now
      const r = await get(t, a.id);
      assert.equal(r.state, "running", "the late settle must not finish the resumed generation");
      assert.equal(r.generation, a.generation + 1);
      assert.ok(staged.has(a.id), "the resumed generation's credentials survive");
      assert.ok(gw.authorize(keys[1] ?? ""), "the resumed generation's model key survives");
      assert.equal((await t.fakes.hosts.getReservation(a.id))?.state, "running", "the resumed generation keeps its placement slot");
      await d.kill(a.id);
    } else {
      await t.orchestrator.idle();
      const r = await get(t, a.id);
      assert.ok(r.state === "exited" || r.state === "reaped", `finished, not ${r.state}`);
      assert.equal(r.generation, a.generation);
      assert.ok(!staged.has(a.id), "credentials unstaged");
      assert.equal(await t.fakes.hosts.getReservation(a.id), null, "the placement slot is released");
    }
    assert.equal(gw.authorize(keys[0] ?? ""), null, "the exited run's key is revoked");
    await t.orchestrator.idle();
  });
}

// settleLocked's superseded branch journaled `sandbox exited cause=superseded` at the superseded generation, which the journal always
// refuses ('audit write failed (sandbox-exited)'). It now writes nothing; the resumed generation's own rows record the supersession.
// Negative control: an exit with no newer generation still journals its `sandbox exited` row.
for (const superseded of [true, false]) {
  test(`a ${superseded ? "superseded run's settle writes no stale-generation sandbox exit row" : "run that exits with no newer generation journals its sandbox exit (negative control)"}`, async () => {
    let end!: () => void;
    const ended = new Promise<void>((r) => (end = r));
    const t = setup(async (c) => {
      if (c.wake !== undefined) return void (await c.stopped);
      await (superseded ? c.stopped : ended);
    });
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    try {
      const d = t.daemon;
      const a = await t.spawn();
      await until(async () => (await get(t, a.id)).sandbox !== null);
      const sb0 = (await get(t, a.id)).sandbox;
      if (superseded) {
        await d.deps.checkpoints.write(
          {
            agent: a.id,
            generation: a.generation,
            host: "h1",
            sessionRef: "sha256:fake",
            workspace: `ws-${a.id}`,
            node: "h1",
            ingested: null,
            wait: { kind: "message" },
            remainingBudgetMicros: 50_000,
            imageDigest: "img@sha256:x",
            envManifestHash: null,
            template: "code",
            templateDigest: null,
            resumeLevel: "session" as const,
          },
          "cp-key",
        );
        await d.resumeAgent(a.id, "wake", { forced: true });
        await until(async () => {
          const r = await get(t, a.id);
          return r.generation === a.generation + 1 && r.sandbox !== null && r.sandbox !== sb0;
        });
        await new Promise((r) => setTimeout(r, 50)); // the superseded run's settle has run by now
      } else {
        end();
        await t.orchestrator.idle();
      }
      const exited = (await t.journal.read({ agent: a.id })).filter(
        (e) =>
          e.payload.kind === SANDBOX_LIFECYCLE_KIND &&
          (e.payload as { phase?: string }).phase === "exited" &&
          (e.payload as { sandbox?: string }).sandbox === sb0,
      );
      assert.equal(exited.length, superseded ? 0 : 1);
      if (!superseded) assert.equal(exited[0]?.generation, a.generation);
      assert.deepEqual(
        errors.filter((e) => e.includes("audit write failed")),
        [],
      );
      if (superseded) await d.kill(a.id);
      await t.orchestrator.idle();
    } finally {
      console.error = realError;
    }
  });
}
