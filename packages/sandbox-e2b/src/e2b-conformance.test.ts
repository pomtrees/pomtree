import assert from "node:assert/strict";
import test from "node:test";
import type { Sandbox, SandboxOwner, SandboxSpec } from "@pomtree/core";
import {
  brokenSandbox,
  evaluateSandboxConformance,
  runSandboxConformance,
  SANDBOX_CONFORMANCE_CLAUSES,
  type SandboxConformanceWorld,
  type SandboxUnderTest,
  scaled,
} from "@pomtree/testing";
import { E2BApi } from "./api.ts";
import { E2B_DECLARATION, E2BSandbox } from "./sandbox.ts";
import { API_KEY_PLACEHOLDER, type E2BStubWorld, startE2BStub } from "./stub-world.ts";

// The shared conformance suite against the E2B adapter, run offline through the provider stub shaped as E2B (stub-world.ts). Each
// clause gets a fresh stub. The hooks make the stub misbehave the way E2B can: a lost create reply, a sandbox removed behind the
// adapter's back (E2B's timeout), and they observe the User-Agent and the create-time environment.
//
// resolve-digest is left out: E2B templates report no image digest, so imageIdentity throws SandboxCapabilityError as the port
// prescribes for a backend without image.digestAttest (provider.test.ts asserts it), and the clause demands an identity.
//
// Ownership: list(owner) fails closed and returns only sandboxes labelled with the owner's store id, so the main run stamps the
// owner's store_id and daemon_epoch labels on every spec that carries no store_id, as pomtreed does (daemonLabelled). This makes
// list-by-owner's "a live unlabelled sandbox is included" assertion vacuous here: an unlabelled sandbox is deliberately never listed
// (provider.test.ts and dedup.test.ts assert the exclusion). label-rules checks that an unlabelled start lists no labels, which the
// stamping would break, so it runs unwrapped in its own test below.

const UA = "pomtree-e2b-conformance/1";
const worlds = new WeakMap<SandboxConformanceWorld, E2BStubWorld>();

const OWNER: SandboxOwner = { host: "host-e2b", storeId: "store-e2b", epoch: 1 };

// The labels pomtreed stamps on every sandbox it starts (store_id, daemon_epoch), added where a clause's spec carries no store_id.
function daemonLabelled(inner: Sandbox): Sandbox {
  const start = (spec: SandboxSpec, key: string) =>
    inner.start(
      spec.labels?.store_id === undefined ? { ...spec, labels: { ...spec.labels, store_id: OWNER.storeId, daemon_epoch: String(OWNER.epoch) } } : spec,
      key,
    );
  return new Proxy(inner, {
    get(t, p) {
      if (p === "start") return start;
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

const descriptor = (wrap: (s: Sandbox) => Sandbox = daemonLabelled): SandboxUnderTest => ({
  name: "e2b (provider stub)",
  capabilities: E2B_DECLARATION,
  async make() {
    const w = await startE2BStub({ userAgent: UA });
    const api = new E2BApi({
      baseUrl: w.stub.baseUrl,
      request: w.request,
      apiKey: async () => API_KEY_PLACEHOLDER,
      timeoutMs: scaled(500),
      retry: { maxAttempts: 1 },
    });
    const sandbox = new E2BSandbox({ api, template: "", timeoutS: 900, pollMs: 20, probe: { probes: 1, intervalMs: 0 } });
    const world: SandboxConformanceWorld = {
      sandbox: wrap(sandbox),
      owner: OWNER,
      imageRef: "base",
      hooks: {
        unknownOutcome: (applied) => {
          if (applied) {
            // Applied, then answered 5xx; the reconcile lookup fails too, so the outcome stays unknown to the caller.
            w.stub.faults.arm("server-error-after-apply", { method: "POST", path: "/sandboxes" });
            w.failListsAfterNextCreateError(1);
          } else {
            w.stub.faults.arm("timeout", { method: "POST", path: "/sandboxes" });
          }
        },
        preempt: (id) => w.vanish(id),
        requests: { expectedUserAgent: UA, observe: () => w.identity.seen().map((s) => s.userAgent) },
        secrets: {
          secretsInEnv: false,
          plant: () => {}, // the adapter delivers no secret at all, so there is nothing to arm
          createEnv: (id) => w.createEnv.get(id),
        },
      },
    };
    worlds.set(world, w);
    return world;
  },
  async cleanup(world) {
    const w = worlds.get(world);
    if (w === undefined) return;
    await w.close();
    w.stub.assertNoUnmatched();
    assert.deepEqual(w.schemaFailures, [], "a create body broke the vendored E2B create schema");
  },
});

const clauses = SANDBOX_CONFORMANCE_CLAUSES.filter((c) => c.id !== "resolve-digest" && c.id !== "label-rules");
runSandboxConformance(descriptor(), { clauses });

test("negative control: an E2B adapter that forgets its idempotency key fails idempotent-start", async () => {
  const report = await evaluateSandboxConformance(
    descriptor((s) => brokenSandbox(daemonLabelled(s), "forget-key")),
    { clauses: clauses.filter((c) => c.id === "idempotent-start") },
  );
  const r = report.results.find((x) => x.id === "idempotent-start");
  assert.equal(r?.status, "failed", report.summary);
});

test("label-rules passes on the unwrapped adapter (no daemon labels stamped)", async () => {
  const report = await evaluateSandboxConformance(
    descriptor((s) => s),
    { clauses: SANDBOX_CONFORMANCE_CLAUSES.filter((c) => c.id === "label-rules") },
  );
  const r = report.results.find((x) => x.id === "label-rules");
  assert.equal(r?.status, "passed", report.summary);
});
