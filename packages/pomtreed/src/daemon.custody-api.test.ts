// The API side of custody (TODO(guardian-reap): custody authz and the merge guard): the custodian of a dead parent's exited descendant may
// address it, and reaping a zombie is checked against the custodian's branch (the default branch for a root custodian).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, Signal } from "@pomtree/core";
import { fakeBundle, keyed } from "@pomtree/testing";
import { handle } from "./api.ts";
import { setup, spawnSpec } from "./test-setup.ts";

type T = ReturnType<typeof setup>;

const running = async (t: T, key: string, parent?: string): Promise<AgentRecord> => {
  const reg = t.daemon.deps.registry;
  const a = await reg.create({
    spec: spawnSpec,
    parent: parent ?? (await t.daemon.root()).id,
    name: key,
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: key,
  });
  const r = await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
  await t.daemon.deps.workspace.create(r.id, {});
  return r;
};
const exitWith = async (t: T, a: AgentRecord, exit: "succeeded" | "cancelled", result?: unknown) =>
  t.daemon.deps.registry.transition(a.id, a.generation, "exited", {
    exit,
    ...(result !== undefined && { result }),
    idempotencyKey: `${a.id}-exit-${a.generation}`,
  });
const tail = async (t: T, r: AgentRecord, exit: "succeeded" | "cancelled" = "succeeded") =>
  (t.daemon as unknown as { finishTail: (r: AgentRecord, e: string) => Promise<void> }).finishTail(r, exit);
const die = async (t: T, a: AgentRecord, exit: "succeeded" | "cancelled" = "cancelled", result?: unknown) => {
  const e = await exitWith(t, a, exit, result);
  await tail(t, e, exit);
  return e;
};
const pushAs = async (t: T, a: AgentRecord, commit: string) => {
  const out = await t.daemon.push(
    a.id,
    a.generation,
    `push-${a.id}-${commit}`,
    (async function* () {
      yield fakeBundle([{ name: `agent/${a.id}`, commit }]);
    })(),
    1 << 20,
  );
  assert.ok(out.ok);
};
const as = (t: T, a: AgentRecord, method: string, url: string) =>
  handle(t.daemon, { method, url, body: keyed(method), token: t.daemon.agentToken(a.id, a.generation) });
const state = async (t: T, a: AgentRecord) => (await t.daemon.get(a.id))!.state;

// root -> T -> A -> B -> C, all running.
const chain = async (t: T) => {
  const top = await running(t, "T");
  const a = await running(t, "A", top.id);
  const b = await running(t, "B", a.id);
  const c = await running(t, "C", b.id);
  return { top, a, b, c };
};
// C exited with a handoff and tailed while B was live; then B exited (cancelled) and tailed. A is C's custodian.
const held = async (t: T) => {
  const { top, a, b, c } = await chain(t);
  const c1 = await die(t, c, "succeeded", { summary: "leaf poem" });
  const b1 = await die(t, b);
  return { top, a, b: b1, c: c1 };
};

test("the custodian of a held grandchild can show, read events, wait, read the transcript route and reap it", async () => {
  const t = setup(async () => {});
  const { a, c } = await held(t);
  const show = await as(t, a, "GET", `/v1/agents/${c.id}`);
  assert.equal(show.status, 200);
  assert.equal((show.body as { id: string }).id, c.id);
  assert.equal((await as(t, a, "GET", `/v1/agents/${c.id}/events`)).status, 200);
  assert.equal((await as(t, a, "GET", `/v1/agents/${c.id}/wait`)).status, 200);
  assert.notEqual((await as(t, a, "GET", `/v1/agents/${c.id}/transcript`)).status, 403, "authorized (a missing checkpoint is a 404)");
  const reap = await as(t, a, "POST", `/v1/agents/${c.id}/reap`);
  assert.equal(reap.status, 200);
  assert.equal(await state(t, c), "reaped");
});

test("only the custodian: a sibling of the custodian and its live parent are refused (403) on show and reap", async () => {
  const t = setup(async () => {});
  const { top, c } = await held(t);
  const s = await running(t, "S", top.id);
  for (const who of [s, top]) {
    const show = await as(t, who, "GET", `/v1/agents/${c.id}`);
    assert.equal(show.status, 403, `${who.name} show`);
    assert.match((show.body as { error: string }).error, /custody/, "the message names the rule");
    assert.equal((await as(t, who, "POST", `/v1/agents/${c.id}/reap`)).status, 403, `${who.name} reap`);
  }
  assert.equal(await state(t, c), "exited", "nothing was reaped");
});

test("custody passes up: when the custodian dies the next live ancestor can show and reap the zombie", async () => {
  const t = setup(async () => {});
  const { top, a, c } = await held(t);
  await die(t, a);
  assert.equal(await state(t, c), "exited");
  assert.equal((await as(t, top, "GET", `/v1/agents/${c.id}`)).status, 200);
  assert.equal((await as(t, top, "POST", `/v1/agents/${c.id}/reap`)).status, 200);
  assert.equal(await state(t, c), "reaped");
});

test("a running grandchild under a dead parent is not addressable through custody; only zombies are", async () => {
  const t = setup(async () => {});
  const { a, b, c } = await chain(t);
  await exitWith(t, b, "cancelled"); // not tailed: the tail would take its running children down with it
  assert.equal(await state(t, c), "running");
  assert.equal((await as(t, a, "GET", `/v1/agents/${c.id}`)).status, 403);
  assert.equal((await as(t, a, "POST", `/v1/agents/${c.id}/reap`)).status, 403);
});

// Merge guard on a zombie: the check runs against the custodian's branch, not the dead parent's.
const withRepos = (t: T) => {
  t.daemon.deps.repos = t.fakes.repos;
  const targets: string[] = [];
  const orig = t.fakes.repos.mergeStatus.bind(t.fakes.repos);
  t.fakes.repos.mergeStatus = async (q) => {
    targets.push(q.target);
    return orig(q);
  };
  return targets;
};
const settle = (t: T, c: AgentRecord) => t.fakes.repos.reports.set(c.id, { state: "merged", merged: true, failedRounds: 0, settled: true });

test("a zombie with unmerged work: the custodian's reap is refused 409 unmerged, then succeeds once merged into the custodian's ref", async () => {
  const t = setup(async () => {});
  const targets = withRepos(t);
  const { a, b, c } = await chain(t);
  await pushAs(t, a, "a1");
  await pushAs(t, c, "c1");
  await die(t, c, "succeeded");
  await die(t, b);
  const refused = await as(t, a, "POST", `/v1/agents/${c.id}/reap`);
  assert.equal(refused.status, 409);
  assert.equal((refused.body as { code: string }).code, "unmerged");
  assert.ok(targets.includes(`refs/agents/${a.id}/heads/agent/${a.id}`), "checked against the custodian's ingested ref");
  assert.ok(!targets.some((x) => x.includes(b.id)), "never against the dead parent's");
  assert.equal(await state(t, c), "exited");
  settle(t, c);
  assert.equal((await as(t, a, "POST", `/v1/agents/${c.id}/reap`)).status, 200);
  assert.equal(await state(t, c), "reaped");
});

test("a root-custody zombie is checked against the default branch: the operator's reap is refused while unmerged, then succeeds", async () => {
  const t = setup(async () => {});
  const targets = withRepos(t);
  const p = await running(t, "P");
  const k = await running(t, "K", p.id);
  await pushAs(t, p, "p1");
  await pushAs(t, k, "k1");
  await die(t, k, "succeeded");
  await die(t, p);
  assert.equal(await state(t, k), "exited", "held by the root");
  const refused = await t.operator("POST", `/v1/agents/${k.id}/reap`, {});
  assert.equal(refused.status, 409);
  assert.equal((refused.body as { code: string }).code, "unmerged");
  const main = `refs/heads/${(await t.fakes.repos.repo()).defaultBranch}`;
  assert.deepEqual([...new Set(targets)], [main]);
  settle(t, k);
  assert.equal((await t.operator("POST", `/v1/agents/${k.id}/reap`, {})).status, 200);
  assert.equal(await state(t, k), "reaped");
});

// No operator discard path exists (TODO(merge-discard)): the API reap always passes guard=true and the CLI has no flag, so there is
// nothing to test for a zombie; this pins that the guard has no bypass by agent or operator body flags.
test("no discard bypass: a force flag in the reap body does not skip the merge guard", async () => {
  const t = setup(async () => {});
  withRepos(t);
  const p = await running(t, "P");
  const k = await running(t, "K", p.id);
  await pushAs(t, k, "k1");
  await die(t, k, "succeeded");
  await die(t, p);
  const r = await t.operator("POST", `/v1/agents/${k.id}/reap`, { force: true, discard: true });
  assert.equal(r.status, 409);
  assert.equal(await state(t, k), "exited");
});

// A long `pomtree wait` parks via POST /park; it must admit the same targets as the synchronous GET /wait.
const park = (t: T, who: AgentRecord, child: string) =>
  handle(t.daemon, {
    method: "POST",
    url: "/v1/agents/self/park",
    body: { on: { kind: "child", child }, timeoutMs: 60_000, idempotencyKey: `park-${who.id}-${child}` },
    token: t.daemon.agentToken(who.id, who.generation),
  });

test("a long wait on a held zombie is admitted by the custodian and returns at once (no park, no 404)", async () => {
  const t = setup(async () => {});
  const { a, c } = await held(t);
  const r = await park(t, a, c.id);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { parked: false });
  assert.equal(await state(t, a), "running", "the custodian was not yielded");
});

test("a long wait on a zombie is still refused with 404 for its non-custodians (sibling of the custodian, live parent)", async () => {
  const t = setup(async () => {});
  const { top, c } = await held(t);
  const s = await running(t, "S", top.id);
  for (const who of [s, top]) assert.equal((await park(t, who, c.id)).status, 404, who.name);
  assert.equal(await state(t, s), "running");
});

test("a long wait on a running grandchild under a dead parent is refused 404 (only exited zombies are held)", async () => {
  const t = setup(async () => {});
  const { a, b, c } = await chain(t);
  await exitWith(t, b, "cancelled");
  assert.equal((await park(t, a, c.id)).status, 404);
});

// One rule (Daemon.canWaitOn / Tree.canWaitOn) behind both the synchronous GET /wait and the park; each case also pins that the two agree.
test("canWaitOn: each admission class is admitted and each refusal refused, and GET /wait and park agree", async () => {
  const t = setup(async () => {});
  const { top, a, b, c } = await chain(t);
  const own = await running(t, "OWN", a.id);
  const sib = await running(t, "SIB", top.id);
  const other = await running(t, "OTHER");
  const ownDone = await die(t, own, "succeeded");
  const cDone = await die(t, c, "succeeded");
  const bDone = await die(t, b); // A now holds C in custody
  const g = await running(t, "G", bDone.id); // a running grandchild under the dead B
  const rows: { name: string; who: AgentRecord; target: AgentRecord; admit: boolean }[] = [
    { name: "self", who: a, target: a, admit: true },
    { name: "exited child", who: a, target: ownDone, admit: true },
    { name: "exited descendant held in custody", who: a, target: cDone, admit: true },
    { name: "sibling of the custodian", who: sib, target: cDone, admit: false },
    { name: "live parent of the custodian", who: top, target: cDone, admit: false },
    { name: "running grandchild under a dead parent", who: a, target: g, admit: false },
    { name: "unrelated agent", who: other, target: cDone, admit: false },
    { name: "own parent", who: a, target: top, admit: false },
  ];
  for (const r of rows) {
    const rec = (await t.daemon.get(r.target.id))!;
    assert.equal(await t.daemon.canWaitOn(r.who.id, rec), r.admit, `${r.name}: predicate`);
    if (r.who.id === r.target.id) continue; // park and /wait on self are not routed through target()
    const sync = await as(t, r.who, "GET", `/v1/agents/${r.target.id}/wait`);
    if (rec.state === "exited") {
      assert.equal(sync.status, r.admit ? 200 : 403, `${r.name}: GET /wait`);
      const parked = await park(t, r.who, r.target.id);
      assert.equal(parked.status, r.admit ? 201 : 404, `${r.name}: park`);
    } else assert.equal(sync.status, 403, `${r.name}: GET /wait`);
  }
});

// The routes each `pomtree` command calls (packages/pomtree/src/cli.ts); the custody resume line may name only commands whose every route admits the custodian.
const COMMAND_ROUTES: Record<string, [string, (id: string) => string][]> = {
  show: [
    ["GET", (id) => `/v1/agents/${id}`],
    ["GET", (id) => `/v1/agents/${id}/events?tail=10`],
    ["GET", (id) => `/v1/agents/${id}/checkpoint`],
    ["GET", (id) => `/v1/agents/${id}/deadline`],
  ],
  wait: [["GET", (id) => `/v1/agents/${id}/wait?timeoutMs=0`]],
  reap: [["POST", (id) => `/v1/agents/${id}/reap`]],
};

test("the custody resume line names only pomtree commands the agent custodian is admitted to run on the held child", async () => {
  const t = setup(async () => {});
  const { a, c } = await held(t);
  const resumeText = (signal: Signal) =>
    ((t.daemon as unknown as { lifecycle: object }).lifecycle as unknown as { resumeText(a: string, c: null, s: Signal): Promise<string> }).resumeText(
      a.id,
      null,
      signal,
    );
  const line = await resumeText({ kind: "child_exited", child: c.id, exit: "succeeded", custodyOf: "B-gone" });
  const cmds = [...line.matchAll(/`pomtree (\w+) (\S+)`/g)].map((m) => m[1]!);
  assert.deepEqual(cmds, ["wait", "reap"], line);
  for (const cmd of cmds) {
    const routes = COMMAND_ROUTES[cmd];
    assert.ok(routes, `no route table for \`pomtree ${cmd}\``);
    for (const [method, url] of routes) {
      const r = await as(t, a, method, url(c.id));
      assert.notEqual(r.status, 403, `\`pomtree ${cmd}\` ${method} ${url(c.id)} refused the custodian: ${JSON.stringify(r.body)}`);
    }
  }
  // negative control: the route table does catch a command the custodian cannot run (`pomtree show` reads the checkpoint, self-only)
  assert.equal((await as(t, a, "GET", `/v1/agents/${c.id}/checkpoint`)).status, 403);
});
