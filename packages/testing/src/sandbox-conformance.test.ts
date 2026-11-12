import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { IdempotencyConflictError, LOOPBACK_PORTS, SandboxOutcomeUnknownError } from "@pomtree/core";
import type { Sandbox, SandboxSpec } from "@pomtree/core";
import type { FakeSandbox } from "./fakes.ts";
import { tmpDir } from "./tmp.ts";
import { CLAUSE_IDS, SANDBOX_CONFORMANCE_CLAUSES, conformanceSummary, evaluateSandboxConformance, fakeSandboxUnderTest } from "./sandbox-conformance.ts";
import type { Clause, ClauseResult, ConformanceReport, FakeUnderTestOptions, SandboxUnderTest } from "./sandbox-conformance.ts";

// A deliberately broken sandbox: the fake with some members replaced. Methods stay bound to the fake so its private state works.
function broken(fake: FakeSandbox, overrides: Record<string, unknown>): Sandbox {
  return new Proxy(fake, {
    get(t, p) {
      if (typeof p === "string" && p in overrides) return overrides[p];
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as unknown as Sandbox;
}

const only = (...ids: string[]): readonly Clause[] => SANDBOX_CONFORMANCE_CLAUSES.filter((c) => ids.includes(c.id));
const status = (r: ConformanceReport, id: string) => r.results.find((x) => x.id === id)?.status;
const failure = (r: ConformanceReport, id: string) => {
  const x = r.results.find((y) => y.id === id);
  return x?.status === "failed" ? x.error.message : "";
};
const failedIds = (r: ConformanceReport) => r.results.filter((x) => x.status === "failed").map((x) => x.id);
const skips = (r: ConformanceReport) => Object.fromEntries(r.results.flatMap((x) => (x.status === "skipped" ? [[x.id, x.reason]] : [])));

// Asserts the skip set is EXACTLY `expected` (id -> reason pattern) and that nothing failed: a capability the fake gains or loses turns this red.
function assertExactSkips(r: ConformanceReport, expected: Record<string, RegExp>) {
  assert.deepEqual(failedIds(r), [], `no check may fail: ${r.results.flatMap((x) => (x.status === "failed" ? [x.error.message] : [])).join(" | ")}`);
  const got = skips(r);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(expected).sort(), `unexpected skip set; skips were: ${JSON.stringify(got)}`);
  for (const [id, re] of Object.entries(expected)) assert.match(got[id] ?? "", re, `skip reason of ${id}`);
}

// RED against the broken descriptor (the named clauses fail), then green against the correct one (the same clauses pass).
async function redThenGreen(broke: SandboxUnderTest, good: SandboxUnderTest, ids: string[]) {
  const red = await evaluateSandboxConformance(broke, { clauses: only(...ids) });
  for (const id of ids) assert.equal(status(red, id), "failed", `${id} must fail on the broken sandbox: ${JSON.stringify(red.results)}`);
  const green = await evaluateSandboxConformance(good, { clauses: only(...ids) });
  for (const id of ids) assert.equal(status(green, id), "passed", `${id} must pass on the fake: ${failure(green, id)}`);
  return red;
}

const brokenFake = (overrides: (fake: FakeSandbox) => Record<string, unknown>, o: FakeUnderTestOptions = {}) =>
  fakeSandboxUnderTest({ ...o, wrap: (fake) => broken(fake, overrides(fake)) });

test("registry: every final clause id is registered once, with a rule and a fix", () => {
  assert.deepEqual(
    SANDBOX_CONFORMANCE_CLAUSES.map((c) => c.id),
    [...CLAUSE_IDS],
  );
  assert.equal(new Set(CLAUSE_IDS).size, CLAUSE_IDS.length);
  for (const c of SANDBOX_CONFORMANCE_CLAUSES) assert.ok(c.title.length > 0 && c.fix.length > 0, c.id);
});

test("fake: the exact skip set of the remote fake, every other check passes", async () => {
  const r = await evaluateSandboxConformance(fakeSandboxUnderTest());
  assertExactSkips(r, {
    "idempotency-conflict": /startConflict/,
    "foreign-backend-record": /foreignRecord hook/,
    "api-version-pin": /engineApiVersion/,
  });
  assert.equal(status(r, "declaration"), "passed");
  assert.equal(status(r, "probe"), "passed");
  assert.match(r.summary, /^conformance: 19 passed, 0 failed, 3 skipped \(idempotency-conflict: .*; foreign-backend-record: .*; api-version-pin: .*\)$/);
});

test("fake: a fake that loses its remote capabilities skips exactly the connect and files clauses, each saying not declared", async () => {
  const r = await evaluateSandboxConformance(fakeSandboxUnderTest({ remote: false }));
  assertExactSkips(r, {
    "idempotency-conflict": /startConflict/,
    "foreign-backend-record": /foreignRecord hook/,
    "api-version-pin": /engineApiVersion/,
    "channel-drop-throws": /^conformance not declared: capability connect not declared by fake$/,
    "files-hash-mismatch": /^conformance not declared: capability files\.put not declared by fake; capability files\.get not declared by fake$/,
    "files-partial-upload": /^conformance not declared: capability files\.put not declared by fake$/,
  });
});

test("fake: a fake with no probe skips both probe clauses with a printed reason", async () => {
  const r = await evaluateSandboxConformance(fakeSandboxUnderTest({ probe: false }));
  assert.match(skips(r)["probe-subset"] ?? "", /no probe/);
  assert.match(skips(r)["probe-widening-fails"] ?? "", /no probe/);
});

test("summary: counts and the printed reasons form one line", () => {
  const results: ClauseResult[] = [
    { id: "a", status: "passed" },
    { id: "b", status: "passed" },
    { id: "c", status: "failed", error: new Error("x") },
    { id: "d", status: "skipped", reason: "capability files.put not declared by fake" },
  ];
  assert.equal(conformanceSummary(results), "conformance: 2 passed, 1 failed, 1 skipped (d: capability files.put not declared by fake)");
  assert.equal(conformanceSummary([{ id: "a", status: "passed" }]), "conformance: 1 passed, 0 failed, 0 skipped");
  assert.equal(conformanceSummary([{ id: "a", status: "gated", reason: "no docker" }]), "conformance: 0 passed, 0 failed, 0 skipped, 1 gated (no docker)");
});

test("gating: requireCapabilities turns a capability skip into a failure naming the capability", async () => {
  const r = await evaluateSandboxConformance(fakeSandboxUnderTest({ remote: false, requireCapabilities: ["files.put"] }), {
    clauses: only("files-partial-upload", "channel-drop-throws"),
  });
  assert.equal(status(r, "files-partial-upload"), "failed");
  assert.match(failure(r, "files-partial-upload"), /requires files\.put/);
  assert.equal(status(r, "channel-drop-throws"), "skipped", "a capability that is not required still skips");
});

test("gating: a closed environment gates every check without building a sandbox", async () => {
  const sut: SandboxUnderTest = {
    ...fakeSandboxUnderTest(),
    gate: () => "no engine",
    make: async () => {
      throw new Error("make must not run while gated");
    },
  };
  const r = await evaluateSandboxConformance(sut);
  assert.ok(r.results.every((x) => x.status === "gated"));
  assert.match(r.summary, /0 passed, 0 failed, 0 skipped, 22 gated \(conformance gated: no engine\)$/);
});

test("vacuity: a clause whose check never calls its targets fails", async () => {
  const idle: Clause = { id: "idle", title: "idle", needs: [], targets: ["probe", "list"], fix: "call the targets", check: async () => {} };
  const r = await evaluateSandboxConformance(fakeSandboxUnderTest(), { clauses: [idle] });
  assert.equal(status(r, "idle"), "failed");
  assert.match(failure(r, "idle"), /never called its target method\(s\) probe, list/);
});

test("mutation: an undeclared files facet that no-ops fails unsupported-capability-throws, the plain fake passes", async () => {
  const noop = { put: async () => {}, get: async () => ({ body: (async function* () {})(), sha256: Promise.resolve("") }) };
  const red = await redThenGreen(
    brokenFake(() => ({ files: noop }), { remote: false }),
    fakeSandboxUnderTest({ remote: false }),
    ["unsupported-capability-throws"],
  );
  assert.match(failure(red, "unsupported-capability-throws"), /must throw SandboxCapabilityError|declares different|need\(/);
});

test("mutation: api-version-pin runs when engineApiVersion is set, passes on a pinned client and fails on an unpinned one", async () => {
  const pinned = { apiVersion: () => "1.40", newerOnlyCall: async () => Promise.reject(new Error("API version too new")) };
  const unpinned = { apiVersion: () => "1.40", newerOnlyCall: async () => {} };
  const red = await redThenGreen(
    fakeSandboxUnderTest({ engineApiVersion: "1.40", hooks: { engine: unpinned } }),
    fakeSandboxUnderTest({ engineApiVersion: "1.40", hooks: { engine: pinned } }),
    ["api-version-pin"],
  );
  assert.match(failure(red, "api-version-pin"), /newer engine API version/);
  const wrongPin = await evaluateSandboxConformance(fakeSandboxUnderTest({ engineApiVersion: "1.41", hooks: { engine: pinned } }), {
    clauses: only("api-version-pin"),
  });
  assert.match(failure(wrongPin, "api-version-pin"), /pin the declared engine API version/);
});

test("mutation: idempotency-conflict passes on a keyed-fingerprint start and fails on the plain fake", async () => {
  const conflicting = (fake: FakeSandbox) => {
    const seen = new Map<string, string>();
    return {
      start: async (spec: SandboxSpec, key: string) => {
        const fp = JSON.stringify(spec);
        const prior = seen.get(key);
        if (prior !== undefined && prior !== fp) throw new IdempotencyConflictError("sandbox.start", key);
        seen.set(key, fp);
        return fake.start(spec, key);
      },
    };
  };
  const green = await evaluateSandboxConformance(brokenFake(conflicting, { startConflict: true }), { clauses: only("idempotency-conflict") });
  assert.equal(status(green, "idempotency-conflict"), "passed", failure(green, "idempotency-conflict"));
  const red = await evaluateSandboxConformance(fakeSandboxUnderTest({ startConflict: true }), { clauses: only("idempotency-conflict") });
  assert.equal(status(red, "idempotency-conflict"), "failed");
});

test("mutation: foreign-backend-record passes when attach names both backends and fails when it reports the sandbox gone", async () => {
  const hooks = { foreignRecord: () => ({ id: "foreign-1", backend: "other-backend" }) };
  const naming = (fake: FakeSandbox) => ({
    attach: async (id: string, agent: string) => {
      if (id === "foreign-1")
        throw new Error("sandbox foreign-1 was created under backend other-backend; the active backend is fake. Switch sandbox.backend back.");
      return fake.attach(id, agent);
    },
  });
  const green = await evaluateSandboxConformance(brokenFake(naming, { hooks }), { clauses: only("foreign-backend-record") });
  assert.equal(status(green, "foreign-backend-record"), "passed", failure(green, "foreign-backend-record"));
  const red = await evaluateSandboxConformance(fakeSandboxUnderTest({ hooks }), { clauses: only("foreign-backend-record") });
  assert.equal(status(red, "foreign-backend-record"), "failed");
  assert.match(failure(red, "foreign-backend-record"), /gone|name both/);
});

test("negative: a sandbox that ignores the idempotency key fails idempotent-start", async () => {
  let n = 0;
  const red = await redThenGreen(
    brokenFake((fake) => ({ start: (spec: SandboxSpec, key: string) => fake.start(spec, `${key}-${++n}`) })),
    fakeSandboxUnderTest(),
    ["idempotent-start"],
  );
  assert.match(failure(red, "idempotent-start"), /must return the same sandbox/);
});

test("negative: a list() that omits live sandboxes fails list-by-owner", async () => {
  const red = await redThenGreen(
    brokenFake(() => ({ list: async () => [] })),
    fakeSandboxUnderTest(),
    ["list-by-owner"],
  );
  assert.match(failure(red, "list-by-owner"), /must include the owner's labelled sandbox/);
});

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
async function* chunks(b: Uint8Array) {
  yield b;
}
// A files.put that really drains the stream; with `onBreak` it swallows a broken stream and hands on what arrived.
function putVia(fake: FakeSandbox, how: "skip-hash-verification" | "accept-broken-stream") {
  return async (id: string, path: string, body: AsyncIterable<Uint8Array>, sha: string, key: string) => {
    const parts: Uint8Array[] = [];
    let brokeStream = false;
    try {
      for await (const c of body) parts.push(c);
    } catch (e) {
      if (how === "skip-hash-verification") throw e;
      brokeStream = true;
    }
    const data = Buffer.concat(parts);
    // skip-hash-verification vouches for whatever arrived; accept-broken-stream verifies hashes but accepts a stream that broke
    return fake.files!.put(id, path, chunks(data), how === "skip-hash-verification" || brokeStream ? sha256(data) : sha, key);
  };
}

test("negative: files that skip hash verification, accept a broken stream or have no facet fail their files clauses", async () => {
  const none = await redThenGreen(
    brokenFake(() => ({ files: undefined })),
    fakeSandboxUnderTest(),
    ["files-hash-mismatch", "files-partial-upload"],
  );
  assert.match(failure(none, "files-hash-mismatch"), /declares files\.put but provides no files facet/);
  const unverified = await redThenGreen(
    brokenFake((fake) => ({ files: { get: fake.files!.get, put: putVia(fake, "skip-hash-verification") } })),
    fakeSandboxUnderTest(),
    ["files-hash-mismatch"],
  );
  assert.match(failure(unverified, "files-hash-mismatch"), /rejected|SandboxTransferError|did not reject|Missing expected rejection/i);
  const swallow = await evaluateSandboxConformance(
    brokenFake((fake) => ({ files: { get: fake.files!.get, put: putVia(fake, "accept-broken-stream") } })),
    { clauses: only("files-hash-mismatch", "files-partial-upload") },
  );
  assert.equal(status(swallow, "files-partial-upload"), "failed", "a stream that broke mid-upload must not be accepted");
  assert.equal(status(swallow, "files-hash-mismatch"), "passed", "hash verification is intact, so only the partial-upload clause fails");
});

test("negative: a probe that widens the declaration is caught by the probe clauses and the probe check", async () => {
  const widening = async () => ({ withheld: ["conformance.undeclared"], problems: [], account: null });
  const brokenSut = brokenFake(() => ({ probe: widening }));
  const red = await evaluateSandboxConformance(brokenSut, { clauses: only("probe-subset", "probe-widening-fails") });
  assert.equal(status(red, "probe-subset"), "failed");
  assert.equal(status(red, "probe-widening-fails"), "failed");
  assert.equal(status(red, "probe"), "failed", "a probe error is a failing check, never a skip");
  assert.match(failure(red, "probe-subset"), /widens its declaration/);
  const green = await evaluateSandboxConformance(fakeSandboxUnderTest(), { clauses: only("probe-subset", "probe-widening-fails") });
  assert.deepEqual([status(green, "probe-subset"), status(green, "probe-widening-fails"), status(green, "probe")], ["passed", "passed", "passed"]);
});

test("negative: an unknown create outcome that list(owner) cannot reconcile fails unknown-outcome-reconcile", async () => {
  const hidden = new Set<string>();
  const red = await redThenGreen(
    brokenFake((fake) => ({
      start: async (spec: SandboxSpec, key: string) => {
        try {
          return await fake.start(spec, key);
        } catch (e) {
          if (e instanceof SandboxOutcomeUnknownError) hidden.add(e.id);
          throw e;
        }
      },
      list: async (owner: Parameters<FakeSandbox["list"]>[0]) => (await fake.list(owner)).filter((l) => !hidden.has(l.id)),
    })),
    fakeSandboxUnderTest(),
    ["unknown-outcome-reconcile"],
  );
  assert.match(failure(red, "unknown-outcome-reconcile"), /found by list\(owner\) exactly once/);
});

test("mutation: listing tags are required by default, so a backend that drops the generation fails label-rules", async () => {
  const stamping = (generation: number | null) => (fake: FakeSandbox) => ({
    list: async (owner: Parameters<FakeSandbox["list"]>[0]) => (await fake.list(owner)).map((l) => ({ ...l, host: owner.host, generation })),
  });
  const green = await evaluateSandboxConformance(brokenFake(stamping(1), { listingTags: "required" }), { clauses: only("label-rules") });
  assert.equal(status(green, "label-rules"), "passed", failure(green, "label-rules"));
  const dropped = await evaluateSandboxConformance(brokenFake(stamping(null), { listingTags: "required" }), { clauses: only("label-rules") });
  assert.equal(status(dropped, "label-rules"), "failed");
  assert.match(failure(dropped, "label-rules"), /integer generation/);
  const plain = await evaluateSandboxConformance(fakeSandboxUnderTest({ listingTags: "required" }), { clauses: only("label-rules") });
  assert.equal(status(plain, "label-rules"), "failed", "the fake stamps nothing, so it needs listingTags optional (its descriptor default)");
});

test("mutation: a connect stream that never ends fails channel-drop-throws at its deadline instead of hanging", async () => {
  const hang = (fake: FakeSandbox) => ({
    connect: {
      open: async (id: string) => ({
        ...(await fake.connect!.open(id, "daemon-api")),
        write: async () => {},
        output: () =>
          (async function* () {
            await new Promise<never>(() => {});
          })(),
      }),
    },
  });
  const r = await evaluateSandboxConformance(brokenFake(hang, { deadlineMs: 50 }), { clauses: only("channel-drop-throws") });
  assert.equal(status(r, "channel-drop-throws"), "failed");
  assert.match(failure(r, "channel-drop-throws"), /did not finish within 50 ms/);
});

test("mutation: a loopback facet that accepts any port fails loopback-stream; the plain fake passes", async () => {
  const anyPort = (fake: FakeSandbox) => ({
    loopback: { open: (id: string) => fake.loopback!.open(id, LOOPBACK_PORTS[0]) },
  });
  const bad = await evaluateSandboxConformance(brokenFake(anyPort), { clauses: only("loopback-stream") });
  assert.equal(status(bad, "loopback-stream"), "failed");
  assert.match(failure(bad, "loopback-stream"), /RangeError/);
  const ok = await evaluateSandboxConformance(fakeSandboxUnderTest(), { clauses: only("loopback-stream") });
  assert.equal(status(ok, "loopback-stream"), "passed");
});

test("mutation: a SandboxCapabilityError without an action fails unsupported-capability-throws", async () => {
  const { SandboxCapabilityError } = await import("@pomtree/core");
  const noAction = () => {
    const e = new SandboxCapabilityError("fake", "files.put", "x");
    e.action = "";
    return e;
  };
  const r = await evaluateSandboxConformance(
    brokenFake(
      () => ({
        files: {
          put: async () => {
            throw noAction();
          },
          get: async () => {
            throw noAction();
          },
        },
      }),
      { remote: false },
    ),
    { clauses: only("unsupported-capability-throws") },
  );
  assert.equal(status(r, "unsupported-capability-throws"), "failed");
  assert.match(failure(r, "unsupported-capability-throws"), /carry an action/);
});

// The registration path: node:test cases, t.skip, the stderr summary and the after() floor, observed through a child node --test run of a generated file.
function runRegistered(mode: "plain" | "gated" | "gated-require" | "broken") {
  const dir = tmpDir("conformance-register-");
  const file = join(dir, "register.test.ts");
  const mod = pathToFileURL(join(import.meta.dirname, "sandbox-conformance.ts")).href;
  writeFileSync(
    file,
    `import { runSandboxConformance, fakeSandboxUnderTest } from ${JSON.stringify(mod)};
const mode = ${JSON.stringify(mode)};
const base = fakeSandboxUnderTest(mode === "broken" ? { wrap: (f) => new Proxy(f, { get: (t, p) => (p === "list" ? async () => [] : typeof t[p] === "function" ? t[p].bind(t) : t[p]) }) } : {});
runSandboxConformance(mode.startsWith("gated") ? { ...base, gate: () => "no engine", requireReal: mode === "gated-require" } : base);
`,
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", timeout: 60000, env });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test("registration: runSandboxConformance registers a case per check, skips by reason and prints the summary", () => {
  const r = runRegistered("plain");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /CONFORMANCE fake: conformance: 19 passed, 0 failed, 3 skipped \(/);
  assert.match(r.out, /ℹ skipped 3/);
  assert.match(r.out, /fake conformance idempotent-start/);
});

test("registration: a closed gate skips every check with the stable prefix and stays green without requireReal", () => {
  const r = runRegistered("gated");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /conformance gated: no engine/);
  assert.match(r.out, /ℹ skipped 22/);
});

test("registration: requireReal turns gated checks into a failure that names the cause and the action", () => {
  const r = runRegistered("gated-require");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /requireReal is set but 22 check\(s\) were gated/);
  assert.match(r.out, /open the gate/);
});

test("registration: a failing clause fails the run", () => {
  const r = runRegistered("broken");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /✖ fake conformance list-by-owner/);
});
