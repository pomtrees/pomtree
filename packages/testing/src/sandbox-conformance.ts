import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import {
  FACET_OF,
  IdempotencyConflictError,
  LOOPBACK_PORTS,
  SANDBOX_CAPABILITIES,
  SandboxCapabilityError,
  SandboxOutcomeUnknownError,
  SandboxTransferError,
  SandboxUnavailableError,
  checkProbe,
  need,
  validateDeclaration,
} from "@pomtree/core";
import type {
  FacetCapability,
  LoopbackPort,
  Sandbox,
  SandboxBackendId,
  SandboxCapability,
  SandboxDeclaration,
  SandboxFacets,
  SandboxHandle,
  SandboxId,
  SandboxOwner,
  SandboxSpec,
} from "@pomtree/core";
import { FakeSandbox, assertFacetPresence } from "./fakes.ts";
import type { FakeSandboxOptions } from "./fakes.ts";
import { SANDBOX_CAPABILITY_COVERAGE, coverageCounts, coverageTableFindings, suiteFloorFindings } from "./sandbox-capability-coverage.ts";
import type { CapabilityTable } from "./sandbox-capability-coverage.ts";
import { EXTENDED_CONFORMANCE_CLAUSES, NOT_DECLARED, needsHook } from "./sandbox-conformance-extra.ts";
import { FaultPlan, assertStartIdempotent } from "./sandbox-faults.ts";
import { realSetTimeout, scaled } from "./timing.ts";

// The Sandbox port conformance suite: a registry of named clauses, each declaring the capabilities it needs and the port methods it
// must call, run against a `SandboxUnderTest` descriptor. A clause whose capability the backend does not declare is reported as
// skipped with a printed reason; a clause whose capability is declared and fails is a failure, never a skip. `evaluateSandboxConformance`
// returns a report (for tests and the out-of-tree runner); `runSandboxConformance` registers one node:test case per clause.

// ---- descriptor ----

// Port methods a clause can name as targets: required methods by name, facet methods as `<facet>.<method>`.
export type PortMethod =
  | "start"
  | "attach"
  | "wait"
  | "stop"
  | "kill"
  | "inspect"
  | "list"
  | "probe"
  | "imageIdentity"
  | "reclaim"
  | "resultWork"
  | "terminal.open"
  | "connect.open"
  | "loopback.open"
  | "files.put"
  | "files.get"
  | "snapshots.create"
  | "pause.pause"
  | "lease.extend"
  | "images.prepare";

// What a clause cannot do through the port alone: make the backend misbehave. Each hook is optional; a clause that needs an absent
// hook is skipped with that reason printed. A hook arms the NEXT matching operation (or, for preempt, makes the next inspect or wait
// observe it), so a fake can implement it as a scripted fault and a live adapter as a provider-side action.
export interface SandboxConformanceHooks {
  // The next start() throws SandboxOutcomeUnknownError; the sandbox exists afterwards iff `applied`.
  unknownOutcome?(applied: boolean): void;
  // The provider takes this sandbox away; the next inspect or wait observes the preemption.
  preempt?(id: SandboxId): void | Promise<void>;
  // The next connect channel opened breaks after this many output bytes.
  dropChannel?(afterBytes: number): void;
  // The next loopback stream opened echoes every byte written to it back as output.
  loopbackEcho?(): void;
  // The id of a live sandbox that was created under a different backend, with that backend's id.
  foreignRecord?(): { id: SandboxId; backend: SandboxBackendId } | Promise<{ id: SandboxId; backend: SandboxBackendId }>;
  // Docker-API-family adapters: the engine API version the client pins, and a call only newer engines accept (must be refused).
  engine?: { apiVersion(): string | Promise<string>; newerOnlyCall(): Promise<void> };
  // The requests the adapter made to the provider since this world was made, as the `user-agent` value of each (`undefined` when a
  // request carried none), and the value `workflow.fetch.userAgent` was configured to. Enables `user-agent-stamped`.
  requests?: { expectedUserAgent: string; observe(): readonly (string | undefined)[] | Promise<readonly (string | undefined)[]> };
  // Enables `no-sentinel-in-env`. `plant` arms the adapter so the next start carries this fake secret value as its secret; `createEnv`
  // returns the environment the adapter sent when it created that sandbox, or `undefined` when none was observed; `secretsInEnv` is
  // whether the lane sets `sandbox.secretsInEnv`.
  secrets?: {
    secretsInEnv: boolean;
    plant(sentinel: string): void | Promise<void>;
    createEnv(id: SandboxId): Readonly<Record<string, string>> | undefined | Promise<Readonly<Record<string, string>> | undefined>;
  };
}

export interface SandboxConformanceWorld {
  sandbox: Sandbox;
  // Adapter-specific values the clauses cannot invent: a startable image reference (default "i"), the id of a workspace mount the
  // adapter can resolve (default "ws-a"), and a long-lived command for images whose default entrypoint exits (default none).
  imageRef?: string;
  workspaceId?: string;
  cmd?: string[];
  // The owner the clauses list under (default a fixed contract owner).
  owner?: SandboxOwner;
  hooks?: SandboxConformanceHooks;
}

export interface SandboxUnderTest {
  name: string;
  // The declaration the adapter is expected to make (a boolean record, never a literal in the test). It gates the clauses; the world's
  // sandbox must declare the same capabilities, which the `declaration` check enforces.
  capabilities: SandboxDeclaration;
  // A fresh world per clause. A live adapter builds its sandbox here; the fake builds a new FakeSandbox.
  make(): Promise<SandboxConformanceWorld>;
  // Runs after every clause, after its sandboxes were killed.
  cleanup?(world: SandboxConformanceWorld): Promise<void>;
  // Environment gate (no Docker, no credentials): a non-empty string skips every check as gated, with the reason prefixed
  // "conformance gated:". A gate WITHOUT requireReal stays green by design (the environment may legitimately be closed); only
  // requireReal turns gated checks into a failure.
  gate?(): string | false | null | undefined;
  // Fail the run when checks were gated, so a lane proves the real half ran.
  requireReal?: boolean;
  // The suite floor fails a run in which no clause passed. A closed environment gate (every check gated) would otherwise dodge it, so a
  // descriptor whose environment may legitimately be closed (no Docker on this machine) sets this to stay green; default false.
  // requireReal still fails a gated run whatever this says.
  acceptClosedEnvironment?: boolean;
  // Whether list(owner) must stamp the host and generation tags on its listings. Default "required": the port's list(owner) exists so
  // reconcile can fence by host and generation. "optional" is for a backend that cannot stamp them yet (the shared fake).
  listingTags?: "required" | "optional";
  // Turn a capability skip into a failure for these capabilities (a lane that insists the adapter supports them).
  requireCapabilities?: readonly SandboxCapability[];
  // Deadline for waits that must end or throw (a dropped stream, a preempted wait); default 10 s times the test timeout scale.
  deadlineMs?: number;
  // Docker-API-family adapters: the pinned engine API version; enables `api-version-pin`.
  engineApiVersion?: string;
  // The adapter conflicts a start() whose key is reused for a different spec; enables `idempotency-conflict`.
  startConflict?: boolean;
}

// ---- clauses ----

export const CLAUSE_IDS = [
  "lifecycle-run",
  "attach-existing",
  "resolve-digest",
  "label-rules",
  "idempotent-start",
  "idempotency-conflict",
  "unknown-outcome-retry",
  "unknown-outcome-reconcile",
  "list-by-owner",
  "preemption-status",
  "foreign-backend-record",
  "stop-kill-keyed",
  "unsupported-capability-throws",
  "probe-subset",
  "probe-widening-fails",
  "api-version-pin",
  "channel-drop-throws",
  "loopback-stream",
  "files-hash-mismatch",
  "files-partial-upload",
  "user-agent-stamped",
  "no-sentinel-in-env",
] as const;
export type ClauseId = (typeof CLAUSE_IDS)[number];

export interface ClauseContext {
  sut: SandboxUnderTest;
  world: SandboxConformanceWorld;
  // The sandbox under test, recording every port call (the vacuity check reads it) and every sandbox id a clause started.
  sandbox: Sandbox;
  owner: SandboxOwner;
  hooks: SandboxConformanceHooks;
  spec(label: string, extra?: Partial<SandboxSpec>): SandboxSpec;
  agent(label: string): string;
  key(label: string): string;
}

export interface Clause {
  id: string;
  title: string;
  // Capabilities that must be in the effective set (declared, narrowed by the probe) for the clause to run.
  needs: readonly SandboxCapability[];
  // Port methods the check must call; a check that never calls them proves nothing and fails. A function computes them from the world.
  targets: readonly PortMethod[] | ((sut: SandboxUnderTest, world: SandboxConformanceWorld) => readonly PortMethod[]);
  // The action an adapter author takes when the clause fails.
  fix: string;
  // A designed skip that is not a missing capability (no hook, no probe, no engine pin): the reason, or null to run.
  skip?(sut: SandboxUnderTest, world: SandboxConformanceWorld): string | null;
  check(ctx: ClauseContext): Promise<void>;
}

const DEFAULT_OWNER: SandboxOwner = { host: "host-contract", storeId: "store-contract", epoch: 1 };
const GONE = "conformance-no-such-sandbox";
const GATED = "conformance gated: ";
const WITHHELD = "conformance withheld: ";

// A wait that must end or throw gets a deadline, so a backend that never ends the stream fails instead of hanging the run.
class DeadlineError extends Error {}
async function withDeadline<T>(what: string, work: Promise<T>, ms = scaled(10_000)): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = realSetTimeout(
      () => reject(new DeadlineError(`${what} did not finish within ${ms} ms; the backend never ended or broke it, so make it end or throw`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
const isRealError = (e: unknown) => e instanceof Error && !(e instanceof DeadlineError);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);
async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* parts;
}
async function drain(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const out: Uint8Array[] = [];
  for await (const c of body) out.push(c);
  return Buffer.concat(out);
}

// Each facet, with the capability `need` is asked for and the method a clause calls to learn whether an undeclared facet is a no-op.
const FACETS = [...new Set(Object.values(FACET_OF))] as (keyof SandboxFacets)[];
const FACET_REP: Record<keyof SandboxFacets, { capability: FacetCapability; method: PortMethod }> = {
  terminal: { capability: "terminal", method: "terminal.open" },
  connect: { capability: "connect", method: "connect.open" },
  loopback: { capability: "loopback", method: "loopback.open" },
  files: { capability: "files.put", method: "files.put" },
  snapshots: { capability: "snapshot.disk", method: "snapshots.create" },
  pause: { capability: "pause", method: "pause.pause" },
  lease: { capability: "lease.extend", method: "lease.extend" },
  images: { capability: "image.template", method: "images.prepare" },
};
const CALL_FACET: { [K in keyof SandboxFacets]: (f: NonNullable<SandboxFacets[K]>, key: string) => Promise<unknown> } = {
  terminal: (f) => f.open(GONE),
  connect: (f) => f.open(GONE, "daemon-api"),
  loopback: (f) => f.open(GONE, LOOPBACK_PORTS[0]),
  files: (f, key) => f.put(GONE, "/conformance/x", chunks(bytes("x")), sha256(bytes("x")), key),
  snapshots: (f, key) => f.create(GONE, { memory: false }, key),
  pause: (f, key) => f.pause(GONE, key),
  lease: (f, key) => f.extend(GONE, Date.now() + 1000, key),
  images: (f, key) => f.prepare("conformance-ref", { engineLocalId: "x", configDigest: null, revision: null }, key),
};

function undeclaredFacets(d: SandboxDeclaration): (keyof SandboxFacets)[] {
  return FACETS.filter((f) => !(Object.keys(FACET_OF) as FacetCapability[]).some((c) => FACET_OF[c] === f && d.capabilities[c] === true));
}

// A validator: the error is a SandboxCapabilityError naming a capability of the facet and carrying an action (cause and action).
function capabilityError(named: (capability: string) => boolean, what: string) {
  return (e: unknown) => {
    assert.ok(e instanceof SandboxCapabilityError, `${what} must throw SandboxCapabilityError, not no-op; got ${String(e)}`);
    assert.ok(named(e.capability), `${what}: the error names capability ${e.capability}, which is not the one asked for`);
    assert.ok(typeof e.action === "string" && e.action.length > 0, `${what}: the error must carry an action telling the caller what to do`);
    return true;
  };
}

// Reading a file that was never accepted fails as unavailable (not found) or as a transfer error, never with content.
const noFile = (e: unknown) => e instanceof SandboxUnavailableError || e instanceof SandboxTransferError;

const unknownOutcome = async (ctx: ClauseContext, applied: boolean, label: string) => {
  ctx.hooks.unknownOutcome!(applied);
  const spec = ctx.spec(label);
  const key = ctx.key(label);
  const err = await ctx.sandbox.start(spec, key).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof SandboxOutcomeUnknownError, `start with an unknown outcome must throw SandboxOutcomeUnknownError, got ${String(err)}`);
  assert.equal(err.idempotencyKey, key, "the unknown-outcome error carries the idempotency key to retry with");
  return { spec, key, err };
};
const countFor = async (ctx: ClauseContext, agent: string) => (await ctx.sandbox.list(ctx.owner)).filter((l) => l.agent === agent).length;

export const SANDBOX_CONFORMANCE_CLAUSES = [
  {
    id: "lifecycle-run",
    title: "start, wait, inspect, stop and kill report the exit code faithfully",
    needs: [],
    targets: ["start", "wait", "inspect", "stop", "kill"],
    fix: "report the same exit code from wait() and inspect(), 137 after kill, running status while live, and null for an unknown sandbox",
    async check(ctx) {
      const s = ctx.sandbox;
      const h = await s.start(ctx.spec("life"), ctx.key("life"));
      assert.equal(typeof h.id, "string");
      const live = await s.inspect(h.id);
      assert.ok(live !== null && live.running === true && live.exitCode === null, `a started sandbox must inspect as running, got ${JSON.stringify(live)}`);
      assert.ok(live.status === undefined || live.status === "running", `a live sandbox's status must be absent or "running", got ${live.status}`);
      await s.stop(h.id, 1000, ctx.key("life-stop"));
      const exit = await h.wait();
      assert.equal(typeof exit.exitCode, "number");
      const stopped = await s.inspect(h.id);
      assert.ok(
        stopped !== null && stopped.running === false && stopped.exitCode === exit.exitCode,
        `inspect after stop must agree with wait (exit ${exit.exitCode}), got ${JSON.stringify(stopped)}`,
      );
      const k = await s.start(ctx.spec("life-kill"), ctx.key("life-kill"));
      await s.kill(k.id, ctx.key("life-kill-k"));
      assert.equal((await k.wait()).exitCode, 137, "a killed sandbox exits 137");
      const killed = await s.inspect(k.id);
      assert.ok(
        killed !== null && killed.running === false && killed.exitCode === 137,
        `a killed sandbox inspects as stopped with exit 137, got ${JSON.stringify(killed)}`,
      );
      assert.ok(killed.status === undefined || killed.status === "exited", `a killed sandbox's status is absent or "exited", got ${killed.status}`);
      assert.equal(await s.inspect(GONE), null, "inspect of an unknown sandbox is null");
    },
  },
  {
    id: "attach-existing",
    title: "attach returns the running sandbox, not a new one",
    needs: [],
    targets: ["start", "attach", "list"],
    fix: "make attach(id) re-adopt the existing sandbox, throw SandboxUnavailableError for an unknown id, and never create a sandbox",
    async check(ctx) {
      const s = ctx.sandbox;
      const agent = ctx.agent("attach");
      const h = await s.start(ctx.spec("attach"), ctx.key("attach"));
      const before = await countFor(ctx, agent);
      const a = await s.attach(h.id, agent);
      assert.equal(a.id, h.id, "attach must return the sandbox it was asked for");
      assert.equal(await countFor(ctx, agent), before, "attach must not create a sandbox");
      await assert.rejects(() => s.attach(GONE, agent), SandboxUnavailableError);
    },
  },
  {
    id: "resolve-digest",
    title: "an image reference resolves to a stable pinned identity",
    needs: [],
    targets: ["imageIdentity"],
    fix: "return a non-empty engineLocalId and a configDigest that is null or sha256:<64 hex>, the same on every call for one reference",
    async check(ctx) {
      const ref = ctx.world.imageRef ?? "i";
      const id = await ctx.sandbox.imageIdentity(ref);
      assert.ok(id.engineLocalId.length > 0, "imageIdentity reports a non-empty engine-local id");
      assert.ok(id.configDigest === null || /^sha256:[0-9a-f]{64}$/.test(id.configDigest), "configDigest is null or sha256:<hex>");
      assert.deepEqual(await ctx.sandbox.imageIdentity(ref), id, "one reference resolves to one identity");
    },
  },
  {
    id: "label-rules",
    title: "extra labels are validated, echoed by list, and never forged as pomtree labels",
    needs: [],
    targets: ["start", "list"],
    fix: "reject label names that are malformed or start with pomtree before starting anything, and echo the labels given in list()",
    async check(ctx) {
      const s = ctx.sandbox;
      const bad = ctx.agent("label-bad");
      for (const name of ["pomtree.owner", "has space", ""]) {
        await assert.rejects(
          () => s.start(ctx.spec("label-bad", { labels: { [name]: "v" } }), ctx.key(`label-bad-${name}`)),
          // a validation refusal, not an outage or an unknown outcome
          (e: unknown) => isRealError(e) && !(e instanceof SandboxUnavailableError) && !(e instanceof SandboxOutcomeUnknownError),
          `label ${JSON.stringify(name)} must be rejected`,
        );
      }
      assert.ok(!(await s.list(ctx.owner)).some((l) => l.agent === bad), "a start refused for its labels must create nothing");
      const plain = await s.start(ctx.spec("label-plain"), ctx.key("label-plain"));
      const labels = { daemon_epoch: String(ctx.owner.epoch), store_id: ctx.owner.storeId };
      const tagged = await s.start(ctx.spec("label-tagged", { labels }), ctx.key("label-tagged"));
      const listed = await s.list(ctx.owner);
      assert.equal(listed.find((l) => l.id === plain.id)?.labels, undefined, "a sandbox started without labels lists none");
      assert.deepEqual(listed.find((l) => l.id === tagged.id)?.labels, labels, "list echoes the labels the sandbox was started with");
      for (const l of listed.filter((x) => x.id === plain.id || x.id === tagged.id)) {
        if (ctx.sut.listingTags === "optional") {
          assert.ok(l.host === null || l.host === ctx.owner.host, `a listed host tag must be the owner's host, got ${l.host}`);
          assert.ok(l.generation === null || Number.isInteger(l.generation), `a listed generation must be an integer or null, got ${l.generation}`);
        } else {
          assert.equal(l.host, ctx.owner.host, `list(owner) must stamp the owner's host on ${l.id} (descriptor listingTags is required); got ${l.host}`);
          assert.ok(
            Number.isInteger(l.generation),
            `list(owner) must stamp an integer generation on ${l.id} (descriptor listingTags is required); got ${l.generation}`,
          );
        }
      }
    },
  },
  {
    id: "idempotent-start",
    title: "the same key and spec returns the same sandbox and creates one",
    needs: [],
    targets: ["start", "list"],
    fix: "derive the sandbox from the idempotency key so a repeated start returns the same handle and leaves one sandbox",
    async check(ctx) {
      await assertStartIdempotent(ctx.sandbox, ctx.spec("idem"), ctx.key("idem"), ctx.owner);
    },
  },
  {
    id: "idempotency-conflict",
    title: "the same key with a different spec is an idempotency conflict",
    needs: [],
    targets: ["start", "list"],
    fix: "throw IdempotencyConflictError when a start key is reused for a different spec, and create nothing",
    // TODO(conformance-start-conflict): neither the shared fake nor the Docker adapter conflicts a reused start key yet, so only descriptors
    // that set startConflict run this clause; current behavior: skipped with this reason on the fake.
    skip: (sut) => (sut.startConflict === true ? null : "descriptor sets no startConflict (the adapter does not conflict a reused start key)"),
    async check(ctx) {
      const agent = ctx.agent("conflict");
      const key = ctx.key("conflict");
      await ctx.sandbox.start(ctx.spec("conflict"), key);
      await assert.rejects(() => ctx.sandbox.start(ctx.spec("conflict", { env: { CONFORMANCE: "changed" } }), key), IdempotencyConflictError);
      assert.equal(await countFor(ctx, agent), 1, "a conflicting replay creates nothing");
    },
  },
  {
    id: "unknown-outcome-retry",
    title: "after an unknown create outcome a retry with the same key yields exactly one sandbox",
    needs: [],
    targets: ["start", "list"],
    fix: "make start idempotent by key so a retry after SandboxOutcomeUnknownError finds or creates the single sandbox",
    skip: (_sut, world) => needsHook("unknownOutcome", world.hooks?.unknownOutcome !== undefined),
    async check(ctx) {
      for (const applied of [true, false]) {
        const label = `retry-${applied}`;
        const { spec, key, err } = await unknownOutcome(ctx, applied, label);
        const h = await ctx.sandbox.start(spec, key);
        assert.equal(h.id, err.id, "the retry resolves to the id the unknown-outcome error named");
        assert.equal(await countFor(ctx, spec.agent), 1, `after a retry (applied=${applied}) exactly one sandbox exists`);
      }
    },
  },
  {
    id: "unknown-outcome-reconcile",
    title: "after an unknown create outcome list(owner) shows whether the sandbox exists",
    needs: [],
    targets: ["start", "list"],
    fix: "return every sandbox the owner may have created from list(owner), so reconcile can find a sandbox whose create reply was lost",
    skip: (_sut, world) => needsHook("unknownOutcome", world.hooks?.unknownOutcome !== undefined),
    async check(ctx) {
      const applied = await unknownOutcome(ctx, true, "reconcile-applied");
      const found = (await ctx.sandbox.list(ctx.owner)).filter((l) => l.agent === applied.spec.agent);
      assert.deepEqual(
        found.map((l) => l.id),
        [applied.err.id],
        "a create that took effect must be found by list(owner) exactly once",
      );
      const lost = await unknownOutcome(ctx, false, "reconcile-lost");
      assert.equal(await countFor(ctx, lost.spec.agent), 0, "a create that did not take effect must not be listed");
    },
  },
  {
    id: "list-by-owner",
    title: "list(owner) returns this owner's live sandboxes and not another owner's",
    needs: [],
    targets: ["start", "list"],
    fix: "return every live sandbox of the owner, and exclude those labelled with another store id or a newer daemon epoch (filter on the client when the provider cannot)",
    async check(ctx) {
      const s = ctx.sandbox;
      const o = ctx.owner;
      const mine = await s.start(ctx.spec("lbo-mine", { labels: { store_id: o.storeId, daemon_epoch: String(o.epoch) } }), ctx.key("lbo-mine"));
      const plain = await s.start(ctx.spec("lbo-plain"), ctx.key("lbo-plain"));
      const other = await s.start(ctx.spec("lbo-other", { labels: { store_id: `${o.storeId}-other` } }), ctx.key("lbo-other"));
      const newer = await s.start(ctx.spec("lbo-newer", { labels: { store_id: o.storeId, daemon_epoch: String(o.epoch + 1) } }), ctx.key("lbo-newer"));
      const ids = (await s.list(o)).map((l) => l.id);
      assert.ok(ids.includes(mine.id), "list(owner) must include the owner's labelled sandbox");
      assert.ok(ids.includes(plain.id), "list(owner) must include a live unlabelled sandbox");
      assert.ok(!ids.includes(other.id), "list(owner) must exclude another store's sandbox");
      assert.ok(!ids.includes(newer.id), "list(owner) must exclude a sandbox from a newer daemon epoch");
    },
  },
  {
    id: "preemption-status",
    title: "a preempted sandbox is distinguishable from a clean exit",
    needs: [],
    targets: ["start", "inspect", "wait"],
    fix: "report a preempted sandbox through a rejected wait() or a status and exit code other than a clean exit",
    skip: (_sut, world) => needsHook("preempt", world.hooks?.preempt !== undefined),
    async check(ctx) {
      const h = await ctx.sandbox.start(ctx.spec("preempt"), ctx.key("preempt"));
      await ctx.hooks.preempt!(h.id);
      const st = await ctx.sandbox.inspect(h.id);
      assert.ok(st !== null && st.running === false, `a preempted sandbox is not running, got ${JSON.stringify(st)}`);
      assert.ok(!(st.status === "exited" && st.exitCode === 0), "a preempted sandbox must not inspect as a clean exit");
      const w: unknown = await withDeadline("wait() on a preempted sandbox", h.wait(), ctx.sut.deadlineMs).then(
        (r) => r,
        (e: unknown) => e,
      );
      if (w instanceof DeadlineError) throw w;
      assert.ok(w instanceof Error || (w as { exitCode: number }).exitCode !== 0, "wait() on a preempted sandbox must reject or report a non-zero exit");
    },
  },
  {
    id: "foreign-backend-record",
    title: "attaching a sandbox of another backend fails naming both backends and never reports it gone",
    needs: [],
    targets: ["attach"],
    fix: "throw an error naming the sandbox's backend and the active backend, not SandboxUnavailableError not-found",
    // TODO(conformance-foreign-record): the port has no resume verb that carries a backend id yet (SandboxBackendMismatchError is a daemon
    // concern), so only descriptors with a foreignRecord hook run this clause; current behavior: skipped with this reason on the fake.
    skip: (_sut, world) => needsHook("foreignRecord", world.hooks?.foreignRecord !== undefined),
    async check(ctx) {
      const foreign = await ctx.hooks.foreignRecord!();
      const active = ctx.world.sandbox.declaration.backend;
      const err = await ctx.sandbox.attach(foreign.id, ctx.agent("foreign")).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err instanceof Error, "attaching another backend's sandbox must fail");
      assert.ok(!(err instanceof SandboxUnavailableError && err.reason === "not-found"), "a foreign sandbox must never be reported as gone");
      assert.ok(
        err.message.includes(foreign.backend) && err.message.includes(active),
        `the error must name both backends (${foreign.backend}, ${active}), got: ${err.message}`,
      );
    },
  },
  {
    id: "stop-kill-keyed",
    title: "stop and kill are keyed and an already-gone sandbox counts as success",
    needs: [],
    targets: ["start", "stop", "kill"],
    fix: "resolve stop and kill for a stopped, killed or unknown sandbox, and for a repeated key",
    async check(ctx) {
      const s = ctx.sandbox;
      const h = await s.start(ctx.spec("stopkill"), ctx.key("stopkill"));
      await s.stop(h.id, 1000, ctx.key("stopkill-stop"));
      await s.stop(h.id, 1000, ctx.key("stopkill-stop")); // same key again
      await s.kill(h.id, ctx.key("stopkill-kill")); // already exited
      await s.stop(GONE, 1000, ctx.key("stopkill-gone-stop"));
      await s.kill(GONE, ctx.key("stopkill-gone-kill"));
    },
  },
  {
    id: "unsupported-capability-throws",
    title: "an undeclared facet is absent or throws SandboxCapabilityError, never a no-op",
    needs: [],
    targets: (sut, world) =>
      undeclaredFacets(sut.capabilities)
        .filter((f) => world.sandbox[f] !== undefined && world.sandbox[f] !== null)
        .map((f) => FACET_REP[f].method),
    fix: "leave undeclared facets absent, or make their methods throw SandboxCapabilityError",
    skip: (sut) => (undeclaredFacets(sut.capabilities).length > 0 ? null : "every facet is declared, so there is no undeclared capability to probe"),
    async check(ctx) {
      for (const f of undeclaredFacets(ctx.sut.capabilities)) {
        const { capability } = FACET_REP[f];
        assert.throws(
          () => need(ctx.sandbox, capability),
          capabilityError((c) => c === capability, `need(${capability}) when the facet ${f} is undeclared`),
          `need(${capability}) must throw SandboxCapabilityError when the facet ${f} is undeclared`,
        );
        const facet = ctx.sandbox[f];
        if (facet !== undefined && facet !== null) {
          await assert.rejects(
            () => (CALL_FACET[f] as (facet: unknown, key: string) => Promise<unknown>)(facet, ctx.key(`unsupported-${f}`)),
            capabilityError((c) => FACET_OF[c as FacetCapability] === f, `the present but undeclared facet ${f}`),
            `the undeclared facet ${f} is present and must throw SandboxCapabilityError, not no-op`,
          );
        }
      }
    },
  },
  {
    id: "probe-subset",
    title: "the probe result stays within the declaration, with and without a runtime block",
    needs: [],
    targets: ["probe"],
    fix: "return a well-formed probe result that only withholds capabilities the declaration marks true",
    skip: (_sut, world) => (world.sandbox.probe === undefined ? "the adapter has no probe()" : null),
    async check(ctx) {
      const decl = ctx.world.sandbox.declaration;
      checkProbe(decl, await ctx.sandbox.probe!());
      checkProbe(decl, await ctx.sandbox.probe!({ ociRuntime: "runsc" }));
    },
  },
  {
    id: "probe-widening-fails",
    title: "no probe variant widens the declaration",
    needs: [],
    targets: ["probe"],
    fix: "make every probe variant only withhold capabilities the declaration marks true",
    skip: (_sut, world) => (world.sandbox.probe === undefined ? "the adapter has no probe()" : null),
    async check(ctx) {
      // Every runtime variant the daemon may probe with: no block, an empty block and two runtime classes. Each result must only narrow.
      const decl = ctx.world.sandbox.declaration;
      for (const runtime of [undefined, {}, { ociRuntime: "runc" }, { ociRuntime: "runsc" }]) {
        checkProbe(decl, await ctx.sandbox.probe!(runtime)); // throws SandboxProbeError when this adapter's probe widens or is malformed
      }
    },
  },
  {
    id: "api-version-pin",
    title: "the Docker-API client pins the oldest supported engine API version",
    needs: [],
    targets: ["start", "list"],
    fix: "pin the client to the oldest supported engine API version so a call only newer engines accept is refused",
    skip: (sut, world) =>
      sut.engineApiVersion === undefined
        ? "descriptor sets no engineApiVersion (not a Docker-API-family adapter)"
        : needsHook("engine", world.hooks?.engine !== undefined),
    async check(ctx) {
      const engine = ctx.hooks.engine!;
      await ctx.sandbox.start(ctx.spec("pin"), ctx.key("pin"));
      await ctx.sandbox.list(ctx.owner);
      assert.equal(await engine.apiVersion(), ctx.sut.engineApiVersion, "the client must pin the declared engine API version");
      await assert.rejects(() => engine.newerOnlyCall(), "a call only newer engine API versions accept must be refused");
    },
  },
  {
    id: "channel-drop-throws",
    title: "a connect stream cut mid-flight makes the reader throw",
    needs: ["connect"],
    targets: ["start", "connect.open"],
    fix: "make the channel's output() throw when the stream breaks, not end cleanly",
    skip: (_sut, world) => needsHook("dropChannel", world.hooks?.dropChannel !== undefined),
    async check(ctx) {
      const h = await ctx.sandbox.start(ctx.spec("drop"), ctx.key("drop"));
      ctx.hooks.dropChannel!(4);
      const ch = await need(ctx.sandbox, "connect").open(h.id, "daemon-api");
      await ch.write("0123456789").catch(() => {}); // the cut may reject the write itself
      const err = await withDeadline(
        "reading a dropped connect stream",
        (async () => {
          for await (const _ of ch.output()) {
            // drain until the stream ends or throws
          }
        })(),
        ctx.sut.deadlineMs,
      ).then(
        () => null,
        (e: unknown) => e,
      );
      if (err instanceof DeadlineError) throw err;
      assert.ok(err instanceof Error, "a dropped connect stream must make output() throw, not end cleanly");
    },
  },
  {
    id: "loopback-stream",
    title: "a loopback stream opens on a running sandbox, rejects a port outside LOOPBACK_PORTS and an unavailable sandbox",
    needs: ["loopback"],
    targets: ["start", "loopback.open"],
    fix: "open only ports in LOOPBACK_PORTS (RangeError otherwise, also at run time), throw SandboxUnavailableError for a sandbox that is not running, and carry written bytes to the port",
    async check(ctx) {
      const lb = need(ctx.sandbox, "loopback");
      const h = await ctx.sandbox.start(ctx.spec("loopback"), ctx.key("loopback"));
      await assert.rejects(() => lb.open(h.id, 1 as LoopbackPort), RangeError, "a port outside LOOPBACK_PORTS must be a RangeError");
      await assert.rejects(() => lb.open(GONE, LOOPBACK_PORTS[0]), SandboxUnavailableError, "an unknown sandbox must throw SandboxUnavailableError");
      if (ctx.hooks.loopbackEcho) ctx.hooks.loopbackEcho();
      const stream = await lb.open(h.id, LOOPBACK_PORTS[0]);
      await stream.write(bytes("ping"));
      if (ctx.hooks.loopbackEcho) {
        const first = await withDeadline("reading the loopback echo", stream.output()[Symbol.asyncIterator]().next(), ctx.sut.deadlineMs);
        assert.equal(new TextDecoder().decode(first.value), "ping", "the loopback stream must return what the port echoes");
      }
      stream.close();
      assert.equal((await withDeadline("closing the loopback stream", stream.closed, ctx.sut.deadlineMs)).reason, "local");
    },
  },
  {
    id: "files-hash-mismatch",
    title: "bytes that differ from the declared hash raise SandboxTransferError and leave no file",
    needs: ["files.put", "files.get"],
    targets: ["start", "files.put", "files.get"],
    fix: "verify the sha256 end to end, throw SandboxTransferError on a mismatch and keep nothing",
    async check(ctx) {
      const files = need(ctx.sandbox, "files.put");
      const get = need(ctx.sandbox, "files.get");
      const h = await ctx.sandbox.start(ctx.spec("hash"), ctx.key("hash"));
      const data = bytes("conformance payload");
      await assert.rejects(() => files.put(h.id, "/tmp/conformance-bad", chunks(data), sha256(bytes("different")), ctx.key("hash-bad")), SandboxTransferError);
      await assert.rejects(() => get.get(h.id, "/tmp/conformance-bad", 1 << 20), noFile, "a rejected transfer must leave no accepted file");
      await files.put(h.id, "/tmp/conformance-ok", chunks(data), sha256(data), ctx.key("hash-ok")); // positive control
      const got = await get.get(h.id, "/tmp/conformance-ok", 1 << 20);
      const back = await drain(got.body);
      assert.deepEqual(Buffer.from(back), Buffer.from(data), "a verified upload reads back unchanged");
      assert.equal(await got.sha256, sha256(data));
    },
  },
  {
    id: "files-partial-upload",
    title: "a partial upload is not reported complete",
    needs: ["files.put"],
    targets: ["start", "files.put"],
    fix: "reject an upload whose stream ends early or breaks, and keep nothing",
    async check(ctx) {
      const files = need(ctx.sandbox, "files.put");
      const h = await ctx.sandbox.start(ctx.spec("partial"), ctx.key("partial"));
      const data = bytes("0123456789abcdef");
      // The stream ends after half the bytes while the declared hash covers all of them.
      await assert.rejects(
        () => files.put(h.id, "/tmp/conformance-cut", chunks(data.subarray(0, 8)), sha256(data), ctx.key("partial-cut")),
        SandboxTransferError,
      );
      // The stream breaks mid-flight.
      const broken = (async function* () {
        yield data.subarray(0, 8);
        throw new Error("conformance stream broke");
      })();
      await assert.rejects(() => files.put(h.id, "/tmp/conformance-broke", broken, sha256(data), ctx.key("partial-broke")), isRealError);
      if (ctx.sut.capabilities.capabilities["files.get"] === true) {
        const get = need(ctx.sandbox, "files.get");
        for (const p of ["/tmp/conformance-cut", "/tmp/conformance-broke"]) {
          await assert.rejects(() => get.get(h.id, p, 1 << 20), noFile, `a partial upload must leave no accepted file at ${p}`);
        }
      }
    },
  },
  ...EXTENDED_CONFORMANCE_CLAUSES,
] as const satisfies readonly (Clause & { id: ClauseId })[];

// ---- results, gating and the runner ----

export type ClauseResult =
  | { id: string; status: "passed" }
  | { id: string; status: "failed"; error: Error }
  | { id: string; status: "skipped"; reason: string }
  | { id: string; status: "gated"; reason: string };

// Declared capabilities narrowed by the probe. `withheld` is kept apart so a skip can say why.
export interface EffectiveCapabilities {
  declared: ReadonlySet<SandboxCapability>;
  withheld: ReadonlySet<SandboxCapability>;
  probeError: Error | null;
}

export function declaredCapabilities(d: SandboxDeclaration): Set<SandboxCapability> {
  return new Set(SANDBOX_CAPABILITIES.filter((c) => d.capabilities[c] === true));
}

let runCounter = 0;

function recordingSandbox(raw: Sandbox, calls: Set<string>, started: Set<SandboxId>): Sandbox {
  const handle = (h: SandboxHandle): SandboxHandle =>
    new Proxy(h, {
      get(t, p) {
        const v = Reflect.get(t, p, t);
        if (p === "wait") {
          return () => {
            calls.add("wait");
            return t.wait();
          };
        }
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  const facet = (name: string, f: object) =>
    new Proxy(f, {
      get(t, p) {
        const v = Reflect.get(t, p, t);
        if (typeof p !== "string" || typeof v !== "function") return v;
        return (...args: unknown[]) => {
          calls.add(`${name}.${p}`);
          return v.apply(t, args);
        };
      },
    });
  return new Proxy(raw, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (typeof p !== "string") return v;
      if ((FACETS as string[]).includes(p) && v !== null && typeof v === "object") return facet(p, v);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls.add(p);
        const r = v.apply(t, args);
        if (p !== "start" && p !== "attach") return r;
        return Promise.resolve(r).then(
          (h: SandboxHandle) => {
            started.add(h.id);
            return handle(h);
          },
          (e: unknown) => {
            if (e instanceof SandboxOutcomeUnknownError) started.add(e.id);
            throw e;
          },
        );
      };
    },
  });
}

function clauseFailure(clause: Clause, name: string, e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(`backend ${name} failed conformance clause ${clause.id} (${clause.title}): ${msg}; ${clause.fix}`, { cause: e });
}

// Probes once (when the adapter has a probe) and returns the effective set. A probe that throws or returns a widening or malformed
// result is reported by the `probe` check; the clauses then run on the declared set, so a bad probe never hides clauses.
export async function effectiveCapabilities(sut: SandboxUnderTest): Promise<EffectiveCapabilities> {
  const declared = declaredCapabilities(sut.capabilities);
  const world = await sut.make();
  try {
    if (world.sandbox.probe === undefined) return { declared, withheld: new Set(), probeError: null };
    const r = await world.sandbox.probe();
    checkProbe(world.sandbox.declaration, r);
    return { declared, withheld: new Set(r.withheld), probeError: null };
  } catch (e) {
    return { declared, withheld: new Set(), probeError: e instanceof Error ? e : new Error(String(e)) };
  } finally {
    await sut.cleanup?.(world).catch(() => {});
  }
}

// Runs one clause. Gating order: environment gate, then capability gating (skip with "not declared", or fail when the lane requires
// the capability), then the clause's designed skips, then the check and its vacuity test.
export async function runClause(clause: Clause, sut: SandboxUnderTest, effective: EffectiveCapabilities): Promise<ClauseResult> {
  const why = sut.gate?.();
  if (why) return { id: clause.id, status: "gated", reason: `${GATED}${why}` };
  const missing = clause.needs.filter((c) => !effective.declared.has(c) || effective.withheld.has(c));
  if (missing.length > 0) {
    const required = missing.filter((c) => sut.requireCapabilities?.includes(c));
    const prefix = missing.some((c) => !effective.declared.has(c)) ? NOT_DECLARED : WITHHELD;
    const reason =
      prefix +
      missing
        .map((c) => (effective.declared.has(c) ? `capability ${c} withheld by ${sut.name}'s probe` : `capability ${c} not declared by ${sut.name}`))
        .join("; ");
    if (required.length > 0) {
      return {
        id: clause.id,
        status: "failed",
        error: new Error(`${reason}, but this run requires ${required.join(", ")}; declare and implement the capability, or drop it from requireCapabilities`),
      };
    }
    return { id: clause.id, status: "skipped", reason };
  }
  const run = ++runCounter;
  const world = await sut.make();
  const calls = new Set<string>();
  const started = new Set<SandboxId>();
  const cleanupErrors: unknown[] = [];
  let outcome: ClauseResult;
  try {
    const skip = clause.skip?.(sut, world) ?? null;
    if (skip !== null) {
      outcome = { id: clause.id, status: "skipped", reason: skip };
    } else {
      const ctx: ClauseContext = {
        sut,
        world,
        sandbox: recordingSandbox(world.sandbox, calls, started),
        owner: world.owner ?? DEFAULT_OWNER,
        hooks: world.hooks ?? {},
        spec: (label, extra = {}) => ({
          agent: `conf-${run}-${label}`,
          image: world.imageRef ?? "i",
          env: {},
          mounts: [{ kind: "workspace", workspace: world.workspaceId ?? "ws-a", containerPath: "/w" }],
          ...(world.cmd && { cmd: world.cmd }),
          ...extra,
        }),
        agent: (label) => `conf-${run}-${label}`,
        key: (label) => `conf-${run}-${clause.id}-${label}`,
      };
      try {
        await clause.check(ctx);
        const targets = typeof clause.targets === "function" ? clause.targets(sut, world) : clause.targets;
        const unmet = targets.filter((t) => !calls.has(t));
        if (unmet.length > 0) {
          throw new Error(`the check never called its target method(s) ${unmet.join(", ")}, so it proves nothing; make the check exercise them`);
        }
        outcome = { id: clause.id, status: "passed" };
      } catch (e) {
        outcome = { id: clause.id, status: "failed", error: clauseFailure(clause, sut.name, e) };
      }
    }
  } finally {
    // Kill what the clause started, then let the adapter clean up.
    for (const id of started) {
      await world.sandbox.kill(id, `conf-${run}-cleanup-${id}`).catch((e: unknown) => cleanupErrors.push(e));
    }
    await sut.cleanup?.(world).catch((e: unknown) => cleanupErrors.push(e));
  }
  // A cleanup error never hides a clause failure, but a passing clause whose cleanup failed is a failure: it left state behind or
  // never exercised what it armed (a planned fault that did not fire).
  if (outcome.status === "passed" && cleanupErrors.length > 0) {
    const e = cleanupErrors[0];
    return { id: clause.id, status: "failed", error: clauseFailure(clause, sut.name, e) };
  }
  return outcome;
}

// The checks that are not clauses: the world's own declaration must be valid, match the descriptor's and have exactly the facets it
// declares (the old contract body's facet-presence case), and the probe must be well formed. Both fail loudly, never skip.
export async function checkDeclaration(sut: SandboxUnderTest): Promise<ClauseResult> {
  const world = await sut.make();
  try {
    const d = world.sandbox.declaration;
    assert.deepEqual(validateDeclaration(d), [], `backend ${sut.name} declares an invalid declaration; fix the reasons listed`);
    assert.equal(d.backend, sut.capabilities.backend, `the sandbox declares backend ${d.backend} but the descriptor expects ${sut.capabilities.backend}`);
    assert.deepEqual(
      [...declaredCapabilities(d)].sort(),
      [...declaredCapabilities(sut.capabilities)].sort(),
      `backend ${sut.name} declares different capabilities than its descriptor expects; update the declaration or the descriptor`,
    );
    assertFacetPresence(world.sandbox);
    return { id: "declaration", status: "passed" };
  } catch (e) {
    return { id: "declaration", status: "failed", error: e instanceof Error ? e : new Error(String(e)) };
  } finally {
    await sut.cleanup?.(world).catch(() => {});
  }
}

export function checkProbeResult(effective: EffectiveCapabilities): ClauseResult {
  if (effective.probeError === null) return { id: "probe", status: "passed" };
  const e = effective.probeError;
  return {
    id: "probe",
    status: "failed",
    error: new Error(`the probe failed or widened the declaration: ${e.message}; fix the adapter's probe (a probe error never skips clauses)`, { cause: e }),
  };
}

export interface ConformanceReport {
  name: string;
  results: ClauseResult[];
  summary: string;
}

// One line: conformance: N passed, M failed, K skipped (id: reason; ...). Gated clauses (environment closed) are counted apart.
export function conformanceSummary(results: readonly ClauseResult[]): string {
  const of = <S extends ClauseResult["status"]>(s: S) => results.filter((r): r is Extract<ClauseResult, { status: S }> => r.status === s);
  const skipped = of("skipped");
  const gated = of("gated");
  const skips = skipped.length > 0 ? ` (${skipped.map((r) => `${r.id}: ${r.reason}`).join("; ")})` : "";
  const gate = gated.length > 0 ? `, ${gated.length} gated (${[...new Set(gated.map((r) => r.reason))].join("; ")})` : "";
  return `conformance: ${of("passed").length} passed, ${of("failed").length} failed, ${skipped.length} skipped${skips}${gate}`;
}

export interface ConformanceOptions {
  // The clauses to run. `runSandboxConformance`'s floor applies to this registered set: a declared capability whose clauses were left
  // out of it fails the floor, so narrowing the set cannot hide a capability.
  clauses?: readonly Clause[];
  // The coverage table the floor reads; default SANDBOX_CAPABILITY_COVERAGE. Tests inject a broken table here.
  coverage?: CapabilityTable;
}

// Runs every clause and returns the report; does not register tests, so a test can run a deliberately broken sandbox and read the failures.
export async function evaluateSandboxConformance(sut: SandboxUnderTest, opts: ConformanceOptions = {}): Promise<ConformanceReport> {
  const clauses = opts.clauses ?? SANDBOX_CONFORMANCE_CLAUSES;
  const why = sut.gate?.();
  const effective: EffectiveCapabilities = why
    ? { declared: declaredCapabilities(sut.capabilities), withheld: new Set(), probeError: null }
    : await effectiveCapabilities(sut);
  const results: ClauseResult[] = why
    ? [
        { id: "declaration", status: "gated", reason: `${GATED}${why}` },
        { id: "probe", status: "gated", reason: `${GATED}${why}` },
      ]
    : [await checkDeclaration(sut), checkProbeResult(effective)];
  for (const clause of clauses) results.push(await runClause(clause, sut, effective));
  return { name: sut.name, results, summary: conformanceSummary(results) };
}

// Registers one node:test case per check, the summary line on stderr, and, with requireReal, a failure when any clause was gated.
export function runSandboxConformance(sut: SandboxUnderTest, opts: ConformanceOptions = {}): void {
  const clauses = opts.clauses ?? SANDBOX_CONFORMANCE_CLAUSES;
  const results: ClauseResult[] = [];
  let effective: Promise<EffectiveCapabilities> | undefined;
  const effectiveOnce = () => (effective ??= effectiveCapabilities(sut));
  const entry = (id: string, run: () => Promise<ClauseResult>) =>
    test(`${sut.name} conformance ${id}`, async (t) => {
      const r = await run();
      results.push(r);
      if (r.status === "failed") throw r.error;
      if (r.status === "skipped" || r.status === "gated") t.skip(r.reason);
    });
  entry("declaration", async () => {
    const why = sut.gate?.();
    return why ? { id: "declaration", status: "gated", reason: `${GATED}${why}` } : checkDeclaration(sut);
  });
  const declaredOnly = (): EffectiveCapabilities => ({ declared: declaredCapabilities(sut.capabilities), withheld: new Set(), probeError: null });
  entry("probe", async () => {
    const why = sut.gate?.();
    return why ? { id: "probe", status: "gated", reason: `${GATED}${why}` } : checkProbeResult(await effectiveOnce());
  });
  for (const clause of clauses) entry(clause.id, async () => runClause(clause, sut, sut.gate?.() ? declaredOnly() : await effectiveOnce()));
  after(async () => {
    console.error(`CONFORMANCE ${sut.name}: ${conformanceSummary(results)}`);
    const problems: string[] = [];
    const gated = results.filter((r) => r.status === "gated");
    if (sut.requireReal && gated.length > 0) {
      problems.push(
        `conformance for ${sut.name}: requireReal is set but ${gated.length} check(s) were gated (${[...new Set(gated.map((r) => (r as { reason: string }).reason))].join("; ")}); open the gate (start the engine or supply credentials) so the real adapter runs`,
      );
    }
    // The suite floor: a run in which every entry ran must have exercised the clauses its declaration needs. A filtered run
    // (--test-name-pattern, --test-only) has fewer results and is left alone.
    const table = opts.coverage ?? SANDBOX_CAPABILITY_COVERAGE;
    if (results.length === clauses.length + 2) {
      const counts = coverageCounts(table);
      console.error(`CONFORMANCE ${sut.name} floor: ${counts.covered} capabilities covered, ${counts.deferred} deferred`);
      problems.push(...coverageTableFindings(table));
      if (gated.length > 0) {
        if (!sut.acceptClosedEnvironment && !sut.requireReal) {
          problems.push(
            `conformance for ${sut.name}: the environment gate is closed, so no clause ran and the run proves nothing; open the gate, or set acceptClosedEnvironment: true on the descriptor if a closed environment is legitimate for this lane`,
          );
        }
      } else {
        const eff = await effectiveOnce();
        problems.push(
          ...suiteFloorFindings({
            name: sut.name,
            declared: [...eff.declared].filter((c) => !eff.withheld.has(c)),
            results,
            table,
            clauseIds: clauses.map((c) => c.id),
          }),
        );
      }
    } else {
      console.error(`CONFORMANCE ${sut.name} floor: not checked, only ${results.length} of ${clauses.length + 2} checks ran (a filtered run)`);
    }
    if (problems.length > 0) throw new Error(problems.join("\n"));
  });
}

// ---- the shared fake as a backend under test ----

export interface FakeUnderTestOptions {
  name?: string;
  // Default true: the fake with connect, files.put and files.get declared. false = the plain fake (terminal only).
  remote?: boolean;
  // Default an empty probe result; false = the fake has no probe().
  probe?: SandboxProbeShape | false;
  // Decorates the fake (a deliberately broken sandbox in tests); the hooks keep driving the undecorated fake's fault plan.
  wrap?(fake: FakeSandbox): Sandbox;
  engineApiVersion?: string;
  startConflict?: boolean;
  deadlineMs?: number;
  // Hooks merged over the fake's own (add foreignRecord or engine here; the fake has neither).
  hooks?: SandboxConformanceHooks;
  requireCapabilities?: readonly SandboxCapability[];
  // Default "optional": the shared fake lists host and generation as null (it cannot stamp the reserved pomtree labels). Set "required" on a wrapper that stamps them.
  listingTags?: "required" | "optional";
  fake?: Omit<FakeSandboxOptions, "faults" | "remote" | "probe">;
}
type SandboxProbeShape = NonNullable<FakeSandboxOptions["probe"]>;

// The descriptor of the shared FakeSandbox (one fresh fake and fault plan per clause). Its hooks script the fault plan, and cleanup
// fails when a planned fault never fired.
export function fakeSandboxUnderTest(o: FakeUnderTestOptions = {}): SandboxUnderTest {
  const remote = o.remote !== false;
  const probe = o.probe === false ? undefined : (o.probe ?? { withheld: [], problems: [], account: null });
  const options = (faults: FaultPlan): FakeSandboxOptions => ({ ...o.fake, faults, remote, ...(probe && { probe }) });
  const plans = new WeakMap<SandboxConformanceWorld, FaultPlan>();
  return {
    name: o.name ?? "fake",
    capabilities: new FakeSandbox([], "graceful", options(new FaultPlan())).declaration,
    ...(o.deadlineMs !== undefined && { deadlineMs: o.deadlineMs }),
    ...(o.engineApiVersion !== undefined && { engineApiVersion: o.engineApiVersion }),
    ...(o.startConflict !== undefined && { startConflict: o.startConflict }),
    ...(o.requireCapabilities && { requireCapabilities: o.requireCapabilities }),
    listingTags: o.listingTags ?? "optional",
    async make() {
      const plan = new FaultPlan();
      const fake = new FakeSandbox([], "graceful", options(plan));
      const world: SandboxConformanceWorld = {
        sandbox: o.wrap ? o.wrap(fake) : fake,
        hooks: {
          unknownOutcome: (applied) => void plan.add("start", { kind: "unknown-outcome", applied }),
          preempt: (id) => void plan.add("inspect", { kind: "preempt" }, { id }),
          dropChannel: (afterBytes) => void plan.add("connect", { kind: "drop", afterBytes }),
          loopbackEcho: () => {
            fake.echoNextLoopback = true;
          },
          ...o.hooks,
        },
      };
      plans.set(world, plan);
      return world;
    },
    async cleanup(world) {
      plans.get(world)?.assertSpent();
    },
  };
}
