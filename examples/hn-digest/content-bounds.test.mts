// ContentBounds: built from the registry, never copied; the live entry's resolve; the browser deadline ladder.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BROWSER_SCREENSHOT_FALLBACK_HEIGHTS,
  BROWSER_SETTLE_POLLS_MAX,
  BROWSER_SETTLE_WAIT_MAX_MS,
  BROWSER_VIEWPORT,
} from "../../packages/agent-image/src/browser-capture.ts";
import { CONFIG_REGISTRY, containerConfigDoc, containerParamDefs, DEFAULT_FETCH_USER_AGENT } from "../../packages/core/src/index.ts";
import { CONTENT_CONFIG_DEFAULTS, DEFAULT_CONTENT_BOUNDS, contentBounds } from "./content-bounds.mts";
import { BROWSER_DEADLINE_MS, BROWSER_LIMITS, BROWSER_WRAPUP_MS } from "./content-browser-method.mts";
import { isPinnedImage, parseLiveArgs, resolveLiveConfig } from "./content-live.mts";
import { liveContainerConfig } from "./content-live-runtime.mts";

const noFile = (): string => {
  throw new Error("no file expected");
};

test("DEFAULT_CONTENT_BOUNDS is the registry defaults plus the worker's own image facts", () => {
  const c = CONTENT_CONFIG_DEFAULTS;
  assert.deepEqual(DEFAULT_CONTENT_BOUNDS, {
    capture: {
      maxBytesCeiling: c["browser.capture.maxBytesCeiling"],
      rawAllocationMaxBytes: c["browser.capture.rawAllocationMaxBytes"],
      textMaxBytes: c["browser.capture.textMaxBytes"],
      screenshotMaxBytes: c["browser.capture.screenshotMaxBytes"],
      deadlineMinMs: c["browser.capture.deadlineMinMs"],
      deadlineMaxMs: c["browser.capture.deadlineMaxMs"],
    },
    articleCaptureBytes: c["ext.hnDigest.articleCaptureBytes"],
    articleTextMaxBytes: c["ext.hnDigest.articleTextMaxBytes"],
    articlePageMaxBytes: c["ext.hnDigest.articlePageMaxBytes"],
    articleAnalystReadMaxBytes: c["ext.hnDigest.articleAnalystReadMaxBytes"],
    browserCaptureDeadlineMs: c["ext.hnDigest.articleBrowserCaptureDeadlineMs"],
    auditBodyMaxBytes: c["ext.hnDigest.articleAuditBodyMaxBytes"],
    digestReportMaxBytes: c["ext.hnDigest.reportMaxBytes"],
    reportMaxBytes: c["report.maxBytes"],
    reportCeilingBytes: Math.min(c["report.workflowMaxBytes"], c["report.maxBytes"]),
    viewport: { width: BROWSER_VIEWPORT.width, height: BROWSER_VIEWPORT.height },
    screenshotClipHeights: [...BROWSER_SCREENSHOT_FALLBACK_HEIGHTS],
    settlePollsMax: BROWSER_SETTLE_POLLS_MAX,
    settleWaitMaxMs: BROWSER_SETTLE_WAIT_MAX_MS,
  });
  // The registry relations the digest relies on hold at the defaults: the browser text fits the article text bound, the capture fits
  // the ceiling, the digest report fits the workflow ceiling.
  const b = DEFAULT_CONTENT_BOUNDS;
  assert.ok(b.capture.textMaxBytes <= b.articleTextMaxBytes);
  assert.ok(b.articlePageMaxBytes <= b.articleAnalystReadMaxBytes);
  assert.ok(b.articleCaptureBytes <= b.capture.maxBytesCeiling);
  assert.ok(b.digestReportMaxBytes <= b.reportCeilingBytes);
});

test("contentBounds follows non-default values; the report ceiling is the smaller of the two report keys", () => {
  const b = contentBounds({ ...CONTENT_CONFIG_DEFAULTS, "browser.capture.textMaxBytes": 4096, "report.maxBytes": 200_000 });
  assert.equal(b.capture.textMaxBytes, 4096);
  assert.equal(b.reportMaxBytes, 200_000);
  assert.equal(b.reportCeilingBytes, 200_000);
});

test("resolveLiveConfig: --set and env override the defaults; a violated relation refuses with one line per error", () => {
  const set = resolveLiveConfig({ env: {}, set: ["browser.capture.textMaxBytes=4096"], readFile: noFile });
  assert.ok(set.ok);
  assert.equal(contentBounds(set.values).capture.textMaxBytes, 4096);
  const relation = resolveLiveConfig({ env: { POMTREED_EXT_HN_DIGEST_REPORT_MAX_BYTES: "300000" }, set: [], readFile: noFile });
  assert.equal(relation.ok, false);
  assert.ok(!relation.ok && relation.errors.length === 1 && /ext\.hnDigest\.reportMaxBytes=300000.*<= report\.workflowMaxBytes/.test(relation.errors[0] ?? ""));
  const several = resolveLiveConfig({ env: {}, set: ["ext.hnDigest.articleTextMaxBytes=9000", "no.such.key=1"], readFile: noFile });
  assert.ok(!several.ok && several.errors.length >= 2, JSON.stringify(several));
});

test("resolveLiveConfig: workflow.fetch.userAgent resolves unset or blank to the default, and keeps a contactless value", () => {
  const ua = (env: Record<string, string>) => {
    const r = resolveLiveConfig({ env, set: [], readFile: noFile });
    assert.ok(r.ok);
    return r.values["workflow.fetch.userAgent"];
  };
  assert.equal(ua({}), DEFAULT_FETCH_USER_AGENT);
  assert.equal(ua({ POMTREED_WORKFLOW_FETCH_USER_AGENT: "" }), DEFAULT_FETCH_USER_AGENT);
  assert.equal(ua({ POMTREED_WORKFLOW_FETCH_USER_AGENT: "hn-digest" }), "hn-digest");
});

test("resolveLiveConfig: the config file (--config, else $POMTREED_CONFIG) is read; an unreadable or non-JSON file refuses", () => {
  const files: Record<string, string> = { "/cfg.json": JSON.stringify({ ext: { hnDigest: { articleCaptureBytes: 131072 } } }), "/bad.json": "{" };
  const readFile = (p: string): string => {
    const text = files[p];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  };
  const viaFlag = resolveLiveConfig({ env: {}, configFile: "/cfg.json", set: [], readFile });
  assert.ok(viaFlag.ok && viaFlag.values["ext.hnDigest.articleCaptureBytes"] === 131072);
  const viaEnv = resolveLiveConfig({ env: { POMTREED_CONFIG: "/cfg.json" }, set: [], readFile });
  assert.ok(viaEnv.ok && viaEnv.values["ext.hnDigest.articleCaptureBytes"] === 131072);
  assert.deepEqual(resolveLiveConfig({ env: {}, configFile: "/bad.json", set: [], readFile }), {
    ok: false,
    errors: ["config file /bad.json: not valid JSON"],
  });
  const missing = resolveLiveConfig({ env: {}, configFile: "/none.json", set: [], readFile });
  assert.ok(!missing.ok && /^config file \/none\.json: cannot read/.test(missing.errors[0] ?? ""));
});

// The digest's own keys (params.mts) reach contentBounds from each source, and the old core names are refused as unknown.
test("resolveLiveConfig: ext.hnDigest keys resolve by default, --set, the file and POMTREED_EXT_HN_DIGEST_* env; the old names are refused", () => {
  const resolved = (o: { env?: Record<string, string>; set?: string[] }) => resolveLiveConfig({ env: o.env ?? {}, set: o.set ?? [], readFile: noFile });
  const dflt = resolved({});
  assert.ok(dflt.ok);
  assert.deepEqual(contentBounds(dflt.values), DEFAULT_CONTENT_BOUNDS);
  const viaSet = resolved({ set: ["ext.hnDigest.articleCaptureBytes=131072"] });
  assert.ok(viaSet.ok);
  assert.equal(contentBounds(viaSet.values).articleCaptureBytes, 131072);
  const viaEnv = resolved({ env: { POMTREED_EXT_HN_DIGEST_ARTICLE_PAGE_MAX_BYTES: "8192", POMTREED_EXT_HN_DIGEST_REPORT_MAX_BYTES: "1000" } });
  assert.ok(viaEnv.ok);
  assert.equal(contentBounds(viaEnv.values).articlePageMaxBytes, 8192);
  assert.equal(contentBounds(viaEnv.values).digestReportMaxBytes, 1000);
  const both = resolved({ env: { POMTREED_EXT_HN_DIGEST_ARTICLE_CAPTURE_BYTES: "100000" }, set: ["ext.hnDigest.articleCaptureBytes=120000"] });
  assert.ok(both.ok);
  assert.equal(contentBounds(both.values).articleCaptureBytes, 120000, "--set wins over env");
  const oldNames = [
    "POMTREED_ARTICLE_CAPTURE_BYTES",
    "POMTREED_ARTICLE_AUDIT_BODY_MAX_BYTES",
    "POMTREED_ARTICLE_TEXT_MAX_BYTES",
    "POMTREED_ARTICLE_PAGE_MAX_BYTES",
    "POMTREED_ARTICLE_ANALYST_READ_MAX_BYTES",
    "POMTREED_ARTICLE_BROWSER_CAPTURE_DEADLINE_MS",
    "POMTREED_DIGEST_REPORT_MAX_BYTES",
  ];
  for (const old of oldNames) {
    const r = resolved({ env: { [old]: "1" } });
    const errors = r.ok ? [] : r.errors;
    assert.equal(errors.length, 1, old);
    assert.ok((errors[0] ?? "").startsWith(`unknown env ${old}`), `${old} names the cause: ${errors[0]}`);
    assert.ok((errors[0] ?? "").endsWith("remove it, or use a name listed in docs/configuration.md"), `${old} names the action: ${errors[0]}`);
  }
  const unknown = resolved({ env: { POMTREED_EXT_HN_DIGEST_NO_SUCH_KEY: "1" } });
  assert.ok(!unknown.ok && unknown.errors.length === 1 && /POMTREED_EXT_HN_DIGEST_NO_SUCH_KEY/.test(unknown.errors[0] ?? ""), JSON.stringify(unknown));
  const otherExt = resolved({ env: { POMTREED_EXT_OTHER_KEY: "1" } });
  assert.ok(!otherExt.ok, "a POMTREED_EXT_ name for an extension that is not hn-digest is refused");
  // The inverted relation: the digest's stored-text bound may not drop below the browser worker's clip.
  const inverted = resolved({ set: ["ext.hnDigest.articleTextMaxBytes=4096"] });
  assert.ok(
    !inverted.ok && inverted.errors.length === 1 && /ext\.hnDigest\.articleTextMaxBytes=4096.*>= browser\.capture\.textMaxBytes/.test(inverted.errors[0] ?? ""),
    JSON.stringify(inverted),
  );
  assert.ok(resolved({ set: ["ext.hnDigest.articleTextMaxBytes=4096", "browser.capture.textMaxBytes=4096"] }).ok);
});

test("resolveLiveConfig never opens a secret file: an <ENV>_FILE name is recognized and not read", () => {
  const r = resolveLiveConfig({ env: { POMTREED_MODEL_UPSTREAM_KEY_FILE: "/operator/secret" }, set: [], readFile: noFile });
  assert.ok(r.ok, JSON.stringify(r));
});

test("parseLiveArgs: --config and repeatable --set are carried; --image must be a digest pin or a local image id", () => {
  const base = ["--output-dir", "/out"];
  const a = parseLiveArgs([...base, "--config", "/c.json", "--set", "a=1", "--set", "b=2"]);
  assert.equal(a.configFile, "/c.json");
  assert.deepEqual(a.set, ["a=1", "b=2"]);
  assert.deepEqual(parseLiveArgs(base).set, []);
  const hex = "0123456789abcdef".repeat(4);
  for (const ok of [`pomtree/agent@sha256:${hex}`, `sha256:${hex}`]) {
    assert.ok(isPinnedImage(ok), ok);
    assert.equal(parseLiveArgs([...base, "--image", ok]).image, ok);
  }
  for (const bad of ["pomtree/agent:dev", "pomtree/agent", `sha256:${hex.slice(1)}`, `agent@sha256:${hex.toUpperCase()}`, `a@b@sha256:${hex}`])
    assert.throws(() => parseLiveArgs([...base, "--image", bad]), /--image must be a digest pin/, bad);
});

test("liveContainerConfig is the delivered subset of the resolved values and is accepted by the container document producer", () => {
  const values = { ...CONTENT_CONFIG_DEFAULTS, "browser.capture.textMaxBytes": 4096 };
  const subset = liveContainerConfig(values);
  assert.equal(subset["browser.capture.textMaxBytes"], 4096);
  assert.deepEqual(
    Object.keys(subset).sort(),
    containerParamDefs(CONFIG_REGISTRY)
      .map((p) => p.path)
      .sort(),
  );
  assert.match(containerConfigDoc(CONFIG_REGISTRY, subset), /"browser\.capture\.textMaxBytes":4096/);
});

// The worker's process slack (packages/agent-image/ext/pomtree-browser/index.ts, not exported) read from its source, never copied.
const CAPTURE_PROCESS_SLACK_MS = Number(
  /const CAPTURE_PROCESS_SLACK_MS = ([0-9_]+);/
    .exec(readFileSync(new URL("../../packages/agent-image/ext/pomtree-browser/index.ts", import.meta.url), "utf8"))?.[1]
    ?.replaceAll("_", ""),
);

test("browser deadline ladder: the article child outlives the browser run and its wrap-up, and the capture call fits the browser run", () => {
  assert.ok(Number.isSafeInteger(CAPTURE_PROCESS_SLACK_MS) && CAPTURE_PROCESS_SLACK_MS > 0, "slack read from the extension source");
  assert.ok(BROWSER_DEADLINE_MS >= BROWSER_LIMITS.maxMs + BROWSER_WRAPUP_MS);
  // At the default and at the largest value the registry admits (ext.hnDigest.articleBrowserCaptureDeadlineMs <= browser.capture.deadlineMaxMs).
  const largest = resolveLiveConfig({
    env: {},
    set: [`ext.hnDigest.articleBrowserCaptureDeadlineMs=${CONTENT_CONFIG_DEFAULTS["browser.capture.deadlineMaxMs"]}`],
    readFile: noFile,
  });
  assert.ok(largest.ok);
  for (const b of [DEFAULT_CONTENT_BOUNDS, contentBounds(largest.values)])
    assert.ok(b.browserCaptureDeadlineMs + CAPTURE_PROCESS_SLACK_MS < BROWSER_LIMITS.maxMs, String(b.browserCaptureDeadlineMs));
});
