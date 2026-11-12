import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { IdempotencyConflictError } from "@pomtree/core";
import { CLAUSE_IDS, evaluateSandboxConformance, fakeSandboxUnderTest } from "./sandbox-conformance.ts";
import type { ClauseId, ConformanceReport } from "./sandbox-conformance.ts";
import { BREAK_MODES, brokenSandbox, conflictingSandbox, newBreakEnv } from "./sandbox-broken.ts";
import type { BreakEnv, BreakMode } from "./sandbox-broken.ts";
import { FakeSandbox } from "./fakes.ts";

const statusOf = (r: ConformanceReport) => Object.fromEntries(r.results.map((x) => [x.id, x.status]));
const failedIds = (r: ConformanceReport) =>
  r.results
    .filter((x) => x.status === "failed")
    .map((x) => x.id)
    .sort();
const messages = (r: ConformanceReport) => r.results.flatMap((x) => (x.status === "failed" ? [`${x.id}: ${x.error.message}`] : [])).join(" | ");

test("registry: every clause id has exactly one break mode, with a unique name", () => {
  assert.deepEqual(Object.keys(BREAK_MODES).sort(), [...CLAUSE_IDS].sort());
  const names = Object.values(BREAK_MODES).map((m) => m.name);
  assert.equal(new Set(names).size, names.length);
  for (const [clause, mode] of Object.entries(BREAK_MODES) as [ClauseId, BreakMode][]) {
    assert.ok(!mode.collateral.includes(clause), `${mode.name} lists its own clause as collateral`);
  }
});

// The proof each clause can fail: over a correct sandbox the clause passes and nothing fails; over the same sandbox broken in one way,
// exactly the named clause and the mode's declared collateral fail, the failure message shows the intended assertion fired, and every
// other check keeps its status. A clause with several assertions has one variant per assertion the first would hide.
for (const clause of CLAUSE_IDS) {
  const entry: BreakMode = BREAK_MODES[clause];
  for (const mode of [entry, ...(entry.also ?? [])]) {
    test(`break mode ${mode.name} fails ${clause} and exactly its collateral [${mode.collateral.join(", ")}]`, async () => {
      // Each world gets its own engine; the descriptor's hooks read the engine of the world being run.
      const descriptor = (broken: boolean) => {
        let world = newBreakEnv();
        const live: BreakEnv = {
          get engine() {
            return world.engine;
          },
        };
        return fakeSandboxUnderTest({
          ...entry.enable?.descriptor(live),
          wrap: (fake) => {
            world = newBreakEnv();
            const base = entry.enable ? entry.enable.reference(fake, world) : fake;
            return broken ? mode.wrap(base, world) : base;
          },
        });
      };
      const good = await evaluateSandboxConformance(descriptor(false));
      assert.deepEqual(failedIds(good), [], `the correct sandbox must pass everything: ${messages(good)}`);
      assert.equal(statusOf(good)[clause], "passed", `${clause} must run and pass over the correct sandbox (an enabled clause is never skipped)`);

      const bad = await evaluateSandboxConformance(descriptor(true));
      assert.equal(statusOf(bad)[clause], "failed", `${mode.name} must fail ${clause}: ${JSON.stringify(statusOf(bad))}`);
      assert.deepEqual(failedIds(bad), [clause, ...mode.collateral].sort(), `failures must be ${clause} plus the collateral only: ${messages(bad)}`);
      const named = bad.results.find((x) => x.id === clause);
      assert.ok(named?.status === "failed");
      assert.match(named.error.message, mode.fails, `${clause} failed, but not on the assertion ${mode.name} breaks`);
      const unchanged = (r: ConformanceReport) =>
        Object.fromEntries(Object.entries(statusOf(r)).filter(([id]) => id !== clause && !(mode.collateral as readonly string[]).includes(id)));
      assert.deepEqual(unchanged(bad), unchanged(good), "every other check keeps the status it has over the correct sandbox");
    });
  }
}

test("brokenSandbox: a mode name that does not exist is refused with the names to use", () => {
  assert.throws(
    () => brokenSandbox(new FakeSandbox(), "no-such-mode" as never),
    (e: unknown) => e instanceof Error && /unknown break mode "no-such-mode"/.test(e.message) && /swallow-exit-code/.test(e.message),
  );
});

test("brokenSandbox: a mode that needs a facet or the engine the sandbox lacks says so", () => {
  assert.throws(() => brokenSandbox(new FakeSandbox(), "drop-as-eof"), /needs a sandbox with the connect facet.*run it over a sandbox that declares it/);
  assert.throws(() => brokenSandbox(new FakeSandbox(), "unpinned-newer-call"), /needs the simulated engine.*pass newBreakEnv\(\)/);
});

test("conflictingSandbox: a start that failed does not claim its key, so a later start with another spec is not a conflict", async () => {
  const fake = new FakeSandbox();
  const sandbox = conflictingSandbox(fake);
  const spec = (image: string) => ({ agent: "a", image, env: {}, mounts: [] });
  fake.startErrors.push(new Error("provider refused the first start"));
  await assert.rejects(() => sandbox.start(spec("one"), "k"), /provider refused/);
  await sandbox.start(spec("two"), "k");
  await assert.rejects(() => sandbox.start(spec("three"), "k"), IdempotencyConflictError);
});

// ---- the exhaustiveness negative control ----

const root = join(import.meta.dirname, "..", "..", "..");
const brokenFile = join(import.meta.dirname, "sandbox-broken.ts");

test("negative: the fixture that adds a clause id without a mode stops the type check with TS1360 naming it", () => {
  const tsc = join(root, "node_modules", "typescript", "lib", "tsc.js");
  const r = spawnSync(process.execPath, [tsc, "--noEmit", "-p", join(root, "packages", "testing", "tsconfig.negative.json")], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, `the fixture that omits a mode must not compile; tsc printed: ${out}`);
  assert.match(out, /sandbox-broken-missing-mode\.fixture\.ts.*error TS1360/);
  assert.match(out, /Property '"clause-added-without-a-mode"' is missing/);
});

// Compiles the REAL sandbox-broken.ts, with its text changed by `mutate`, and returns the diagnostics as "TS<code> message".
function compileBroken(mutate: (source: string) => string): string[] {
  const ts: typeof import("typescript") = createRequire(join(root, "package.json"))("typescript");
  const cfg = ts.getParsedCommandLineOfConfigFile(
    join(root, "packages", "testing", "tsconfig.json"),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  assert.ok(cfg, "the testing tsconfig must parse");
  const host = ts.createCompilerHost(cfg.options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) =>
    name === brokenFile
      ? ts.createSourceFile(name, mutate(readFileSync(name, "utf8")), cfg.options.target ?? ts.ScriptTarget.ES2023, true)
      : original(name, ...rest);
  const program = ts.createProgram([brokenFile], cfg.options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

const dropLifecycleMode = (src: string) => {
  const from = src.indexOf('\n  "lifecycle-run": {\n');
  const to = src.indexOf('\n  "attach-existing": {\n');
  assert.ok(from > 0 && to > from, "the lifecycle-run entry must be found in the table");
  return src.slice(0, from) + src.slice(to);
};
const SATISFIES = "} as const satisfies Record<ClauseId, BreakMode>;";

test("negative: the real table is exhaustive because of its own satisfies (removing a mode is TS1360; removing the satisfies silences that)", () => {
  assert.deepEqual(
    compileBroken((src) => src),
    [],
    "the unmodified table must compile cleanly",
  );
  const missing = compileBroken(dropLifecycleMode);
  assert.ok(
    missing.some((d) => d.startsWith("TS1360") && d.includes("Property '\"lifecycle-run\"' is missing")),
    `a table without the lifecycle-run mode must fail its satisfies check; got ${JSON.stringify(missing)}`,
  );
  const unchecked = compileBroken((src) => {
    assert.ok(src.includes(SATISFIES), "the table must end with the satisfies clause this control removes");
    return dropLifecycleMode(src).replace(SATISFIES, "} as const;");
  });
  assert.ok(!unchecked.some((d) => d.startsWith("TS1360")), `without the satisfies the omission is not a TS1360; got ${JSON.stringify(unchecked)}`);
});
