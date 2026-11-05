// Scenario tests: pure capture guards (URL contract, dispatch caps, deadline validation) and one offline integration run
// on the real stack. The integration run uses recorded fixtures and a stubbed DNS; it never touches the network.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openRuntime } from "./runtime.mts";
import {
  checkLiveUrl,
  DispatchBudget,
  liveFetch,
  LIVE_FEEDS_MAX,
  LIVE_ITEMS_MAX,
  liveRequestSignal,
  runScenario,
  type ScenarioSummary,
  validateDeadlineMs,
} from "./scenario.mts";

describe("capture guards", () => {
  it("a live run with a header-unsafe UA is refused before any runtime opens", async () => {
    let opened = false;
    await assert.rejects(
      runScenario({
        liveHn: true,
        fetchUserAgent: "x\r\ny",
        openRuntime: async () => {
          opened = true;
          throw new Error("must not open");
        },
      }),
      /^Error: scenario --live-hn: workflow\.fetch\.userAgent is refused .*POMTREED_WORKFLOW_FETCH_USER_AGENT/,
    );
    assert.equal(opened, false);
  });

  it("accepts only the two official paths on the exact origin", () => {
    assert.deepEqual(checkLiveUrl("https://hacker-news.firebaseio.com/v0/topstories.json"), { kind: "feed" });
    assert.deepEqual(checkLiveUrl("https://hacker-news.firebaseio.com/v0/item/101.json"), { kind: "item", id: 101 });
    for (const bad of [
      "http://hacker-news.firebaseio.com/v0/topstories.json",
      "https://hacker-news.firebaseio.com:8443/v0/topstories.json",
      "https://user:pw@hacker-news.firebaseio.com/v0/topstories.json",
      "https://hacker-news.firebaseio.com/v0/topstories.json?x=1",
      "https://hacker-news.firebaseio.com/v0/topstories.json#frag",
      "https://hacker-news.firebaseio.com/v0/item/0.json",
      "https://hacker-news.firebaseio.com/v0/item/01.json",
      "https://hacker-news.firebaseio.com/v0/item/99999999999999999999.json",
      "https://hacker-news.firebaseio.com/v0/user/pg.json",
      "https://news.ycombinator.com/item?id=101",
      "https://example.com/v0/topstories.json",
    ]) {
      assert.throws(() => checkLiveUrl(bad), Error, bad);
    }
  });

  it("caps feed and item dispatches before any fetch (3 feeds, 10 items)", () => {
    const b = new DispatchBudget();
    for (let i = 0; i < LIVE_FEEDS_MAX; i++) b.reserve("feed");
    assert.throws(() => b.reserve("feed"), /feed dispatch cap/);
    for (let i = 0; i < LIVE_ITEMS_MAX; i++) b.reserve("item");
    assert.throws(() => b.reserve("item"), /item dispatch cap/);
    assert.equal(b.feedDispatches, 3);
    assert.equal(b.itemDispatches, 10);
  });

  it("validates the deadline as an integer 1..180000 and cannot raise the cap", () => {
    assert.equal(validateDeadlineMs(), 180_000);
    assert.equal(validateDeadlineMs(1), 1);
    for (const bad of [0, -1, 1.5, 180_001, Number.NaN, "60000"]) {
      assert.throws(() => validateDeadlineMs(bad), RangeError, String(bad));
    }
  });
});

describe("live cancellation (offline, injected transport)", () => {
  const FEED = "https://hacker-news.firebaseio.com/v0/topstories.json";

  it("an incoming init.signal abort reaches the composed request signal", () => {
    const global = new AbortController();
    const incoming = new AbortController();
    const composed = liveRequestSignal(global.signal, incoming.signal);
    assert.equal(composed.aborted, false);
    incoming.abort(new Error("task cancelled"));
    assert.equal(composed.aborted, true);
  });

  it("the global deadline still aborts the composed signal with an incoming signal present", () => {
    const global = new AbortController();
    const composed = liveRequestSignal(global.signal, new AbortController().signal);
    global.abort(new Error("scenario: deadline reached"));
    assert.equal(composed.aborted, true);
  });

  it("a pre-aborted incoming signal is refused before any dispatch is counted", async () => {
    const budget = new DispatchBudget();
    const records: Array<unknown> = [];
    let sent = 0;
    const fetch = liveFetch(budget, records as never, "unused", new AbortController().signal, async () => {
      sent++;
      throw new Error("must not be sent");
    });
    const incoming = new AbortController();
    incoming.abort(new Error("cancelled"));
    await assert.rejects(fetch(FEED, { redirect: "manual", signal: incoming.signal }), /cancelled before dispatch/);
    assert.equal(sent, 0);
    assert.equal(budget.feedDispatches, 0);
    assert.equal(budget.dispatchFailures, 0);
  });

  it("an in-flight incoming cancel reaches the transport signal", async () => {
    const budget = new DispatchBudget();
    const incoming = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const fetch = liveFetch(budget, [], "unused", new AbortController().signal, async (_url, init) => {
      transportSignal = init.signal;
      await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      throw new Error("unreachable");
    });
    const pending = fetch(FEED, { redirect: "manual", signal: incoming.signal });
    incoming.abort(new Error("task cancelled"));
    await assert.rejects(pending, /aborted/);
    assert.equal(transportSignal?.aborted, true);
    assert.equal(budget.feedDispatches, 1);
    assert.equal(budget.dispatchFailures, 1);
  });
});

describe("offline integration", () => {
  it("runs ask, crash, reopen, chat repair, fresh run with counted populations", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "hn-scenario-test-"));
    try {
      const s: ScenarioSummary = await runScenario({ artifactDir, deadlineMs: 120_000 });
      assert.equal(s.error, undefined, s.error);
      assert.equal(s.status, "passed");
      assert.equal(s.live, false);
      assert.equal(s.simulatedDiscord, true);
      for (const [name, ok] of Object.entries(s.checks)) assert.equal(ok, true, `check ${name}`);
      // Ordinary run: 2 feed dispatches and 4 item dispatches (two runs of feed plus two items); repair dispatches none.
      assert.deepEqual(s.dispatch, { feedDispatches: 2, itemDispatches: 4, dispatchFailures: 0, responses: 6 });
      assert.equal(s.counts.repairDigestOutbox, 1);
      assert.equal(s.counts.digestOutbox, 2, "final digest outbox after the fresh run");
      assert.equal(s.counts.reports, 2);
      assert.equal(s.counts.digestPosts, 2);
      assert.equal(s.reportIds.length, 2);
      assert.equal(new Set(s.reportIds).size, 2, "fresh run has its own report id");
      assert.equal(s.entryIds.repair.length, 2);
      assert.equal(s.entryIds.fresh.length, 2);
      assert.equal(
        s.entryIds.repair.some((id) => s.entryIds.fresh.includes(id)),
        false,
        "fresh ids are disjoint",
      );
      assert.ok(s.timing.elapsedMs <= s.timing.deadlineMs, "within the total deadline");
      assert.deepEqual(s.unusedCalls, []);
      assert.deepEqual(s.cleanup, { ok: true });
      assert.equal(s.outboxPurposes.filter((p) => p === "report").length, 2);

      const manifest = JSON.parse(readFileSync(join(artifactDir, "manifest.json"), "utf8")) as ScenarioSummary;
      assert.equal(manifest.status, "passed");
      const sources = JSON.parse(readFileSync(join(artifactDir, "source", "sources.json"), "utf8")) as Array<{
        url: string;
        sha256: string;
        file: string;
        status: number;
        bytes: number;
      }>;
      assert.equal(sources.length, 6);
      for (const r of sources) {
        assert.ok(r.url.startsWith("https://hacker-news.firebaseio.com/v0/"), `official origin: ${r.url}`);
        assert.equal(r.file, join(artifactDir, "source", "raw", `${r.sha256}.json`));
        assert.ok(existsSync(r.file), `raw body retained: ${r.file}`);
        assert.equal(r.status, 200);
      }
      const transcript = JSON.parse(readFileSync(join(artifactDir, "transcript.json"), "utf8")) as Array<{ content: string }>;
      assert.ok(
        transcript.some((t) => t.content.includes("Reply yes to continue")),
        "ask reached the transcript",
      );
      assert.equal(transcript.filter((t) => t.content.startsWith("[report] HN digest")).length, 2);
      const text = JSON.stringify(manifest) + JSON.stringify(transcript);
      assert.doesNotMatch(text, /secret|token|bearer/i);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
});

describe("cleanup failure", () => {
  for (const failure of ["initial-open", "reopen"] as const) {
    it(`${failure} failure preserves diagnostic state and cannot use an earlier clean close as cleanup proof`, async () => {
      const artifactDir = mkdtempSync(join(tmpdir(), "hn-scenario-open-failure-"));
      let stateDir: string | undefined;
      let opens = 0;
      let closes = 0;
      try {
        const s = await runScenario({
          artifactDir,
          deadlineMs: 120_000,
          openRuntime: async (o) => {
            stateDir = o.stateDir;
            opens++;
            if (failure === "initial-open" || opens === 2)
              throw new Error(`${failure} original failure; teardown failures: pending resource token=abc /secret/path`);
            const rt = await openRuntime(o);
            return new Proxy(rt, {
              get: (t, k) =>
                k === "close"
                  ? async () => {
                      closes++;
                      await t.close();
                    }
                  : Reflect.get(t, k),
            });
          },
        });
        assert.equal(s.status, "failed");
        assert.equal(s.cleanup.ok, false);
        assert.match(s.cleanup.error ?? "", /partial cleanup unproven/);
        assert.match(s.error ?? "", new RegExp(`${failure} original failure`), "original error remains first");
        assert.equal(s.cleanup.preservedStateDir, stateDir);
        assert.ok(stateDir && existsSync(stateDir));
        assert.doesNotMatch(JSON.stringify(s.cleanup) + s.error, /abc|\/secret\/path/);
        assert.equal(opens, failure === "initial-open" ? 1 : 2);
        assert.equal(closes, failure === "initial-open" ? 0 : 1, "do not re-close the prior runtime after reopen rejected");
        const manifest = JSON.parse(readFileSync(join(artifactDir, "manifest.json"), "utf8")) as ScenarioSummary;
        assert.equal(manifest.cleanup.ok, false);
        assert.equal(manifest.cleanup.preservedStateDir, stateDir);
      } finally {
        if (stateDir) rmSync(stateDir, { recursive: true, force: true });
        rmSync(artifactDir, { recursive: true, force: true });
      }
    });
  }

  it("a failing runtime close marks the run failed, records cleanup, and preserves the state dir", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "hn-scenario-cleanup-"));
    let preserved: string | undefined;
    try {
      const s = await runScenario({
        artifactDir,
        deadlineMs: 120_000,
        openRuntime: async (o) => {
          const rt = await openRuntime(o);
          return new Proxy(rt, {
            get: (t, k) =>
              k === "close"
                ? async () => {
                    await t.close();
                    throw new Error("runtime close had failures: store close: boom /secret/path token=abc");
                  }
                : Reflect.get(t, k),
          });
        },
      });
      preserved = s.cleanup.preservedStateDir;
      assert.equal(s.status, "failed");
      assert.equal(s.cleanup.ok, false);
      assert.match(s.error ?? "", /cleanup failed/);
      assert.doesNotMatch(JSON.stringify(s.cleanup), /abc|\/secret\/path/);
      assert.ok(preserved && existsSync(preserved), "state dir preserved for diagnosis");
      const manifest = JSON.parse(readFileSync(join(artifactDir, "manifest.json"), "utf8")) as ScenarioSummary;
      assert.equal(manifest.status, "failed");
      assert.equal(manifest.cleanup.ok, false);
    } finally {
      if (preserved) rmSync(preserved, { recursive: true, force: true });
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
});
