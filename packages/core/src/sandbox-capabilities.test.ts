import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACET_OF,
  SANDBOX_CAPABILITIES,
  SANDBOX_TAGS,
  SandboxCapabilityError,
  SandboxProbeError,
  SandboxUnavailableError,
  admitBackend,
  checkProbe,
  need,
  ownerStampTags,
  readOwnerStamp,
  sandboxIdForKey,
  validateDeclaration,
} from "./index.ts";
import type { BackendNeeds, FacetCapability, ProbeResult, Sandbox, SandboxCapability, SandboxDeclaration, SandboxFacets } from "./index.ts";

// Compile-time controls (C-3): the unions must stay closed. If "events" ever becomes a capability, these lines no longer error and
// `npx tsc -p packages/core` fails on the unused directive.
// @ts-expect-error "events" is not a capability
export const notACapability: SandboxCapability = "events";
// @ts-expect-error "events" is not a facet capability
export const notAFacetCapability: FacetCapability = "events";
// @ts-expect-error "connect" is a facet capability but "list.byTag" is not
export const noFacet: FacetCapability = "list.byTag";

const EVERYTHING: Record<SandboxCapability, boolean> = {
  terminal: true,
  connect: true,
  loopback: true,
  "files.put": true,
  "files.get": true,
  "files.volume": true,
  "mounts.host": true,
  "image.ociPull": true,
  "image.template": true,
  "image.digestAttest": true,
  "snapshot.disk": true,
  "snapshot.memory": true,
  fork: true,
  pause: true,
  "list.byTag": true,
  "egress.denyAll": true,
  "egress.allowHost": true,
  "egress.allowCidr": true,
  "reach.outbound": true,
  "reach.exposedPort": true,
  "reach.hostAlias": true,
  "secrets.env": true,
  "secrets.proxySwap": true,
  "resources.limits": true,
  "isolation.gvisor": true,
  "isolation.microvm": true,
  "lease.extend": true,
};

function decl(over: Partial<Record<SandboxCapability, boolean>> = {}, rest: Partial<SandboxDeclaration> = {}): SandboxDeclaration {
  return {
    backend: "fake",
    capabilities: { ...EVERYTHING, ...over },
    region: null,
    idempotency: "unique-name",
    idempotencyWindowMs: null,
    tagging: "metadata",
    output: "stream",
    maxLifetimeMs: null,
    preemptible: false,
    billing: { unit: "none", whileStopped: false, whilePaused: false },
    ...rest,
  };
}

// EVERYTHING is a full literal, so adding a capability without updating it fails to compile (no unchecked cast).
const { terminal: _omitted, ...MISSING_TERMINAL } = EVERYTHING;
// @ts-expect-error a declaration literal missing one capability key does not type-check
export const incomplete: SandboxDeclaration = { ...decl(), capabilities: MISSING_TERMINAL };

// Facet coverage (compile-time): every key of SandboxFacets must be a value of FACET_OF, so a facet cannot ship without a capability.
type Uncovered<F> = Exclude<keyof F, (typeof FACET_OF)[FacetCapability]>;
export const everyFacetHasACapability: [Uncovered<SandboxFacets>] extends [never] ? true : never = true;
// Negative control: a facet with no capability must make the same check fail.
// @ts-expect-error "orphan" is a facet key that no capability realises
export const orphanFacetIsCaught: [Uncovered<SandboxFacets & { orphan?: unknown }>] extends [never] ? true : never = true;

const NEEDS: BackendNeeds = {
  egress: true,
  daemonReach: true,
  terminal: true,
  workspace: "mount",
  secrets: { agentToken: false, envAllowed: false },
};
const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({ withheld: [], problems: [], account: null, ...over });

test("the capability set is pinned exactly", () => {
  assert.deepEqual(
    [...SANDBOX_CAPABILITIES],
    [
      "terminal",
      "connect",
      "loopback",
      "files.put",
      "files.get",
      "files.volume",
      "mounts.host",
      "image.ociPull",
      "image.template",
      "image.digestAttest",
      "snapshot.disk",
      "snapshot.memory",
      "fork",
      "pause",
      "list.byTag",
      "egress.denyAll",
      "egress.allowHost",
      "egress.allowCidr",
      "reach.outbound",
      "reach.exposedPort",
      "reach.hostAlias",
      "secrets.env",
      "secrets.proxySwap",
      "resources.limits",
      "isolation.gvisor",
      "isolation.microvm",
      "lease.extend",
    ],
  );
  assert.equal(new Set(SANDBOX_CAPABILITIES).size, SANDBOX_CAPABILITIES.length);
  for (const c of Object.keys(FACET_OF)) assert.ok((SANDBOX_CAPABILITIES as readonly string[]).includes(c), c);
});

test("SANDBOX_TAGS names the five tag keys", () => {
  assert.deepEqual(SANDBOX_TAGS, {
    sandbox: "pomtree.sandbox",
    agent: "pomtree.agent",
    backend: "pomtree.backend",
    host: "pomtree.host",
    generation: "pomtree.generation",
  });
});

test("sandboxIdForKey is sha256 hex, byte-identical to the Docker adapter's derivation", () => {
  // Vector from createHash("sha256").update("agent-1:1:start").digest("hex"), the expression Docker's idForKey uses.
  assert.equal(sandboxIdForKey("agent-1:1:start"), "ea05bcb01d228888fcb175c5a4b3b702d844b2091f968f670b8c885371533c9c");
  assert.equal(sandboxIdForKey("agent-1:1:start"), sandboxIdForKey("agent-1:1:start"));
  assert.notEqual(sandboxIdForKey("agent-1:1:start"), sandboxIdForKey("agent-1:2:start"));
  assert.match(sandboxIdForKey(""), /^[0-9a-f]{64}$/);
});

test("validateDeclaration accepts a complete declaration", () => {
  assert.deepEqual(validateDeclaration(decl()), []);
  assert.deepEqual(validateDeclaration(decl({}, { backend: "e2b-prod2", idempotency: "native-token", idempotencyWindowMs: 86_400_000 })), []);
});

test("validateDeclaration refuses each defect with a cause and an action", () => {
  const one = (d: SandboxDeclaration, needle: RegExp) => {
    const out = validateDeclaration(d);
    assert.equal(out.length, 1, out.join("\n"));
    assert.match(out[0] as string, needle);
  };
  for (const backend of ["Docker", "e2b:prod", "a_b", "", "a b"]) one(decl({}, { backend }), /not lowercase/);
  one(decl({}, { idempotency: "none" }), /idempotency "none".*implement/);
  one(decl({ fork: true, "snapshot.disk": false, "snapshot.memory": false }), /fork without snapshot/);
  assert.deepEqual(validateDeclaration(decl({ fork: true, "snapshot.disk": false, "snapshot.memory": true })), []);
  const partial = decl();
  const caps: Record<string, boolean> = { ...partial.capabilities };
  delete caps.terminal;
  one({ ...partial, capabilities: caps as Record<SandboxCapability, boolean> }, /does not answer capabilities terminal/);
  one({ ...partial, capabilities: { ...partial.capabilities, events: true } as Record<SandboxCapability, boolean> }, /unknown capabilities events/);
  one(decl({}, { tagging: "x" as "metadata" }), /tagging/);
  one(decl({}, { maxLifetimeMs: -1 }), /maxLifetimeMs/);
  one(decl({}, { idempotency: "uuid" as "unique-name" }), /idempotency "uuid"/);
  one(decl({}, { output: "push" as "stream" }), /output "push"/);
  one(decl({}, { billing: { unit: "day" as "hour", whileStopped: false, whilePaused: false } }), /billing unit "day"/);
  one(decl({ terminal: "yes" as unknown as boolean }), /does not answer capabilities terminal/);
  one(decl({}, { idempotencyWindowMs: undefined as unknown as number }), /idempotencyWindowMs undefined/);
});

test("admitBackend admits a full backend with nothing degraded", () => {
  assert.deepEqual(admitBackend(decl(), null, NEEDS), { ok: true, degraded: [] });
  assert.deepEqual(admitBackend(decl(), probe(), NEEDS), { ok: true, degraded: [] });
});

test("admitBackend degrades convenience gaps and names each fallback", () => {
  const r = admitBackend(
    decl({
      "mounts.host": false,
      terminal: false,
      pause: false,
      "lease.extend": false,
      "snapshot.disk": false,
      "snapshot.memory": false,
      fork: false,
      "list.byTag": false,
      "image.ociPull": false,
    }),
    null,
    NEEDS,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const by = new Map(r.degraded.map((x) => [x.capability, x.fallback]));
  assert.match(by.get("mounts.host") ?? "", /git bundle.*connect/);
  assert.match(by.get("terminal") ?? "", /typed error/);
  assert.match(by.get("pause") ?? "", /resume fresh/);
  assert.match(by.get("lease.extend") ?? "", /80%/);
  assert.match(by.get("snapshot.disk") ?? "", /git bundle/);
  assert.match(by.get("list.byTag") ?? "", /client-side/);
  assert.match(by.get("image.ociPull") ?? "", /images\.prepare/);
  // terminal is only degraded when the config needs it
  const quiet = admitBackend(decl({ terminal: false }), null, { ...NEEDS, terminal: false });
  assert.ok(quiet.ok && !quiet.degraded.some((x) => x.capability === "terminal"));
  // tarball fallback when connect is absent
  const tar = admitBackend(decl({ "mounts.host": false, connect: false, "reach.outbound": true }), null, NEEDS);
  assert.ok(tar.ok && tar.degraded.some((x) => x.capability === "mounts.host" && /tarball/.test(x.fallback)));
});

test("admitBackend refuses security- and reach-bearing gaps with cause and action", () => {
  const refused = (r: ReturnType<typeof admitBackend>, cap: SandboxCapability | null) => {
    assert.equal(r.ok, false);
    if (r.ok) return;
    const hit = r.refusals.find((x) => x.capability === cap);
    assert.ok(hit, JSON.stringify(r.refusals));
    assert.ok(hit.cause.length > 0 && hit.action.length > 0);
    assert.match(hit.cause, /fake/);
  };
  refused(admitBackend(decl({ "egress.allowHost": false, "egress.denyAll": false }), null, NEEDS), "egress.allowHost");
  refused(admitBackend(decl({ "egress.allowHost": false, connect: false }), null, NEEDS), "egress.allowHost");
  // denyAll plus connect is enough
  assert.equal(admitBackend(decl({ "egress.allowHost": false }), null, NEEDS).ok, true);
  // egress not needed: no refusal
  assert.equal(admitBackend(decl({ "egress.allowHost": false, "egress.denyAll": false }), null, { ...NEEDS, egress: false }).ok, true);
  refused(admitBackend(decl({ connect: false, "reach.outbound": false, "mounts.host": false }), null, NEEDS), "connect");
  refused(admitBackend(decl({ "resources.limits": false }), null, NEEDS), "resources.limits");
  refused(admitBackend(decl({ "isolation.gvisor": false }), null, { ...NEEDS, isolation: "gvisor" }), "isolation.gvisor");
  assert.equal(admitBackend(decl({ "isolation.gvisor": false }), null, NEEDS).ok, true);
  refused(admitBackend(decl({ "image.ociPull": false, "image.template": false }), null, NEEDS), "image.ociPull");
  refused(
    admitBackend(decl({ "mounts.host": false, connect: false, "files.put": false, "reach.outbound": true, "egress.allowHost": true }), null, NEEDS),
    "mounts.host",
  );
  refused(
    admitBackend(decl({ "mounts.host": false, connect: false, "files.get": false, "reach.outbound": true }), null, { ...NEEDS, workspace: "staged" }),
    "connect",
  );
});

test("admitBackend treats probe.withheld as false and turns probe.problems into refusals", () => {
  const withheld = admitBackend(decl(), probe({ withheld: ["resources.limits"] }), NEEDS);
  assert.equal(withheld.ok, false);
  if (!withheld.ok) {
    assert.equal(withheld.refusals[0]?.capability, "resources.limits");
    assert.match(withheld.refusals[0]?.cause ?? "", /withheld by the backend's readiness probe/);
  }
  const degrades = admitBackend(decl(), probe({ withheld: ["pause"] }), NEEDS);
  assert.ok(degrades.ok && degrades.degraded.some((x) => x.capability === "pause"));
  const problems = admitBackend(decl(), probe({ problems: [{ code: "auth", cause: "credential rejected", action: "set sandbox.fake.token" }] }), NEEDS);
  assert.equal(problems.ok, false);
  if (!problems.ok) {
    assert.deepEqual(problems.refusals, [
      { capability: null, cause: "backend fake is not ready: credential rejected (auth)", action: "set sandbox.fake.token" },
    ]);
  }
});

test("checkProbe accepts a narrowing probe", () => {
  checkProbe(decl(), probe());
  checkProbe(decl({ pause: false }), probe({ withheld: ["terminal", "connect"], account: "ab12" }));
  checkProbe(decl(), probe({ problems: [{ code: "x", cause: "c", action: "a" }] }));
});

test("checkProbe throws SandboxProbeError on a widening or malformed probe (negative control)", () => {
  const widens = (r: unknown, needle: RegExp, d = decl({ pause: false })) => {
    assert.throws(
      () => checkProbe(d, r as ProbeResult),
      (e: unknown) => e instanceof SandboxProbeError && e.backend === "fake" && needle.test(e.widened.join("|")) && /fix the adapter/.test(e.message),
    );
  };
  widens(probe({ withheld: ["pause"] }), /withheld pause, which is not declared true/);
  widens({ withheld: ["events"], problems: [], account: null }, /unknown capability/);
  widens(null, /not an object/);
  widens({ problems: [], account: null }, /withheld is not an array/);
  widens({ withheld: [], account: null }, /problems is not an array/);
  widens({ withheld: [], problems: [{ code: "x" }], account: null }, /problems\[0\]/);
  widens({ withheld: [], problems: [], account: 5 }, /account/);
});

test("admitBackend fails closed: a malformed or widening probe throws instead of reading as all available", () => {
  const throwsProbe = (r: unknown, d = decl({ pause: false })) =>
    assert.throws(
      () => admitBackend(d, r as ProbeResult, NEEDS),
      (e: unknown) => e instanceof SandboxProbeError && e.backend === "fake",
    );
  throwsProbe({ problems: [] });
  throwsProbe({ withheld: [], account: null });
  throwsProbe(probe({ withheld: ["pause"] }));
  throwsProbe(probe({ withheld: ["events" as SandboxCapability] }));
  throwsProbe("ok");
  // control: the well-formed narrowing probe still admits
  assert.equal(admitBackend(decl({ pause: false }), probe(), NEEDS).ok, true);
});

test("admitBackend secret-delivery row: a delivered credential needs connect, or secrets.env with the operator opt-in", () => {
  const needs = (envAllowed: boolean): BackendNeeds => ({ ...NEEDS, secrets: { agentToken: true, envAllowed } });
  const refusal = (r: ReturnType<typeof admitBackend>) => {
    assert.equal(r.ok, false);
    if (r.ok) return;
    const hit = r.refusals.find((x) => x.capability === "secrets.env");
    assert.ok(hit, JSON.stringify(r.refusals));
    assert.match(hit.cause, /credential.*backend fake/);
    assert.ok(hit.action.length > 0);
  };
  // connect delivers over the daemon channel
  assert.equal(admitBackend(decl(), null, needs(false)).ok, true);
  // no connect: env delivery only with the opt-in
  const noConnect = decl({ connect: false, "reach.outbound": true });
  assert.equal(admitBackend(noConnect, null, needs(true)).ok, true);
  refusal(admitBackend(noConnect, null, needs(false)));
  // no connect and no secrets.env: refused even with the opt-in
  refusal(admitBackend(decl({ connect: false, "secrets.env": false, "reach.outbound": true }), null, needs(true)));
  // a withheld capability counts as false
  refusal(admitBackend(noConnect, probe({ withheld: ["secrets.env"] }), needs(true)));
  assert.equal(admitBackend(decl(), probe({ withheld: ["connect"] }), needs(false)).ok, false);
  // no credential needed: nothing is refused
  assert.equal(admitBackend(decl({ connect: false, "secrets.env": false, "reach.outbound": true }), null, NEEDS).ok, true);
  // proxySwap is preferred, never required
  assert.equal(admitBackend(decl({ "secrets.proxySwap": false }), null, needs(false)).ok, true);
  const swap = admitBackend(decl({ connect: false, "secrets.proxySwap": true, "secrets.env": false, "reach.outbound": true }), null, needs(true));
  assert.equal(swap.ok, false);
});

test("admitBackend isolation row: each runtime needs its own capability and never falls back", () => {
  const refusalFor = (r: ReturnType<typeof admitBackend>, cap: SandboxCapability) => {
    assert.equal(r.ok, false);
    if (r.ok) return;
    const hit = r.refusals.find((x) => x.capability === cap);
    assert.ok(hit, JSON.stringify(r.refusals));
    assert.match(hit.cause, /fake.*never falls back/);
    assert.ok(hit.action.length > 0);
  };
  for (const iso of ["gvisor", "microvm"] as const) {
    const cap = `isolation.${iso}` as SandboxCapability;
    const other = (iso === "gvisor" ? "isolation.microvm" : "isolation.gvisor") as SandboxCapability;
    const needs: BackendNeeds = { ...NEEDS, isolation: iso };
    assert.equal(admitBackend(decl(), null, needs).ok, true);
    refusalFor(admitBackend(decl({ [cap]: false }), null, needs), cap);
    // the other runtime does not satisfy it
    refusalFor(admitBackend(decl({ [cap]: false, [other]: true }), null, needs), cap);
    // withheld by the probe
    refusalFor(admitBackend(decl(), probe({ withheld: [cap] }), needs), cap);
    // not asked for: no refusal
    assert.equal(admitBackend(decl({ [cap]: false }), null, NEEDS).ok, true);
  }
});

test("admitBackend degrades image.digestAttest when absent or withheld", () => {
  for (const r of [
    admitBackend(decl({ "image.digestAttest": false }), null, NEEDS),
    admitBackend(decl(), probe({ withheld: ["image.digestAttest"] }), NEEDS),
  ]) {
    assert.ok(r.ok && r.degraded.some((x) => x.capability === "image.digestAttest" && /registry/.test(x.fallback)), JSON.stringify(r));
  }
});

function fakeSandbox(over: Partial<Record<SandboxCapability, boolean>>, facets: Partial<Sandbox>): Sandbox {
  return { declaration: decl(over), ...facets } as Sandbox;
}

test("need returns the facet when declared and present", () => {
  const files = { put: async () => {}, get: async () => ({ body: (async function* () {})(), sha256: Promise.resolve("") }) };
  const s = fakeSandbox({}, { files });
  assert.equal(need(s, "files.put"), files);
  assert.equal(need(s, "files.get"), files);
  const snapshots = { create: async () => ({}), start: async () => ({}), remove: async () => {} } as unknown as Sandbox["snapshots"];
  const withSnapshots = fakeSandbox({}, { snapshots });
  assert.equal(need(withSnapshots, "fork"), snapshots);
  assert.equal(need(withSnapshots, "snapshot.disk"), snapshots);
});

test("need throws SandboxCapabilityError for declared-false and for a declared-true missing facet (negative control)", () => {
  const files = { put: async () => {}, get: async () => ({ body: (async function* () {})(), sha256: Promise.resolve("") }) };
  assert.throws(
    () => need(fakeSandbox({ pause: false }, { files }), "pause"),
    (e: unknown) =>
      e instanceof SandboxCapabilityError && e.backend === "fake" && e.capability === "pause" && /does not support pause; choose a backend/.test(e.message),
  );
  // declared false although the facet is present: still refused
  assert.throws(() => need(fakeSandbox({ "files.put": false }, { files }), "files.put"), SandboxCapabilityError);
  const snapshots = { create: async () => ({}), start: async () => ({}), remove: async () => {} } as unknown as Sandbox["snapshots"];
  assert.throws(
    () => need(fakeSandbox({ fork: false }, { snapshots }), "fork"),
    (e: unknown) => e instanceof SandboxCapabilityError && e.capability === "fork" && /does not support fork/.test(e.message),
  );
  // declared true, facet missing: adapter bug
  assert.throws(
    () => need(fakeSandbox({}, {}), "files.put"),
    (e: unknown) => e instanceof SandboxCapabilityError && e.capability === "files.put" && /provides no files facet; fix the adapter/.test(e.message),
  );
});

test("SandboxUnavailableError keeps the bare default and names cause and action when given a reason", () => {
  assert.equal(new SandboxUnavailableError().message, "sandbox unavailable");
  for (const reason of ["engine-unreachable", "auth", "provider-outage", "not-found"] as const) {
    const e = new SandboxUnavailableError(reason);
    assert.equal(e.reason, reason);
    assert.ok(e.message.includes(reason), e.message);
    assert.match(e.message, /; (start|check|wait|restart|re)/i, e.message);
  }
  // an explicit message still wins
  assert.equal(new SandboxUnavailableError("auth", "custom").message, "custom");
});

test("SandboxProbeError message is accurate for malformed results as well as withholding", () => {
  const e = new SandboxProbeError("fake", ["withheld is not an array"]);
  assert.match(e.message, /malformed or widens/);
  assert.match(e.message, /withheld is not an array/);
  assert.match(e.message, /fix the adapter/);
});

test("ownerStampTags stamps the host and the generation under the reserved tag keys", () => {
  assert.deepEqual(ownerStampTags({ host: "host-a", generation: 0 }), { "pomtree.host": "host-a", "pomtree.generation": "0" });
  assert.deepEqual(ownerStampTags({ host: "h".repeat(300), generation: 12 })["pomtree.generation"], "12");
});

test("ownerStampTags refuses a host or generation no provider could hold, naming the cause and the action", () => {
  for (const host of ["", "a\nb", "a\u0000b"]) assert.throws(() => ownerStampTags({ host, generation: 1 }), /host id .*non-empty.*pass the daemon's host id/s);
  for (const generation of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => ownerStampTags({ host: "h", generation }), /non-negative integer.*pass the agent's generation/s);
  }
});

test("readOwnerStamp reads a stamp back strictly: missing or damaged values read as null", () => {
  assert.deepEqual(readOwnerStamp({ "pomtree.host": "host-a", "pomtree.generation": "7" }), { host: "host-a", generation: 7 });
  assert.deepEqual(readOwnerStamp({}), { host: null, generation: null });
  assert.deepEqual(readOwnerStamp({ "pomtree.host": "", "pomtree.generation": "" }), { host: null, generation: null });
  for (const bad of [" 1", "1.5", "-1", "0x10", "1e3", "NaN", "99999999999999999999"]) {
    assert.equal(readOwnerStamp({ "pomtree.host": "h", "pomtree.generation": bad }).generation, null, bad);
  }
});
