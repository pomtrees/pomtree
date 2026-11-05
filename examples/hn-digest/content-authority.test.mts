import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "../../packages/core/src/index.ts";
import { createFakes } from "../../packages/testing/src/fakes.ts";
import { BROWSER_INTERACTIVE_TOOLS } from "../../packages/agent-image/src/browser-run.ts";
import { parseNativeCaptureArgs, type NativeCaptureArgs } from "./browser-contract.mts";
import { CONTENT_CONFIG_DEFAULTS, DEFAULT_CONTENT_BOUNDS as BOUNDS, contentBounds } from "./content-bounds.mts";
import { approvedBrowserWorker, createJournalCaptureAuthority, parseCaptureReceipt } from "./content-authority.mts";
import type { CaptureReceipt } from "./content-evidence.mts";

const artifact = (id: string) => ({ id, sha256: "a".repeat(64) });
const expected: NativeCaptureArgs = { url: "https://example.com/post", maxBytes: 262144, deadlineMs: 60000 };
const receipt: CaptureReceipt = {
  worker: "browser",
  generation: 0,
  originalUrl: expected.url,
  finalUrl: "https://publisher.example/final",
  method: "browser",
  status: 200,
  contentType: "text/html",
  rawBodyReport: artifact("http-entity"),
  domReport: artifact("dom"),
  textReport: artifact("text"),
  screenshotReport: artifact("screenshot"),
  navigationReport: artifact("navigation"),
};

async function fixture(options: { tool?: string; input?: unknown; output?: string; ok?: boolean } = {}) {
  const f = createFakes();
  const child = await f.registry.create({
    id: "browser",
    parent: "story",
    host: "h1",
    name: "browser",
    task: "capture",
    executor: "container",
    spec: { image: "pinned@sha256:fixture", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "audited-public" } },
    budgetMicros: 1000,
    idempotencyKey: "browser",
  });
  await f.journal.append({
    agent: child.id,
    host: child.host,
    generation: child.generation,
    payload: { kind: "tool_call", tool: options.tool ?? "browser_capture", callId: "native-capture", input: options.input ?? expected },
    idempotencyKey: "call",
  });
  await f.journal.append({
    agent: child.id,
    host: child.host,
    generation: child.generation,
    payload: { kind: "tool_result", callId: "native-capture", output: options.output ?? JSON.stringify(receipt), ok: options.ok ?? true },
    idempotencyKey: "result",
  });
  const authority = createJournalCaptureAuthority({
    registry: f.registry,
    journal: f.journal,
    approvedWorker: (a) => a.executor === "container" && a.spec.image === "pinned@sha256:fixture",
    bounds: BOUNDS,
  });
  return { f, child, authority };
}

test("capture authority binds native browser_capture args/result, expected source, generation and approved image", async () => {
  const f = await fixture();
  assert.deepEqual(await f.authority.receipt("browser", 0, expected), receipt);
  assert.equal(await f.authority.receipt("browser", 1, expected), null);
  for (const wrong of [
    { ...expected, url: "https://other.example/post" },
    { ...expected, maxBytes: 32768 },
    { ...expected, deadlineMs: 20000 },
  ])
    assert.equal(await f.authority.receipt("browser", 0, wrong), null);
  const refused = createJournalCaptureAuthority({ registry: f.f.registry, journal: f.f.journal, approvedWorker: () => false, bounds: BOUNDS });
  assert.equal(await refused.receipt("browser", 0, expected), null);
});

test("capture authority rejects bash/model receipts, malformed bounded arguments, failed tool output and receipt suffixes", async () => {
  for (const options of [
    { tool: "bash", input: { command: "node /opt/pomtree/browser-capture.ts 'https://example.com/post' 262144 60000" } },
    { tool: "browser_navigate" },
    { input: { ...expected, url: "https://other.example/post" } },
    { input: { ...expected, deadlineMs: 0 } },
    { input: { ...expected, maxBytes: 1048577 } },
    { input: { ...expected, extra: "not an argv parameter" } },
    { ok: false },
    { output: `${JSON.stringify(receipt)}\nextra prose` },
    { output: JSON.stringify({ capture: receipt }) },
    { output: JSON.stringify({ ...receipt, worker: "sibling" }) },
  ]) {
    const f = await fixture(options);
    assert.equal(await f.authority.receipt("browser", 0, expected), null, JSON.stringify(options));
  }
});

for (const first of ["success", "failed", "malformed", "invalid-args"])
  test(`capture authority rejects a second native invocation after ${first}, regardless of successful receipts`, async () => {
    const f = await fixture(
      first === "failed"
        ? { ok: false }
        : first === "malformed"
          ? { output: "not JSON" }
          : first === "invalid-args"
            ? { input: { ...expected, maxBytes: 0 } }
            : {},
    );
    await f.f.journal.append({
      agent: "browser",
      host: "h1",
      generation: 0,
      payload: { kind: "tool_call", tool: "browser_capture", callId: "second", input: expected },
      idempotencyKey: "call2",
    });
    await f.f.journal.append({
      agent: "browser",
      host: "h1",
      generation: 0,
      payload: { kind: "tool_result", callId: "second", output: JSON.stringify(receipt), ok: true },
      idempotencyKey: "result2",
    });
    assert.equal(await f.authority.receipt("browser", 0, expected), null);
  });

test("capture args/receipt parsing enforces native ranges, direct JSON shape and all browser artifacts", () => {
  assert.deepEqual(parseCaptureReceipt(JSON.stringify(receipt)), receipt);
  for (const bad of [
    { ...receipt, domReport: null },
    { ...receipt, textReport: { id: "x", sha256: "forged" } },
    { ...receipt, finalUrl: "http://127.0.0.1/private" },
    { ...receipt, originalUrl: "https://user:password@example.com/post" },
    { ...receipt, generation: -1 },
    { ...receipt, status: 0 },
    { ...receipt, extra: true },
  ])
    assert.equal(parseCaptureReceipt(JSON.stringify(bad)), null);
  assert.equal(parseCaptureReceipt("not JSON"), null);
  for (const args of [
    { ...expected, maxBytes: 0 },
    { ...expected, maxBytes: 1048577 },
    { ...expected, deadlineMs: 999 },
    { ...expected, deadlineMs: 120001 },
    { ...expected, url: "file:///etc/passwd" },
  ])
    assert.equal(parseNativeCaptureArgs(args, BOUNDS), null);
  assert.ok(parseNativeCaptureArgs({ ...expected, maxBytes: 1048576, deadlineMs: 120000 }, BOUNDS));
});

test("native capture args follow the resolved bounds, not the defaults: a lowered ceiling and deadline range refuse what the defaults accept", () => {
  const lowered = contentBounds({
    ...CONTENT_CONFIG_DEFAULTS,
    "browser.capture.maxBytesCeiling": 524288,
    "browser.capture.deadlineMinMs": 2000,
    "browser.capture.deadlineMaxMs": 60000,
  });
  assert.ok(parseNativeCaptureArgs({ ...expected, maxBytes: 524288, deadlineMs: 60000 }, lowered));
  assert.ok(parseNativeCaptureArgs({ ...expected, maxBytes: 524288, deadlineMs: 2000 }, lowered));
  for (const args of [
    { ...expected, maxBytes: 524289 },
    { ...expected, deadlineMs: 1999 },
    { ...expected, deadlineMs: 60001 },
  ]) {
    assert.equal(parseNativeCaptureArgs(args, lowered), null, JSON.stringify(args));
    assert.ok(parseNativeCaptureArgs(args, BOUNDS), "the defaults accept it");
  }
});

test("static receipts still refuse capture-summary fields: the host recomputes them, a worker cannot assert them", () => {
  const { domReport: _d, screenshotReport: _s, navigationReport: _n, ...base } = receipt;
  const staticReceipt = { ...base, method: "static-http" as const, truncated: true, bytesRetained: 100, fetchedAt: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(parseCaptureReceipt(JSON.stringify(staticReceipt)), staticReceipt);
  for (const extra of [{ textChars: 700 }, { reason: "thin" }, { capture: { status: "usable" } }, { bodyBytes: 1 }, { finalOrigin: "https://example.com" }])
    assert.equal(parseCaptureReceipt(JSON.stringify({ ...staticReceipt, ...extra })), null, JSON.stringify(extra));
});

test("static receipts may carry truncation facts and fetchedAt, and nothing else extra", () => {
  const { domReport: _d, screenshotReport: _s, navigationReport: _n, ...base } = receipt;
  const staticReceipt = { ...base, method: "static-http" as const };
  const withFacts = { ...staticReceipt, truncated: true, bytesRetained: 100, fetchedAt: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(parseCaptureReceipt(JSON.stringify(withFacts)), withFacts);
  assert.deepEqual(parseCaptureReceipt(JSON.stringify(staticReceipt)), staticReceipt);
  for (const bad of [
    { ...withFacts, truncated: "yes" },
    { ...withFacts, bytesRetained: -1 },
    { ...withFacts, fetchedAt: "nope" },
    { ...withFacts, extra: 1 },
  ])
    assert.equal(parseCaptureReceipt(JSON.stringify(bad)), null);
});

test("approvedBrowserWorker requires the browser template, the browser marker and the approved image digest", () => {
  const image = `approved@sha256:${"a".repeat(64)}`;
  const ok = { executor: "container", spec: { template: "capture-browser", browser: { maxSteps: 16, maxMs: 150000 }, image } } as unknown as AgentRecord;
  const variant = (spec: Record<string, unknown>, executor = "container") =>
    ({ ...ok, executor, spec: { ...(ok as { spec: object }).spec, ...spec } }) as unknown as AgentRecord;
  assert.equal(approvedBrowserWorker(ok, image), true);
  assert.equal(approvedBrowserWorker(variant({ browser: undefined }), image), false, "no browser marker");
  assert.equal(approvedBrowserWorker(variant({ image: `other@sha256:${"b".repeat(64)}` }), image), false, "another image");
  assert.equal(approvedBrowserWorker(variant({ template: "capture-static" }), image), false, "another template");
  assert.equal(approvedBrowserWorker(variant({}, "deterministic"), image), false, "not a container");
});

test("an interactive browser worker is never capture authority: its own template is refused, and it has no browser_capture to journal", () => {
  const image = `approved@sha256:${"a".repeat(64)}`;
  // The shipped interactive example's id (examples/browse-agent/browse-interactive-haiku.json), from the approved image.
  const interactive = {
    executor: "container",
    spec: { template: "browse-interactive-haiku", browser: { maxSteps: 30, maxMs: 300000, profile: "interactive" }, image },
  } as unknown as AgentRecord;
  assert.equal(approvedBrowserWorker(interactive, image), false);
  // Its journal could only ever carry the interactive tools: browser_capture is not among them, so no call of it can be journaled.
  assert.equal((BROWSER_INTERACTIVE_TOOLS as readonly string[]).includes("browser_capture"), false);
  // An interactive template saved under the capture template's own id is refused too: the profile marker decides, not the id.
  const reusedId = { ...interactive, spec: { ...(interactive as { spec: object }).spec, template: "capture-browser" } } as unknown as AgentRecord;
  assert.equal(approvedBrowserWorker(reusedId, image), false);
});
