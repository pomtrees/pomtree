import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserEvidence } from "../../agent-image/ext/pomtree-browser/browser.ts";
import { browserLimits } from "../../agent-image/src/browser-run.ts";
import { BROWSER_MAX_MS_RANGE, BROWSER_MAX_STEPS_RANGE } from "../../core/src/template.ts";
import { DirTemplateStore } from "../../template-dir/src/index.ts";

// The browser step and run-ms budgets are checked in three places: the template manifest (template-dir), the in-image
// budget reader (browserLimits), and the in-image step guard (browserEvidence, steps only). All three must agree at the
// boundaries. The literal ranges below are the spec; the core constants must equal them.

const SPEC = { steps: { min: 1, max: 256 }, ms: { min: 1000, max: 600_000 } } as const;
const BOUNDARY = (r: { min: number; max: number }) => [
  { value: r.min, accept: true },
  { value: r.max, accept: true },
  { value: r.min - 1, accept: false },
  { value: r.max + 1, accept: false },
];

test("core's browser range constants equal the spec", () => {
  assert.deepEqual({ ...BROWSER_MAX_STEPS_RANGE }, SPEC.steps);
  assert.deepEqual({ ...BROWSER_MAX_MS_RANGE }, SPEC.ms);
});

test("browserLimits accepts and rejects the same step and ms boundaries as the spec", () => {
  for (const { value, accept } of BOUNDARY(SPEC.steps)) {
    const env = { PTREE_BROWSER_MAX_STEPS: String(value), PTREE_BROWSER_MAX_MS: "1000" };
    if (accept) assert.deepEqual(browserLimits(env), { steps: value, ms: 1000 }, `steps=${value}`);
    else assert.throws(() => browserLimits(env), /budgets/, `steps=${value}`);
  }
  for (const { value, accept } of BOUNDARY(SPEC.ms)) {
    const env = { PTREE_BROWSER_MAX_STEPS: "1", PTREE_BROWSER_MAX_MS: String(value) };
    if (accept) assert.deepEqual(browserLimits(env), { steps: 1, ms: value }, `ms=${value}`);
    else assert.throws(() => browserLimits(env), /budgets/, `ms=${value}`);
  }
});

test("browserEvidence accepts and rejects the same step boundaries as the spec", () => {
  const deps = (maxSteps: number) => ({ maxSteps, publish: async () => ({ id: "x", sha256: "0".repeat(64) }), record: () => {} });
  for (const { value, accept } of BOUNDARY(SPEC.steps)) {
    if (accept) assert.ok(browserEvidence(deps(value)), `maxSteps=${value}`);
    else assert.throws(() => browserEvidence(deps(value)), /invalid browser step budget/, `maxSteps=${value}`);
  }
});

test("the template manifest validator accepts and rejects the same boundaries as the spec", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "contract-ranges-"));
  try {
    const store = new DirTemplateStore({ root });
    const AUDITED = { kind: "audited-public" };
    // Returns "accepted" or the validator's message; a rejection must name the field so an unrelated failure cannot pass.
    const verdict = async (browser: Record<string, number>, field: "maxSteps" | "maxMs") => {
      const name = `t-${field}-${Math.random().toString(36).slice(2, 8)}`;
      writeFileSync(join(root, `${name}.json`), JSON.stringify({ egress: AUDITED, browser }));
      try {
        const t = await store.resolve(name as never);
        return t ? "accepted" : "absent";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, new RegExp(`browser\\.${field} must be an integer`));
        return "rejected";
      }
    };
    for (const { value, accept } of BOUNDARY(SPEC.steps)) {
      assert.equal(await verdict({ maxSteps: value, maxMs: 1000 }, "maxSteps"), accept ? "accepted" : "rejected", `maxSteps=${value}`);
    }
    for (const { value, accept } of BOUNDARY(SPEC.ms)) {
      assert.equal(await verdict({ maxSteps: 1, maxMs: value }, "maxMs"), accept ? "accepted" : "rejected", `maxMs=${value}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
