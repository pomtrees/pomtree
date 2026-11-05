import assert from "node:assert/strict";
import test from "node:test";
import { browserEvidence, parseCaptureReceipt } from "../ext/pomtree-browser/browser.ts";

const ref = (n: number) => ({ id: `r${n}`, sha256: n.toString(16).padStart(64, "0") });
const receipt = () => ({
  worker: "w1",
  generation: 2,
  originalUrl: "https://e.test/a",
  finalUrl: "https://e.test/a",
  method: "browser",
  status: 200,
  contentType: "text/html",
  screenshotReport: ref(5),
  rawBodyReport: ref(1),
  domReport: ref(2),
  textReport: ref(3),
  navigationReport: ref(4),
});

function deps(maxSteps = 2) {
  const published: { name: string; type: string; data: string }[] = [];
  const recorded: unknown[] = [];
  return {
    published,
    recorded,
    deps: {
      maxSteps,
      publish: async (data: Uint8Array, name: string, type: string) => {
        published.push({ name, type, data: Buffer.from(data).toString("utf8") });
        return { id: `p${published.length}`, sha256: "a".repeat(64) };
      },
      record: (v: unknown) => recorded.push(v),
    },
  };
}

test("step budget blocks the call past maxSteps with a reason and never publishes for blocked calls", () => {
  const d = deps(1);
  const ev = browserEvidence(d.deps);
  assert.equal(ev.call({ toolName: "browser_open", toolCallId: "c1", input: {} }), undefined);
  const blocked = ev.call({ toolName: "browser_open", toolCallId: "c2", input: {} }) as { block: boolean; reason: string };
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /budget \(1\) exhausted/);
});

test("invalid step budgets are rejected at construction", () => {
  for (const n of [0, 257, 1.5, Number.NaN]) assert.throws(() => browserEvidence(deps(n).deps), /invalid browser step budget/);
});

test("action metadata keeps only origin for URLs; typed text, selectors and secrets never reach the record", async () => {
  const d = deps();
  const ev = browserEvidence(d.deps);
  ev.call({ toolName: "browser_type", toolCallId: "c1", input: { url: "https://u:pw@e.test:8443/p?token=secret#x", text: "hunter2", selector: "#pw" } });
  await ev.result({ toolName: "browser_type", toolCallId: "c1", isError: false, content: [{ type: "text", text: "ok" }] });
  const action = JSON.parse(d.published[0]!.data);
  assert.equal(action.kind, "browser-action");
  assert.deepEqual(action.input, { url: "https://e.test:8443/[redacted]" });
  assert.doesNotMatch(d.published[0]!.data, /hunter2|secret|pw@|#pw/);
  assert.equal(action.isError, false);
});

test("non-browser tools are ignored entirely", async () => {
  const d = deps();
  const ev = browserEvidence(d.deps);
  assert.equal(await ev.result({ toolName: "web_fetch", toolCallId: "c", isError: false, content: [] }), undefined);
  assert.equal(d.published.length, 0);
});

test("browser_capture keeps one exact receipt JSON result for harness authority matching", async () => {
  const d = deps();
  const ev = browserEvidence(d.deps);
  const text = JSON.stringify(receipt());
  ev.call({ toolName: "browser_capture", toolCallId: "capture", input: { url: "https://e.test/a", maxBytes: 65536, deadlineMs: 20000 } });
  assert.equal(await ev.result({ toolName: "browser_capture", toolCallId: "capture", isError: false, content: [{ type: "text", text }] }), undefined);
  assert.equal(d.published.length, 0, "capture itself publishes/binds artifacts; generic hooks must not rewrite its native JSON output");
  assert.deepEqual(parseCaptureReceipt(JSON.parse(text)), receipt());
});

test("screenshots: only png/jpeg base64 accepted, each published and recorded, and the result cites real receipts", async () => {
  const d = deps();
  const ev = browserEvidence(d.deps);
  ev.call({ toolName: "browser_screenshot", toolCallId: "c1", input: {} });
  const png = Buffer.from("png-bytes").toString("base64");
  const out = (await ev.result({
    toolName: "browser_screenshot",
    toolCallId: "c1",
    isError: false,
    content: [{ type: "image", data: png, mimeType: "image/png" }],
  })) as { content: { type: string; text?: string }[] };
  assert.equal(d.published.length, 2);
  assert.equal(d.published[0]!.name, "browser-screenshot-1");
  assert.equal(d.published[0]!.data, "png-bytes");
  assert.equal(d.published[1]!.name, "browser-action-1");
  assert.equal(d.recorded.length, 2);
  assert.match(out.content[out.content.length - 1]!.text!, /Cite actual report IDs\/hashes/);
});

test("screenshot validation rejects unsupported media types and invalid base64", async () => {
  const ev = browserEvidence(deps().deps);
  await assert.rejects(
    ev.result({ toolName: "browser_x", toolCallId: "c", isError: false, content: [{ type: "image", data: "AAAA", mimeType: "image/gif" }] }),
    /unsupported browser screenshot media type/,
  );
  await assert.rejects(
    ev.result({ toolName: "browser_x", toolCallId: "c", isError: false, content: [{ type: "image", data: "@@@@", mimeType: "image/png" }] }),
    /oversized\/invalid/,
  );
});

test("screenshot byte budget: a single image over 1 MiB is rejected", async () => {
  const ev = browserEvidence(deps().deps);
  const big = Buffer.alloc(1024 ** 2 + 1).toString("base64");
  await assert.rejects(
    ev.result({ toolName: "browser_x", toolCallId: "c", isError: false, content: [{ type: "image", data: big, mimeType: "image/png" }] }),
    /budget exhausted/,
  );
});

test("parseCaptureReceipt accepts exactly the locked receipt shape", () => {
  assert.deepEqual(parseCaptureReceipt(receipt()), receipt());
});

test("parseCaptureReceipt rejects missing, extra, or malformed fields", () => {
  const cases: [string, unknown][] = [
    ["null", null],
    ["missing textReport", (({ textReport: _t, ...r }) => r)(receipt())],
    ["extra key", { ...receipt(), unexpectedReport: ref(9) }],
    ["bad status", { ...receipt(), status: 999 }],
    ["bad contentType", { ...receipt(), contentType: 1 }],
    ["bad method", { ...receipt(), method: "http" }],
    ["bad generation", { ...receipt(), generation: -1 }],
    ["empty worker", { ...receipt(), worker: "" }],
    ["bad sha", { ...receipt(), domReport: { id: "x", sha256: "ABC" } }],
    ["extra ref field", { ...receipt(), rawBodyReport: { id: "x", sha256: "a".repeat(64), name: "n" } }],
    ["empty id", { ...receipt(), navigationReport: { id: "", sha256: "a".repeat(64) } }],
  ];
  for (const [label, value] of cases) assert.throws(() => parseCaptureReceipt(value), /receipt/, label);
});
