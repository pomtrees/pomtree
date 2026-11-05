import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureFailureDiagnostic, diagnosticSinkLine } from "../../packages/agent-image/ext/pomtree-browser/capture-diagnostic.ts";
import type { JournalPayload } from "../../packages/core/src/index.ts";
import { normalize } from "../../packages/harness-pi/src/index.ts";
import {
  WORKER_ITEMS_MAX,
  WORKER_NAVIGATION_MAX,
  WORKER_TEXT_MAX,
  workerEvidenceOf,
  workerFailureOf,
  workerSummaryOf,
  workerText,
} from "./content-live-workers.mts";

const agent = { id: "agent-1", generation: 2, exit: "failed", exitCause: "signal" };
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const base = { storyId: 7, agent, reports: [], env: {} as Record<string, string | undefined> };

describe("workerEvidenceOf", () => {
  const payloads: JournalPayload[] = [
    { kind: "tool_call", tool: "browser_capture", callId: "c1", input: { url: "https://example.com/secret/path?token=abc" } },
    { kind: "tool_result", callId: "c1", ok: false, output: "trusted browser capture failed; pomtree exit 1 (cause=publish_failed)" },
    { kind: "error", message: "oops at /home/user/.cache/x/y.js with https://example.com/a/b?k=v and Bearer abc123" },
  ];

  it("keeps the exit, closed exit cause, tool errors and harness errors, without the call input", () => {
    const w = workerEvidenceOf({ ...base, payloads });
    assert.deepEqual([w.storyId, w.child, w.generation, w.exit, w.exitCause], [7, "agent-1", 2, "failed", "signal"]);
    assert.deepEqual(w.tools, [
      { tool: "browser_capture", ok: false, output: "trusted browser capture failed; pomtree exit 1 (cause=publish_failed)", outputBytes: 69 },
    ]);
    assert.ok(!JSON.stringify(w).includes("token=abc"));
    assert.deepEqual(workerSummaryOf(w), {
      exit: "failed",
      exitCause: "signal",
      failure: w.tools[0]?.output,
      captureCause: "publish_failed",
      captureReason: null,
    });
  });

  it("redacts URLs to their origin, host paths, bearer tokens and environment values, and bounds text and counts", () => {
    const w = workerEvidenceOf({ ...base, payloads, env: { TOKEN: "supersecretvalue" } });
    const err = w.errors[0] ?? "";
    assert.ok(!err.includes("/home/user") && !err.includes("k=v") && !err.includes("abc123"), err);
    assert.match(err, /\[path\]/);
    assert.equal(workerText("a secret supersecretvalue here", { TOKEN: "supersecretvalue" }), "a secret [redacted-env] here");
    assert.ok(Array.from(workerText("x".repeat(5000), {})).length <= WORKER_TEXT_MAX + 3);
    const many: JournalPayload[] = Array.from({ length: 100 }, (_, i) => ({ kind: "error", message: `e${i}` }));
    assert.equal(workerEvidenceOf({ ...base, payloads: many }).errors.length, WORKER_ITEMS_MAX);
  });

  it("marks a call that never returned and a worker with no journal rows", () => {
    const w = workerEvidenceOf({ ...base, payloads: [payloads[0] as JournalPayload] });
    assert.deepEqual(w.tools, [{ tool: "browser_capture", ok: null, output: "", outputBytes: null }]);
    const none = workerEvidenceOf({ ...base, agent: { id: "a", generation: 1, exit: null }, payloads: [] });
    assert.deepEqual([none.tools, none.errors, none.exit, none.exitCause, none.navigation, none.navigationNote], [[], [], null, null, null, "none published"]);
    assert.equal(workerSummaryOf(none).failure, null);
  });

  it("includes a published navigation log with its URLs reduced, and degrades without inventing one", () => {
    const log = { kind: "browser-navigation", finalUrl: "https://example.com/a/b?q=1", limitations: ["ok"] };
    const nav = { name: "browser-navigation", mediaType: "application/json", sizeBytes: 10, sha256: "a".repeat(64) };
    const w = workerEvidenceOf({ ...base, payloads: [], reports: [{ ...nav, content: bytes(log) }] });
    assert.equal(w.navigationNote, null);
    assert.ok(!JSON.stringify(w.navigation).includes("q=1") && !JSON.stringify(w.navigation).includes("/a/b"));
    assert.deepEqual(w.reports, [nav]);
    // Negative: unreadable, oversize, unparseable and absent logs yield null plus a note; another report name is not a navigation log.
    assert.equal(workerEvidenceOf({ ...base, payloads: [], reports: [nav] }).navigationNote, "unreadable");
    assert.equal(workerEvidenceOf({ ...base, payloads: [], reports: [{ ...nav, content: new TextEncoder().encode("{nope") }] }).navigationNote, "unreadable");
    const big = workerEvidenceOf({ ...base, payloads: [], reports: [{ ...nav, content: new Uint8Array(WORKER_NAVIGATION_MAX + 1) }] });
    assert.deepEqual([big.navigation, big.navigationNote], [null, "oversize"]);
    const other = workerEvidenceOf({ ...base, payloads: [], reports: [{ ...nav, name: "browser-text", content: bytes(log) }] });
    assert.deepEqual([other.navigation, other.navigationNote], [null, "none published"]);
  });

  // The producer-to-consumer round trip (worker-diagnostic, fixed): the browser extension's sink line, harness-pi's normalisation, the journal
  // payloads and this module's reading of them are four hand-written steps over one shape; one definition per step is pinned here end to end.
  it("lifts the browser extension's journaled operator diagnostic into diagnostics, redacted, and keeps it out of errors", () => {
    const stderr =
      "scoped report publication failed (pomtree code=1 signal=null timedOut=false) stderr: cannot write /var/lib/x token=hunter2 to https://r.example/a?b=c";
    const diagnostic = captureFailureDiagnostic({ code: 1, stderr }, {});
    const line = diagnosticSinkLine("browser-capture-failure", { tool: "browser_capture", toolCallId: "c1", ...diagnostic });
    const journaled = normalize(line) as JournalPayload[];
    assert.deepEqual(
      journaled.map((p) => p.kind),
      ["error"],
    );
    const w = workerEvidenceOf({
      ...base,
      payloads: [...journaled, { kind: "error", message: "an ordinary error" }],
      env: { POMTREE_TOKEN: "envsecretvalue" },
    });
    assert.deepEqual(w.errors, ["an ordinary error"]);
    assert.equal(w.diagnostics.length, 1);
    const d = w.diagnostics[0] as { name: string; detail: Record<string, any> };
    assert.equal(d.name, "browser-capture-failure");
    assert.deepEqual([d.detail.tool, d.detail.cause, d.detail.pomtree?.code], ["browser_capture", "publish_failed", 1]);
    const text = JSON.stringify(d);
    assert.ok(!text.includes("hunter2") && !text.includes("/var/lib/x") && !text.includes("b=c"), text);
    // Negative: an error that merely resembles the prefix, and more than WORKER_ITEMS_MAX diagnostics, are not unbounded or misread.
    const lookalike = workerEvidenceOf({ ...base, payloads: [{ kind: "error", message: "operator-diagnostic Bad Name {}" }] });
    assert.deepEqual([lookalike.diagnostics, lookalike.errors.length], [[], 1]);
    const many = Array.from({ length: 100 }, () => journaled[0] as JournalPayload);
    assert.equal(workerEvidenceOf({ ...base, payloads: many }).diagnostics.length, WORKER_ITEMS_MAX);
  });

  it("keeps the output of a failed tool result only: a successful result (page text) contributes its size, never its content", () => {
    const secretPage = "Page text with a private sentence about Alice's salary";
    const w = workerEvidenceOf({
      ...base,
      payloads: [
        { kind: "tool_call", tool: "browser_snapshot", callId: "s1", input: {} },
        { kind: "tool_result", callId: "s1", ok: true, output: secretPage },
        { kind: "tool_call", tool: "browser_capture", callId: "c1", input: {} },
        { kind: "tool_result", callId: "c1", ok: false, output: "failed (cause=other)" },
      ],
    });
    assert.deepEqual(w.tools, [
      { tool: "browser_snapshot", ok: true, output: "", outputBytes: secretPage.length },
      { tool: "browser_capture", ok: false, output: "failed (cause=other)", outputBytes: 20 },
    ]);
    assert.ok(!JSON.stringify(w).includes("salary"));
  });

  it("scrubs single-segment paths, paths with spaces, and the keys of a navigation log", () => {
    const e = {};
    assert.equal(workerText("cannot open /tmp now", e), "cannot open [path] now");
    assert.equal(workerText("at /Users/Example User/workspace/x.ts failed", e), "at [path] failed");
    assert.equal(workerText("ENOENT '/var/lib/data' missing", e), "ENOENT '[path]' missing");
    assert.equal(workerText("a and/or b, 3 / 4, https://h.example", e), "a and/or b, 3 / 4, https://h.example/[path-redacted]");
    const nav = { name: "browser-navigation", mediaType: "application/json", sizeBytes: 10, sha256: "a".repeat(64) };
    const log = { kind: "browser-navigation", "https://leak.example/a/b?token=zzz": "x", "/Users/Example User/secret": 1 };
    const w = workerEvidenceOf({ ...base, payloads: [], reports: [{ ...nav, content: bytes(log) }] });
    const text = JSON.stringify(w.navigation);
    assert.ok(!text.includes("zzz") && !text.includes("Example User") && !text.includes("/a/b"), text);
  });
});

describe("workerFailureOf", () => {
  const failedTool = (cause: string): JournalPayload[] => [
    { kind: "tool_call", tool: "browser_capture", callId: "c1", input: {} },
    { kind: "tool_result", callId: "c1", ok: false, output: `trusted browser capture failed; no receipt issued (cause=${cause})` },
  ];
  const diag = (cause: string, stderrTail: string): JournalPayload => {
    const line = diagnosticSinkLine("browser-capture-failure", { tool: "browser_capture", toolCallId: "c1", code: 1, signal: null, stderrTail, cause });
    return normalize(line)[0] as JournalPayload;
  };
  it("reads the closed cause from the failed tool's suffix; a non_html worker has no runtime-error reason", () => {
    const w = workerEvidenceOf({ ...base, payloads: failedTool("non_html") });
    assert.deepEqual(workerFailureOf(w), { cause: "non_html", reason: null });
  });
  it("cause other with a stderr tail is a runtime-error; without a tail, or with another cause, it is not", () => {
    const crash = workerEvidenceOf({ ...base, payloads: [...failedTool("other"), diag("other", "TypeError: x is not a function")] });
    assert.deepEqual(workerFailureOf(crash), { cause: "other", reason: "runtime-error" });
    assert.equal(workerSummaryOf(crash).captureReason, "runtime-error");
    assert.equal(workerFailureOf(workerEvidenceOf({ ...base, payloads: [...failedTool("other"), diag("other", "")] })).reason, null);
    assert.equal(workerFailureOf(workerEvidenceOf({ ...base, payloads: [...failedTool("bound"), diag("bound", "noise")] })).reason, null);
  });
  it("falls back to the diagnostic's cause when the tool error has no suffix, and is null with neither", () => {
    const w = workerEvidenceOf({ ...base, payloads: [diag("navigation_error", "")] });
    assert.deepEqual(workerFailureOf(w), { cause: "navigation_error", reason: null });
    assert.deepEqual(workerFailureOf(workerEvidenceOf({ ...base, payloads: [] })), { cause: null, reason: null });
  });
});
