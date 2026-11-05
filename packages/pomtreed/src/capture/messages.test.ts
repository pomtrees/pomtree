// The failure table: every failure class and reason the broker can produce in S1, driven through a fake
// origin or a named seam, with BOTH messages asserted exactly. The model text comes back in CaptureResponse.message; the operator
// text goes to the log. Classes no origin can produce use a seam, named in the test: the index (FakeCaptureIndex.errors), the
// parser (FakeCaptureParser.script), the quota (a limit of 1), the DNS resolver and the transport (a TLS error).
// Not producible in S1: quota/queue (no broker queue yet) and unavailable/signer (signing is S3).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { CaptureResponse } from "@pomtree/core";
import { CaptureParserError } from "./process-parser.ts";
import { AGENT, agent, harness, req } from "./test-harness.ts";
import type { CaptureScope } from "./types.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const page = { status: 200, headers: { "content-type": "text/html" }, body: "<p>x</p>" };

// The job the response names, the model text, and the operator line logged for that job.
function messages(h: { logs: string[] }, r: CaptureResponse): { job: string; model: string; operator: string } {
  assert.equal(r.outcome.state, "failed", JSON.stringify(r.outcome));
  const job = (r.outcome as { job: string }).job;
  const operator = h.logs.filter((l) => l.startsWith(`capture ${job}`)).at(-1);
  assert.ok(operator !== undefined, `no operator line for ${job}: ${JSON.stringify(h.logs)}`);
  return { job, model: r.message ?? "", operator };
}

async function expect(
  setup: Parameters<typeof harness>[0],
  route: (h: Awaited<ReturnType<typeof harness>>) => void,
  url: string,
  want: (job: string, h: Awaited<ReturnType<typeof harness>>) => { cls: string; reason?: string; model: string; operator: string },
  opts: {
    requester?: Parameters<Awaited<ReturnType<typeof harness>>["broker"]["request"]>[0];
    extra?: Record<string, unknown>;
    before?: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>;
  } = {},
): Promise<void> {
  const h = await harness(setup);
  try {
    route(h);
    await opts.before?.(h);
    const r = await h.broker.request(opts.requester ?? agent(), req(url, opts.extra), "k-msg");
    const m = messages(h, r);
    const w = want(m.job, h);
    const f = (r.outcome as { failure: { class: string; reason?: string } }).failure;
    assert.equal(f.class, w.cls);
    assert.equal(f.reason, w.reason);
    assert.equal(m.model, w.model);
    assert.equal(m.operator, w.operator);
  } finally {
    await h.close();
  }
}

const robotsOk = (h: Awaited<ReturnType<typeof harness>>) => h.origin.robots("example.com", "").waybackAvailability(null);

test("invalid_request: not a public http(s) URL", () =>
  expect(
    {},
    () => {},
    "ftp://example.com/x",
    (j) => ({
      cls: "invalid_request",
      model: "capture refused: example.com/x is not a public http(s) URL; fix the URL",
      operator: `capture ${j} refused for ${AGENT}: invalid url (scheme ftp is not http or https)`,
    }),
  ));

test("forbidden: a browser render (S1 has no browser rung)", () =>
  expect(
    {},
    () => {},
    "https://example.com/a/b",
    (j) => ({
      cls: "forbidden",
      model: "capture refused: this agent may not request browser captures; ask your parent",
      operator: `capture ${j}: ${AGENT} gen 1 lacks render browser (template ?)`,
    }),
    { extra: { render: "browser" } },
  ));

test("forbidden: a stale generation", () =>
  expect(
    {},
    (h) => h.generations.set(AGENT, 3),
    "https://example.com/a/b",
    (j) => ({
      cls: "forbidden",
      model: "capture refused: this agent may not request auto captures; ask your parent",
      operator: `capture ${j}: ${AGENT} gen 1 lacks the current generation (3) (template ?)`,
    }),
  ));

const outOfScope = (approve: CaptureScope["approve"]): CaptureScope => ({ allows: () => false, ...(approve && { approve }) });

test("pending_approval: a host outside the scope with its approval open", () =>
  expect(
    { scope: outOfScope(async () => ({ state: "pending", approval: "ap-1" })) },
    () => {},
    "https://example.com/a/b",
    (j) => ({
      cls: "pending_approval",
      model: "capture of example.com/a/b awaits approval ap-1; retry with the same key or yield",
      operator: `capture ${j}: approval ap-1 open for host example.com requested by ${AGENT}`,
    }),
  ));

test("denied: that approval timed out", () =>
  expect(
    { scope: outOfScope(async () => ({ state: "denied", approval: "ap-2", decision: "timed out" })) },
    () => {},
    "https://example.com/a/b",
    (j) => ({
      cls: "denied",
      model: "capture of example.com/a/b denied (approval ap-2); choose another source",
      operator: `capture ${j}: approval ap-2 timed out at rung admission`,
    }),
  ));

test("quota: the requester's capture.requests are exhausted (seam: a limit of 1)", () =>
  expect(
    { config: { quota: { requests: 1, windowMs: 3_600_000 } } },
    (h) => {
      robotsOk(h);
      h.origin.route("example.com", "/a/b", page);
      h.clock.t = 10 * 3_600_000 + 1000;
    },
    "https://example.com/a/b",
    (j) => ({
      cls: "quota",
      reason: "requests",
      model: "capture quota exhausted (1/1 per 1 h); retry after 3599 s or reuse a cached capture",
      operator: `capture ${j}: ${AGENT} quota 1/1; queue depth 0`,
    }),
    { before: async (h) => void (await h.broker.request(agent(), req("https://example.com/a/b"), "k-first")) },
  ));

test("blocked/robots: our token is disallowed", () =>
  expect(
    {},
    (h) => h.origin.robots("example.com", "User-agent: pomtree-test\nDisallow: /a\n"),
    "https://example.com/a/b",
    (j) => ({
      cls: "blocked",
      reason: "robots",
      model:
        'capture blocked: example.com robots.txt disallows this path for our user agent ("Disallow: /a"); do not retry or work around it; report the source as unavailable',
      operator: `capture ${j} blocked by robots: https://example.com/robots.txt sha256 ${sha("User-agent: pomtree-test\nDisallow: /a\n")} rule "Disallow: /a" tokens pomtree-test,Claude-User`,
    }),
  ));

test("blocked/challenge: a bot-challenge header", () =>
  expect(
    {},
    (h) => {
      robotsOk(h);
      h.origin.route("example.com", "/a/b", { status: 403, headers: { "cf-mitigated": "challenge" } });
    },
    "https://example.com/a/b",
    (j) => ({
      cls: "blocked",
      reason: "challenge",
      model: "capture blocked: example.com served a bot challenge; it is not solved or bypassed; report the source as unavailable",
      operator: `capture ${j} blocked: challenge marker cf-mitigated: challenge at example.com/a/b; screenshot report none`,
    }),
  ));

test("blocked/refused: HTTP 403", () =>
  expect(
    {},
    (h) => {
      robotsOk(h);
      h.origin.route("example.com", "/a/b", { status: 403 });
    },
    "https://example.com/a/b",
    (j) => ({
      cls: "blocked",
      reason: "refused",
      model: "capture blocked: example.com refused the request (HTTP 403); do not retry; report the source as unavailable",
      operator: `capture ${j} blocked: HTTP 403 from example.com/a/b after 0 hops`,
    }),
  ));

test("blocked/policy: the operator denylist", () =>
  expect(
    { config: { denylist: ["example.com"] } },
    () => {},
    "https://www.example.com/a/b",
    (j) => ({
      cls: "blocked",
      reason: "policy",
      model: "capture blocked by operator policy for www.example.com; choose another source",
      operator: `capture ${j}: www.example.com matches denylist entry example.com`,
    }),
  ));

test("rate_limited: HTTP 429 with Retry-After", () =>
  expect(
    {},
    (h) => {
      robotsOk(h);
      h.origin.route("example.com", "/a/b", { status: 429, headers: { "retry-after": "120" } });
    },
    "https://example.com/a/b",
    (j, h) => ({
      cls: "rate_limited",
      model: "capture of example.com/a/b rate limited by the site; retry after 2 min; the broker paces the whole domain until then",
      operator: `capture ${j}: 429 from example.com, Retry-After 2 min; domain paused until ${new Date(h.clock.t + 120_000).toISOString()}`,
    }),
  ));

test("not_found: HTTP 404, with no archived copy", () =>
  expect(
    {},
    (h) => {
      robotsOk(h);
      h.origin.route("example.com", "/a/b", { status: 404 });
    },
    "https://example.com/a/b",
    (j) => ({
      cls: "not_found",
      model: "capture of example.com/a/b not found (HTTP 404); no archived copy",
      operator: `capture ${j}: HTTP 404; wayback none`,
    }),
  ));

test("upstream_error/http: HTTP 500 (retried once)", () =>
  expect(
    {},
    (h) => {
      robotsOk(h);
      h.origin.route("example.com", "/a/b", { status: 500 });
    },
    "https://example.com/a/b",
    (j) => ({
      cls: "upstream_error",
      reason: "http",
      model: "capture of example.com/a/b failed: the site returned an error (500); retry later or choose another source",
      operator: `capture ${j}: upstream 500 at hop 0`,
    }),
  ));

test("upstream_error/reset: the connection is reset", () =>
  expect(
    {},
    (h) => {
      robotsOk(h);
      h.origin.route("example.com", "/a/b", { reset: true });
    },
    "https://example.com/a/b",
    (j) => ({
      cls: "upstream_error",
      reason: "reset",
      model: "capture of example.com/a/b failed: the site returned an error (reset); retry later or choose another source",
      operator: `capture ${j}: upstream reset at hop 0`,
    }),
  ));

test("timeout/first_byte: the origin never answers", () =>
  expect(
    { config: { timeoutMs: 150 } },
    (h) => {
      robotsOk(h);
      h.origin.route("example.com", "/a/b", { hang: true });
    },
    "https://example.com/a/b",
    (j) => ({
      cls: "timeout",
      reason: "first_byte",
      model: "capture of example.com/a/b timed out after 150 ms; retry later or choose another source",
      operator: `capture ${j}: first_byte timeout 150 ms at rung static`,
    }),
  ));

test("network/dns: the name does not resolve (seam: the resolver)", () =>
  expect(
    {},
    (h) => robotsOk(h),
    "https://nx.example.net/a",
    (j) => ({
      cls: "network",
      reason: "dns",
      model: "capture of nx.example.net/a failed: the host name did not resolve; retry later or choose another source",
      operator: `capture ${j}: network dns; host nx.example.net`,
    }),
  ));

test("network/tls: the TLS handshake fails (seam: the transport)", () =>
  expect(
    {
      fetch: (base) => async (url, init) => {
        if (new URL(url).hostname === "tls.example.com")
          throw Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
        return base(url, init);
      },
    },
    (h) => robotsOk(h),
    "https://tls.example.com/a",
    (j) => ({
      cls: "network",
      reason: "tls",
      model: "capture of tls.example.com/a failed: TLS failed; retry later or choose another source",
      operator: `capture ${j}: network tls; host tls.example.com`,
    }),
  ));

test("network/robots_unreachable: robots.txt answers 503", () =>
  expect(
    {},
    (h) => {
      h.origin.robots("example.com", { status: 503 }).waybackAvailability(null).route("example.com", "/a/b", page);
    },
    "https://example.com/a/b",
    (j) => ({
      cls: "network",
      reason: "robots_unreachable",
      model: "capture of example.com/a/b failed: the site's robots.txt could not be read, so the site was not contacted; retry later or choose another source",
      operator: `capture ${j}: network robots_unreachable; https://example.com/robots.txt status 503`,
    }),
  ));

test("network/egress_denied: the name resolves to a private address (seam: the resolver)", () =>
  expect(
    { dns: { "internal.example.net": "10.0.0.5" } },
    () => {},
    "https://internal.example.net/a",
    (j) => ({
      cls: "network",
      reason: "egress_denied",
      model: "capture of internal.example.net/a failed: the egress policy blocks this host; choose another source",
      operator: `capture ${j}: network egress_denied; egress row internal.example.net resolves to a blocked address`,
    }),
  ));

test("too_large: the body exceeds capture.maxBytes", () =>
  expect(
    { config: { maxBytes: 1024 } },
    (h) => {
      robotsOk(h);
      h.origin.route("example.com", "/a/b", { status: 200, headers: { "content-type": "text/plain" }, body: "x".repeat(1500) });
    },
    "https://example.com/a/b",
    (j) => ({
      cls: "too_large",
      model: "capture of example.com/a/b exceeds 1024 bytes; request a more specific page",
      operator: `capture ${j}: 1500 > cap 1024 (capture.maxBytes)`,
    }),
  ));

test("unsupported_type: a video", () =>
  expect(
    {},
    (h) => {
      robotsOk(h);
      h.origin.route("example.com", "/a/b", { status: 200, headers: { "content-type": "video/mp4" }, body: "x" });
    },
    "https://example.com/a/b",
    (j) => ({
      cls: "unsupported_type",
      model: "capture of example.com/a/b returned video/mp4, which is not supported; choose another source",
      operator: `capture ${j}: content type video/mp4 refused by static`,
    }),
  ));

test("capture_failed: the parser process crashes (seam: the parser; L1 settles a parser failure as capture_failed)", () =>
  expect(
    {},
    (h) => {
      h.origin.robots("example.com", "User-agent: *\nAllow: /\n").waybackAvailability(null).route("example.com", "/a/b", page);
      const crash = { reject: new CaptureParserError("capture parser exited with code 3", "killed") };
      h.parser.script = [crash, crash];
    },
    "https://example.com/a/b",
    (j) => ({
      cls: "capture_failed",
      reason: "killed",
      model: "capture of example.com/a/b failed in the browser (killed); retry once later",
      operator: `capture ${j}: worker ${AGENT} gen 1 cause killed; sandbox ?; logs ?`,
    }),
  ));

test("unavailable/index: the capture index fails (seam: FakeCaptureIndex.errors)", () =>
  expect(
    {},
    (h) => {
      robotsOk(h);
      h.index.errors = [new Error("disk I/O error")];
    },
    "https://example.com/a/b",
    (j) => ({
      cls: "unavailable",
      reason: "index",
      model: "capture unavailable: the broker cannot run (index); report this to the operator and do not retry",
      operator: `capture ${j}: broker unavailable: index; fix the capture index store`,
    }),
  ));

test("a cached negative answer renders the same model text and sends nothing upstream", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  robotsOk(h);
  h.origin.route("example.com", "/a/b", { status: 404 });
  const first = await h.broker.request(agent(), req("https://example.com/a/b"), "k1");
  const n = h.origin.requests.length;
  const again = await h.broker.request(agent(), req("https://example.com/a/b"), "k2");
  assert.equal((again.outcome as { cached: boolean }).cached, true);
  assert.equal(again.message, first.message);
  assert.equal(h.origin.requests.length, n);
});
