import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxCapabilityError, SandboxOutcomeUnknownError, SandboxProbeError, type Sandbox, type SandboxSpec } from "@pomtree/core";
import { FakeSandbox } from "@pomtree/testing";
import { FACET_OF, type FacetCapability } from "@pomtree/core";
import { FACET_METHODS, guardSandbox, protectSandbox, rateLimitFailures, traceSandbox, type SandboxTraceRecord } from "./sandbox-guard.ts";

const SENTINEL = "SENTINEL-7c1f-do-not-trace";

const filesFacet = (calls: string[] = []) => ({
  put: async (id: string) => void calls.push(`put ${id}`),
  get: async (id: string) => {
    calls.push(`get ${id}`);
    return { body: (async function* () {})(), sha256: Promise.resolve("00") };
  },
});
const terminalFacet = (calls: string[] = []) => ({
  open: async (id: string) => {
    calls.push(`open ${id}`);
    return undefined as never;
  },
});

const spec = (): SandboxSpec => ({ host: "host-test", generation: 0, agent: "a1", image: "img@sha256:00", env: { TOKEN: SENTINEL }, mounts: [] });

function logs() {
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  return { events, log: (event: string, fields: Record<string, unknown>) => void events.push({ event, fields }) };
}

function capError(fn: () => unknown, capability: string): SandboxCapabilityError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SandboxCapabilityError, `expected SandboxCapabilityError, got ${String(e)}`);
    assert.equal(e.capability, capability);
    assert.match(e.message, /does not support/);
    assert.ok(e.action.length > 20, "the error names an action");
    return e;
  }
  assert.fail("expected the access to throw");
}

test("guard: a facet the declaration denies is refused even though the provider carries it, and logged once", async () => {
  const calls: string[] = [];
  const raw = new FakeSandbox([], "graceful", { declaration: { capabilities: { terminal: false } }, facets: { terminal: terminalFacet(calls) } });
  assert.ok(raw.terminal, "control: the raw provider does expose the denied facet");
  const l = logs();
  const guarded = guardSandbox(raw, { backend: "fake", log: l.log });
  const e = capError(() => guarded.terminal, "terminal");
  assert.match(e.action, /declares terminal false/);
  capError(() => guarded.terminal, "terminal");
  assert.deepEqual(calls, []);
  assert.equal(l.events.length, 1);
  assert.equal(l.events[0]?.event, "facet-undeclared");
  assert.equal(l.events[0]?.fields.facet, "terminal");
});

test("guard: an undeclared facet is unreachable, and a facet that is simply absent is refused the same way without a log", () => {
  const raw = new FakeSandbox([], "graceful", { facets: { files: filesFacet() } }); // files.put and files.get default to false
  const l = logs();
  const guarded = guardSandbox(raw, { backend: "fake", log: l.log });
  capError(() => guarded.files, "files.put");
  for (const absent of ["connect", "snapshots", "lease", "pause", "images"] as const) {
    capError(
      () => guarded[absent],
      { connect: "connect", snapshots: "snapshot.disk", lease: "lease.extend", pause: "pause", images: "image.template" }[absent],
    );
  }
  assert.equal(Object.keys(guarded).includes("files"), false, "a denied facet is not enumerable");
  assert.equal(l.events.length, 1, "only the carried facet is a conformance fault");
});

test("guard: a capability declared true without its facet fails closed at wrap time, naming cause and action", () => {
  const raw = new FakeSandbox([], "graceful", { declaration: { capabilities: { pause: true } }, facets: {} });
  assert.throws(
    () => guardSandbox(raw, { backend: "fake", log: () => {} }),
    (e: unknown) =>
      e instanceof SandboxCapabilityError && e.capability === "pause" && /provides no pause facet/.test(e.message) && /fix the adapter/.test(e.action),
  );
});

test("guard: a declared facet is reachable and its calls reach the provider unchanged", async () => {
  const calls: string[] = [];
  const raw = new FakeSandbox([], "graceful", {
    declaration: { capabilities: { "files.put": true, "files.get": true } },
    facets: { files: filesFacet(calls) },
  });
  const guarded = guardSandbox(raw, { backend: "fake", log: () => {} });
  await guarded.files?.put("s1", "/x", (async function* () {})(), "00", "k");
  await guarded.files?.get("s1", "/x", 10);
  assert.deepEqual(calls, ["put s1", "get s1"]);
});

test("guard: a facet method is gated by its own capability (files.put declared, files.get not)", async () => {
  const calls: string[] = [];
  const raw = new FakeSandbox([], "graceful", { declaration: { capabilities: { "files.put": true } }, facets: { files: filesFacet(calls) } });
  const guarded = guardSandbox(raw, { backend: "fake", log: () => {} });
  await guarded.files?.put("s1", "/x", (async function* () {})(), "00", "k");
  await assert.rejects(
    async () => guarded.files?.get("s1", "/x", 10),
    (e: unknown) => e instanceof SandboxCapabilityError && e.capability === "files.get",
  );
  assert.deepEqual(calls, ["put s1"]);
});

test("guard: a probe that withholds a capability removes the facet, including a reference taken earlier", async () => {
  const calls: string[] = [];
  const raw = new FakeSandbox([], "graceful", { facets: { terminal: terminalFacet(calls) }, probe: { withheld: [], problems: [], account: null } });
  const guarded = guardSandbox(raw, { backend: "fake", log: () => {} });
  const early = guarded.terminal;
  await early?.open("s1");
  raw.probeResult = { withheld: ["terminal"], problems: [], account: null };
  await guarded.probe?.();
  await assert.rejects(
    async () => early?.open("s2"),
    (e: unknown) => e instanceof SandboxCapabilityError && /withheld terminal/.test(e.message),
  );
  const e = capError(() => guarded.terminal, "terminal");
  assert.match(e.action, /readiness probe withheld/);
  assert.deepEqual(calls, ["open s1"]);
});

test("guard: a probe that widens the declaration is refused with SandboxProbeError and narrows nothing", async () => {
  const raw = new FakeSandbox([], "graceful", { facets: { terminal: terminalFacet() }, probe: { withheld: ["pause"], problems: [], account: null } }); // pause is declared false
  const guarded = guardSandbox(raw, { backend: "fake", log: () => {} });
  await assert.rejects(async () => guarded.probe?.(), SandboxProbeError);
  assert.ok(guarded.terminal);
});

for (const [name, wrap] of [
  ["guard", (s: Sandbox) => guardSandbox(s, { backend: "fake", log: () => {} })],
  ["trace", (s: Sandbox) => traceSandbox(s, { backend: "fake", sink: () => {} })],
  ["protect", (s: Sandbox) => protectSandbox(s, { backend: "fake", log: () => {}, sink: () => {} })],
] as const) {
  test(`${name}: identity fields, results and error classes pass through`, async () => {
    const raw = new FakeSandbox([0]);
    const wrapped = wrap(raw);
    assert.deepEqual(wrapped.declaration, raw.declaration);
    assert.notEqual(wrapped.declaration, raw.declaration, "the exposed declaration is a copy");
    assert.ok(Object.isFrozen(wrapped.declaration) && Object.isFrozen(wrapped.declaration.capabilities) && Object.isFrozen(wrapped.declaration.billing));
    const handle = await wrapped.start(spec(), "key-1");
    assert.equal(handle.id, "sbx-1");
    assert.equal(await wrapped.inspect(handle.id).then((r) => r?.running !== undefined), true);
    assert.equal(typeof handle.output, "function");
    const unknown = new SandboxOutcomeUnknownError("sbx-9", "key-9");
    raw.start = async () => {
      throw unknown;
    };
    await assert.rejects(
      () => wrapped.start(spec(), "key-9"),
      (e: unknown) => e === unknown && e instanceof SandboxOutcomeUnknownError,
    );
  });
}

test("trace: every port and facet call emits one record with op, sandbox id, outcome and duration", async () => {
  const raw = new FakeSandbox([0], "graceful", { declaration: { capabilities: { "files.put": true } }, facets: { files: filesFacet() } });
  const records: SandboxTraceRecord[] = [];
  let t = 100;
  const traced = traceSandbox(raw, { backend: "fake", sink: (r) => void records.push(r), now: () => (t += 5) });
  const h = await traced.start(spec(), "key-1");
  await traced.files?.put(h.id, "/p", (async function* () {})(), "00", "k");
  await traced.stop(h.id, 0, "k2");
  await traced.imageIdentity("img:tag");
  assert.deepEqual(
    records.map((r) => [r.op, r.sandbox, r.outcome, r.durationMs]),
    [
      ["start", "sbx-1", "ok", 5],
      ["files.put", "sbx-1", "ok", 5],
      ["stop", "sbx-1", "ok", 5],
      ["imageIdentity", undefined, "ok", 5],
    ],
  );
});

test("trace: an error is recorded by class name only, never its message, and rethrown unchanged", async () => {
  const raw = new FakeSandbox();
  raw.stop = async () => {
    throw new SandboxOutcomeUnknownError("sbx-3", SENTINEL);
  };
  const records: SandboxTraceRecord[] = [];
  const traced = traceSandbox(raw, { backend: "fake", sink: (r) => void records.push(r) });
  await assert.rejects(() => traced.stop("sbx-3", 0, "k"), SandboxOutcomeUnknownError);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.outcome, "error");
  assert.equal(records[0]?.errorClass, "SandboxOutcomeUnknownError");
  assert.equal(records[0]?.sandbox, "sbx-3");
});

test("trace: no request body, env, credential or file bytes appears in any record", async () => {
  const raw = new FakeSandbox([0], "graceful", { declaration: { capabilities: { "files.put": true, "files.get": true } }, facets: { files: filesFacet() } });
  raw.start = async (s) => {
    if (s.env.TOKEN === SENTINEL) throw new Error(`rejected ${SENTINEL}`);
    throw new Error("sentinel missing from the spec");
  };
  const records: SandboxTraceRecord[] = [];
  const traced = traceSandbox(raw, { backend: "fake", sink: (r) => void records.push(r) });
  await assert.rejects(() => traced.start(spec(), SENTINEL));
  async function* bytes() {
    yield new TextEncoder().encode(SENTINEL);
  }
  await traced.files?.put("sbx-1", "/x", bytes(), "00", "k");
  await traced.resultWork("sbx-1", { maxBytes: 1 }).catch(() => {});
  assert.ok(records.length >= 3);
  assert.equal(JSON.stringify(records).includes(SENTINEL), false, JSON.stringify(records));
});

test("trace: a sink that throws or rejects does not affect the call or its result", async () => {
  const raw = new FakeSandbox([0]);
  const throwing = traceSandbox(raw, {
    backend: "fake",
    sink: () => {
      throw new Error("sink down");
    },
  });
  const h = await throwing.start(spec(), "key-1");
  assert.equal(h.id, "sbx-1");
  const rejecting = traceSandbox(raw, { backend: "fake", sink: () => Promise.reject(new Error("sink async down")) });
  assert.notEqual(await rejecting.inspect(h.id), null);
  raw.kill = async () => {
    throw new SandboxOutcomeUnknownError("sbx-1", "k");
  };
  await assert.rejects(() => throwing.kill(h.id, "k"), SandboxOutcomeUnknownError);
});

test("trace: returned streams are passed through without being consumed", async () => {
  const raw = new FakeSandbox();
  let pulled = false;
  const bundle = (async function* () {
    pulled = true;
    yield new Uint8Array([1]);
  })();
  raw.resultWork = async () => ({ dirty: true, fingerprint: "f", bundle });
  const traced = traceSandbox(raw, { backend: "fake", sink: () => {} });
  const r = await traced.resultWork("sbx-1", { maxBytes: 10 });
  assert.equal(r.bundle, bundle);
  assert.equal(pulled, false);
});

test("protect: a refused facet call is traced as an error and the denied facet is unreachable through the composition", async () => {
  const calls: string[] = [];
  const raw = new FakeSandbox([], "graceful", {
    declaration: { capabilities: { "files.put": true, terminal: false } },
    facets: { files: filesFacet(calls), terminal: terminalFacet(calls) },
  });
  const records: SandboxTraceRecord[] = [];
  const l = logs();
  const protectedSandbox = protectSandbox(raw, { backend: "fake", log: l.log, sink: (r) => void records.push(r) });
  capError(() => protectedSandbox.terminal, "terminal");
  await assert.rejects(async () => protectedSandbox.files?.get("sbx-1", "/x", 1), SandboxCapabilityError);
  assert.deepEqual(
    records.map((r) => [r.op, r.outcome, r.errorClass]),
    [["files.get", "error", "SandboxCapabilityError"]],
  );
  assert.deepEqual(calls, []);
  assert.equal(l.events.length, 1);
});

test("guard: a provider that mutates its declaration after wrap does not open a denied facet", async () => {
  const calls: string[] = [];
  const raw = new FakeSandbox([], "graceful", { facets: { files: filesFacet(calls), terminal: terminalFacet(calls) } });
  const guarded = guardSandbox(raw, { backend: "fake", log: () => {} });
  (raw.declaration.capabilities as Record<string, boolean>)["files.put"] = true;
  (raw.declaration.capabilities as Record<string, boolean>).terminal = false;
  capError(() => guarded.files, "files.put");
  assert.ok(guarded.terminal, "a capability narrowed by the provider afterwards does not close what was admitted either");
  assert.throws(() => {
    (guarded.declaration.capabilities as Record<string, boolean>)["files.put"] = true;
  }, TypeError);
  const traced = traceSandbox(raw, { backend: "fake", sink: () => {} });
  (raw.declaration.capabilities as Record<string, boolean>)["files.get"] = true;
  assert.equal(traced.declaration.capabilities["files.get"], false);
});

test("guard: later probes never widen what an earlier probe withheld", async () => {
  const raw = new FakeSandbox([], "graceful", { probe: { withheld: ["terminal"], problems: [], account: null } });
  const guarded = guardSandbox(raw, { backend: "fake", log: () => {} });
  await guarded.probe?.();
  capError(() => guarded.terminal, "terminal");
  raw.probeResult = { withheld: [], problems: [], account: null };
  await guarded.probe?.();
  capError(() => guarded.terminal, "terminal");
});

test("guard: snapshots.start needs a snapshot or fork capability and snapshots.remove only a snapshot capability", async () => {
  const calls: string[] = [];
  const snapshots = {
    create: async () => void calls.push("create") as never,
    start: async () => void calls.push("start") as never,
    remove: async () => void calls.push("remove"),
  };
  const raw = new FakeSandbox([], "graceful", { declaration: { capabilities: { fork: true } }, facets: { snapshots } });
  const guarded = guardSandbox(raw, { backend: "fake", log: () => {} });
  await guarded.snapshots?.start({} as never, spec(), "k");
  await assert.rejects(async () => guarded.snapshots?.remove({} as never, "k"), SandboxCapabilityError);
  await assert.rejects(async () => guarded.snapshots?.create("s", { memory: false }, "k"), SandboxCapabilityError);
  assert.deepEqual(calls, ["start"]);
});

test("guard: every facet capability is reachable when declared and refused when denied", async () => {
  for (const cap of Object.keys(FACET_OF) as FacetCapability[]) {
    const facet = FACET_OF[cap];
    const calls: string[] = [];
    const stub = Object.fromEntries(FACET_METHODS[facet].map((m) => [m, async () => void calls.push(m)]));
    const allowed = guardSandbox(new FakeSandbox([], "graceful", { declaration: { capabilities: { [cap]: true } }, facets: { [facet]: stub } }), {
      backend: "fake",
      log: () => {},
    });
    assert.ok(allowed[facet], `${cap} declared: ${facet} reachable`);
    const denied = guardSandbox(new FakeSandbox([], "graceful", { declaration: { capabilities: { [cap]: false } }, facets: { [facet]: stub } }), {
      backend: "fake",
      log: () => {},
    });
    const first = (Object.keys(FACET_OF) as FacetCapability[]).find((c) => FACET_OF[c] === facet) as FacetCapability;
    capError(() => denied[facet], first);
  }
});

test("trace: hostile provider values (constructor, id and then getters) never change the call outcome", async () => {
  const records: SandboxTraceRecord[] = [];
  const raw = new FakeSandbox();
  const traced = traceSandbox(raw, { backend: "fake", sink: (r) => void records.push(r) });

  const badClass = new Error("original");
  Object.defineProperty(badClass, "constructor", {
    get() {
      throw new Error("constructor getter");
    },
  });
  raw.stop = async () => {
    throw badClass;
  };
  await assert.rejects(
    () => traced.stop("sbx-1", 0, "k"),
    (e: unknown) => e === badClass,
  );

  const badName = new Error("original");
  Object.defineProperty(badName, "constructor", { value: { name: "Evil\nName ".repeat(20) } });
  raw.stop = async () => {
    throw badName;
  };
  await assert.rejects(
    () => traced.stop("sbx-1", 0, "k"),
    (e: unknown) => e === badName,
  );
  assert.equal(records.at(-1)?.errorClass, "Error", "an error class that is not a plain identifier is recorded as Error");

  const badId = {
    get id(): string {
      throw new Error("id getter");
    },
    output: () => (async function* () {})(),
    wait: async () => ({ exitCode: 0 }),
  };
  raw.start = async () => badId as never;
  assert.equal(await traced.start(spec(), "k"), badId);

  const hostile = {};
  // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the case under test
  Object.defineProperty(hostile, "then", {
    get() {
      throw new Error("then getter");
    },
  });
  raw.imageIdentity = (() => hostile) as never;
  assert.equal(traced.imageIdentity("img"), hostile);
});

test("rateLimitFailures: the first failure passes, repeats within the window are dropped, other keys and successes pass", () => {
  const seen: string[] = [];
  let t = 0;
  const sink = rateLimitFailures((r) => void seen.push(`${r.op}:${r.outcome}:${r.errorClass ?? ""}`), { windowMs: 1000, now: () => t });
  const rec = (op: string, outcome: "ok" | "error", errorClass?: string): SandboxTraceRecord => ({
    op,
    backend: "b",
    outcome,
    ...(errorClass && { errorClass }),
    durationMs: 1,
  });
  sink(rec("inspect", "error", "SandboxUnavailableError"));
  sink(rec("inspect", "error", "SandboxUnavailableError"));
  sink(rec("inspect", "error", "OtherError"));
  sink(rec("inspect", "ok"));
  sink(rec("inspect", "ok"));
  t = 1500;
  sink(rec("inspect", "error", "SandboxUnavailableError"));
  assert.deepEqual(seen, [
    "inspect:error:SandboxUnavailableError",
    "inspect:error:OtherError",
    "inspect:ok:",
    "inspect:ok:",
    "inspect:error:SandboxUnavailableError",
  ]);
});

test("loopback facet: traced with the sandbox id, passed through when declared, refused when denied", async () => {
  const records: SandboxTraceRecord[] = [];
  const traced = traceSandbox(new FakeSandbox(), { backend: "fake", sink: (r) => void records.push(r) });
  const h = await traced.start(spec(), "key-lb");
  const stream = await traced.loopback!.open(h.id, 9222);
  stream.close();
  assert.deepEqual(
    records.map((r) => [r.op, r.sandbox, r.outcome]),
    [
      ["start", "sbx-1", "ok"],
      ["loopback.open", "sbx-1", "ok"],
    ],
  );
  const denied = guardSandbox(new FakeSandbox([], "graceful", { declaration: { capabilities: { loopback: false } } }), { backend: "fake", log: () => {} });
  capError(() => denied.loopback, "loopback");
  assert.ok(guardSandbox(new FakeSandbox(), { backend: "fake", log: () => {} }).loopback, "a declared loopback facet is reachable");
});
