// CUS (S0, in-process, no Docker): custody of a dead parent's exited children through the real API with scripted agents' own tokens and the
// operator token (CUS-6, CUS-9, CUS-11). The daemon-level cases are in packages/pomtreed/src/daemon.custody*.test.ts;
// these are the first checks that drive the whole path: an agent's spawn, a kill, the custodian's inbox, its reads and its reap over HTTP handlers.
// The container half is cli-custody.test.ts. Run: node --test packages/e2e/src/custody.test.ts
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { AgentRecord, Signal } from "@pomtree/core";
import { handle, issueToken } from "@pomtree/pomtreed";
import { keyed } from "@pomtree/testing";
import { SECRET, playHarness, rig, until } from "./harness.ts";
import type { Api, Play, Rig } from "./harness.ts";

const BUDGET = 500; // each child's carve; nothing is spent on fakes, so a reap returns all of it
type Exited = Extract<Signal, { kind: "child_exited" }>;

const gate = () => {
  let open = () => {};
  const hold = new Promise<void>((res) => (open = res));
  return { hold, open };
};
// A bounded wait on a gate, so a custodian that is never woken fails the test with its cause instead of hanging it.
const within = async (p: Promise<void>, what: string, ms = 20_000): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([p, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms)))]).finally(() =>
    clearTimeout(timer),
  );
};

const roleOf = (prompt: string): string => /\[\[role:(\w+)\]\]/.exec(prompt)?.[1] ?? "";

interface Facts {
  ids: Record<string, string>;
  midIsLive: boolean;
  inbox: Exited[]; // the custodian's inbox when it was woken, custody signals and the dead parent's own
  views: Record<string, { show: number; events: number; wait: number; waitDone: boolean; stateBefore: string; exit: string }>;
  reaps: Record<string, { status: number; unusedMicros?: number; state?: string }>;
}

interface Opts {
  reap: boolean; // the custodian reaps its two zombies when it wakes (else it parks holding them)
  withChannel?: boolean;
  rootCustodyMax?: number;
  kids?: number; // orphans the middle spawns (default 2)
}

// root -> top -> mid -> {kidA, kidB} (a test may spawn the middle from the root instead), plus an operator-spawned sibling of top. Kids report at once. The middle
// parks after both kids have exited, never reaping. The top yields on its middle child; woken by the middle's exit it reads its inbox until both
// custody signals are in, then (reap) shows, reads, waits on and reaps each kid, or (not reap) parks.
function build(o: Opts) {
  const released = gate(); // frees every parked agent when a test ends
  const proceed = gate(); // the custodian holds the test's checkpoint here, after it has read its inbox and before it reaps
  const atCheckpoint = gate();
  const facts: Facts = { ids: {}, midIsLive: false, inbox: [], views: {}, reaps: {} };
  const kids = ["kidA", "kidB", "kidC"].slice(0, o.kids ?? 2);

  const play = (agent: string, prompt: string): Play => {
    const role = roleOf(prompt);
    facts.ids[role] = agent;
    if (role.startsWith("kid")) return { result: { status: "succeeded", result: { summary: `poem-${role}` } } };
    if (role === "sib") return { hold: released.hold, result: { status: "succeeded", result: { summary: "sib" } } };
    if (role === "mid") {
      return {
        run: async (api: Api) => {
          for (const k of kids) {
            const sp = await api("POST", "/v1/agents", { name: k, task: `[[role:${k}]]`, idempotencyKey: k, budgetMicros: BUDGET });
            assert.equal(sp.status, 201, `mid spawn ${k}: ${JSON.stringify(sp.body)}`);
          }
          await until(
            async () => (await Promise.all(kids.map((k) => r.daemon.get(facts.ids[k] ?? "")))).every((x) => x?.state === "exited"),
            "both kids exited",
          );
          facts.midIsLive = true;
        },
        hold: released.hold,
      };
    }
    // top
    return {
      run: async (api: Api) => {
        const sp = await api("POST", "/v1/agents", { name: "mid", task: "[[role:mid]]", idempotencyKey: "mid", budgetMicros: 4 * BUDGET });
        assert.equal(sp.status, 201, `top spawn mid: ${JSON.stringify(sp.body)}`);
        const y = await api("POST", "/v1/agents/self/yield", {
          wait: { kind: "child_exited", children: [(sp.body as AgentRecord).id], mode: "all" },
          idempotencyKey: "top-y",
        });
        assert.equal(y.status, 201, `top yield: ${JSON.stringify(y.body)}`);
      },
    };
  };

  // playHarness hands a resumed run an API bound to generation 0, which the fence refuses; this one carries the current generation.
  const resume = (agent: string): Play => ({
    run: async () => {
      const api: Api = async (method, url, body) =>
        handle(r.daemon, { method, url, body, token: r.daemon.agentToken(agent, (await r.daemon.get(agent))!.generation) });
      await until(async () => {
        const ib = await api("GET", "/v1/agents/self/inbox");
        if (ib.status !== 200) return false; // 409 until the resume has made the agent running
        facts.inbox = (ib.body as Signal[]).filter((s): s is Exited => s.kind === "child_exited");
        return kids.every((k) => facts.inbox.some((s) => s.child === facts.ids[k] && s.custodyOf === facts.ids.mid));
      }, "both custody signals in the custodian's inbox");
      atCheckpoint.open();
      await proceed.hold;
      if (!o.reap) return void (await released.hold);
      for (const k of [...kids, "mid"]) {
        const id = facts.ids[k]!;
        const show = await api("GET", `/v1/agents/${id}`);
        const ev = await api("GET", `/v1/agents/${id}/events`);
        const wait = await api("GET", `/v1/agents/${id}/wait?timeoutMs=100`);
        const rec = show.body as AgentRecord;
        facts.views[k] = {
          show: show.status,
          events: ev.status,
          wait: wait.status,
          waitDone: (wait.body as { done: boolean }).done,
          stateBefore: rec.state,
          exit: String(rec.exit),
        };
        const rp = await api("POST", `/v1/agents/${id}/reap`, { idempotencyKey: `reap-${k}` });
        const body = rp.body as { record?: AgentRecord; unusedMicros?: number };
        facts.reaps[k] = { status: rp.status, unusedMicros: body.unusedMicros, state: body.record?.state };
      }
    },
    result: { status: "succeeded", result: { summary: "top done" } },
  });

  const r: Rig = rig({
    maxSessions: 8,
    deps: {
      ...(o.withChannel ? { escalationChannels: ["discord"] } : {}),
      ...(o.rootCustodyMax !== undefined ? { limits: { rootCustodyMax: o.rootCustodyMax } as never } : {}),
    },
    harness: playHarness(
      () => r.daemon,
      play,
      (agent) => resume(agent),
    ),
  });
  const op = (method: string, url: string, body?: unknown) =>
    handle(r.daemon, { method, url, body: keyed(method, body), token: issueToken(SECRET, { scope: "operator" }) });
  const as = (id: string, method: string, url: string, body?: unknown) => {
    const a = r.daemon.agentToken(id);
    return handle(r.daemon, { method, url, body, token: a });
  };
  const state = async (id: string) => (await r.daemon.get(id))!.state;
  const status = async () =>
    (await r.daemon.outbox({ channel: "discord" }))
      .map((e) => e.payload as unknown as { kind: string; purpose: string; subject: string })
      .filter((p) => p.kind === "message_sent");
  const cleanup = async () => {
    released.open();
    proceed.open();
    atCheckpoint.open();
    await r.orchestrator.idle(); // let every parked scripted agent finish before the store closes
    r.store.close();
    rmSync(r.stateDir, { recursive: true, force: true });
    rmSync(r.repo, { recursive: true, force: true });
  };
  return { r, facts, op, as, state, status, cleanup, proceed, atCheckpoint, released, kids };
}

async function launch(w: ReturnType<typeof build>, spawnTop = true) {
  const root = await w.r.daemon.root();
  const sib = await w.r.daemon.spawn(root.id, { name: "sib", task: "[[role:sib]]", idempotencyKey: "sib", budgetMicros: BUDGET });
  const top = spawnTop ? await w.r.daemon.spawn(root.id, { name: "top", task: "[[role:top]]", idempotencyKey: "top", budgetMicros: 8 * BUDGET }) : undefined;
  return { sib, top };
}

// Kill the middle once both kids have exited under it, and the middle is parked.
async function killMid(w: ReturnType<typeof build>) {
  await until(() => w.facts.midIsLive, "the middle parked with both kids exited");
  const k = await w.op("POST", `/v1/agents/${w.facts.ids.mid}/kill`, {});
  assert.equal(k.status, 202, `operator kill of the middle: ${JSON.stringify(k.body)}`);
}

test("CUS-6 (S0): a killed middle's exited children stay exited; the top is woken with custody signals, reads each, reaps each and gets the budget back; a sibling gets 403", async () => {
  const w = build({ reap: true });
  try {
    const { sib } = await launch(w);
    await killMid(w);
    await within(w.atCheckpoint.hold, "the custodian to be woken and to read its custody signals");
    const { ids } = w.facts;
    const mid = await w.r.daemon.get(ids.mid!);
    assert.equal(mid!.exit, "cancelled", `the middle was killed: ${mid!.exit}`);
    assert.equal(mid!.state, "exited", "the middle is itself the top's zombie");

    // Both children are held, never auto-reaped, and the top's inbox carries one custody signal each naming the dead parent.
    for (const k of w.kids) assert.equal(await w.state(ids[k]!), "exited", `${k} must stay exited after its parent died`);
    for (const k of w.kids) {
      const sigs = w.facts.inbox.filter((s) => s.child === ids[k]);
      assert.equal(sigs.length, 1, `${k}: expected one custody signal, got ${JSON.stringify(sigs)}`);
      assert.equal(sigs[0]!.custodyOf, ids.mid, `${k}: custodyOf must name the dead parent`);
      assert.equal(sigs[0]!.handoff, `poem-${k}`, `${k}: the signal carries the clipped handoff`);
    }
    const own = w.facts.inbox.filter((s) => s.child === ids.mid);
    assert.equal(own.length, 1, "the top also got its own child's exit");
    assert.equal(own[0]!.custodyOf, undefined, "a normal parent notification never sets custodyOf");

    // A non-custodian (the top's sibling) is refused on every read and on reap, without revealing anything.
    for (const k of w.kids) {
      for (const [method, path] of [
        ["GET", ""],
        ["GET", "/events"],
        ["GET", "/wait?timeoutMs=1"],
        ["POST", "/reap"],
      ] as const) {
        const res = await w.as(sib.id, method, `/v1/agents/${ids[k]}${path}`, method === "POST" ? keyed(method, {}) : undefined);
        assert.equal(res.status, 403, `sibling ${method} ${path} on ${k}: expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
      }
      assert.equal(await w.state(ids[k]!), "exited", `${k}: the refused reap changed nothing`);
    }

    w.proceed.open();
    await until(async () => (await w.state(ids.top!)) === "reaped", "the top to finish after reaping"); // a root child is reaped at exit
    for (const k of [...w.kids, "mid"]) {
      const v = w.facts.views[k]!;
      assert.deepEqual([v.show, v.events, v.wait], [200, 200, 200], `${k}: the custodian's show, events and wait`);
      assert.equal(v.waitDone, true, `${k}: wait reports done`);
      assert.equal(v.stateBefore, "exited", `${k}: still exited when the custodian looked`);
      assert.equal(v.exit, k === "mid" ? "cancelled" : "succeeded");
      const rp = w.facts.reaps[k]!;
      assert.deepEqual([rp.status, rp.state, rp.unusedMicros], [200, "reaped", k === "mid" ? 4 * BUDGET : BUDGET], `${k}: reap returns its unused budget`);
      assert.equal(await w.state(ids[k]!), "reaped");
    }
    // The custodian was woken (resumed) after the kill, and finished.
    const kinds = (await w.r.daemon.events({ agent: ids.top! })).map((e) => e.payload.kind);
    assert.ok(kinds.includes("resumed"), `the top must have been resumed by the exit/custody signals; journal: ${kinds}`);
    assert.equal((await w.r.daemon.get(ids.top!))!.exit, "succeeded");
  } finally {
    await w.cleanup();
  }
});

test("CUS-6 (S0): custody passes up: the custodian is cancelled before it reaps, so the operator holds both children (and the middle) with a status line naming pomtree show and pomtree reap", async () => {
  const w = build({ reap: false, withChannel: true });
  try {
    await launch(w);
    await killMid(w);
    await within(w.atCheckpoint.hold, "the custodian to be woken and to read its custody signals");
    const { ids } = w.facts;
    for (const k of w.kids) assert.equal(await w.state(ids[k]!), "exited");
    const before = (await w.status()).filter((p) => p.purpose === "status" && w.kids.some((k) => p.subject.includes(ids[k]!)));
    assert.equal(before.length, 0, "while the top holds them the operator is not told about the children");

    const k = await w.op("POST", `/v1/agents/${ids.top}/kill`, {});
    assert.equal(k.status, 202, `operator kill of the top: ${JSON.stringify(k.body)}`);
    await until(async () => (await w.r.daemon.get(ids.top!))!.state !== "running", "the top's exit");
    await until(async () => (await w.state(ids.top!)) === "reaped", "the top, a root child, to be reaped at exit");

    // Now the operator is the custodian of the two children and of the (exited) middle.
    const lines = (await w.status()).filter((p) => p.purpose === "status");
    for (const id of [ids.kidA!, ids.kidB!, ids.mid!]) {
      assert.equal(await w.state(id), "exited", `${id} must still be exited, never auto-reaped`);
      const mine = lines.filter((p) => p.subject.startsWith(`${id} `));
      assert.equal(mine.length, 1, `${id}: expected one status line, got ${JSON.stringify(mine)}`);
      assert.ok(
        mine[0]!.subject.includes(`pomtree show ${id}`) && mine[0]!.subject.includes(`pomtree reap ${id}`),
        `${id}: the line names the action: ${mine[0]!.subject}`,
      );
      assert.match(mine[0]!.subject, /held for the operator: parent \S+ is gone/);
      assert.equal((await w.op("GET", `/v1/agents/${id}`)).status, 200, `${id}: the operator reads it`);
    }
    for (const k of w.kids) {
      const rp = await w.op("POST", `/v1/agents/${ids[k]}/reap`, {});
      assert.equal(rp.status, 200, `operator reap of ${k}: ${JSON.stringify(rp.body)}`);
      assert.equal((rp.body as { unusedMicros: number }).unusedMicros, BUDGET, `${k}: the budget comes back`);
      assert.equal(await w.state(ids[k]!), "reaped");
    }
  } finally {
    await w.cleanup();
  }
});

test("CUS-11 (S0): past agent.rootCustodyMax each further delivery to the operator adds an error entry and an alert; nothing is dropped, refused or reaped", async (t) => {
  const w = build({ reap: false, withChannel: true, rootCustodyMax: 1 });
  try {
    // flat: the middle is operator-spawned, so its two children are held for the operator when it dies.
    const root = await w.r.daemon.root();
    await w.r.daemon.spawn(root.id, { name: "mid", task: "[[role:mid]]", idempotencyKey: "mid-flat", budgetMicros: 4 * BUDGET });
    await killMid(w);
    await w.r.orchestrator.idle();
    const { ids } = w.facts;
    for (const k of w.kids) assert.equal(await w.state(ids[k]!), "exited", `${k}: held, not reaped`);

    const out = await w.status();
    const statusLines = out.filter((p) => p.purpose === "status" && w.kids.some((k) => p.subject.includes(`pomtree reap ${ids[k]}`)));
    assert.equal(statusLines.length, 2, `a status line per child, none dropped: ${JSON.stringify(statusLines.map((p) => p.subject))}`);
    const alerts = out.filter((p) => p.purpose === "alert" && p.subject.startsWith("custody queue full"));
    assert.ok(alerts.length >= 1, "past the cap there is an alert");
    const errs = async (k: string) =>
      (await w.r.daemon.events({ agent: ids[k]! })).filter((e) => e.payload.kind === "error" && String(e.payload.message).startsWith("custody queue full"));
    for (const al of alerts) {
      const k = w.kids.find((x) => al.subject.includes(`pomtree reap ${ids[x]}`));
      assert.ok(k, `the alert names a held child: ${al.subject}`);
      assert.match(al.subject, /2 exited results are held for the operator \(limit 1\)/);
      assert.ok(al.subject.includes(`pomtree show ${ids[k]}`), "and says how to read it");
      assert.equal((await errs(k)).length, 1, `${k}: an error entry beside its alert`);
    }
    // Documented (docs/safety-decisions.md, Class 1; CUS-11): only the delivery past the cap is escalated, whatever the burst order.
    await t.test("only the second delivery is escalated", async () => {
      assert.equal(alerts.length, 1, `expected one alert (the second delivery), got ${alerts.length}`);
      const within = w.kids.filter((k) => !alerts.some((al) => al.subject.includes(`pomtree reap ${ids[k]}`)));
      assert.equal(within.length, 1, "one child is within the cap and gets only its status line");
      assert.equal((await errs(within[0]!)).length, 0, "no error entry on the child within the cap");
    });

    // Every held zombie is listed and reapable (nothing refused).
    const listed = (await w.op("GET", "/v1/agents?state=exited")).body as AgentRecord[];
    for (const k of w.kids) {
      assert.ok(
        listed.some((a) => a.id === ids[k]),
        `${k} is listed as exited`,
      );
      const rp = await w.op("POST", `/v1/agents/${ids[k]}/reap`, {});
      assert.equal(rp.status, 200, `reap ${k}: ${JSON.stringify(rp.body)}`);
    }
  } finally {
    await w.cleanup();
  }
});

test("CUS-11 (S0): below agent.rootCustodyMax there is no alert or error entry, and the delivery past it alerts", async () => {
  const alertsOf = async (w: ReturnType<typeof build>) => (await w.status()).filter((p) => p.purpose === "alert" && p.subject.startsWith("custody queue full"));
  const full = async (w: ReturnType<typeof build>, k: string) =>
    (await w.r.daemon.events({ agent: w.facts.ids[k]! })).filter(
      (e) => e.payload.kind === "error" && String(e.payload.message).startsWith("custody queue full"),
    );
  const run = async (w: ReturnType<typeof build>) => {
    const root = await w.r.daemon.root();
    await w.r.daemon.spawn(root.id, { name: "mid", task: "[[role:mid]]", idempotencyKey: "mid-flat", budgetMicros: 4 * BUDGET });
    await killMid(w);
    await w.r.orchestrator.idle();
    const statusLines = (await w.status()).filter((p) => p.purpose === "status" && w.kids.some((k) => p.subject.includes(`pomtree reap ${w.facts.ids[k]}`)));
    assert.equal(statusLines.length, w.kids.length, "a status line per child");
  };
  const two = build({ reap: false, withChannel: true, rootCustodyMax: 2 });
  try {
    await run(two);
    assert.deepEqual(await alertsOf(two), [], "two held results at a cap of two: no alert");
    for (const k of two.kids) assert.equal((await full(two, k)).length, 0, `${k}: no error entry within the cap`);
  } finally {
    await two.cleanup();
  }
  const three = build({ reap: false, withChannel: true, rootCustodyMax: 2, kids: 3 });
  try {
    await run(three);
    const alerts = await alertsOf(three);
    assert.equal(alerts.length, 1, `only the third delivery alerts: ${JSON.stringify(alerts.map((a) => a.subject))}`);
    assert.match(alerts[0]!.subject, /3 exited results are held for the operator \(limit 2\)/);
    const withErr = [];
    for (const k of three.kids) if ((await full(three, k)).length) withErr.push(k);
    assert.equal(withErr.length, 1, `one error entry, beside the alert: ${withErr}`);
    assert.ok(alerts[0]!.subject.includes(`pomtree reap ${three.facts.ids[withErr[0]!]}`), "the alert and the error entry are on the same child");
  } finally {
    await three.cleanup();
  }
});

test("CUS-9 (S0): reap-on-exit is reaped after the parent is told; hold and the default stay exited; a bad disposition is a 400", async () => {
  const released = gate();
  const ids: Record<string, string> = {};
  const r: Rig = rig({
    harness: playHarness(
      () => r.daemon,
      (agent, prompt) => {
        const role = roleOf(prompt);
        ids[role] = agent;
        if (role !== "top") return { result: { status: "succeeded", result: { summary: `done-${role}` } } };
        return {
          run: async (api: Api) => {
            const spawn = (name: string, extra: object) =>
              api("POST", "/v1/agents", { name, task: `[[role:${name}]]`, idempotencyKey: name, budgetMicros: BUDGET, ...extra });
            for (const [name, extra] of [
              ["advisory", { disposition: { mode: "reap-on-exit" } }],
              ["hold", { disposition: { mode: "hold" } }],
              ["plain", {}],
            ] as const) {
              const sp = await spawn(name, extra);
              assert.equal(sp.status, 201, `${name}: ${JSON.stringify(sp.body)}`);
            }
            const bad = await spawn("bad1", { disposition: { mode: "other" } });
            const both = await spawn("bad2", { disposition: { mode: "reap-on-exit", ttlMs: 5000 } });
            const zero = await spawn("bad3", { disposition: { mode: "hold", ttlMs: 0 } });
            ids.badStatuses = [bad.status, both.status, zero.status].join(",");
            ids.badMessage = String((both.body as { error?: string }).error);
          },
          hold: released.hold,
        };
      },
    ),
  });
  try {
    const root = await r.daemon.root();
    const top = await r.daemon.spawn(root.id, { name: "top", task: "[[role:top]]", idempotencyKey: "top", budgetMicros: 10 * BUDGET });
    await until(
      async () => ["advisory", "hold", "plain"].every((n) => ids[n]) && (await r.daemon.get(ids.plain!))?.state === "exited" && !!ids.badStatuses,
      "the children exited",
    );
    await until(async () => (await r.daemon.get(ids.advisory!))?.state === "reaped", "the reap-on-exit child to be reaped");
    assert.equal(ids.badStatuses, "400,400,400");
    assert.match(ids.badMessage!, /ttlMs applies only to mode hold/, "the refusal names the cause and the action");
    const state = async (n: string) => (await r.daemon.get(ids[n]!))!.state;
    assert.equal(await state("advisory"), "reaped", "reap-on-exit is reaped at exit");
    assert.equal(await state("hold"), "exited");
    assert.equal(await state("plain"), "exited", "the default is hold");
    assert.equal(((await r.daemon.get(ids.advisory!))!.result as { summary: string }).summary, "done-advisory", "the result survives the reap");
    // Order: the parent's child_exited signal (with the handoff) precedes the child's reaped entry.
    const topEvents = await r.daemon.events({ agent: top.id });
    const told = topEvents.find((e) => e.payload.kind === "signal" && (e.payload.signal as { child?: string }).child === ids.advisory);
    const reaped = (await r.daemon.events({ agent: ids.advisory! })).find((e) => e.payload.kind === "reaped");
    assert.ok(told && reaped, "both the signal and the reaped entry exist");
    assert.ok(told.seq < reaped.seq, `the parent is told (seq ${told.seq}) before the reap (seq ${reaped.seq})`);
    assert.equal((told.payload as unknown as { signal: { handoff: string } }).signal.handoff, "done-advisory");
    assert.equal((await r.daemon.events({ agent: ids.hold! })).filter((e) => e.payload.kind === "reaped").length, 0);
  } finally {
    released.open();
    await r.orchestrator.idle();
    r.store.close();
    rmSync(r.stateDir, { recursive: true, force: true });
    rmSync(r.repo, { recursive: true, force: true });
  }
});
