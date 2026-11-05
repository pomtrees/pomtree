// The creating requester's per-call limits (CaptureRequestOptions.takeRequest and maxBytes): a hop past the budget is never sent, a
// joiner is never charged, and neither refusal is negatively cached for other requesters. FakeOrigin behind the test fetch seam.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaptureResponse } from "@pomtree/core";
import { agent, harness, req } from "./test-harness.ts";

const page = { status: 200, headers: { "content-type": "text/html" }, body: "<p>ok</p>" };
const to = (location: string) => ({ status: 302, headers: { location } });
const budget = (n: number) => {
  const b = { left: n, taken: 0 };
  const take = (): boolean => {
    if (b.left === 0) return false;
    b.left--;
    b.taken++;
    return true;
  };
  return { b, take };
};
const failure = (r: CaptureResponse) => (r.outcome.state === "failed" ? `${r.outcome.failure.class}/${r.outcome.failure.reason ?? ""}` : r.outcome.state);

test("a redirect chain longer than the remaining budget sends exactly the budget's worth of requests; nothing is negatively cached", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  h.origin.robots("example.com", "").route("example.com", "/a", to("/b")).route("example.com", "/b", to("/c")).route("example.com", "/c", page);
  const { b, take } = budget(2);
  const r = await h.broker.request(agent(), req("https://example.com/a"), "k1", { takeRequest: take });
  assert.equal(failure(r), "quota/requests");
  assert.equal(b.taken, 2);
  const sent = h.origin.requests.filter((x) => x.path !== "/robots.txt").map((x) => x.path);
  assert.deepEqual(sent, ["/a", "/b"], "the third hop was never sent");
  const key = r.outcome.state === "failed" ? (await h.index.job(r.outcome.job))?.key : undefined;
  assert.ok(key !== undefined);
  assert.equal(await h.index.negative(key, h.clock.t), null, "a budget refusal is the requester's own: not negatively cached");
  // Another requester with no budget reads the chain: the refusal was the first requester's own.
  const ok = await h.broker.request(agent(), req("https://example.com/a"), "k2");
  assert.equal(ok.outcome.state, "ok", JSON.stringify(ok));
});

test("a joined second requester is not charged: only the job's creator takes from its budget", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  h.origin.robots("example.com", "").route("example.com", "/slow", { ...page, delayMs: 150 });
  const first = budget(5);
  const second = budget(5);
  const [r1, r2] = await Promise.all([
    h.broker.request(agent(), req("https://example.com/slow"), "k1", { takeRequest: first.take }),
    h.broker.request(agent(), req("https://example.com/slow"), "k2", { takeRequest: second.take }),
  ]);
  assert.equal(r1.outcome.state, "ok");
  assert.equal(r2.outcome.state, "ok");
  assert.equal(first.b.taken, 1);
  assert.equal(second.b.taken, 0, "the joiner shared the creator's run");
  assert.equal(h.origin.requestsFor("example.com", "/slow").length, 1);
  // A cache hit charges nothing either.
  const third = budget(5);
  const r3 = await h.broker.request(agent(), req("https://example.com/slow"), "k3", { takeRequest: third.take });
  assert.equal(r3.outcome.state === "ok" && r3.outcome.servedFrom, "cache");
  assert.equal(third.b.taken, 0);
});

test("a per-call maxBytes stops the body read at the cap; the too_large is not served to a requester without the cap", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  h.origin.robots("example.com", "").route("example.com", "/big", { status: 200, headers: { "content-type": "text/html" }, body: "x".repeat(5000) });
  const capped = await h.broker.request(agent(), req("https://example.com/big"), "k1", { maxBytes: 100 });
  assert.equal(failure(capped), "too_large/");
  assert.equal(capped.message, "capture of example.com/big exceeds 100 bytes; request a more specific page");
  const full = await h.broker.request(agent(), req("https://example.com/big"), "k2");
  assert.equal(full.outcome.state === "ok" && full.outcome.servedFrom, "static");
});
