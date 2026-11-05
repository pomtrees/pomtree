import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { captureBrowser, captureLimits, type CapturePage, type CaptureReceipt } from "../../agent-image/src/browser-capture.ts";
import { CONTAINER_DEFAULTS } from "../../agent-image/src/container-contract.gen.ts";
import { parseCaptureReceipt as parseExtensionReceipt } from "../../agent-image/ext/pomtree-browser/browser.ts";
import { parseCaptureReceipt as parseAuthorityReceipt } from "../../../examples/hn-digest/content-authority.mts";
import { receiptKeyProblems } from "./browser-live.ts";

// One real receipt from the real captureBrowser, fed to every consumer parser. A consumer that drifts from the producer fails here.

const sha = (d: Uint8Array | string) => createHash("sha256").update(d).digest("hex");
const RAW = new TextEncoder().encode("<html>entity</html>");
const DOM = new TextEncoder().encode("<html><body>rendered</body></html>");

function fakePage(): CapturePage {
  const response = {
    body: async () => RAW,
    status: () => 200,
    headerValue: async (name: string) => (name === "content-type" ? "text/html; charset=utf-8" : null),
  };
  return {
    goto: async () => response,
    url: () => "https://example.com/a",
    evaluate: async () => ({ dom: new TextDecoder().decode(DOM), text: "rendered" }),
    screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    close: async () => {},
  };
}

async function realReceipt(): Promise<{ receipt: CaptureReceipt; bodies: Map<string, Uint8Array> }> {
  const bodies = new Map<string, Uint8Array>();
  let n = 0;
  const receipt = await captureBrowser(fakePage(), {
    url: "https://example.com/a",
    maxBytes: 65536,
    deadlineMs: 5000,
    limits: captureLimits(CONTAINER_DEFAULTS),
    worker: "worker-1",
    generation: 2,
    publish: async (data) => {
      const id = `report-${++n}`;
      bodies.set(id, data);
      return { id, sha256: sha(data) };
    },
  });
  return { receipt, bodies };
}

// Runs the three consumers on one candidate value. `problems` is what the e2e receipt check reports (empty means accepted).
function verdicts(value: Record<string, unknown>) {
  const json = JSON.stringify(value);
  let extension = "accepted";
  try {
    parseExtensionReceipt(JSON.parse(json));
  } catch (error) {
    extension = error instanceof Error ? error.message : "rejected";
  }
  return {
    extension,
    authority: parseAuthorityReceipt(json) === null ? "rejected" : "accepted",
    e2e: receiptKeyProblems(JSON.parse(json)),
  };
}

test("the real captureBrowser receipt is accepted by every consumer parser", async () => {
  const { receipt } = await realReceipt();
  const value = JSON.parse(JSON.stringify(receipt));
  assert.deepEqual(parseExtensionReceipt(value), receipt);
  assert.deepEqual(parseAuthorityReceipt(JSON.stringify(receipt)), receipt);
  assert.deepEqual(receiptKeyProblems(value), []);
});

test("the real receipt has the documented key set, with two-key report refs", async () => {
  const { receipt } = await realReceipt();
  const keys = Object.keys(receipt).sort();
  assert.deepEqual(keys, [
    "contentType",
    "domReport",
    "finalUrl",
    "generation",
    "method",
    "navigationReport",
    "originalUrl",
    "rawBodyReport",
    "screenshotReport",
    "status",
    "textReport",
    "worker",
  ]);
  for (const ref of keys.filter((k) => k.endsWith("Report"))) {
    assert.deepEqual(Object.keys((receipt as unknown as Record<string, object>)[ref]!).sort(), ["id", "sha256"], ref);
  }
});

test("an unknown key is rejected by the extension and authority parsers and flagged by the e2e check", async () => {
  const { receipt } = await realReceipt();
  const v = verdicts({ ...receipt, extra: 1 });
  assert.match(v.extension, /unexpected shape/);
  assert.equal(v.authority, "rejected");
  assert.deepEqual(v.e2e, ["unexpected key extra"]);
});

test("dropping each real receipt key is rejected by every consumer", async () => {
  const { receipt } = await realReceipt();
  for (const key of Object.keys(receipt)) {
    const value: Record<string, unknown> = { ...receipt };
    delete value[key];
    const v = verdicts(value);
    assert.notEqual(v.extension, "accepted", `extension accepted receipt without ${key}`);
    assert.equal(v.authority, "rejected", `authority accepted receipt without ${key}`);
    assert.ok(v.e2e.includes(`missing key ${key}`), `e2e check did not flag missing ${key}: ${v.e2e.join("; ")}`);
  }
});

test("a report ref carrying an extra field is rejected by the extension and authority parsers", async () => {
  const { receipt } = await realReceipt();
  const value = { ...receipt, domReport: { ...receipt.domReport, bytes: 1 } };
  assert.throws(() => parseExtensionReceipt(value), /domReport invalid/);
  assert.equal(parseAuthorityReceipt(JSON.stringify(value)), null);
  assert.deepEqual(receiptKeyProblems(value), ["domReport must have exactly the keys id and sha256"]);
});
