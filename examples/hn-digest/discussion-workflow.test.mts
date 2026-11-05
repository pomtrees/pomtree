import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { JsonValue, WorkflowFetchResult, WorkflowRunContext } from "../../packages/core/src/index.ts";
import { type DiscussionSample, sourceUrlOf } from "./discussion.mts";
import { type DiscussionInput, discussionWorkflow, FETCH_MAX_REQUESTS, validateDiscussionInput } from "./discussion-workflow.mts";

const FIXTURES = new URL("./discussion-fixtures/", import.meta.url);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const FETCHED_AT = 1_700_000_500_000;
const STORY_A = { id: 100, sha256: sha("story-a"), kids: [201, 203] };
const STORY_B = { id: 200, sha256: sha("story-b"), kids: [204, 205] };
const BATCH: DiscussionInput = { instance: "hn-disc", stories: [STORY_A, STORY_B] };

// Fixture body for a comment ID; unknown IDs answer 404 so tests never touch the network.
function fixtureBody(id: number): string | null {
  const name = readdirSync(FIXTURES).find((f) => f.startsWith(`comment_${id}_`));
  return name === undefined ? null : readFileSync(new URL(name, FIXTURES), "utf8");
}

type Reply = { status: number; body: string } | { error: "network" | "timeout" };
type World = {
  cell: JsonValue | null;
  writes: Map<string, JsonValue>;
  results: Map<string, unknown>;
  urls: string[];
  respond: (id: number) => Reply;
  crashOnce: Set<number>;
};

function world(respond: (id: number) => Reply = defaultReply): World {
  return { cell: null, writes: new Map(), results: new Map(), urls: [], respond, crashOnce: new Set() };
}

function defaultReply(id: number): Reply {
  const body = fixtureBody(id);
  return body === null ? { status: 404, body: "{}" } : { status: 200, body };
}

// Scripted facade for one task launch. Only state, fetch and submitResult are provided; every other op throws.
function task(w: World, input: DiscussionInput, runKey: string, abort?: AbortController) {
  const ac = abort ?? new AbortController();
  const workflow = {
    instance: input.instance,
    runKey,
    async getState() {
      return w.cell;
    },
    async setState(value: JsonValue, key: string) {
      if (w.writes.has(key)) return; // host replay: same key returns the original
      w.writes.set(key, value);
      w.cell = value;
    },
    async fetch(url: string): Promise<WorkflowFetchResult> {
      const m = /\/item\/(\d+)\.json$/.exec(url);
      if (m === null) throw new Error("unexpected url");
      const id = Number(m[1]);
      if (w.urls.length >= FETCH_MAX_REQUESTS) throw new Error("fetch budget exceeded");
      w.urls.push(url);
      if (w.crashOnce.has(id)) {
        w.crashOnce.delete(id);
        ac.abort();
        throw new Error("task crashed mid-fetch");
      }
      const r = w.respond(id);
      if ("error" in r) throw new Error(r.error === "timeout" ? "request timed out" : "socket hang up");
      return { url, status: r.status, body: r.body, fetchedAt: FETCHED_AT, sha256: sha(r.body) };
    },
    publishReport() {
      throw new Error("not declared");
    },
    sendToUser() {
      throw new Error("not declared");
    },
    ask() {
      throw new Error("not declared");
    },
  };
  const unexpected = (name: string) => () => {
    throw new Error(`op ${name} is not reachable from capture`);
  };
  const ops = {
    peek: unexpected("peek"),
    ack: unexpected("ack"),
    message: unexpected("message"),
    spawn: unexpected("spawn"),
    reap: unexpected("reap"),
    async submitResult(result: unknown, key: string) {
      if (!w.results.has(key)) w.results.set(key, result);
    },
  };
  // Only test scaffolding is cast: the real context carries more identity fields than the facade needs.
  return {
    run: () =>
      discussionWorkflow.run({
        agent: "agent-capture",
        generation: 1,
        host: "host-test",
        input: input as unknown as JsonValue,
        signal: ac.signal,
        deadlineAt: null,
        ops,
        workflow,
      } as unknown as WorkflowRunContext & { input: DiscussionInput }),
  };
}

type Result = { summary: string; stories: unknown; samples: DiscussionSample[]; runId: string };
const resultOf = (w: World, key: string): Result => w.results.get(key) as Result;

describe("validateDiscussionInput", () => {
  it("normalizes kids to two unique IDs per story in display order", () => {
    const r = validateDiscussionInput({ instance: "hn-disc", stories: [{ id: 1, sha256: sha("a"), kids: [9, 3, 9, 4] }] });
    assert.ok(r.ok);
    assert.deepEqual(r.value.stories[0]?.kids, [9, 3]);
  });
  it("rejects bad instance, story counts, duplicates, hashes and oversized kids", () => {
    const st = (over: object) => ({ id: 1, sha256: sha("a"), kids: [2], ...over });
    assert.equal(validateDiscussionInput({ instance: "Bad Name", stories: [st({})] }).ok, false);
    assert.equal(validateDiscussionInput({ instance: "ok", stories: [] }).ok, false);
    assert.equal(validateDiscussionInput({ instance: "ok", stories: [st({ id: 1 }), st({ id: 2 }), st({ id: 3 }), st({ id: 4 })] }).ok, false);
    assert.equal(validateDiscussionInput({ instance: "ok", stories: [st({}), st({})] }).ok, false);
    assert.equal(validateDiscussionInput({ instance: "ok", stories: [st({ sha256: "xyz" })] }).ok, false);
    assert.equal(validateDiscussionInput({ instance: "ok", stories: [st({ kids: Array.from({ length: 501 }, (_, i) => i + 1) })] }).ok, false);
    assert.equal(validateDiscussionInput({ instance: "ok", stories: [st({ id: 1, kids: [7] }), st({ id: 2, kids: [7] })] }).ok, false);
  });
});

describe("capture workflow", () => {
  it("declares only state and a fetch to the official HN host", () => {
    assert.deepEqual(Object.keys(discussionWorkflow.capabilities ?? {}).sort(), ["fetch", "state"]);
    assert.deepEqual(discussionWorkflow.capabilities?.fetch, {
      hosts: ["hacker-news.firebaseio.com"],
      maxRequests: 6,
      maxBytes: 262144,
      timeoutMs: 10000,
    });
  });

  it("fetches exactly the depth-1 item URLs, in order, and persists the plan before any GET", async () => {
    const w = world();
    await task(w, BATCH, "run-1").run();
    assert.deepEqual(w.urls, [201, 203, 204, 205].map(sourceUrlOf));
    const first = [...w.writes.values()][0] as { comments: Array<{ sample: unknown }>; phase: string };
    assert.equal(first.phase, "capturing");
    assert.ok(first.comments.every((c) => c.sample === null));
    assert.equal([...w.writes.keys()][0], "run-1:state:1");
  });

  it("classifies each sampled comment and submits a sample-only result without author fields", async () => {
    const w = world();
    await task(w, BATCH, "run-2").run();
    const r = resultOf(w, "run-2:result");
    assert.ok(r);
    assert.deepEqual(
      r.samples.map((s) => [s.id, s.status]),
      [
        [201, "usable"],
        [203, "deleted"],
        [204, "dead"],
        [205, "wrong_parent"],
      ],
    );
    assert.match(r.summary, /captured sample only, not representative/);
    assert.equal(r.runId, "run-2");
    assert.equal(JSON.stringify(r).includes('"by"'), false);
    assert.equal(r.samples[0]?.sourceUrl, sourceUrlOf(201));
    assert.equal(r.samples[0]?.sha256, sha(fixtureBody(201) ?? ""));
    assert.equal(r.samples[0]?.fetchedAt, FETCHED_AT);
  });

  it("records network, timeout, HTTP and malformed-JSON failures without retrying", async () => {
    const w = world((id) => {
      if (id === 201) return { error: "network" };
      if (id === 203) return { error: "timeout" };
      if (id === 204) return { status: 500, body: "oops" };
      return { status: 200, body: "{not json" };
    });
    await task(w, BATCH, "run-3").run();
    assert.equal(w.urls.length, 4);
    const r = resultOf(w, "run-3:result");
    assert.deepEqual(
      r.samples.map((s) => [s.id, s.status]),
      [
        [201, "unavailable"],
        [203, "unavailable"],
        [204, "unavailable"],
        [205, "malformed"],
      ],
    );
  });

  it("refuses a different batch on the same instance before any network effect", async () => {
    const w = world();
    await task(w, BATCH, "run-4").run();
    const before = w.urls.length;
    const other = { instance: "hn-disc", stories: [{ ...STORY_A, kids: [201] }] };
    await assert.rejects(task(w, other, "run-5").run(), /different capture batch/);
    assert.equal(w.urls.length, before);
  });

  it("a complete instance is sticky: a repair replays the result with no new GET", async () => {
    const w = world();
    await task(w, BATCH, "run-6").run();
    const before = w.urls.length;
    await task(w, BATCH, "run-7").run();
    assert.equal(w.urls.length, before);
    assert.equal(w.results.size, 1);
    assert.ok(w.results.has("run-6:result"));
  });

  it("crash after the attempt marker: repair keeps the interrupted sample and never refetches it", async () => {
    const w = world();
    w.crashOnce.add(203);
    const ac = new AbortController();
    await assert.rejects(task(w, BATCH, "run-8", ac).run(), /crashed/);
    assert.equal(w.results.size, 0);
    await task(w, BATCH, "run-9").run();
    assert.equal(w.urls.filter((u) => u === sourceUrlOf(203)).length, 1);
    assert.equal(w.urls.length, 4);
    const r = resultOf(w, "run-8:result");
    assert.ok(r);
    assert.deepEqual(
      r.samples.map((s) => [s.id, s.status]),
      [
        [201, "usable"],
        [203, "interrupted"],
        [204, "dead"],
        [205, "wrong_parent"],
      ],
    );
    assert.equal(r.runId, "run-8");
    assert.equal(w.results.has("run-9:result"), false);
  });

  it("uses the persisted run id and reads each ID under a per-sequence key", async () => {
    const w = world();
    await task(w, BATCH, "run-10").run();
    const keys = [...w.writes.keys()];
    assert.equal(
      keys.every((k) => k.startsWith("run-10:state:")),
      true,
    );
    assert.equal(new Set(keys).size, keys.length);
  });

  it("six comments across three stories use exactly the hard maximum, and a repair adds no GET", async () => {
    const w = world();
    const three: DiscussionInput = {
      instance: "hn-three",
      stories: [
        { id: 100, sha256: sha("a"), kids: [201, 202] },
        { id: 200, sha256: sha("b"), kids: [204, 205] },
        { id: 300, sha256: sha("c"), kids: [207, 208] },
      ],
    };
    await task(w, three, "run-11").run();
    assert.equal(w.urls.length, 6);
    await task(w, three, "run-12").run();
    assert.equal(w.urls.length, 6);
  });

  it("a story with no kids completes with an empty sample set and no GET", async () => {
    const w = world();
    await task(w, { instance: "hn-empty", stories: [{ id: 5, sha256: sha("e"), kids: [] }] }, "run-13").run();
    assert.equal(w.urls.length, 0);
    assert.deepEqual(resultOf(w, "run-13:result").samples, []);
  });
});
