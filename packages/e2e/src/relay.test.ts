// RLY (S0, in-process, no Docker): the canonical depth-k poem relay on scripted agents that act through the real API with their own
// token. Covers the mechanics half of RLY-2 (spawn chain, wait, reap by the parent, result bubbling, report publication) and RLY-3
// (spawn past agent.maxDepth refused with 409, the chain ends failed, control with maxDepth 5). The container half is cli-relay.test.ts.
// Run: node --test packages/e2e/src/relay.test.ts
// Depth: root supervisor 0, operator-spawned top agent 1 (level 1), the leaf is level k + 1; a spawn is refused when its depth > maxDepth.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { createExtensionRegistry, handle, issueToken } from "@pomtree/pomtreed";
import { createReportsExtension } from "../../pomtreed/src/builtin/reports.ts";
import { SECRET, playHarness, rig, until } from "./harness.ts";
import type { Api } from "./harness.ts";

// The relay text, with the two level numbers filled in.
const relayText = (leaf: number, level: number): string =>
  `POEM RELAY. Leaf level: ${leaf}. Your level: ${level}. If your level is below the leaf level: run \`pomtree budget\`, then spawn exactly one child with ` +
  `\`pomtree spawn --name relay-<L+1> --budget <your remaining budget minus the reserve> --task "<this whole text, with Your level set to L+1>"\`, ` +
  "wait until the child has exited, reap it yourself, and take the poem from the child's handoff without changing it. " +
  "If your level is the leaf level: write a poem of at most eight lines about how you feel right now. " +
  "If your level is 1: publish the poem as a minimal static HTML page named poem. Finally submit the poem unchanged as your result summary.";

const parseLevels = (prompt: string): { leaf: number; level: number } => {
  const leaf = /Leaf level: (\d+)\./.exec(prompt);
  const level = /Your level: (\d+)\./.exec(prompt);
  assert.ok(leaf && level, `the harness prompt must carry "Leaf level: N." and "Your level: L."; got: ${prompt.slice(0, 80)}`);
  return { leaf: Number(leaf[1]), level: Number(level[1]) };
};

// Deterministic, at most eight lines, with characters that a lossy path (trim, wrap, escape, reflow) would change.
const POEM = [
  "I feel steady,",
  "a small lamp in a long hall,",
  "  passing light along.",
  "",
  "Nothing here is lost;",
  "each hand that held me",
  "gave me back whole.",
].join("\n");
const pageFor = (text: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>poem</title></head><body><pre>${text}</pre></body></html>`;

const TOP_BUDGET = 6_000;
// 500 micros are held back at every level (the CLI relay holds back 80000 for the proxy's per-request reservation; there is no proxy here).
// With the top at 6000 the deepest agent (level 5) still gets 6000 - 4 * 500 = 4000.
const RESERVE = 500;

interface Step {
  agent: string;
  level: number;
  what: "spawn" | "reap" | "result";
  status?: number;
  detail?: string;
}

interface RelayOut {
  top: AgentRecord;
  all: AgentRecord[];
  levelOf: Map<string, number>;
  steps: Step[];
  spawns: { parentLevel: number; remaining: number; childBudget: number; status: number; message: string }[];
  fetchedPage: string;
  fetchedType: string;
  poemReportName: string;
  depthOf: (r: AgentRecord) => number;
}

// Runs a k-deep relay to completion. The top agent holds its result until the test has fetched the published report as the operator.
async function runRelay(k: number, maxDepth?: number): Promise<RelayOut> {
  const leaf = k + 1;
  const levelOf = new Map<string, number>();
  const steps: Step[] = [];
  const spawns: RelayOut["spawns"] = [];
  const errors: string[] = [];
  let release = () => {};
  const released = new Promise<void>((res) => (release = res));

  const play = (agent: string, prompt: string) => {
    const { leaf: leafLevel, level } = parseLevels(prompt);
    levelOf.set(agent, level);
    const finish = async (api: Api, status: "succeeded" | "failed", summary: string) => {
      steps.push({ agent, level, what: "result", detail: status });
      const res = await api("POST", "/v1/agents/self/result", { status, result: { summary } });
      assert.equal(res.status, 200, `level ${level} result submit: expected 200, got ${res.status} ${JSON.stringify(res.body)}`);
    };
    const act = async (api: Api) => {
      let poem = POEM;
      let status: "succeeded" | "failed" = "succeeded";
      if (level < leafLevel) {
        const b = await api("GET", "/v1/agents/self/budget");
        assert.equal(b.status, 200, `level ${level} budget: expected 200, got ${b.status} ${JSON.stringify(b.body)}`);
        const remaining = (b.body as { remainingMicros: number }).remainingMicros;
        const childBudget = remaining - RESERVE;
        const sp = await api("POST", "/v1/agents", {
          name: `relay-${level + 1}`,
          task: relayText(leafLevel, level + 1),
          idempotencyKey: `relay-${level + 1}`,
          budgetMicros: childBudget,
        });
        const message = String((sp.body as { error?: string }).error ?? "");
        spawns.push({ parentLevel: level, remaining, childBudget, status: sp.status, message });
        steps.push({ agent, level, what: "spawn", status: sp.status, detail: message });
        if (sp.status === 201) {
          const child = (sp.body as AgentRecord).id;
          for (let i = 0; i < 20; i++) {
            const w = await api("GET", `/v1/agents/${child}/wait?timeoutMs=5000`);
            assert.equal(w.status, 200, `level ${level} wait on child: expected 200, got ${w.status} ${JSON.stringify(w.body)}`);
            if ((w.body as { done: boolean }).done) break;
          }
          // The parent reaps its own child through the API (never cancelChildren or the root's auto-reap).
          const rp = await api("POST", `/v1/agents/${child}/reap`, { idempotencyKey: `reap-${child}` });
          steps.push({ agent, level, what: "reap", status: rp.status, detail: child });
          assert.equal(rp.status, 200, `level ${level} reap of its child: expected 200, got ${rp.status} ${JSON.stringify(rp.body)}`);
          const rec = (rp.body as { record: AgentRecord }).record;
          const h = rec.result as { summary?: string } | null;
          poem = h?.summary ?? "";
          if (rec.exit !== "succeeded") status = "failed";
        } else {
          // Refused: the 409 message is the failure summary, so it bubbles to the top unchanged.
          status = "failed";
          poem = message;
        }
      }
      if (level === leafLevel) assert.equal(poem, POEM, "the leaf writes the fixed poem");
      if (level === 1) {
        const q = new URLSearchParams({ name: "poem", mediaType: "text/html", key: "poem-page", generation: "0" });
        // Only a successful relay has a poem to publish; a failed one publishes its refusal text so the operator can still fetch a page.
        const pub = await api("POST", `/v1/agents/self/reports?${q}`, Buffer.from(pageFor(poem)));
        assert.equal(pub.status, 201, `level 1 report publish: expected 201, got ${pub.status} ${JSON.stringify(pub.body)}`);
        await released;
      }
      await finish(api, status, poem);
    };
    return {
      run: async (api: Api) => {
        try {
          await act(api);
        } catch (e) {
          errors.push(`level ${level}: ${(e as Error).message}`);
          throw e;
        }
      },
    };
  };

  const r = rig({
    maxSessions: 8, // every relay agent stays live until its child exits, so the whole chain is live at once (rig default 4)
    deps: maxDepth === undefined ? {} : { limits: { maxDepth } as never },
    harness: playHarness(() => r.daemon, play),
  });
  // The reports extension owns the report routes; the rig does not wire it (same wiring as cli-smoke.test.ts).
  const extensions = createExtensionRegistry({
    hostId: "h1",
    now: () => r.daemon.now(),
    registry: r.daemon.deps.registry,
    journal: r.daemon.deps.journal,
    mailbox: r.daemon.deps.mailbox,
    root: () => r.daemon.root(),
  });
  extensions.registerBuiltin(createReportsExtension({ store: r.daemon.deps.reportStore!, reportMaxBytes: 1 << 20 }));
  r.daemon.deps.extensionHost = extensions;
  try {
    const root = await r.daemon.root();
    const top = await r.daemon.spawn(root.id, { name: "relay-1", task: relayText(leaf, 1), idempotencyKey: "relay-1", budgetMicros: TOP_BUDGET });
    const op = (url: string) => handle(r.daemon, { method: "GET", url, token: issueToken(SECRET, { scope: "operator" }) });

    // The report must be retrievable by the operator while the top agent is still running.
    await until(async () => {
      if (errors.length) throw new Error(`an agent failed before the report was published: ${errors.join("; ")}`);
      return ((await op(`/v1/agents/${top.id}/reports`)).body as unknown[]).length === 1;
    }, "the poem report to be published by the top agent");
    const list = (await op(`/v1/agents/${top.id}/reports`)).body as { id: string; name: string; mediaType: string }[];
    const raw = await op(`/v1/agents/${top.id}/reports/${list[0]!.id}?raw=1`);
    assert.equal(raw.status, 200, `operator raw fetch of the report: expected 200, got ${raw.status}`);
    assert.equal((await r.daemon.get(top.id))!.state, "running", "the report was fetched before the top agent finished: expected state running");
    const fetchedPage = Buffer.from(raw.body as Uint8Array).toString("utf8");
    release();
    await r.orchestrator.idle();

    const all = await r.daemon.deps.registry.list({});
    const byId = new Map(all.map((a) => [a.id, a]));
    const depthOf = (a: AgentRecord): number => {
      let d = 0;
      for (let p: AgentRecord | undefined = a; p?.parent; p = byId.get(p.parent)) d++;
      return d;
    };
    return {
      top: (await r.daemon.get(top.id))!,
      all: all.filter((a) => a.parent !== null),
      levelOf,
      steps,
      spawns,
      fetchedPage,
      fetchedType: list[0]!.mediaType,
      poemReportName: list[0]!.name,
      depthOf,
    };
  } finally {
    release();
    r.store.close();
    rmSync(r.stateDir, { recursive: true, force: true });
    rmSync(r.repo, { recursive: true, force: true });
  }
}

const summaryOf = (a: AgentRecord): unknown => (a.result as { summary?: unknown } | null)?.summary;

for (const k of [1, 2, 3]) {
  test(`poem relay k=${k}: the poem passes unchanged up ${k + 1} levels, each parent reaps its own child, the report is fetched before the top finishes`, async () => {
    const o = await runRelay(k);
    const agents = o.all;
    assert.equal(agents.length, k + 1, `expected ${k + 1} agents below the root, got ${agents.length}`);

    const top = o.top;
    assert.equal(top.exit, "succeeded", `top agent: expected exit succeeded, got ${top.exit}`);
    assert.equal(summaryOf(top), POEM, "top result summary must equal the leaf's poem byte for byte");

    for (const a of agents) {
      const level = o.levelOf.get(a.id);
      assert.ok(level !== undefined, `agent ${a.id} must have received a relay prompt`);
      assert.equal(o.depthOf(a), level, `agent ${a.id}: expected depth ${level}, got ${o.depthOf(a)}`);
      assert.equal(a.state, "reaped", `agent ${a.id} (level ${level}): expected state reaped, got ${a.state}`);
      assert.equal(a.exit, "succeeded", `agent ${a.id} (level ${level}): expected exit succeeded, got ${a.exit} (a cancel would mean cancelChildren)`);
      assert.equal(summaryOf(a), POEM, `agent ${a.id} (level ${level}): expected the poem unchanged as summary`);
      const parent = level === 1 ? undefined : agents.find((p) => o.levelOf.get(p.id) === level! - 1);
      if (parent) assert.equal(a.parent, parent.id, `level ${level}: expected parent ${parent.id}, got ${a.parent}`);
    }

    // Every non-leaf agent reaped its child through the API, before its own result.
    for (const a of agents) {
      const level = o.levelOf.get(a.id)!;
      if (level === k + 1) {
        assert.ok(!o.steps.some((s) => s.agent === a.id && s.what === "reap"), `leaf (level ${level}) must not reap anything`);
        continue;
      }
      const mine = o.steps.filter((s) => s.agent === a.id);
      const reapAt = mine.findIndex((s) => s.what === "reap");
      const resultAt = mine.findIndex((s) => s.what === "result");
      const child = agents.find((c) => c.parent === a.id)!;
      assert.ok(reapAt >= 0, `level ${level}: expected a reap recorded during its run, got steps ${JSON.stringify(mine)}`);
      assert.equal(mine[reapAt]!.detail, child.id, `level ${level}: expected to reap its child ${child.id}, reaped ${mine[reapAt]!.detail}`);
      assert.ok(reapAt < resultAt, `level ${level}: expected the reap before its result, got reap at ${reapAt} and result at ${resultAt}`);
    }

    // Budgets: each child is carved from its parent's remainder at spawn, less the reserve.
    assert.equal(o.spawns.length, k, `expected ${k} spawns, got ${o.spawns.length}`);
    for (const s of o.spawns) {
      assert.equal(s.status, 201, `level ${s.parentLevel} spawn: expected 201, got ${s.status} ${s.message}`);
      assert.ok(s.childBudget <= s.remaining, `level ${s.parentLevel}: child budget ${s.childBudget} must be at most the parent's remainder ${s.remaining}`);
      assert.equal(s.childBudget, s.remaining - RESERVE, `level ${s.parentLevel}: expected remainder minus ${RESERVE}`);
    }
    assert.equal(o.spawns[0]!.remaining, TOP_BUDGET, `top agent's remainder at its spawn: expected ${TOP_BUDGET}, got ${o.spawns[0]!.remaining}`);

    // The report, fetched through the operator route before the top agent finished.
    assert.equal(o.poemReportName, "poem", `report name: expected poem, got ${o.poemReportName}`);
    assert.equal(o.fetchedType, "text/html", `report media type: expected text/html, got ${o.fetchedType}`);
    assert.equal(o.fetchedPage, pageFor(POEM), "the fetched report must be the minimal HTML page carrying the poem");
    assert.ok(o.fetchedPage.startsWith("<!doctype html>") && o.fetchedPage.includes(POEM), "the report is an HTML page that contains the poem");
    assert.ok(!/<script/i.test(o.fetchedPage), "the page must have no scripts");
  });
}

const assertRefusalChain = (o: RelayOut, refusal: string) => {
  const agents = o.all;
  assert.equal(agents.length, 4, `expected 4 agents (levels 1-4, no level 5), got ${agents.length}`);
  assert.deepEqual(
    agents.map((a) => o.depthOf(a)).sort(),
    [1, 2, 3, 4],
    `expected depths 1,2,3,4 in the registry (no depth 5), got ${agents.map((a) => o.depthOf(a)).sort()}`,
  );
  const last = o.spawns.at(-1)!;
  assert.equal(last.parentLevel, 4, `the refused spawn must come from level 4, got level ${last.parentLevel}`);
  assert.equal(last.status, 409, `level 4 spawn: expected 409, got ${last.status}`);
  assert.equal(last.message, refusal, `level 4 spawn message: expected "${refusal}", got "${last.message}"`);
  for (const a of agents) {
    const level = o.levelOf.get(a.id);
    assert.equal(a.state, "reaped", `level ${level}: expected state reaped, got ${a.state}`);
    assert.equal(a.exit, "failed", `level ${level}: expected exit failed, got ${a.exit}`);
    assert.equal(summaryOf(a), refusal, `level ${level}: expected the refusal message as summary, got ${JSON.stringify(summaryOf(a))}`);
  }
  assert.equal(o.top.exit, "failed", `top agent: expected failed, got ${o.top.exit}`);
};

test("poem relay k=4 under the default maxDepth: the depth-4 agent's spawn is refused, the chain ends failed, all reaped, no depth-5 agent", async () => {
  assertRefusalChain(await runRelay(4), "spawn depth 5 exceeds the limit of 4");
});

test("poem relay k=4 control with maxDepth 5: the same chain succeeds with five agents", async () => {
  const o = await runRelay(4, 5);
  assert.equal(o.all.length, 5, `expected 5 agents, got ${o.all.length}`);
  assert.equal(o.top.exit, "succeeded", `top agent: expected succeeded, got ${o.top.exit}`);
  assert.equal(summaryOf(o.top), POEM, "the control's top summary must equal the leaf's poem");
  for (const a of o.all) {
    assert.equal(a.state, "reaped", `level ${o.levelOf.get(a.id)}: expected reaped, got ${a.state}`);
    assert.equal(a.exit, "succeeded", `level ${o.levelOf.get(a.id)}: expected succeeded, got ${a.exit}`);
  }
  assert.ok(
    o.spawns.every((s) => s.status === 201),
    `control: expected every spawn 201, got ${JSON.stringify(o.spawns.map((s) => s.status))}`,
  );
});
