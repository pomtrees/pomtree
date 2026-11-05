import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_DEFAULTS, CONFIG_REGISTRY, CONTAINER_READER_SOURCE_PATH, containerConfigEnv, containerContractText } from "@pomtree/core";
import { BROWSER_REFUSED_EXIT, browserConfigRefusal } from "./browser-run.ts";
import { CONTAINER_CONFIG_ENV, CONTAINER_CONTRACT, CONTAINER_DEFAULTS, canonicalContainerDoc, readContainerConfig } from "./container-contract.gen.ts";

// This package ships two generated copies: src/ (browser-run.ts, browser-capture.ts) and ext/pomtree-browser/ (the extension).
const COPIES = [join(import.meta.dirname, "container-contract.gen.ts"), join(import.meta.dirname, "..", "ext", "pomtree-browser", "container-contract.gen.ts")];

test("both generated container contract copies equal a fresh regeneration from core (stale: run pnpm gen:config)", () => {
  const text = containerContractText(CONFIG_REGISTRY, readFileSync(CONTAINER_READER_SOURCE_PATH, "utf8"));
  for (const copy of COPIES) assert.equal(readFileSync(copy, "utf8"), text, `${copy} is stale: run pnpm gen:config`);
});

const VALID = containerConfigEnv(CONFIG_REGISTRY, CONFIG_DEFAULTS)[CONTAINER_CONFIG_ENV];
const doc = (values: object, contract = CONTAINER_CONTRACT) => canonicalContainerDoc(contract, values as Record<string, number | boolean>);

// Every way the worker's startup document can be wrong. Each must refuse the start; none may fall back to the image defaults.
const REFUSED: [string, Record<string, string>, RegExp][] = [
  ["missing document", {}, /not set/],
  ["tampered contract digest", { [CONTAINER_CONFIG_ENV]: doc(CONTAINER_DEFAULTS, "0123456789abcdef") }, /rebuild the image/],
  ["extra key", { [CONTAINER_CONFIG_ENV]: doc({ ...CONTAINER_DEFAULTS, "browser.capture.unbounded": 1 }) }, /unknown key/],
  [
    "missing key",
    { [CONTAINER_CONFIG_ENV]: doc({ ...CONTAINER_DEFAULTS, "browser.capture.textMaxBytes": undefined }) },
    /missing key browser\.capture\.textMaxBytes/,
  ],
  ["out-of-range value", { [CONTAINER_CONFIG_ENV]: doc({ ...CONTAINER_DEFAULTS, "browser.capture.textMaxBytes": 0 }) }, /below its minimum/],
  ["fractional value", { [CONTAINER_CONFIG_ENV]: doc({ ...CONTAINER_DEFAULTS, "browser.capture.screenshotMaxBytes": 1.5 }) }, /non-negative integer/],
  [
    "broken relation (deadline min >= max)",
    { [CONTAINER_CONFIG_ENV]: doc({ ...CONTAINER_DEFAULTS, "browser.capture.deadlineMinMs": 120000 }) },
    /must be < browser\.capture\.deadlineMaxMs/,
  ],
  ["not JSON", { [CONTAINER_CONFIG_ENV]: "{" }, /not valid JSON/],
  ["oversize", { [CONTAINER_CONFIG_ENV]: " ".repeat(16385) }, /exceeds the 16384-byte cap/],
  // A looser bound smuggled past the operator's: a duplicate key (JSON.parse keeps the last) is refused as non-canonical.
  [
    "duplicate key carrying a looser bound",
    {
      [CONTAINER_CONFIG_ENV]: VALID.replace(
        '"browser.capture.textMaxBytes":1048576',
        '"browser.capture.textMaxBytes":1048576,"browser.capture.textMaxBytes":2097152',
      ),
    },
    /not in canonical form/,
  ],
  // Per-key env names a hostile env might set are no channel: without the document the worker refuses, it never reads them.
  [
    "looser per-key env vars without the document",
    { POMTREED_BROWSER_CAPTURE_TEXT_MAX_BYTES: "1048576", POMTREED_BROWSER_CAPTURE_MAX_BYTES_CEILING: "8388608" },
    /not set/,
  ],
];

test("browserConfigRefusal accepts the producer's document and refuses every malformed, mismatched or smuggled one", () => {
  assert.equal(browserConfigRefusal({ [CONTAINER_CONFIG_ENV]: VALID }), undefined);
  for (const [name, env, why] of REFUSED) {
    const line = browserConfigRefusal(env);
    assert.ok(line, name);
    assert.match(line, /^browser worker refused to start: PTREE_CONFIG_JSON: /, name);
    assert.match(line, why, name);
    assert.doesNotMatch(line, /[\n\r]/, `${name}: one line`);
  }
});

test("a refusal line never echoes the document and is bounded even when a key name is long caller text", () => {
  const key = `x\n${"k".repeat(5000)}`;
  const line = browserConfigRefusal({ [CONTAINER_CONFIG_ENV]: doc({ ...CONTAINER_DEFAULTS, [key]: 1 }) }) ?? "";
  assert.ok(line.length <= 450, String(line.length));
  assert.doesNotMatch(line, /[\n\r]/);
  assert.ok(!line.includes(VALID));
});

test("hostile per-key env vars beside a valid document do not change the delivered bounds", () => {
  const cfg = readContainerConfig({ [CONTAINER_CONFIG_ENV]: VALID, POMTREED_BROWSER_CAPTURE_TEXT_MAX_BYTES: "1048576" }, { required: true });
  assert.deepEqual(cfg, CONTAINER_DEFAULTS);
});

// The real entrypoint, run as the image runs it. Neither Chromium nor Pi exists here: a refused document must exit before either is
// reached, and an accepted one must get past the gate (to the next startup check, the explicit run budgets, which are absent).
const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, [join(import.meta.dirname, "browser-run.ts"), "pi"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
    timeout: 30_000,
  });

test("browser-run.ts exits 1 with one stderr line before starting Chromium or Pi on each refused document", () => {
  assert.equal(BROWSER_REFUSED_EXIT, 1);
  for (const [name, env, why] of REFUSED) {
    const r = run(env);
    assert.equal(r.status, BROWSER_REFUSED_EXIT, name);
    assert.equal(r.stdout, "", name);
    const lines = r.stderr.trimEnd().split("\n");
    assert.equal(lines.length, 1, `${name}: ${r.stderr}`);
    assert.match(lines[0] ?? "", why, name);
    assert.doesNotMatch(r.stderr, /budgets|Chromium/, `${name}: the gate runs first`);
  }
});

test("browser-run.ts with a valid document passes the config gate and stops at the next check", () => {
  const r = run({ [CONTAINER_CONFIG_ENV]: VALID });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /refused to start/);
  assert.match(r.stderr, /explicit positive step \(<=256\) and whole-run ms \(1000\.\.600000\) budgets/);
});
