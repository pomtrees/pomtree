import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONFIG_DEFAULTS,
  CONFIG_REGISTRY,
  CONTAINER_CONFIG_ENV,
  CONTAINER_CONFIG_MAX_BYTES,
  SHIPPED_CONTRACT_COPIES,
  canonicalContainerDoc,
  configEnvIgnore,
  containerConfigEnv,
  containerConfigValues,
  resolveConfig,
} from "@pomtree/core";
import { DirReportStore } from "@pomtree/report-dir";
import { openStore } from "@pomtree/store-sqlite";
import { captureBrowser, captureLimits, type CaptureLimits, type CaptureReceipt } from "../../agent-image/src/browser-capture.ts";
import { nativeCaptureArgs } from "../../../examples/hn-digest/browser-contract.mts";
import { type ContentBounds, DEFAULT_CONTENT_BOUNDS, contentBounds } from "../../../examples/hn-digest/content-bounds.mts";
import { HN_DIGEST_DEFAULTS } from "../../../examples/hn-digest/params.mts";
import { hash } from "../../../examples/hn-digest/content-contract.mts";
import { createArticleVerifier } from "../../../examples/hn-digest/content-evidence.mts";

// Producer to every consumer of the container config contract, with no Docker: the operator's overrides are resolved by core's
// resolveConfig, written by containerConfigEnv (what pomtreed sets on every container start), read back by EVERY generated copy the
// image ships (SHIPPED_CONTRACT_COPIES, imported from disk), turned into the browser worker's capture limits, and the navigation log
// captureBrowser writes under those limits is checked by the digest's host verifier built from the same resolved values. The two sides
// must agree with each other and disagree with the defaults; and every copy refuses the same malformed documents.

type Copy = typeof import("../../agent-image/src/container-contract.gen.ts");
const REPO = new URL("../../../", import.meta.url);
const copies: ReadonlyArray<readonly [path: string, mod: Copy]> = await Promise.all(
  SHIPPED_CONTRACT_COPIES.map(async (p) => [p, (await import(new URL(p, REPO).href)) as Copy] as const),
);

// Two keys by their operator env names, one by `--set`: both resolver inputs feed the one document.
const resolved = (() => {
  const r = resolveConfig(CONFIG_REGISTRY, {
    env: { POMTREED_BROWSER_CAPTURE_TEXT_MAX_BYTES: "4096", POMTREED_BROWSER_CAPTURE_SCREENSHOT_MAX_BYTES: "524288" },
    set: ["wait.yieldMs=7000"],
    skipSecretFiles: true,
    ...configEnvIgnore(),
  });
  assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
  return r.values;
})();
// The digest bounds are built from the core values resolved above plus the digest's own keys (host-side only, at their defaults).
const operatorConfig = { ...HN_DIGEST_DEFAULTS, ...resolved };
const OVERRIDES = { "browser.capture.textMaxBytes": 4096, "browser.capture.screenshotMaxBytes": 524288, "wait.yieldMs": 7000 } as const;
const env = containerConfigEnv(CONFIG_REGISTRY, resolved);
const doc = env[CONTAINER_CONFIG_ENV];

test("every generated copy reads the operator's overrides from the document containerConfigEnv writes, equal to the resolved subset", () => {
  const expected = containerConfigValues(CONFIG_REGISTRY, resolved);
  for (const [k, v] of Object.entries(OVERRIDES)) assert.equal(expected[k as keyof typeof expected], v, `${k} resolved`);
  for (const [path, m] of copies) {
    const got = m.readContainerConfig(env, { required: true });
    assert.deepEqual({ ...got }, { ...expected }, path);
    assert.ok(Object.isFrozen(got), path);
    // The no-document fallback is the defaults, not the overrides (pomtree's wait path); the browser worker refuses it.
    assert.equal(m.readContainerConfig({}, { required: false })["wait.yieldMs"], CONFIG_DEFAULTS["wait.yieldMs"], path);
    assert.throws(() => m.readContainerConfig({}, { required: true }), /not set/, path);
  }
});

test("the worker's capture limits from the read document equal the digest's capture bounds from the same resolved values", () => {
  const worker = captureLimits(copies[0]![1].readContainerConfig(env, { required: true }));
  assert.deepEqual(worker, { ...contentBounds(operatorConfig).capture });
  assert.equal(worker.textMaxBytes, 4096);
  assert.notDeepEqual(worker, { ...DEFAULT_CONTENT_BOUNDS.capture });
});

// --- host verifier agreement ---------------------------------------------------------------------------------------------------------

const input = { storyId: 7, url: "https://example.com/article", itemHash: "b".repeat(64), maxBytes: 32768 };
// Visible text longer than both clips (4096 and the 8192 default), so each capture records its own clip.
const TEXT = "Rendered article sentence that the fake page presents as visible text. ".repeat(160);
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

// One browser capture under `limits`, published into a real report store under a real registry, and a verifier factory over it.
async function captured(limits: CaptureLimits, b: ContentBounds) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-config-roundtrip-"));
  const store = openStore(join(dir, "pomtreed.sqlite"));
  const reports = new DirReportStore({ root: join(dir, "reports"), registry: store.registry });
  const close = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const make = async (id: string, parent: string | null, container: boolean) => {
      const base = { id, parent, name: id, task: id, host: "h1", budgetMicros: 1000, idempotencyKey: id };
      const a = container
        ? await store.registry.create({
            ...base,
            executor: "container",
            spec: { image: "fixture@sha256:abc", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "audited-public" } },
          })
        : await store.registry.create({ ...base, executor: "deterministic", spec: { driver: "hn-content/story", input: {} } });
      return store.registry.transition(a.id, a.generation, "running", { idempotencyKey: `${id}:start` });
    };
    const root = await make("root", null, false);
    const parent = await make("story", root.id, false);
    const child = await make("article", parent.id, true);
    const html = new TextEncoder().encode("<html><body>entity</body></html>");
    const receipt: CaptureReceipt = await captureBrowser(
      {
        goto: async () => ({
          body: async () => html,
          status: () => 200,
          headerValue: async (name) => (name === "content-type" ? "text/html" : String(html.byteLength)),
        }),
        url: () => "https://publisher.example/final",
        evaluate: async () => ({ dom: "<html><main>rendered</main></html>", text: TEXT }),
        screenshot: async () => PNG,
        close: async () => {},
      },
      {
        ...nativeCaptureArgs(input, b),
        limits,
        settle: { pollMs: 2, stablePolls: 2, maxMs: 40 },
        worker: child.id,
        generation: child.generation,
        publish: async (data, name, mediaType) => {
          const id = `${name.replace(/[^a-z0-9]/g, "-")}-${hash(data).slice(0, 16)}`;
          const r = await reports.write(
            {
              id,
              agent: child.id,
              generation: child.generation,
              host: child.host,
              name,
              mediaType,
              sizeBytes: data.byteLength,
              sha256: hash(data),
              content: data,
            },
            id,
          );
          return { id: r.id, sha256: r.sha256 };
        },
      },
    );
    const terminal = await store.registry.transition(child.id, child.generation, "exited", {
      exit: "succeeded",
      result: { summary: "offline round-trip fixture", capture: receipt },
      idempotencyKey: "article:exit",
    });
    const ctx = { agent: parent.id, generation: parent.generation, signal: new AbortController().signal, deadlineAt: null };
    const accepts = async (bounds: ContentBounds) => {
      const v = createArticleVerifier({ registry: store.registry, reports, root: async () => root, bounds, authority: { receipt: async () => receipt } });
      const evidence = await v.verify(ctx, terminal, input, "browser");
      const summary = await v.summarize(ctx, terminal, input, "browser");
      assert.equal(evidence === null, summary === null, "verify and summarize agree");
      return evidence !== null;
    };
    return { accepts, close };
  } catch (e) {
    close();
    throw e;
  }
}

test("a capture under the operator's limits verifies at the operator's bounds and is refused at the defaults, and vice versa", async () => {
  const operator = contentBounds(operatorConfig);
  const workerLimits = captureLimits(copies[0]![1].readContainerConfig(env, { required: true }));
  const lowered = await captured(workerLimits, operator);
  try {
    assert.equal(await lowered.accepts(operator), true, "the 4096 log verifies at the 4096 bounds");
    assert.equal(await lowered.accepts(DEFAULT_CONTENT_BOUNDS), false, "the 4096 log is refused at the defaults");
  } finally {
    lowered.close();
  }
  const defaults = await captured(captureLimits(copies[0]![1].readContainerConfig({}, { required: false })), DEFAULT_CONTENT_BOUNDS);
  try {
    assert.equal(await defaults.accepts(DEFAULT_CONTENT_BOUNDS), true, "the default log verifies at the defaults");
    assert.equal(await defaults.accepts(operator), false, "the default log is refused at the 4096 bounds");
  } finally {
    defaults.close();
  }
});

// --- negatives: every copy refuses the same malformed documents ------------------------------------------------------------------

const parsed = JSON.parse(doc) as { contract: string; values: Record<string, number> };
const withValues = (patch: Record<string, number | undefined>) => {
  const values: Record<string, number> = { ...parsed.values };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete values[k];
    else values[k] = v;
  }
  return canonicalContainerDoc(parsed.contract, values);
};
const tamperedContract = parsed.contract.replace(/^./, (c) => (c === "0" ? "1" : "0"));
// A duplicate key placed after the operator's 4096 smuggles the looser default; JSON.parse keeps the last value.
const duplicate = doc.replace('"browser.capture.textMaxBytes":4096', '"browser.capture.textMaxBytes":4096,"browser.capture.textMaxBytes":8192');

const NEGATIVES: ReadonlyArray<readonly [name: string, raw: string, why: RegExp]> = [
  ["a tampered contract digest", canonicalContainerDoc(tamperedContract, parsed.values), /does not match daemon contract/],
  ["an extra key", withValues({ "browser.capture.extra": 1 }), /unknown key/],
  ["a missing key", withValues({ "wait.yieldMs": undefined }), /missing key wait\.yieldMs/],
  [
    "a value above its relation (ceiling looser than the raw allocation bound)",
    withValues({ "browser.capture.maxBytesCeiling": parsed.values["browser.capture.rawAllocationMaxBytes"]! + 1 }),
    /maxBytesCeiling=\d+ must be <= browser\.capture\.rawAllocationMaxBytes/,
  ],
  [
    "deadline min >= max",
    withValues({ "browser.capture.deadlineMinMs": parsed.values["browser.capture.deadlineMaxMs"]! }),
    /must be < browser\.capture\.deadlineMaxMs/,
  ],
  ["a value below its minimum", withValues({ "browser.capture.textMaxBytes": 0 }), /below its minimum/],
  ["a fraction", doc.replace('"wait.yieldMs":7000', '"wait.yieldMs":7000.5'), /must be a non-negative integer/],
  ["a duplicate key smuggling a looser value", duplicate, /not in canonical form/],
  ["non-canonical whitespace", doc.replace('{"contract"', '{ "contract"'), /not in canonical form/],
  ["an oversize document", `${doc}${" ".repeat(CONTAINER_CONFIG_MAX_BYTES)}`, /exceeds the \d+-byte cap/],
];

test("every generated copy refuses each malformed document with the same reason (negative variants)", () => {
  assert.notEqual(duplicate, doc, "the duplicate-key fixture applied");
  assert.equal(JSON.parse(duplicate).values["browser.capture.textMaxBytes"], 8192, "the smuggled value is what a naive parse sees");
  for (const [path, m] of copies) {
    for (const [name, raw, why] of NEGATIVES) {
      assert.throws(
        () => m.readContainerConfig({ [CONTAINER_CONFIG_ENV]: raw }, { required: false }),
        (e: unknown) => e instanceof m.ContainerConfigError && why.test(e.message),
        `${path}: ${name}`,
      );
    }
  }
});
