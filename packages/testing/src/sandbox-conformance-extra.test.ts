import assert from "node:assert/strict";
import { test } from "node:test";
import { SANDBOX_CONFORMANCE_CLAUSES, evaluateSandboxConformance, fakeSandboxUnderTest } from "./sandbox-conformance.ts";
import type { Clause, ClauseId, ConformanceReport, SandboxConformanceHooks, SandboxUnderTest } from "./sandbox-conformance.ts";
import { EXTENDED_CONFORMANCE_CLAUSES } from "./sandbox-conformance-extra.ts";
import { SimulatedProvider, breakMode, providerHooks, providerSandbox } from "./sandbox-broken.ts";
import type { BreakModeName } from "./sandbox-broken.ts";

const IDS = ["user-agent-stamped", "no-sentinel-in-env"] as const satisfies readonly ClauseId[];
const only = (...ids: string[]): readonly Clause[] => SANDBOX_CONFORMANCE_CLAUSES.filter((c) => ids.includes(c.id));
const result = (r: ConformanceReport, id: string) => r.results.find((x) => x.id === id);
const failure = (r: ConformanceReport, id: string) => {
  const x = result(r, id);
  return x?.status === "failed" ? x.error.message : "";
};
const failedIds = (r: ConformanceReport) =>
  r.results
    .filter((x) => x.status === "failed")
    .map((x) => x.id)
    .sort();

// The shared fake behind a SimulatedProvider (one per world), optionally with a mode applied and hooks edited.
function descriptor(opts: { mode?: BreakModeName; secretsInEnv?: boolean; edit?: (hooks: ReturnType<typeof providerHooks>) => SandboxConformanceHooks } = {}) {
  let provider = new SimulatedProvider();
  const live = () => provider;
  const sut: SandboxUnderTest = fakeSandboxUnderTest({
    hooks: opts.edit ? opts.edit(providerHooks(live)) : providerHooks(live),
    wrap: (fake) => {
      provider = new SimulatedProvider();
      provider.secretsInEnv = opts.secretsInEnv ?? false;
      const base = providerSandbox(fake, provider);
      return opts.mode ? breakMode(opts.mode).mode.wrap(base, { provider }) : base;
    },
  });
  return sut;
}

test("registry: the extended clauses are registered once, each with a title and a fix", () => {
  assert.deepEqual(
    EXTENDED_CONFORMANCE_CLAUSES.map((c) => c.id),
    [...IDS],
  );
  for (const id of IDS) {
    assert.equal(SANDBOX_CONFORMANCE_CLAUSES.filter((c) => c.id === id).length, 1, `${id} is registered exactly once`);
  }
});

test("skip: a descriptor without the hooks skips both clauses with the not-declared prefix, never silently", async () => {
  const r = await evaluateSandboxConformance(fakeSandboxUnderTest(), { clauses: only(...IDS) });
  assert.deepEqual(failedIds(r), []);
  const ua = result(r, "user-agent-stamped");
  const env = result(r, "no-sentinel-in-env");
  assert.ok(ua?.status === "skipped" && /^conformance not declared: descriptor provides no requests hook/.test(ua.reason));
  assert.ok(env?.status === "skipped" && /^conformance not declared: descriptor provides no secrets hook/.test(env.reason));
});

test("green: over a correct provider both clauses pass, with secretsInEnv off and on", async () => {
  for (const secretsInEnv of [false, true]) {
    const r = await evaluateSandboxConformance(descriptor({ secretsInEnv }), { clauses: only(...IDS) });
    for (const id of IDS) assert.equal(result(r, id)?.status, "passed", `${id} (secretsInEnv ${secretsInEnv}): ${failure(r, id)}`);
  }
});

test("arm: with secretsInEnv on, an adapter that leaves the secret out of the environment fails the positive arm", async () => {
  const sut = descriptor({
    edit: (hooks) => ({ ...hooks, secrets: { ...hooks.secrets, secretsInEnv: true } }), // the lane says on, the adapter (secretsInEnv off) does not comply
  });
  const r = await evaluateSandboxConformance(sut, { clauses: only("no-sentinel-in-env") });
  assert.match(failure(r, "no-sentinel-in-env"), /secretsInEnv is set but the planted secret is absent/);
});

test("arm: an adapter whose create-time environment lacks the spec's variables fails, so an empty observation is not a pass", async () => {
  const sut = descriptor({ edit: (hooks) => ({ ...hooks, secrets: { ...hooks.secrets, createEnv: () => ({}) } }) });
  const r = await evaluateSandboxConformance(sut, { clauses: only("no-sentinel-in-env") });
  assert.match(failure(r, "no-sentinel-in-env"), /lacks the variable the clause set/);
});

test("arm: a requests hook that observed nothing fails user-agent-stamped instead of passing", async () => {
  const sut = descriptor({ edit: (hooks) => ({ ...hooks, requests: { expectedUserAgent: "pomtree", observe: () => [] } }) });
  const r = await evaluateSandboxConformance(sut, { clauses: only("user-agent-stamped") });
  assert.match(failure(r, "user-agent-stamped"), /observed no request/);
});

test("arm: a request with a different User-Agent fails, not only a missing one", async () => {
  const sut = descriptor({ edit: (hooks) => ({ ...hooks, requests: { expectedUserAgent: "another-agent", observe: () => hooks.requests.observe() } }) });
  const r = await evaluateSandboxConformance(sut, { clauses: only("user-agent-stamped") });
  assert.match(failure(r, "user-agent-stamped"), /without the configured User-Agent "another-agent"/);
});

// One per break mode: over the correct provider the named clause passes, over the same provider broken in one way exactly that clause
// fails, on the assertion the mode breaks.
for (const [mode, clause, fails] of [
  ["drops-user-agent", "user-agent-stamped", /without the configured User-Agent/],
  ["sentinel-in-env", "no-sentinel-in-env", /appears in the create-time environment variable\(s\)/],
  ["sentinel-in-env-key", "no-sentinel-in-env", /variable\(s\) CONFORMANCE_<secret>/],
  ["env-never-set", "no-sentinel-in-env", /could not be observed/],
] as const) {
  test(`${mode === "sentinel-in-env-key" ? "variant" : "negative"}: ${mode} fails ${clause} on its own assertion and nothing else`, async () => {
    const good = await evaluateSandboxConformance(descriptor(), { clauses: only(...IDS) });
    assert.equal(result(good, clause)?.status, "passed", `${clause} must pass over the correct provider: ${failure(good, clause)}`);
    const bad = await evaluateSandboxConformance(descriptor({ mode }), { clauses: only(...IDS) });
    assert.deepEqual(failedIds(bad), [clause], `only ${clause} may fail: ${JSON.stringify(bad.results.map((x) => [x.id, x.status]))}`);
    assert.match(failure(bad, clause), fails);
    const other = IDS.find((id) => id !== clause) as string;
    assert.equal(result(bad, other)?.status, "passed", `${other} must keep passing: ${failure(bad, other)}`);
  });
}
