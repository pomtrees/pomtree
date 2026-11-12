import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { EXTENSION_API_VERSION, type Delivered, type WorkflowRunContext } from "../../packages/core/src/index.ts";
import extension, { type HnInput, hnDigest, validateInput } from "./entry.mts";
import { REPORT_MAX } from "./logic.mts";
import { until } from "../../packages/testing/src/index.ts";

const FETCHED_MS = Date.parse("2026-10-19T00:00:00.000Z");
const FEED = "https://hacker-news.firebaseio.com/v0/topstories.json";
const item = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

type Net = Record<string, { status: number; body: string } | "throw">;

// Shared effects mimic the host: state per instance, reports and outbox deduped by key, inbox per instance.
type Eff = {
  state: Map<string, unknown>;
  reports: Map<string, { id: string; name: string; content: string; owner: string }>;
  outbox: Map<string, string>;
  inbox: Delivered[];
  acks: Array<{ ids: string[]; key: string }>;
  ackCalls: Array<{ agent: string; ids: string[]; key: string }>;
  asks: Array<{ question: string; key: string; escalation: string }>;
  urls: string[];
  results: Array<{ key: string; handoff: { summary: string; [k: string]: unknown } }>;
  ackSnaps: Array<unknown>;
  failAcks: number;
  crashAfter?: string;
  crashAfterKey?: string;
};

function newEff(): Eff {
  return {
    state: new Map(),
    reports: new Map(),
    outbox: new Map(),
    inbox: [],
    acks: [],
    asks: [],
    urls: [],
    results: [],
    ackSnaps: [],
    failAcks: 0,
    ackCalls: [],
  };
}

type Opts = { signal?: AbortSignal; deadlineAt?: number | null; stale?: boolean; agent?: string };

// Builds a WorkflowRunContext over the shared effects. Host-side escalation ids are derived from the ask key.
function ctxFor(eff: Eff, instance: string, runKey: string, net: Net, input: unknown, opts: Opts = {}): WorkflowRunContext & { input: HnInput } {
  const guard =
    <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      if (opts.stale) throw new Error("fence rejected: stale generation");
      const out = await fn(...a);
      if (eff.crashAfter === name) {
        eff.crashAfter = undefined;
        throw new Error(`simulated crash after ${name}`);
      }
      return out;
    };
  const workflow = {
    instance,
    runKey,
    getState: guard("getState", async () => structuredClone((eff.state.get(instance) ?? null) as never)),
    setState: async (v: unknown, key: string) => {
      if (opts.stale) throw new Error("fence rejected: stale generation");
      eff.state.set(instance, structuredClone(v));
      if (eff.crashAfterKey !== undefined && key.endsWith(eff.crashAfterKey)) {
        eff.crashAfterKey = undefined;
        throw new Error(`simulated crash after state ${key}`);
      }
    },
    fetch: guard("fetch", async (url: string) => {
      eff.urls.push(url);
      const r = net[url];
      if (r === undefined || r === "throw") throw new Error("socket hang up token=SECRET-123");
      return { url, status: r.status, body: r.body, fetchedAt: FETCHED_MS, sha256: sha(r.body) };
    }),
    publishReport: guard("publishReport", async (rep: { name: string; content: string }, key: string) => {
      if (!eff.reports.has(key)) eff.reports.set(key, { id: `rpt:${key}`, name: rep.name, content: rep.content, owner: "root" });
      return { id: `rpt:${key}`, ...(eff.reports.get(key) as object) } as never;
    }),
    sendToUser: guard("sendToUser", async (body: string, key: string) => {
      if (!eff.outbox.has(key)) eff.outbox.set(key, body);
    }),
    ask: guard("ask", async (question: string, key: string) => {
      const escalation = `esc:${key}`;
      eff.asks.push({ question, key, escalation });
      return { escalation };
    }),
  };
  const ops = {
    peek: async () => structuredClone(eff.inbox),
    ack: async (ids: string[], key: string) => {
      eff.ackCalls.push({ agent: opts.agent ?? "a1", ids, key });
      eff.ackSnaps.push(structuredClone(eff.state.get(instance) ?? null));
      if (eff.failAcks > 0) {
        eff.failAcks--;
        throw new Error("ack transport failed");
      }
      eff.acks.push({ ids, key });
      eff.inbox = eff.inbox.filter((s) => !ids.includes(s.id));
      return ids;
    },
    submitResult: async (handoff: { summary: string; [k: string]: unknown }, key: string) => {
      if (opts.stale) throw new Error("fence rejected: stale generation");
      if (!handoff.summary.trim()) throw new Error("summary required");
      if (!eff.results.some((r) => r.key === key)) eff.results.push({ key, handoff: structuredClone(handoff) });
      if (eff.crashAfter === "submitResult") {
        eff.crashAfter = undefined;
        throw new Error("simulated crash after submitResult");
      }
    },
  };
  return {
    agent: opts.agent ?? "a1",
    generation: 1,
    host: "h1",
    input,
    signal: opts.signal ?? new AbortController().signal,
    deadlineAt: opts.deadlineAt ?? null,
    ops,
    workflow,
  } as unknown as WorkflowRunContext & { input: HnInput };
}

const runWf = (ctx: WorkflowRunContext & { input: HnInput }) => hnDigest.run(ctx);

function feedNet(ids: number[], extra: Net = {}): Net {
  return { [FEED]: { status: 200, body: JSON.stringify(ids) }, ...extra };
}

const goodItems: Net = {
  [item(101)]: { status: 200, body: fx("item_101_story.json") },
  [item(102)]: { status: 200, body: fx("item_102_job.json") },
  [item(103)]: { status: 200, body: fx("item_103_ask.json") },
  [item(104)]: { status: 200, body: fx("item_104_poll.json") },
};

const state = (eff: Eff, instance: string) => eff.state.get(instance) as { seen: number[]; active: unknown } | undefined;

const answer = (escalation: string, body: string, id = `sig-${escalation}-${body}`): Delivered =>
  ({ kind: "human_answer", id, escalation, from: { channel: "discord", sender: "u1" }, body }) as Delivered;

// Waits until the handler has asked, so a test can answer while it is parked.
async function untilAsked(eff: Eff, n = 1): Promise<void> {
  await until(() => eff.asks.length >= n, 1000, { what: "the handler to ask", intervalMs: 2 });
}

describe("manifest and export", () => {
  it("manifest matches the extension and registers the digest workflow", () => {
    const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    assert.equal(
      m.apiVersion,
      EXTENSION_API_VERSION,
      "manifest.json declares the extension API version the host speaks (the entry's compiled-in manifest has none)",
    );
    const { apiVersion: _, ...declared } = m;
    assert.deepEqual(extension.manifest, declared, "manifest.json carries the entry's manifest, including the params table (params.mts)");
    let registered: { name?: string; capabilities?: { ask?: boolean } } | undefined;
    extension.init({
      config: { "ext.hnDigest.reportMaxBytes": 1234 },
      workflow(def) {
        registered = def as typeof registered;
      },
    });
    assert.equal(registered?.name, "digest");
    assert.equal(registered?.capabilities?.ask, true);
    assert.deepEqual(
      (registered as { capabilities?: { reports?: unknown } }).capabilities?.reports,
      { maxBytes: 1234 },
      "the report capability follows host.config",
    );
    assert.throws(() => extension.init({ config: {}, workflow() {} }), /host\.config has no ext\.hnDigest\.reportMaxBytes/);
  });
});

describe("validateInput", () => {
  it("applies defaults and rejects unknown, missing and invalid keys", () => {
    assert.deepEqual(validateInput({ instance: "daily" }), {
      ok: true,
      value: { instance: "daily", limit: 5, ask: false, insightBudgetMicros: 0 },
    });
    for (const bad of [
      {},
      { instance: "Bad Name" },
      { instance: "x", extra: 1 },
      { instance: "x", limit: 11 },
      { instance: "x", limit: 0 },
      { instance: "x", ask: "yes" },
    ]) {
      assert.equal(validateInput(bad).ok, false);
    }
    assert.equal(validateInput("nope").ok, false);
  });
  it("accepts ask:true and rejects nonzero insight budget with the insights TODO", () => {
    assert.deepEqual(validateInput({ instance: "x", ask: true }), {
      ok: true,
      value: { instance: "x", limit: 5, ask: true, insightBudgetMicros: 0 },
    });
    const b = validateInput({ instance: "x", insightBudgetMicros: 5 });
    assert.equal(b.ok, false);
    if (!b.ok) {
      assert.match(b.error, /TODO\(hn-insights\)/);
      assert.equal(b.error.includes("hn-ask"), false);
    }
    assert.equal(validateInput({ instance: "x", insightBudgetMicros: 100001 }).ok, false);
  });
  it("accepts underscores in instance and still rejects a leading underscore", () => {
    assert.equal(validateInput({ instance: "team_daily" }).ok, true);
    assert.equal(validateInput({ instance: "_team" }).ok, false);
  });
});

describe("digest run", () => {
  it("normal run: dedupes, skips a non-story type, reports, sends once, marks presented only", async () => {
    const eff = newEff();
    const net = feedNet([101, 102, 103, 102, 104, 105, 106], {
      ...goodItems,
      [item(105)]: { status: 200, body: fx("item_105_pollopt.json") },
    });
    await runWf(ctxFor(eff, "daily", "run-A", net, { instance: "daily" }));
    assert.equal(eff.asks.length, 0);
    assert.equal(eff.reports.size, 1);
    const rep = [...eff.reports.values()][0];
    assert.equal(rep?.name, "hn-daily.md");
    assert.equal(rep?.owner, "root");
    assert.match(rep?.content ?? "", /Show: A & B/);
    assert.equal(eff.outbox.size, 1);
    assert.match([...eff.outbox.values()][0] ?? "", /partial/);
    assert.deepEqual(state(eff, "daily")?.seen, [101, 102, 103, 104]);
    assert.equal(state(eff, "daily")?.active, null);
    assert.equal(eff.results.length, 1);
    assert.equal(eff.results[0]?.key, "run-A:result");
    assert.deepEqual(eff.results[0]?.handoff.entryIds, [101, 102, 103, 104]);
    assert.equal(eff.results[0]?.handoff.reportId, "rpt:run-A:report");
    assert.equal(eff.results[0]?.handoff.skipped, 1);
    assert.match(eff.results[0]?.handoff.summary ?? "", /new 4 · skipped 1 · report rpt:run-A:report/);
  });

  it("empty feed (zero ids) is a failure, not a no-new-posts outcome: no plan, report, outbox or result", async () => {
    const eff = newEff();
    await assert.rejects(
      runWf(ctxFor(eff, "daily", "r", feedNet([]), { instance: "daily" })),
      /hn-digest: feed returned zero ids \(sha256:[0-9a-f]{64}\); nothing to digest/,
    );
    assert.equal(eff.results.length, 0);
    assert.equal(eff.reports.size, 0);
    assert.equal(eff.outbox.size, 0);
    assert.equal(state(eff, "daily"), undefined);
  });

  it("an all-seen feed is a no-new-posts outcome whose report and outbox say how many feed ids were seen", async () => {
    const eff = newEff();
    const net = feedNet([101, 102], goodItems);
    await runWf(ctxFor(eff, "daily", "run-1", net, { instance: "daily", limit: 2 }));
    await runWf(ctxFor(eff, "daily", "run-2", net, { instance: "daily", limit: 2 }));
    assert.equal(eff.results.length, 2);
    assert.deepEqual(eff.results[1]?.handoff.entryIds, []);
    const reports = [...eff.reports.values()].map((r) => r.content);
    assert.match(reports[0] ?? "", /New posts: 2 \(limit 2; feed 2 ids, 0 seen; seen before: 0\)/);
    assert.match(reports[1] ?? "", /No new posts \(feed 2 ids, 2 seen\)\./);
    assert.match([...eff.outbox.values()][1] ?? "", /No new posts \(feed 2 ids, 2 seen\)/);
  });

  it("skips deleted, dead, null and unavailable items without marking them seen", async () => {
    const eff = newEff();
    const net = feedNet([107, 108, 109, 110, 101], {
      [item(107)]: { status: 200, body: fx("item_107_deleted.json") },
      [item(108)]: { status: 200, body: fx("item_108_dead.json") },
      [item(109)]: { status: 200, body: "null" },
      [item(110)]: "throw",
      [item(101)]: { status: 200, body: fx("item_101_story.json") },
    });
    await runWf(ctxFor(eff, "daily", "r", net, { instance: "daily", limit: 5 }));
    assert.deepEqual(state(eff, "daily")?.seen, [101]);
    const body = [...eff.reports.values()][0]?.content ?? "";
    assert.match(body, /Skipped: 4 \(dead=1, deleted=1, null=1, unavailable=1\)/);
    // The thrown fetch keeps a clipped, redacted cause on its own line; the secret never reaches the report.
    assert.match(body, /\n {3}item 110 unavailable: Error: socket hang up token=\[redacted\]/);
    assert.equal(body.includes("SECRET"), false);
  });

  it("does not re-present seen items on a later run", async () => {
    const eff = newEff();
    const net = feedNet([101, 102], goodItems);
    await runWf(ctxFor(eff, "daily", "run-1", net, { instance: "daily", limit: 1 }));
    await runWf(ctxFor(eff, "daily", "run-2", net, { instance: "daily", limit: 1 }));
    assert.deepEqual(state(eff, "daily")?.seen, [101, 102]);
    assert.equal(eff.reports.size, 2);
  });

  it("all candidates unusable: fails, persists no plan, marks nothing seen", async () => {
    const eff = newEff();
    const net = feedNet([107, 108], {
      [item(107)]: { status: 200, body: fx("item_107_deleted.json") },
      [item(108)]: "throw",
    });
    await assert.rejects(runWf(ctxFor(eff, "daily", "r", net, { instance: "daily" })), /no usable candidates/);
    assert.equal(eff.results.length, 0);
    assert.equal(state(eff, "daily"), undefined);
    assert.equal(eff.reports.size, 0);
    assert.equal(eff.outbox.size, 0);
  });

  it("feed unavailable or malformed fails with a clipped, redacted cause and no secret", async () => {
    const eff = newEff();
    await assert.rejects(runWf(ctxFor(eff, "daily", "r", { [FEED]: "throw" }, { instance: "daily" })), (e: Error) => {
      assert.equal(e.message, "hn-digest: feed unavailable (Error: socket hang up token=[redacted])");
      assert.equal(e.message.includes("SECRET"), false);
      return true;
    });
    await assert.rejects(
      runWf(ctxFor(eff, "daily", "r", { [FEED]: { status: 200, body: fx("feed_malformed.json") } }, { instance: "daily" })),
      /^Error: hn-digest: feed malformed \(TypeError: feed: entry \d+ is not a positive safe integer\)$/,
    );
    await assert.rejects(
      runWf(ctxFor(eff, "daily", "r", { [FEED]: { status: 200, body: "{not json" } }, { instance: "daily" })),
      /hn-digest: feed malformed \(SyntaxError: /,
    );
    await assert.rejects(runWf(ctxFor(eff, "daily", "r", { [FEED]: { status: 500, body: "" } }, { instance: "daily" })), /feed unavailable/);
    assert.equal(eff.outbox.size, 0);
    assert.equal(eff.results.length, 0);
  });

  it("instance state is separate", async () => {
    const eff = newEff();
    const net = feedNet([101], goodItems);
    await runWf(ctxFor(eff, "alpha", "r1", net, { instance: "alpha" }));
    await runWf(ctxFor(eff, "beta", "r2", net, { instance: "beta" }));
    assert.deepEqual(state(eff, "alpha")?.seen, [101]);
    assert.deepEqual(state(eff, "beta")?.seen, [101]);
  });

  it("fetches only the feed and item URLs on the allowed host", async () => {
    const eff = newEff();
    await runWf(ctxFor(eff, "daily", "r", feedNet([101], goodItems), { instance: "daily" }));
    assert.ok(eff.urls.length >= 2 && eff.urls.length <= 11);
    for (const u of eff.urls) assert.match(u, /^https:\/\/hacker-news\.firebaseio\.com\/v0\/(topstories\.json|item\/\d+\.json)$/);
  });

  it("stale facade rejects every effect and nothing is marked seen", async () => {
    const eff = newEff();
    await assert.rejects(runWf(ctxFor(eff, "daily", "r", feedNet([101], goodItems), { instance: "daily" }, { stale: true })), /fence rejected/);
    assert.equal(eff.reports.size, 0);
    assert.equal(eff.results.length, 0);
    assert.equal(state(eff, "daily"), undefined);
  });

  it("a rendered report fits the cap with ten maximal entries", async () => {
    const eff = newEff();
    const long = JSON.stringify({
      id: 1,
      type: "story",
      title: "t".repeat(400),
      text: "x".repeat(900),
      url: `https://example.com/${"p".repeat(1900)}`,
      score: 1,
      descendants: 1,
      time: 1700000000,
      by: "a",
    });
    const ids = Array.from({ length: 10 }, (_, i) => 1000 + i);
    const net: Net = { [FEED]: { status: 200, body: JSON.stringify(ids) } };
    for (const id of ids) net[item(id)] = { status: 200, body: long.replace('"id":1,', `"id":${id},`) };
    await runWf(ctxFor(eff, "daily", "r", net, { instance: "daily", limit: 10 }));
    const body = [...eff.reports.values()][0]?.content ?? "";
    assert.ok(Buffer.byteLength(body, "utf8") <= 65536, `report is ${Buffer.byteLength(body, "utf8")} bytes`);
    assert.ok(Array.from(body).length <= REPORT_MAX);
    for (const id of ids) assert.ok(body.includes(`item ${id} · source`), `entry ${id} missing from report`);
    assert.match(body, /Skipped: 0/);
    assert.equal(body.includes("…\n   discussion"), false);
    assert.equal(state(eff, "daily")?.seen.length, 10);
    assert.equal((eff.results[0]?.handoff.entryIds as number[] | undefined)?.length, 10);
  });
});

describe("ask confirmation", () => {
  it("waits without publishing until a matching yes is answered", async () => {
    const eff = newEff();
    const net = feedNet([101], goodItems);
    const p = runWf(ctxFor(eff, "daily", "run-A", net, { instance: "daily", ask: true }));
    await untilAsked(eff);
    assert.equal(eff.asks[0]?.key, "run-A:confirm");
    assert.match(eff.asks[0]?.question ?? "", /^Publish ranked digest .*\? Reply yes to continue\.$/);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(eff.reports.size, 0);
    assert.equal(eff.outbox.size, 0);
    assert.deepEqual(state(eff, "daily")?.seen ?? [], []);
    eff.inbox.push(answer(eff.asks[0]?.escalation ?? "", "Yes", "sig-1"));
    await p;
    assert.equal(eff.reports.size, 1);
    assert.equal(eff.outbox.size, 1);
    assert.deepEqual(state(eff, "daily")?.seen, [101]);
    assert.deepEqual(eff.acks, [{ ids: ["sig-1"], key: "run-A:confirm:sig-1:ack" }]);
  });

  it("ignores an answer for a different escalation and leaves it unacked", async () => {
    const eff = newEff();
    const p = runWf(ctxFor(eff, "daily", "run-A", feedNet([101], goodItems), { instance: "daily", ask: true }));
    await untilAsked(eff);
    eff.inbox.push(answer("esc:other", "yes", "sig-wrong"));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(eff.reports.size, 0);
    assert.equal(eff.acks.length, 0);
    eff.inbox.push(answer(eff.asks[0]?.escalation ?? "", "approve", "sig-right"));
    await p;
    assert.equal(eff.reports.size, 1);
    assert.deepEqual(eff.acks, [{ ids: ["sig-right"], key: "run-A:confirm:sig-right:ack" }]);
    assert.ok(eff.inbox.some((s) => s.id === "sig-wrong"));
  });

  it("accepts approve case-insensitively with whitespace", async () => {
    const eff = newEff();
    const p = runWf(ctxFor(eff, "daily", "run-A", feedNet([101], goodItems), { instance: "daily", ask: true }));
    await untilAsked(eff);
    eff.inbox.push(answer(eff.asks[0]?.escalation ?? "", "  APPROVE ", "sig-a"));
    await p;
    assert.equal(eff.reports.size, 1);
  });

  it("a decline throws a sanitized error, publishes nothing and leaves nothing seen", async () => {
    const eff = newEff();
    const p = runWf(ctxFor(eff, "daily", "run-A", feedNet([101], goodItems), { instance: "daily", ask: true }));
    await untilAsked(eff);
    eff.inbox.push(answer(eff.asks[0]?.escalation ?? "", "no thanks token=SECRET", "sig-n"));
    await assert.rejects(p, (e: Error) => {
      assert.equal(e.message, "digest publication declined");
      assert.equal(e.message.includes("SECRET"), false);
      return true;
    });
    assert.equal(eff.reports.size, 0);
    assert.equal(eff.outbox.size, 0);
    assert.deepEqual(state(eff, "daily")?.seen ?? [], []);
    assert.deepEqual(eff.acks, [{ ids: ["sig-n"], key: "run-A:confirm:sig-n:ack" }]);
    assert.equal(state(eff, "daily")?.active, null);
    assert.equal(eff.results.length, 0);
  });

  it("abort while waiting stops with no publish and no seen change", async () => {
    const eff = newEff();
    const ac = new AbortController();
    const p = runWf(ctxFor(eff, "daily", "run-A", feedNet([101], goodItems), { instance: "daily", ask: true }, { signal: ac.signal }));
    await untilAsked(eff);
    ac.abort();
    await assert.rejects(p, /confirmation aborted/);
    assert.equal(eff.results.length, 0);
    assert.equal(eff.reports.size, 0);
    assert.equal(eff.outbox.size, 0);
    assert.deepEqual(state(eff, "daily")?.seen ?? [], []);
  });

  it("a cancel or timeout signal delivered to the inbox stops the wait", async () => {
    for (const sig of [{ kind: "cancel", graceMs: 0 }, { kind: "timeout" }] as const) {
      const eff = newEff();
      const p = runWf(ctxFor(eff, "daily", "run-A", feedNet([101], goodItems), { instance: "daily", ask: true }));
      await untilAsked(eff);
      eff.inbox.push({ ...sig, id: `sig-${sig.kind}` } as Delivered);
      await assert.rejects(p, /confirmation cancelled/);
      assert.equal(eff.results.length, 0);
      assert.equal(eff.reports.size, 0);
      assert.deepEqual(state(eff, "daily")?.seen ?? [], []);
    }
  });

  it("a passed deadline stops the wait with no effects", async () => {
    const eff = newEff();
    const deadlineAt = Date.now() + 25;
    await assert.rejects(runWf(ctxFor(eff, "daily", "run-A", feedNet([101], goodItems), { instance: "daily", ask: true }, { deadlineAt })), /deadline reached/);
    assert.equal(eff.results.length, 0);
    assert.equal(eff.reports.size, 0);
    assert.equal(eff.outbox.size, 0);
    assert.deepEqual(state(eff, "daily")?.seen ?? [], []);
  });

  it("a new task repairs the same parked plan: same runId, keys and no refetch", async () => {
    const eff = newEff();
    const net = feedNet([101], goodItems);
    const ac = new AbortController();
    const first = runWf(ctxFor(eff, "daily", "run-first", net, { instance: "daily", ask: true }, { signal: ac.signal }));
    await untilAsked(eff);
    const fetchesBefore = eff.urls.length;
    ac.abort();
    await assert.rejects(first, /aborted/);
    assert.equal((state(eff, "daily")?.active as { runId: string } | null)?.runId, "run-first");

    const second = runWf(ctxFor(eff, "daily", "run-NEW", net, { instance: "daily", ask: true }));
    await untilAsked(eff, 2);
    assert.equal(eff.asks[1]?.key, "run-first:confirm");
    eff.inbox.push(answer(eff.asks[1]?.escalation ?? "", "yes", "sig-2"));
    await second;
    assert.equal(eff.urls.length, fetchesBefore);
    assert.deepEqual([...eff.reports.keys()], ["run-first:report"]);
    assert.deepEqual([...eff.outbox.keys()], ["run-first:outbox"]);
    assert.deepEqual(state(eff, "daily")?.seen, [101]);
    assert.equal(state(eff, "daily")?.active, null);
  });

  it("repair with ask false still requires the saved confirmation", async () => {
    const eff = newEff();
    const net = feedNet([101], goodItems);
    eff.crashAfterKey = ":plan";
    await assert.rejects(runWf(ctxFor(eff, "daily", "a", net, { instance: "daily", ask: true })), /simulated crash/);
    const p = runWf(ctxFor(eff, "daily", "b", net, { instance: "daily", ask: false }));
    await untilAsked(eff, 1);
    assert.equal(eff.reports.size, 0);
    eff.inbox.push(answer(eff.asks[0]?.escalation ?? "", "yes", "sig-r"));
    await p;
    assert.equal(eff.asks.length, 1);
    assert.deepEqual([...eff.reports.keys()], ["a:report"]);
  });

  it("confirmed marker is persisted before publish; crash after it does not reask", async () => {
    const eff = newEff();
    const net = feedNet([101], goodItems);
    const p = runWf(ctxFor(eff, "daily", "run-A", net, { instance: "daily", ask: true }));
    await untilAsked(eff);
    eff.crashAfter = "publishReport";
    eff.inbox.push(answer(eff.asks[0]?.escalation ?? "", "yes", "sig-y"));
    await assert.rejects(p, /simulated crash/);
    const saved = state(eff, "daily")?.active as { confirmed: boolean } | null | undefined;
    assert.equal(saved?.confirmed, true);
    await runWf(ctxFor(eff, "daily", "run-NEW", net, { instance: "daily", ask: false }));
    assert.equal(eff.asks.length, 1);
    assert.deepEqual([...eff.reports.keys()], ["run-A:report"]);
    assert.deepEqual([...eff.outbox.keys()], ["run-A:outbox"]);
    assert.deepEqual(state(eff, "daily")?.seen, [101]);
  });

  it("cancel leaves the plan blocked: a repair without ask still asks and does not publish", async () => {
    const eff = newEff();
    const net = feedNet([101], goodItems);
    const p = runWf(ctxFor(eff, "daily", "run-A", net, { instance: "daily", ask: true }));
    await untilAsked(eff);
    eff.inbox.push({ kind: "cancel", graceMs: 0, id: "sig-c" } as Delivered);
    await assert.rejects(p, /confirmation cancelled/);
    eff.inbox = eff.inbox.filter((s) => s.id !== "sig-c");
    const saved = state(eff, "daily")?.active as { confirmRequired: boolean; confirmed: boolean } | null;
    assert.equal(saved?.confirmRequired, true);
    assert.equal(saved?.confirmed, false);
    const again = runWf(ctxFor(eff, "daily", "run-B", net, { instance: "daily", ask: false }));
    await untilAsked(eff, 2);
    assert.equal(eff.reports.size, 0);
    eff.inbox.push(answer(eff.asks[1]?.escalation ?? "", "yes", "sig-y2"));
    await again;
    assert.deepEqual([...eff.reports.keys()], ["run-A:report"]);
  });
});

describe("crash and repair", () => {
  const points = ["plan", "publishReport", "sendToUser"] as const;
  for (const point of points) {
    it(`crash after ${point}: rerun on a new task reuses plan, keys and one report and outbox`, async () => {
      const eff = newEff();
      const net = feedNet([101, 102], goodItems);
      if (point === "plan") eff.crashAfterKey = ":plan";
      else eff.crashAfter = point;
      await assert.rejects(runWf(ctxFor(eff, "daily", "run-first", net, { instance: "daily", limit: 2 })), /simulated crash/);
      const fetchesBefore = eff.urls.length;
      await runWf(ctxFor(eff, "daily", "run-NEW", net, { instance: "daily", limit: 2 }));
      assert.equal(eff.reports.size, 1);
      assert.equal(eff.outbox.size, 1);
      assert.ok([...eff.reports.keys()][0] === "run-first:report");
      assert.ok([...eff.outbox.keys()][0] === "run-first:outbox");
      assert.deepEqual(state(eff, "daily")?.seen, [101, 102]);
      assert.equal(state(eff, "daily")?.active, null);
      assert.ok(eff.urls.length >= fetchesBefore);
    });
  }

  it("repair after plan persisted performs no new fetch", async () => {
    const eff = newEff();
    const net = feedNet([101], goodItems);
    eff.crashAfter = "publishReport";
    await assert.rejects(runWf(ctxFor(eff, "daily", "a", net, { instance: "daily" })), /simulated crash/);
    const before = eff.urls.length;
    await runWf(ctxFor(eff, "daily", "b", net, { instance: "daily" }));
    assert.equal(eff.urls.length, before);
  });
});

describe("confirmation ack order and repair", () => {
  it("durable marker is written before the ack: accepted sets confirmed, declined clears active", async () => {
    const eff = newEff();
    const p = runWf(ctxFor(eff, "daily", "run-A", feedNet([101], goodItems), { instance: "daily", ask: true }));
    await untilAsked(eff);
    eff.inbox.push(answer(eff.asks[0]?.escalation ?? "", "yes", "sig-o"));
    await p;
    assert.equal((eff.ackSnaps[0] as { active: { confirmed: boolean } }).active.confirmed, true);
    assert.equal(eff.acks.length, 1);

    const d = newEff();
    const q = runWf(ctxFor(d, "daily", "run-B", feedNet([101], goodItems), { instance: "daily", ask: true }));
    await untilAsked(d);
    d.inbox.push(answer(d.asks[0]?.escalation ?? "", "no", "sig-d"));
    await assert.rejects(q, /declined/);
    assert.equal((d.ackSnaps[0] as { active: unknown }).active, null);
    assert.equal(d.results.length, 0);
  });

  it("accepted: ack failure after the confirmed marker repairs the same plan without reask or refetch", async () => {
    const eff = newEff();
    const net = feedNet([101], goodItems);
    const p = runWf(ctxFor(eff, "daily", "run-A", net, { instance: "daily", ask: true }));
    await untilAsked(eff);
    eff.failAcks = 1;
    eff.inbox.push(answer(eff.asks[0]?.escalation ?? "", "yes", "sig-f"));
    await assert.rejects(p, /ack transport failed/);
    assert.equal(eff.reports.size, 0);
    assert.equal(eff.results.length, 0);
    const saved = state(eff, "daily")?.active as { confirmed: boolean; runId: string } | null;
    assert.equal(saved?.confirmed, true);
    const fetchesBefore = eff.urls.length;
    await runWf(ctxFor(eff, "daily", "run-NEW", net, { instance: "daily", ask: false }, { agent: "a-repair" }));
    assert.equal(eff.asks.length, 1, "no reask");
    assert.equal(eff.urls.length, fetchesBefore, "no refetch");
    // The failed ack was the old task's. The repair task must not ack the old answer (its inbox is its own).
    assert.deepEqual(
      eff.ackCalls.filter((c) => c.agent === "a-repair"),
      [],
    );
    assert.deepEqual(eff.acks, []);
    assert.deepEqual([...eff.reports.keys()], ["run-A:report"]);
    assert.deepEqual([...eff.outbox.keys()], ["run-A:outbox"]);
    assert.deepEqual(
      eff.results.map((r) => r.key),
      ["run-A:result"],
    );
    assert.deepEqual(state(eff, "daily")?.seen, [101]);
  });

  it("declined: ack failure leaves active cleared and seen unchanged; the decline is not undone by the failed ack", async () => {
    const eff = newEff();
    const p = runWf(ctxFor(eff, "daily", "run-A", feedNet([101], goodItems), { instance: "daily", ask: true }));
    await untilAsked(eff);
    eff.failAcks = 1;
    eff.inbox.push(answer(eff.asks[0]?.escalation ?? "", "no", "sig-x"));
    await assert.rejects(p, /ack transport failed/);
    assert.equal(state(eff, "daily")?.active, null);
    assert.deepEqual(state(eff, "daily")?.seen ?? [], []);
    assert.equal(eff.reports.size, 0);
    assert.equal(eff.results.length, 0);
  });

  it("crash after seen but before result: a fresh launch reports no new posts, submits its own result, keeps seen", async () => {
    const eff = newEff();
    const net = feedNet([101], goodItems);
    eff.crashAfterKey = ":seen";
    await assert.rejects(runWf(ctxFor(eff, "daily", "run-A", net, { instance: "daily" })), /simulated crash after state/);
    assert.deepEqual(state(eff, "daily")?.seen, [101]);
    assert.equal(eff.results.length, 0);
    await runWf(ctxFor(eff, "daily", "run-NEW", net, { instance: "daily" }));
    assert.deepEqual([...eff.reports.keys()], ["run-A:report", "run-NEW:report"]);
    assert.deepEqual(
      eff.results.map((r) => r.key),
      ["run-NEW:result"],
    );
    assert.deepEqual(eff.results[0]?.handoff.entryIds, []);
    assert.deepEqual(state(eff, "daily")?.seen, [101]);
  });

  it("crash after submitResult: the fresh launch is its own run and submits its own keyed result", async () => {
    const eff = newEff();
    const net = feedNet([101], goodItems);
    eff.crashAfter = "submitResult";
    await assert.rejects(runWf(ctxFor(eff, "daily", "run-A", net, { instance: "daily" })), /simulated crash after submitResult/);
    await runWf(ctxFor(eff, "daily", "run-NEW", net, { instance: "daily" }));
    assert.deepEqual(
      eff.results.map((r) => r.key),
      ["run-A:result", "run-NEW:result"],
    );
    assert.deepEqual(eff.results[1]?.handoff.entryIds, []);
  });
});
