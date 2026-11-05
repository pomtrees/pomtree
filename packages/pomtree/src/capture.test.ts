import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPTURE_FAILURE_CLASSES, captureFailure } from "@pomtree/core";
import type { CaptureRecord, CaptureResponse } from "@pomtree/core";
import { CAPTURE_EXIT, captureFailureExit, isCaptureResponse } from "./capture.ts";
import { EXIT, run } from "./cli.ts";
import type { Reply } from "./client.ts";
import { MERGE_EXIT } from "./merge.ts";
import { harness as baseHarness } from "./test-kit.ts";

// An empty env so the host environment cannot leak into the CLI under test.
const harness: typeof baseHarness = (handler, extra = {}) => baseHarness(handler, { env: {}, ...extra });

const reply = (status: number, body: unknown) => () => ({ status, body }) as Reply;

const SHA = "ab12cd34ef56".padEnd(64, "0");
const capture: CaptureRecord = {
  id: "cap-1",
  predicate: {
    key: "k",
    source: "static",
    acquirer: "static",
    freshness: "daily",
    fetch: {
      requestedUrl: "https://example.com/a",
      finalUrl: "https://example.com/b",
      redirects: [{ url: "https://example.com/a", status: 301 }],
      status: 200,
      contentType: "text/html",
      headers: {},
      fetchedAt: 1,
      userAgent: "ua",
    },
    robots: null,
    worker: { agent: "w1", generation: 1, host: "h", sandbox: "s", imageDigest: "d", egressChainHead: null },
    controller: { host: "h", pomtreedVersion: "0" },
  },
  artifacts: [
    { role: "raw", mediaType: "text/html", sizeBytes: 10, sha256: SHA, report: { agent: "w1", id: "r1" } },
    { role: "text", mediaType: "text/plain", sizeBytes: 4, sha256: "99".repeat(32), report: { agent: "w1", id: "r2" } },
  ],
  envelope: null,
  timestamp: null,
  createdAt: Date.now(),
};
const ok: CaptureResponse = { outcome: { state: "ok", capture, servedFrom: "cache", ageMs: 5 }, message: null };
const pending: CaptureResponse = {
  outcome: { state: "pending", job: "cj-9" },
  message: "capture cj-9 is still running; retry with the same key or wait on the job",
};
const ROBOTS_MSG =
  'capture blocked: example.com robots.txt disallows this path for our user agent ("Disallow: /b"); do not retry or work around it; report the source as unavailable';
const failed: CaptureResponse = {
  outcome: { state: "failed", job: "cj-9", failure: captureFailure({ class: "blocked", reason: "robots", rule: "Disallow: /b" }), cached: true },
  message: ROBOTS_MSG,
};
const ARGS = ["capture", "request", "https://example.com/a", "--purpose", "read the filing"];

test("the failure exit mapping is closed, follows core's retry policy and collides with no other code", () => {
  const shared = new Set<number>([...Object.values(EXIT), ...Object.values(MERGE_EXIT), 13, 14]); // 13-14: capture verify (planned)
  for (const c of Object.values(CAPTURE_EXIT)) assert.ok(!shared.has(c), `capture exit ${c} collides`);
  const seen = new Map(CAPTURE_FAILURE_CLASSES.map((c) => [c, captureFailureExit({ class: c })]));
  assert.equal(seen.get("invalid_request"), EXIT.usage);
  assert.equal(seen.get("forbidden"), EXIT.denied);
  assert.equal(seen.get("pending_approval"), CAPTURE_EXIT.approval);
  assert.equal(seen.get("unavailable"), CAPTURE_EXIT.brokerUnavailable);
  for (const c of ["quota", "rate_limited", "upstream_error", "timeout", "capture_failed", "network"] as const)
    assert.equal(seen.get(c), CAPTURE_EXIT.retryLater, c);
  for (const c of ["denied", "blocked", "not_found", "too_large", "unsupported_type"] as const) assert.equal(seen.get(c), CAPTURE_EXIT.unavailableSource, c);
  assert.equal(captureFailureExit({ class: "network", reason: "egress_denied" }), CAPTURE_EXIT.unavailableSource);
  assert.equal(captureFailureExit({ class: "network", reason: "dns" }), CAPTURE_EXIT.retryLater);
});

test("capture request posts {request, idempotencyKey} and prints the capture on ok", async () => {
  const h = harness(reply(200, ok));
  assert.equal(await run([...ARGS, "--render", "static", "--max-age", "60000", "--key", "k1"], h.io), EXIT.ok);
  const c = h.calls[0]!;
  assert.equal(c.method, "POST");
  assert.equal(c.path, "/v1/capture");
  assert.equal(c.timeoutMs, 0);
  assert.deepEqual(c.body, { request: { url: "https://example.com/a", purpose: "read the filing", render: "static", maxAgeMs: 60000 }, idempotencyKey: "k1" });
  const o = h.out.join("\n");
  for (const re of [
    /capture cap-1/,
    /served from: cache/,
    /url: https:\/\/example\.com\/b/,
    /status: 200/,
    /content type: text\/html/,
    /raw {2}sha256:ab12cd34ef56 /,
    /text {2}sha256:999999999999 /,
  ])
    assert.match(o, re);
  assert.deepEqual(h.err, []);
});

test("capture request without --key sends a fresh key each time; --wait becomes ?waitMs=", async () => {
  const h = harness(reply(200, ok));
  await run(ARGS, h.io);
  await run([...ARGS, "--wait", "500"], h.io);
  const keys = h.calls.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
  assert.match(keys[0]!, /^[0-9a-f-]{36}$/);
  assert.notEqual(keys[0], keys[1]);
  assert.equal(h.calls[1]!.path, "/v1/capture?waitMs=500");
});

test("capture request --json prints the reply and keeps the outcome's exit code", async () => {
  const h = harness(reply(200, failed));
  assert.equal(await run([...ARGS, "--json"], h.io), CAPTURE_EXIT.unavailableSource);
  assert.deepEqual(JSON.parse(h.out[0]!), failed);
});

test("a pending capture exits 7 and says how to wait or retry with the same key", async () => {
  const h = harness(reply(200, pending));
  assert.equal(await run([...ARGS, "--key", "k2"], h.io), EXIT.timeout);
  const o = h.out.join("\n");
  assert.match(o, /pomtree capture wait cj-9/);
  assert.match(o, /--key k2/);
  assert.match(o, /cj-9 is still running/);
});

test("a failed capture prints the server's message verbatim, the class and reason, and exits by class", async () => {
  const h = harness(reply(200, failed));
  assert.equal(await run(ARGS, h.io), CAPTURE_EXIT.unavailableSource);
  const lines = h.err.join("\n").split("\n");
  assert.equal(lines[0], `pomtree: ${ROBOTS_MSG}`);
  assert.match(lines[1]!, /class blocked, reason robots, job cj-9, cached/);
  const msg = "capture of example.com/a rate limited by the site; retry after 30 s; the broker paces the whole domain until then";
  const r = harness(
    reply(200, {
      outcome: { state: "failed", job: "cj-1", failure: captureFailure({ class: "rate_limited", status: 429, retryAfterMs: 30000 }), cached: false },
      message: msg,
    }),
  );
  assert.equal(await run(ARGS, r.io), CAPTURE_EXIT.retryLater);
  assert.equal(r.err.join("\n").split("\n")[0], `pomtree: ${msg}`);
  assert.match(r.err.join("\n"), /class rate_limited, HTTP 429, retry after 30000 ms/);
});

test("capture wait polls the job route and maps every outcome", async () => {
  for (const [body, code] of [
    [ok, EXIT.ok],
    [pending, EXIT.timeout],
    [failed, CAPTURE_EXIT.unavailableSource],
  ] as const) {
    const h = harness(reply(200, body));
    assert.equal(await run(["capture", "wait", "cj-9", "--wait", "1000"], h.io), code);
    assert.deepEqual(h.calls[0], { method: "GET", path: "/v1/capture/jobs/cj-9?waitMs=1000", body: undefined, timeoutMs: 0 });
  }
  const h = harness(reply(200, failed));
  await run(["capture", "wait", "cj-9"], h.io);
  assert.equal(h.calls[0]!.path, "/v1/capture/jobs/cj-9");
  assert.equal(h.err[0]!.split("\n")[0], `pomtree: ${ROBOTS_MSG}`);
});

test("capture show and ls print the record and the table", async () => {
  const s = harness(reply(200, { capture }));
  assert.equal(await run(["capture", "show", "cap-1"], s.io), EXIT.ok);
  assert.equal(s.calls[0]!.path, "/v1/capture/cap-1");
  assert.match(s.out.join("\n"), /capture cap-1\nsource: static\nurl: https:\/\/example\.com\/b\nstatus: 200/);
  const sj = harness(reply(200, { capture }));
  await run(["capture", "show", "cap-1", "--json"], sj.io);
  assert.deepEqual(JSON.parse(sj.out[0]!), { capture });
  const l = harness(reply(200, { captures: [capture] }));
  assert.equal(await run(["capture", "ls", "--limit", "5"], l.io), EXIT.ok);
  assert.equal(l.calls[0]!.path, "/v1/capture?limit=5");
  assert.match(l.out[0]!, /^ID\s+SOURCE\s+STATUS\s+TYPE\s+AGE\s+URL\ncap-1\s+static\s+200\s+text\/html\s+\d+s\s+https:\/\/example\.com\/b$/);
  const e = harness(reply(200, { captures: [] }));
  await run(["capture", "ls"], e.io);
  assert.equal(e.calls[0]!.path, "/v1/capture");
  assert.deepEqual(e.out, ["no captures"]);
});

test("HTTP 404 from any capture route exits 3 with the daemon's error", async () => {
  for (const argv of [["capture", "show", "cap-x"], ["capture", "wait", "cj-x"], ARGS, ["capture", "ls"]]) {
    const h = harness(reply(404, { error: "no such capture" }));
    assert.equal(await run(argv, h.io), EXIT.notFound, argv.join(" "));
    assert.match(h.err.join("\n"), /no such capture/);
  }
});

test("an unexpected capture reply is a plain error", async () => {
  const h = harness(reply(200, { outcome: { state: "weird" } }));
  assert.equal(await run(ARGS, h.io), EXIT.error);
  assert.match(h.err.join("\n"), /unexpected capture reply/);
  assert.equal(isCaptureResponse(ok), true);
  assert.equal(isCaptureResponse({ outcome: { state: "ok", capture: {} }, message: null }), false);
});

test("usage errors exit 2 without calling the daemon and name the flag", async () => {
  const cases: [string[], RegExp][] = [
    [["capture"], /capture needs a subcommand/],
    [["capture", "frob"], /unknown capture command: frob/],
    [["capture", "request", "--purpose", "p"], /needs a URL/],
    [["capture", "request", "https://example.com/"], /needs --purpose/],
    [["capture", "request", "https://example.com/", "--purpose", "   "], /needs --purpose/],
    [["capture", "request", "https://example.com/", "--purpose", "x".repeat(201)], /--purpose is longer than 200/],
    [[...ARGS, "--render", "fast"], /--render must be one of auto\|static\|browser, got "fast"/],
    [[...ARGS, "--max-age", "1.5"], /--max-age must be a non-negative integer/],
    [[...ARGS, "--max-age", "-1"], /--max-age must be a non-negative integer/],
    [[...ARGS, "--wait", "soon"], /--wait must be a non-negative integer/],
    [["capture", "wait"], /capture wait needs a job id/],
    [["capture", "show"], /capture show needs a capture id/],
    [["capture", "ls", "--limit", "x"], /--limit must be a non-negative integer/],
    [[...ARGS, "--purpose"], /--purpose needs a value/],
  ];
  for (const [argv, re] of cases) {
    const h = harness(reply(200, ok));
    assert.equal(await run(argv, h.io), EXIT.usage, argv.join(" "));
    assert.match(h.err.join("\n"), re, argv.join(" "));
    assert.equal(h.calls.length, 0, argv.join(" "));
  }
  const h = harness(reply(200, ok));
  await run(["capture"], h.io);
  assert.match(h.err.join("\n"), /usage: pomtree capture request URL[\s\S]*pomtree capture ls/);
});

test("help lists the capture verbs and the 15-18 exit legend", async () => {
  const h = harness(reply(200, ok));
  await run(["--help"], h.io);
  const u = h.out.join("\n");
  assert.match(u, /^ {2}capture request URL --purpose TEXT/m);
  assert.match(u, /^ {2}capture wait JOB/m);
  assert.match(u, /pomtree capture adds 15-18/);
});
