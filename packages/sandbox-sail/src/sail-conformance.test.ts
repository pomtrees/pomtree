import assert from "node:assert/strict";
import type { Sandbox, SandboxId, SandboxRequestOptions } from "@pomtree/core";
import { encodeName } from "@pomtree/sandbox-kit";
import { SANDBOX_CONFORMANCE_CLAUSES, type SandboxConformanceWorld, type SandboxUnderTest, runSandboxConformance } from "@pomtree/testing";
import { sailProvider } from "./provider.ts";
import { SAIL_NAME_SCHEMA } from "./sail.ts";
import { PLANTED_TOKEN, SAIL_RESOURCE, TEST_HOST, TEST_IMAGE, TEST_USER_AGENT, type StubWorld, fixture, stubWorld } from "./stub-world.ts";

// The Sandbox port conformance suite against the real Sail adapter, talking HTTP and WebSocket to the shared loopback provider stub.
// The stub models Sail's collection generically (create, get, list, delete), so a pass proves the adapter's control logic and its
// wire shapes as the documentation fixtures describe them, not live Sail behaviour (README.md, "Unverified").

const worlds = new WeakMap<SandboxConformanceWorld, StubWorld>();

const lost = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

async function make(): Promise<SandboxConformanceWorld> {
  // `blind` scripts an unknown create outcome the stub's own faults cannot: the next create is applied (or dropped) and its reply
  // lost, and every later call fails the same way until that start settles, so the adapter's reconcile lookups see nothing either.
  let blind: { applied: boolean; sent: boolean } | null = null;
  const w = await stubWorld({
    fixture: fixture("conformance-drop.jsonl"),
    wrap: (inner) => async (url: string, init: SandboxRequestOptions) => {
      if (blind !== null) {
        if (!blind.sent && init.method === "POST" && new URL(url).pathname === SAIL_RESOURCE.collection) {
          blind.sent = true;
          if (blind.applied) await inner(url, init);
          throw lost();
        }
        if (blind.sent) throw lost();
      }
      return inner(url, init);
    },
  });
  const raw = w.sandbox;
  const sandbox = new Proxy(raw, {
    get(t, p) {
      if (p === "start") return (...a: Parameters<Sandbox["start"]>) => t.start(...a).finally(() => (blind = null));
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const sailboxOf = (id: SandboxId) => {
    const name = encodeName(SAIL_NAME_SCHEMA, { sandbox: id.slice(0, 32) });
    const r = w.stub.model.resources(SAIL_RESOURCE.collection).find((x) => x.name === name);
    return r === undefined ? undefined : String(r.sailbox_id);
  };
  const world: SandboxConformanceWorld = {
    sandbox,
    imageRef: TEST_IMAGE,
    owner: { host: TEST_HOST, storeId: "store-a", epoch: 1 },
    hooks: {
      unknownOutcome: (applied) => {
        blind = { applied, sent: false };
      },
      // The provider ends the box on its own: a delete the adapter did not make.
      preempt: async (id) => {
        const sb = sailboxOf(id);
        assert.ok(sb !== undefined, `no sailbox for sandbox ${id} to preempt`);
        const res = await w.request(`${w.stub.baseUrl}/v1/sailboxes/${sb}`, { method: "DELETE", headers: { authorization: `Bearer ${PLANTED_TOKEN}` } });
        assert.equal(res.status, 204);
      },
      // conformance-drop.jsonl cuts the first tunnel of the world's first sandbox after four bytes.
      dropChannel: (afterBytes) => assert.equal(afterBytes, 4, "conformance-drop.jsonl scripts a cut after 4 bytes; update the fixture"),
      requests: { expectedUserAgent: TEST_USER_AGENT, observe: () => w.ids.seen().map((s) => s.userAgent) },
      secrets: {
        secretsInEnv: false,
        // The adapter takes no secret at start (credentials travel after start over connect), so there is nothing to arm; the clause
        // still checks the create-time environment it observes below.
        plant: () => {},
        createEnv: (id) => {
          const name = encodeName(SAIL_NAME_SCHEMA, { sandbox: id.slice(0, 32) });
          for (const r of w.stub.requests()) {
            if (r.method !== "POST" || r.path !== SAIL_RESOURCE.collection) continue;
            const body = JSON.parse(r.rawBody) as { name?: string; env?: Record<string, string> };
            if (body.name === name) return body.env;
          }
          return undefined;
        },
      },
    },
  };
  worlds.set(world, w);
  return world;
}

const sut: SandboxUnderTest = {
  name: "sail",
  capabilities: sailProvider.declaration,
  listingTags: "required",
  // The stub is local, so the suite really runs: a closed environment is a failure here.
  acceptClosedEnvironment: false,
  requireCapabilities: ["connect"],
  make,
  async cleanup(world) {
    const w = worlds.get(world);
    if (w === undefined) return;
    try {
      w.stub.assertNoUnmatched();
      // The adapter never sends the credential anywhere but the Authorization header.
      for (const r of w.stub.requests()) assert.ok(!r.rawBody.includes(PLANTED_TOKEN), `request ${r.method} ${r.path} carries the API token in its body`);
      assert.ok(!JSON.stringify(w.logs).includes(PLANTED_TOKEN), "a log line carries the API token");
    } finally {
      await w.close();
    }
  },
};

// resolve-digest is left out: it requires imageIdentity to succeed, but the port says an adapter without image.digestAttest (this one)
// throws SandboxCapabilityError there, and the core contract wins. The clause should be conditional on image.digestAttest (ledger item
// for the conformance suite's owner); no declared capability is covered by it, so the floor is unaffected.
runSandboxConformance(sut, { clauses: SANDBOX_CONFORMANCE_CLAUSES.filter((c) => c.id !== "resolve-digest") });
