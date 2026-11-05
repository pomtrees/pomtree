import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { captureFailure, captureJobIdOf, IdempotencyConflictError } from "@pomtree/core";
import type { CaptureRecord, NewCaptureJob } from "@pomtree/core";
import { captureIndexContractBody, quotaCountersOpIdContractBody } from "@pomtree/testing";
import { openStore } from "./store.ts";
import { tmpDir } from "@pomtree/testing";

const withDir = (fn: (file: string) => void | Promise<void>) => async () => {
  const dir = tmpDir("capture-index-");
  await fn(join(dir, "s.sqlite"));
};

const KEY = "a".repeat(64);
const job = (over: Partial<NewCaptureJob> = {}): NewCaptureJob => ({
  key: KEY,
  request: { url: "https://www.example.com/a", render: "static", purpose: "durability" },
  acquirer: "web",
  render: "static",
  requester: "ag-1",
  generation: 1,
  host: "host-1",
  createdAt: 1_000,
  ...over,
});
const record = (id: string, createdAt: number): CaptureRecord => ({
  id,
  predicate: {
    key: KEY,
    source: "static",
    acquirer: "static",
    freshness: "daily",
    fetch: {
      requestedUrl: "https://www.example.com/a",
      finalUrl: "https://www.example.com/a",
      redirects: [],
      status: 200,
      contentType: "text/html",
      headers: { etag: '"x"' },
      fetchedAt: createdAt,
      userAgent: "pomtree-test ops@example.org",
    },
    robots: null,
    worker: { agent: "ag-w", generation: 1, host: "host-1", sandbox: "sb-1", imageDigest: "sha256:0", egressChainHead: null },
    controller: { host: "host-1", pomtreedVersion: "0.0.0" },
  },
  artifacts: [{ role: "raw", mediaType: "text/html", sizeBytes: 3, sha256: "b".repeat(64), report: { agent: "ag-w", id: "r-1" } }],
  envelope: null,
  timestamp: null,
  createdAt,
});

test("CaptureIndex [sqlite] the shared contract on an in-memory store", () => captureIndexContractBody({ captures: openStore().captures }));

test(
  "CaptureIndex [sqlite] open jobs, steps, captures, the negative cache, pauses and idempotency keys survive a reopen",
  withDir(async (file) => {
    let s = openStore(file);
    const open = await s.captures.begin(job(), "b-1");
    await s.captures.advance(open.id, { kind: "rung_entered", rung: "robots", at: 1_010 }, "a-1");
    const done = await s.captures.begin(job({ key: "c".repeat(64), createdAt: 2_000 }), "b-2");
    const r = { ...record("cap-1", 3_000), predicate: { ...record("cap-1", 3_000).predicate, key: "c".repeat(64) } };
    await s.captures.settle(done.id, { state: "ok", capture: r, servedFrom: "static", ageMs: 0 }, "s-1");
    const failed = await s.captures.begin(job({ key: "d".repeat(64), createdAt: 2_500 }), "b-3");
    const fail = captureFailure({ class: "not_found", status: 404 });
    await s.captures.settle(failed.id, { state: "failed", job: failed.id, failure: fail, cached: false }, "s-2");
    await s.captures.pauseDomain("example.com", Date.now() + 60_000, "p-1");
    s.close();

    s = openStore(file);
    // Restart recovery: the unsettled job and its last step are there, so the broker resumes rather than repeats.
    const recovered = await s.captures.open();
    assert.deepEqual(
      recovered.map((j) => j.id),
      [open.id],
    );
    assert.deepEqual(recovered[0]?.steps, [{ kind: "rung_entered", rung: "robots", at: 1_010 }]);
    assert.deepEqual(await s.captures.get("cap-1"), r);
    assert.deepEqual(await s.captures.latest("c".repeat(64)), r);
    assert.equal((await s.captures.byDigest("b".repeat(64)))?.report.id, "r-1");
    assert.deepEqual((await s.captures.negative("d".repeat(64), Date.now()))?.failure, fail);
    assert.ok(((await s.captures.domainPause("example.com", Date.now())) ?? 0) > Date.now());
    // Idempotency keys are durable too: a replayed begin returns the same job; a different request under it conflicts.
    assert.equal((await s.captures.begin(job({ createdAt: 9_000 }), "b-1")).id, open.id);
    await assert.rejects(() => s.captures.begin(job({ key: "e".repeat(64) }), "b-1"), IdempotencyConflictError);
    // A new requester joins the recovered open job.
    assert.equal((await s.captures.begin(job({ requester: "ag-2" }), "b-4")).requesters.length, 2);
    assert.equal(open.id, captureJobIdOf(KEY, 1_000));
    s.close();
  }),
);

test(
  "CaptureIndex [sqlite] a failed settle rolls back: no negative entry, no state change, and the key stays free",
  withDir(async (file) => {
    const s = openStore(file);
    const j = await s.captures.begin(job(), "b-1");
    const bad = { ...record("cap-x", 5_000), predicate: { ...record("cap-x", 5_000).predicate, key: "f".repeat(64) } };
    await assert.rejects(() => s.captures.settle(j.id, { state: "ok", capture: bad, servedFrom: "static", ageMs: 0 }, "s-1"), /cache key/);
    assert.equal((await s.captures.job(j.id))?.state, "open");
    assert.equal(await s.captures.get("cap-x"), null);
    // The key was not consumed by the failed attempt, so the corrected settle under it goes through.
    await s.captures.settle(j.id, { state: "ok", capture: record("cap-y", 5_000), servedFrom: "static", ageMs: 0 }, "s-1");
    assert.equal((await s.captures.job(j.id))?.state, "settled");
    const raw = new DatabaseSync(file);
    try {
      assert.equal((raw.prepare("SELECT count(*) AS n FROM capture_records").get() as { n: number }).n, 1);
    } finally {
      raw.close();
    }
    s.close();
  }),
);

test("QuotaCounters [sqlite] opId replay contract on an in-memory store", () => quotaCountersOpIdContractBody({ quota: openStore().quotaCounters() }));

test(
  "QuotaCounters [sqlite] an opId take is durable across a reopen (charged once), and its record is pruned with its window",
  withDir((file) => {
    let s = openStore(file);
    assert.deepEqual(s.quotaCounters().take("capture.requests", "ag-1", 1_000, 1, 5, "cj-1:admit"), { ok: true, used: 1 });
    assert.deepEqual(s.quotaCounters().take("capture.requests", "ag-1", 0, 1, 5, "cj-1:admit"), { ok: true, used: 1 });
    s.close();
    s = openStore(file);
    assert.deepEqual(
      s.quotaCounters().take("capture.requests", "ag-1", 1_000, 1, 5, "cj-1:admit"),
      { ok: true, used: 1 },
      "the replay after a restart charges nothing",
    );
    assert.equal(s.quotaCounters().peek("capture.requests", "ag-1", 1_000), 1);
    assert.equal(s.pruneQuotaCounters(5_000, 0), 1, "the old window goes; the lifetime counter stays");
    const raw = new DatabaseSync(file);
    try {
      const ops = raw.prepare("SELECT window_start FROM quota_ops ORDER BY window_start").all() as { window_start: number }[];
      assert.deepEqual(
        ops.map((o) => o.window_start),
        [0],
        "the pruned window's opId record went with it",
      );
    } finally {
      raw.close();
    }
    // After the prune the window is fresh: the same opId applies again (its record went with the count it charged).
    assert.deepEqual(s.quotaCounters().take("capture.requests", "ag-1", 1_000, 1, 5, "cj-1:admit"), { ok: true, used: 1 });
    s.close();
  }),
);
