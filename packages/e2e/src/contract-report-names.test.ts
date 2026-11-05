import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Report } from "@pomtree/core";
import { browserEvidence } from "../../agent-image/ext/pomtree-browser/browser.ts";
import { CAPTURE_REPORT_NAMES, captureBrowser, captureLimits, type CapturePage, parseReportPublishJson } from "../../agent-image/src/browser-capture.ts";
import { CONTAINER_DEFAULTS } from "../../agent-image/src/container-contract.gen.ts";
import { reportExtension } from "./browser-live-audit.ts";

// Report names are published by the capture shell and the browser extension, and read back by the e2e audit. Each side must agree.

const sha = (d: Uint8Array | string) => createHash("sha256").update(d).digest("hex");

function fakePage(): CapturePage {
  const response = {
    body: async () => new TextEncoder().encode("<html>x</html>"),
    status: () => 200,
    headerValue: async (name: string) => (name === "content-type" ? "text/html" : null),
  };
  return {
    goto: async () => response,
    url: () => "https://example.com/a",
    evaluate: async () => ({ dom: "<html></html>", text: "x" }),
    screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    close: async () => {},
  };
}

test("every name the real captureBrowser run publishes is a declared name and has a file extension", async () => {
  const names: string[] = [];
  await captureBrowser(fakePage(), {
    url: "https://example.com/a",
    maxBytes: 65536,
    deadlineMs: 5000,
    limits: captureLimits(CONTAINER_DEFAULTS),
    worker: "w",
    generation: 1,
    publish: async (data, name) => {
      names.push(name);
      return { id: `id-${names.length}`, sha256: sha(data) };
    },
  });
  assert.deepEqual(names, ["browser-main-response", "browser-rendered-dom", "browser-dom-text", "browser-screenshot", "browser-navigation"]);
  assert.deepEqual([...names].sort(), Object.values(CAPTURE_REPORT_NAMES).sort());
  const ext = Object.fromEntries(names.map((n) => [n, reportExtension(n)]));
  assert.deepEqual(ext, {
    "browser-main-response": "html",
    "browser-rendered-dom": "html",
    "browser-dom-text": "txt",
    "browser-screenshot": "png",
    "browser-navigation": "json",
  });
});

test("the screenshot-N and action-N names the browser extension publishes are accepted by reportExtension", async () => {
  const names: string[] = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const evidence = browserEvidence({
    maxSteps: 3,
    record: () => {},
    publish: async (data, name) => {
      names.push(name);
      return { id: `id-${names.length}`, sha256: sha(data) };
    },
  });
  evidence.call({ toolName: "browser_click", toolCallId: "c1", input: {} });
  await evidence.result({
    toolName: "browser_click",
    toolCallId: "c1",
    isError: false,
    content: [{ type: "image", data: png, mimeType: "image/png" }],
  });
  assert.deepEqual(names, ["browser-screenshot-1", "browser-action-1"]);
  assert.equal(reportExtension(names[0]!), "png");
  assert.equal(reportExtension(names[1]!), "json");
});

test("the real `pomtree report publish --json` stdout is accepted by parseReportPublishJson", () => {
  // pomtree prints the daemon's Report with JSON.stringify (packages/pomtree/src/cli.ts, `print`), so this object is that output's shape.
  const body = new TextEncoder().encode("<html>x</html>");
  const report: Report = {
    id: sha(body),
    agent: "worker-1",
    generation: 2,
    host: "host-1",
    name: "browser-main-response",
    mediaType: "text/html",
    sizeBytes: body.byteLength,
    sha256: sha(body),
    createdAt: 1_700_000_000_000,
  };
  assert.deepEqual(parseReportPublishJson(JSON.stringify(report), sha(body)), { id: report.id, sha256: sha(body) });
  assert.throws(() => parseReportPublishJson(JSON.stringify(report), sha("other")), /receipt mismatch/);
});
