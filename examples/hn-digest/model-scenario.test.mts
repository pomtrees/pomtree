// Offline guard and artifact tests for the model scenario. No network, no credentials, no Docker, no paid calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  type AttemptMetric,
  buildInput,
  createCountingFetch,
  guardUpstreamRequest,
  INDEX_MAX_BYTES,
  loadSourceArtifact,
  MAX_OUTPUT_TOKENS,
  RAW_MAX_BYTES,
  RESPONSE_MAX_BYTES,
  runModelScenario,
} from "./model-scenario.mts";
import { runScenario } from "./scenario.mts";

const URL_OK = "https://api.deepseek.com/chat/completions";
const body = (over: Record<string, unknown> = {}) => JSON.stringify({ model: "deepseek-flash", max_tokens: 512, messages: [], ...over });
const post = (b: string) => ({ method: "POST", body: b });

test("guard accepts only the pinned direct route, model, POST and bounded max_tokens", () => {
  assert.deepEqual(guardUpstreamRequest(URL_OK, post(body()), { attempts: 0, rejected: 0 }), { ok: true });
  assert.equal(guardUpstreamRequest("https://openrouter.ai/api/v1/chat/completions", post(body()), { attempts: 0, rejected: 0 }).ok, false);
  assert.equal(guardUpstreamRequest("https://api.deepseek.com/v1/models", post(body()), { attempts: 0, rejected: 0 }).ok, false);
  assert.equal(guardUpstreamRequest(`${URL_OK}?x=1`, post(body()), { attempts: 0, rejected: 0 }).ok, false);
  assert.equal(guardUpstreamRequest(URL_OK, { method: "GET", body: body() }, { attempts: 0, rejected: 0 }).ok, false);
  assert.equal(guardUpstreamRequest(URL_OK, post(body({ model: "deepseek-v4-pro" })), { attempts: 0, rejected: 0 }).ok, false);
  assert.equal(guardUpstreamRequest(URL_OK, post(body({ max_tokens: MAX_OUTPUT_TOKENS + 1 })), { attempts: 0, rejected: 0 }).ok, false);
  assert.equal(guardUpstreamRequest(URL_OK, post(body({ max_tokens: undefined })), { attempts: 0, rejected: 0 }).ok, false);
  assert.equal(guardUpstreamRequest(URL_OK, post("not json"), { attempts: 0, rejected: 0 }).ok, false);
});

test("guard refuses a third attempt before dispatch", () => {
  assert.equal(guardUpstreamRequest(URL_OK, post(body()), { attempts: 2, rejected: 0 }).ok, false);
});

test("counting fetch never calls the inner fetch on refusal and caps dispatch at two", async () => {
  let calls = 0;
  const inner = (async () => {
    calls++;
    return new Response(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), { status: 200 });
  }) as typeof globalThis.fetch;
  const state = { attempts: 0, rejected: 0 };
  const metrics: unknown[] = [];
  const f = createCountingFetch(inner, state, (m) => metrics.push(m));
  await f(URL_OK, post(body()));
  await f(URL_OK, post(body()));
  await assert.rejects(f(URL_OK, post(body())), /attempt cap/);
  await assert.rejects(f("https://api.deepseek.com/x", post(body())), /refused/);
  assert.equal(calls, 2);
  assert.equal(state.attempts, 2);
  assert.equal(state.rejected, 2);
  assert.equal(metrics.length, 2);
  const m = metrics[0] as Record<string, unknown>;
  assert.equal(m.model, "deepseek-flash");
  assert.equal(m.maxTokens, 512);
  assert.equal(m.promptTokens, 3);
  assert.equal(m.completionTokens, 4);
  assert.match(String(m.bodySha256), /^[0-9a-f]{64}$/);
  assert.equal("headers" in m, false);
});

// The artifact is produced by the REAL offline metadata scenario (scenario.mts), then copied per test so mutations are isolated.
// Keep its integration setup out of pure guard/stream tests, including narrow hang reproductions.
describe("metadata artifact integration", () => {
  let producer = "";
  before(async () => {
    producer = mkdtempSync(join(tmpdir(), "hn-model-producer-"));
    const s = await runScenario({ artifactDir: producer, deadlineMs: 120_000 });
    assert.equal(s.status, "passed", s.error);
  });
  after(() => rmSync(producer, { recursive: true, force: true }));

  type Rec = { url: string; status: number; sha256: string; fetchedAt: number; bytes: number; file: string };
  // Copies the producer tree; `file` paths (absolute in the producer) are rewritten relative so the copy is self-contained.
  function copyOf(mutate?: (dir: string, recs: Rec[]) => Rec[] | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), "hn-model-copy-"));
    copyDirs.push(dir);
    cpSync(join(producer, "manifest.json"), join(dir, "manifest.json"));
    cpSync(join(producer, "source"), join(dir, "source"), { recursive: true });
    const path = join(dir, "source", "sources.json");
    const recs = (JSON.parse(readFileSync(path, "utf8")) as Rec[]).map((r) => ({ ...r, file: join("source", "raw", basename(r.file)) }));
    writeFileSync(path, JSON.stringify(mutate?.(dir, recs) ?? recs));
    return dir;
  }
  const copyDirs: string[] = [];
  after(() => {
    for (const d of copyDirs) rmSync(d, { recursive: true, force: true });
  });
  const reasonOf = (dir: string, requireLive = false): string => {
    const r = loadSourceArtifact(dir, { requireLive });
    assert.equal(r.ok, false);
    return r.ok ? "" : r.reason;
  };
  const modelTmp = () =>
    readdirSync(tmpdir()).filter((n) => n.startsWith("hn-model-") && !n.startsWith("hn-model-producer-") && !n.startsWith("hn-model-copy-"));

  test("real producer layout: raw hashes are verified and items normalize through the shared parsers", async () => {
    const dir = copyOf();
    const load = loadSourceArtifact(dir, { requireLive: false });
    assert.equal(load.ok, true);
    if (!load.ok) return;
    assert.equal(load.live, false);
    assert.deepEqual(
      load.items.map((i) => [i.id, i.rank]),
      [
        [101, 1],
        [102, 2],
        [103, 3],
      ],
    );
    // Parsers applied: html entities decoded in the title, unknown fields dropped, source url derived.
    assert.match(load.items[0]?.title ?? "", /A & B/);
    assert.equal(load.items[0]?.sourceUrl, "https://hacker-news.firebaseio.com/v0/item/101.json");
    // Provenance keeps the RAW sha256 (matches the producer index), distinct from the normalized input hash.
    const index = JSON.parse(readFileSync(join(producer, "source", "sources.json"), "utf8")) as Rec[];
    for (const p of load.provenance) assert.ok(index.some((r) => r.sha256 === p.rawSha256 && r.url === p.url));
    assert.equal(load.feed.url, "https://hacker-news.firebaseio.com/v0/topstories.json");
    const before = modelTmp();
    const m = await runModelScenario({ sourceDir: dir });
    assert.equal(m.refused, undefined);
    assert.equal(m.items, 3);
    assert.equal(m.attempts, 0);
    assert.equal(m.sourceLive, false);
    assert.match(m.inputSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(
      m.provenance?.some((p) => p.rawSha256 === m.inputSha256),
      false,
    );
    assert.equal("tmpDir" in m, false);
    assert.deepEqual(modelTmp(), before, "no temporary resources created");
  });

  test("the original producer directory loads directly with its absolute file paths", () => {
    assert.equal(loadSourceArtifact(producer, { requireLive: false }).ok, true);
  });

  test("repeated captures explicitly use the first successful feed and first successful item records", () => {
    const dir = copyOf((dir, recs) => {
      let feeds = 0;
      const updated = recs.map((r) => {
        if (!r.url.includes("/topstories.json") || ++feeds === 1) return r;
        const raw = Buffer.from(JSON.stringify([104, 103, 102, 101]));
        const sha256 = createHash("sha256").update(raw).digest("hex");
        const file = join("source", "raw", `${sha256}.json`);
        writeFileSync(join(dir, file), raw);
        return { ...r, sha256, file, bytes: raw.length, fetchedAt: r.fetchedAt + 1000 };
      });
      assert.equal(feeds, 2, "real producer captures the feed twice");
      const original = recs.find((r) => r.url.endsWith("/item/101.json"));
      assert.ok(original);
      const raw = Buffer.from(JSON.stringify({ id: 101, type: "story", title: "Later title", score: 999 }));
      const sha256 = createHash("sha256").update(raw).digest("hex");
      const file = join("source", "raw", `${sha256}.json`);
      writeFileSync(join(dir, file), raw);
      return [...updated, { ...original, sha256, file, bytes: raw.length, fetchedAt: original.fetchedAt + 1000 }];
    });
    const load = loadSourceArtifact(dir, { requireLive: false });
    assert.ok(load.ok);
    assert.deepEqual(
      load.items.map((i) => [i.id, i.rank]),
      [
        [101, 1],
        [102, 2],
        [103, 3],
      ],
    );
    assert.match(load.items[0]?.title ?? "", /A & B/);
  });

  test("hash drift, byte-count drift, missing and malformed records are refused", () => {
    const first = (recs: Rec[]) => recs.find((r) => r.url.includes("/item/101.json")) as Rec;
    assert.match(reasonOf(copyOf((_d, recs) => recs.map((r) => (r === first(recs) ? { ...r, sha256: "0".repeat(64) } : r)))), /raw hash mismatch/);
    assert.match(reasonOf(copyOf((_d, recs) => recs.map((r) => (r === first(recs) ? { ...r, bytes: r.bytes + 1 } : r)))), /byte count mismatch/);
    assert.match(
      reasonOf(
        copyOf((dir, recs) => {
          writeFileSync(join(dir, recs[0]?.file ?? ""), "[1]");
          return recs;
        }),
      ),
      /mismatch/,
    );
    assert.match(reasonOf(copyOf((_d, recs) => recs.map((r) => ({ ...r, sha256: "xyz" })))), /malformed sha256/);
    assert.match(reasonOf(copyOf((_d, recs) => recs.map((r) => ({ ...r, status: "200" as unknown as number })))), /non-integer/);
    assert.match(reasonOf(copyOf(() => [])), /no successful feed record/);
    assert.match(reasonOf(copyOf((_d, recs) => recs.filter((r) => !r.url.includes("/item/")))), /no usable captured items/);
    assert.match(reasonOf(copyOf(() => ({}) as unknown as Rec[])), /must be an array/);
  });

  test("path escapes, symlinks and out-of-raw files are refused before reading", () => {
    assert.match(reasonOf(copyOf((_d, recs) => recs.map((r) => ({ ...r, file: "../../etc/hosts" })))), /missing or dangling|escapes/);
    const outside = mkdtempSync(join(tmpdir(), "hn-model-copy-"));
    copyDirs.push(outside);
    writeFileSync(join(outside, "x.json"), "[]");
    assert.match(reasonOf(copyOf((_d, recs) => recs.map((r) => ({ ...r, file: join(outside, "x.json") })))), /escapes/);
    const escapedManifest = copyOf();
    rmSync(join(escapedManifest, "manifest.json"));
    symlinkSync(join(outside, "x.json"), join(escapedManifest, "manifest.json"));
    assert.match(reasonOf(escapedManifest), /manifest\.json escapes/);
    const escapedIndex = copyOf();
    rmSync(join(escapedIndex, "source", "sources.json"));
    writeFileSync(join(escapedIndex, "outside-source.json"), "[]");
    symlinkSync(join(escapedIndex, "outside-source.json"), join(escapedIndex, "source", "sources.json"));
    assert.match(reasonOf(escapedIndex), /source\/sources\.json escapes/);
    // A file inside the artifact but outside source/raw is also out of the fence.
    assert.match(
      reasonOf(
        copyOf((dir, recs) => {
          writeFileSync(join(dir, "stray.json"), "[]");
          return recs.map((r) => ({ ...r, file: "stray.json" }));
        }),
      ),
      /escapes/,
    );
    assert.match(
      reasonOf(
        copyOf((dir, recs) => {
          const target = join(dir, "source", "raw", basename(recs[0]?.file ?? ""));
          rmSync(target);
          symlinkSync(join(outside, "x.json"), target);
          return recs;
        }),
      ),
      /escapes/,
    );
  });

  test("oversize raw, index and manifest are refused by size before whole reads", () => {
    const big = copyOf((dir, recs) => {
      writeFileSync(join(dir, recs[0]?.file ?? ""), Buffer.alloc(RAW_MAX_BYTES + 1, 32));
      return recs;
    });
    assert.match(reasonOf(big), /exceeds 262144 bytes/);
    assert.match(reasonOf(copyOf((_d, recs) => recs.map((r, i) => (i === 0 ? { ...r, bytes: RAW_MAX_BYTES + 1 } : r)))), /exceeds 262144 bytes/);
    const bigIndex = copyOf();
    writeFileSync(join(bigIndex, "source", "sources.json"), Buffer.alloc(INDEX_MAX_BYTES + 1, 32));
    assert.match(reasonOf(bigIndex), /sources\.json exceeds/);
    const bigManifest = copyOf();
    truncateSync(join(bigManifest, "manifest.json"), 1_000_000_000); // sparse: reject by stat, never allocate/read this size
    assert.match(reasonOf(bigManifest), /manifest\.json exceeds/);
    const nonFile = copyOf();
    rmSync(join(nonFile, "manifest.json"));
    mkdirSync(join(nonFile, "manifest.json"));
    assert.match(reasonOf(nonFile), /must be a regular file/);
    assert.match(reasonOf(copyOf((_d, recs) => [...recs, ...recs, ...recs])), /more than 13 records/);
  });

  test("manifest status and live flags are strict; live runs need a live capture", () => {
    const withManifest = (m: unknown) => {
      const d = copyOf();
      writeFileSync(join(d, "manifest.json"), JSON.stringify(m));
      return d;
    };
    assert.match(reasonOf(withManifest({ status: "failed", live: false })), /not passed/);
    assert.match(reasonOf(withManifest({ status: "passed" })), /live flag missing/);
    assert.match(reasonOf(withManifest({ status: "passed", live: "yes" })), /live flag missing/);
    assert.match(reasonOf(withManifest([])), /must be an object|not passed/);
    assert.match(reasonOf(copyOf(), true), /not a live capture/);
    assert.equal(loadSourceArtifact(withManifest({ status: "passed", live: true }), { requireLive: true }).ok, true);
  });

  test("non-directory, missing and malformed inputs refuse with a reason instead of throwing", async () => {
    const f = join(producer, "manifest.json");
    assert.match(reasonOf(f), /must be a directory/);
    assert.match(reasonOf(join(producer, "nope")), /unreadable \(ENOENT\)/);
    const bad = copyOf();
    writeFileSync(join(bad, "manifest.json"), "{not json");
    assert.match(reasonOf(bad), /not valid JSON/);
    const m = await runModelScenario({ sourceDir: f });
    assert.match(m.refused ?? "", /must be a directory/);
    assert.equal(m.attempts, 0);
  });

  test("budget above the authorized total fails closed; buildInput enforces the item cap", async () => {
    await assert.rejects(runModelScenario({ sourceDir: producer, budgetMicros: 100_001 }), /budget/);
    const load = loadSourceArtifact(producer, { requireLive: false });
    assert.equal(load.ok, true);
    if (!load.ok) return;
    const four = { ...load, items: [...load.items, { ...load.items[0], id: 999, sourceUrl: "https://hacker-news.firebaseio.com/v0/item/999.json" }] };
    const built = buildInput(four as typeof load, 1000);
    assert.equal(built.ok, false);
  });

  test("scripted backend is reached only through the guard in the scenario runner", async () => {
    let calls = 0;
    const backend = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    const m = await runModelScenario({ sourceDir: producer, backend, mode: "dry-run" });
    assert.equal(calls, 1);
    assert.equal(m.attempts, 1);
    assert.equal(m.metrics[0]?.bodySha256, createHash("sha256").update("{}").digest("hex"));
  });

  test("--live-deepseek stays fail-closed with a consistent refusal for a directory, a file or a missing path", async () => {
    const { spawnSync } = await import("node:child_process");
    const script = new URL("./model-scenario.mts", import.meta.url).pathname;
    const liveDir = copyOf();
    writeFileSync(join(liveDir, "manifest.json"), JSON.stringify({ status: "passed", live: true }));
    for (const p of [producer, join(producer, "manifest.json"), join(producer, "nope"), liveDir]) {
      const r = spawnSync(process.execPath, [script, "--live-deepseek", "--source-artifact", p], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
        timeout: 2000,
      });
      assert.equal(r.status, 3, r.stderr);
      assert.match(r.stderr, /live branch not wired/);
      assert.match(r.stderr, /No credentials were read/);
      if (p !== liveDir) assert.match(r.stderr, /source artifact refused/);
      else assert.doesNotMatch(r.stderr, /source artifact refused/);
      assert.doesNotMatch(r.stderr, /EISDIR|ENOTDIR|at .*\.mts/);
    }
    const ok = spawnSync(process.execPath, [script, "--source-artifact", producer], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      timeout: 2000,
    });
    assert.equal(ok.status, 0);
    assert.equal((JSON.parse(ok.stdout) as { items: number }).items, 3);
  });
});

test("provider response reads are capped and transport failures keep their metric", async () => {
  const state = { attempts: 0, rejected: 0 };
  const metrics: Record<string, unknown>[] = [];
  const huge = (async () => new Response(Buffer.alloc(RESPONSE_MAX_BYTES + 1, 97), { status: 200 })) as typeof globalThis.fetch;
  await assert.rejects(createCountingFetch(huge, state, (m) => metrics.push({ ...m }))(URL_OK, post(body())), /exceeds 262144 bytes/);
  assert.equal(metrics[0]?.truncated, true);
  assert.equal(metrics[0]?.bodySha256, undefined);
  const boom = (async () => {
    throw new Error("network down");
  }) as typeof globalThis.fetch;
  await assert.rejects(createCountingFetch(boom, state, (m) => metrics.push({ ...m }))(URL_OK, post(body())), /network down/);
  assert.equal(metrics[1]?.failed, true);
  assert.equal(state.attempts, 2);
});

// Unlike an unref'ed AbortSignal timeout, this deadline also detects a pending promise with no other event-loop work.
async function within<T>(p: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("bounded assertion deadline reached")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("oversize response joins cancellation and releases its original reader without cloning", async () => {
  let pulls = 0;
  let cancelStarted = false;
  let cancelFinished = false;
  let finishCancel: () => void = () => {};
  const cancelled = new Promise<void>((resolve) => {
    finishCancel = () => {
      cancelFinished = true;
      resolve();
    };
  });
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(RESPONSE_MAX_BYTES + 1));
      },
      cancel() {
        cancelStarted = true;
        return cancelled;
      },
    },
    { highWaterMark: 0 },
  );
  const original = new Response(stream);
  original.clone = () => {
    throw new Error("must consume original, not create an unread tee branch");
  };
  const state = { attempts: 0, rejected: 0 };
  const metrics: AttemptMetric[] = [];
  const f = createCountingFetch(
    async () => original,
    state,
    (m) => metrics.push(m),
  );
  let settled = false;
  const request = f(URL_OK, post(body())).finally(() => {
    settled = true;
  });
  const rejected = assert.rejects(request, /exceeds 262144 bytes/);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancelStarted, true);
    assert.equal(settled, false, "must join ordinary cancellation before returning");
    finishCancel();
    await within(rejected);
    assert.equal(cancelFinished, true);
    assert.equal(stream.locked, false);
    assert.equal(pulls, 1, "stop reading at the first over-cap chunk");
    assert.deepEqual(metrics, [{ attempt: 1, model: "deepseek-flash", maxTokens: 512, status: 200, truncated: true }]);
    assert.equal(state.attempts, 1);
  } finally {
    finishCancel();
    await within(rejected);
  }
});

test("a stalled body is aborted, cancelled and recorded as failed, never a hashed empty success", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  const metrics: AttemptMetric[] = [];
  const abort = new AbortController();
  const f = createCountingFetch(
    async () => new Response(stream),
    { attempts: 0, rejected: 0 },
    (m) => metrics.push(m),
  );
  const rejected = assert.rejects(f(URL_OK, { ...post(body()), signal: abort.signal }), /stopped/);
  // Abort after the pending reader.read(), not just before dispatch.
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort(new Error("stopped"));
  try {
    await within(rejected);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
    assert.deepEqual(metrics, [{ attempt: 1, model: "deepseek-flash", maxTokens: 512, status: 200, failed: true }]);
  } finally {
    // Allows the pre-fix reader to settle even when the bounded assertion fails.
    if (!cancelled) controller?.error(new Error("stopped"));
    await rejected.catch(() => {});
  }
});

test("an unread external clone sibling cannot hang oversize cancellation; its owner can still close it", async () => {
  let sourceCancelled = false;
  let signal: AbortSignal | null | undefined;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(RESPONSE_MAX_BYTES + 1));
      },
      cancel() {
        sourceCancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const original = new Response(source);
  const clone = original.clone();
  const metrics: AttemptMetric[] = [];
  const f = createCountingFetch(
    async (_input, init) => {
      signal = init?.signal;
      return clone;
    },
    { attempts: 0, rejected: 0 },
    (m) => metrics.push(m),
  );
  try {
    await within(assert.rejects(f(URL_OK, post(body())), /exceeds 262144 bytes/));
    assert.equal(signal?.aborted, true, "stop the underlying transport as well as cancelling the consumed branch");
    assert.equal(clone.body?.locked, false);
    assert.equal(metrics[0]?.truncated, true);
    assert.equal(metrics[0]?.cleanupFailed, true, "unjoined external tee cancellation must be visible");
  } finally {
    // WHATWG tee joins cancellation only after BOTH branches cancel. The caller, not the wrapper, owns this hidden sibling.
    await within(original.body?.cancel() ?? Promise.resolve());
  }
  assert.equal(sourceCancelled, true);
});

test("rejecting and never-settling cancellation are bounded, visible and leave no reader lock", async () => {
  for (const outcome of ["reject", "stall"] as const) {
    let rejectCancel: (e: Error) => void = () => {};
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(RESPONSE_MAX_BYTES + 1));
        },
        cancel() {
          if (outcome === "reject") return Promise.reject(new Error("cancel refused"));
          return new Promise<void>((_resolve, reject) => {
            rejectCancel = reject;
          });
        },
      },
      { highWaterMark: 0 },
    );
    const metrics: AttemptMetric[] = [];
    const f = createCountingFetch(
      async () => new Response(stream),
      { attempts: 0, rejected: 0 },
      (m) => metrics.push(m),
    );
    try {
      await within(assert.rejects(f(URL_OK, post(body())), /exceeds 262144 bytes/));
      assert.equal(stream.locked, false);
      assert.equal(metrics[0]?.truncated, true);
      assert.equal(metrics[0]?.cleanupFailed, true);
    } finally {
      // A late rejection of the bounded-out cancellation must not become unhandled.
      rejectCancel(new Error("late cancellation failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
});

test("partial body errors propagate with a failed metric and no hash, and release the reader", async () => {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (++pulls === 1) controller.enqueue(new TextEncoder().encode("partial"));
        else controller.error(new Error("body failed"));
      },
    },
    { highWaterMark: 0 },
  );
  const metrics: AttemptMetric[] = [];
  const f = createCountingFetch(
    async () => new Response(stream),
    { attempts: 0, rejected: 0 },
    (m) => metrics.push(m),
  );
  await within(assert.rejects(f(URL_OK, post(body())), /body failed/));
  assert.equal(stream.locked, false);
  assert.equal(metrics[0]?.failed, true);
  assert.equal(metrics[0]?.bodySha256, undefined);
});

test("exact-cap multi-chunk bodies rebuild correctly without a clone, unsafe usage metrics are dropped, and null bodies stay null", async () => {
  let offset = 0;
  let cancelled = false;
  const expected = Buffer.alloc(RESPONSE_MAX_BYTES, 97);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === expected.length) controller.close();
      else {
        const end = Math.min(offset + 1024, expected.length);
        controller.enqueue(expected.subarray(offset, end));
        offset = end;
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(stream, { status: 201, statusText: "Created", headers: { "x-test": "ok" } });
  response.clone = () => {
    throw new Error("must not clone");
  };
  const metrics: AttemptMetric[] = [];
  const wrapped = await within(
    createCountingFetch(
      async () => response,
      { attempts: 0, rejected: 0 },
      (m) => metrics.push(m),
    )(URL_OK, post(body())),
  );
  assert.deepEqual(Buffer.from(await wrapped.arrayBuffer()), expected);
  assert.equal(wrapped.status, 201);
  assert.equal(wrapped.statusText, "Created");
  assert.equal(wrapped.headers.get("x-test"), "ok");
  assert.equal(metrics[0]?.bodySha256, createHash("sha256").update(expected).digest("hex"));
  assert.equal(stream.locked, false);
  assert.equal(cancelled, false, "fully consumed streams need only release their reader");

  await createCountingFetch(
    async () => new Response(JSON.stringify({ usage: { prompt_tokens: "secret text", completion_tokens: -1 } })),
    { attempts: 0, rejected: 0 },
    (m) => metrics.push(m),
  )(URL_OK, post(body()));
  assert.equal(metrics[1]?.promptTokens, undefined);
  assert.equal(metrics[1]?.completionTokens, undefined);
  const empty = await createCountingFetch(async () => new Response(null, { status: 204 }), { attempts: 0, rejected: 0 })(URL_OK, post(body()));
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
});

test("redirects are not followed and the wrapper forces redirect:manual", async () => {
  let seen: RequestInit | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const inner = (async (_u: unknown, init?: RequestInit) => {
    seen = init;
    return new Response(stream, { status: 307, headers: { location: "https://evil.example/" } });
  }) as typeof globalThis.fetch;
  const state = { attempts: 0, rejected: 0 };
  const f = createCountingFetch(inner, state);
  await assert.rejects(f(URL_OK, post(body())), /redirect 307/);
  assert.equal(seen?.redirect, "manual");
  assert.equal(seen?.signal?.aborted, true);
  assert.equal(state.attempts, 1);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("source guard allows only official GET item/feed reads inside the budget", async () => {
  const { guardSourceRequest } = await import("./model-scenario.mts");
  const kids = new Set([11, 12]);
  const b = { items: 0, feeds: 0 };
  assert.equal(guardSourceRequest("https://hacker-news.firebaseio.com/v0/item/11.json", "GET", kids, b).ok, true);
  assert.equal(guardSourceRequest("https://hacker-news.firebaseio.com/v0/item/13.json", "GET", kids, b).ok, false);
  assert.equal(guardSourceRequest("https://evil.example/v0/item/11.json", "GET", kids, b).ok, false);
  assert.equal(guardSourceRequest("https://hacker-news.firebaseio.com/v0/item/11.json", "POST", kids, b).ok, false);
  assert.equal(guardSourceRequest("https://hacker-news.firebaseio.com/v0/item/11.json?x=1", "GET", kids, b).ok, false);
  assert.equal(guardSourceRequest("https://hacker-news.firebaseio.com/v0/user/a.json", "GET", kids, b).ok, false);
  assert.equal(guardSourceRequest("https://hacker-news.firebaseio.com/v0/topstories.json", "GET", kids, { items: 0, feeds: 0 }).ok, false);
  assert.equal(guardSourceRequest("https://hacker-news.firebaseio.com/v0/item/11.json", "GET", kids, { items: 10, feeds: 0 }).ok, false);
  assert.equal(guardSourceRequest("https://hacker-news.firebaseio.com/v0/item/11.json", "GET", kids, { items: 2, feeds: 3 }).ok, true);
  assert.equal(guardSourceRequest("https://hacker-news.firebaseio.com/v0/item/0.json", "GET", new Set([0]), b).ok, false);
});

test("remaining budget is derived from original counts with independent caps; sentiment maps by storyId", async () => {
  const { remainingSourceBudget, mapDiscussionToItems } = await import("./model-scenario.mts");
  assert.deepEqual(remainingSourceBudget({ items: 4, feeds: 2 }), { items: 6, feeds: 1 });
  assert.equal("refused" in remainingSourceBudget({ items: 11, feeds: 0 }), true);
  const mapped = mapDiscussionToItems<{ id: number; discussion?: unknown[] }>(
    [{ id: 1 }, { id: 2 }],
    [{ storyId: 2 }, { storyId: 1 }, { storyId: 2 }, { storyId: 2 }],
  );
  assert.equal(mapped[0]?.discussion?.length, 1);
  assert.equal(mapped[1]?.discussion?.length, 2);
});
