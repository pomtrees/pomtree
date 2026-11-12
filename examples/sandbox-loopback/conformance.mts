// The conformance descriptor `pnpm conformance:sandbox examples/sandbox-loopback` loads (it lives inside the pinned tree, so it is
// imported from the measured bytes under the same import guard as the provider). The command builds `base` from the provider and the
// offline deps; this adds what only the backend's author knows: where the provider is (a fresh offline loopback server per clause),
// and the hooks that let clauses observe requests and make the provider misbehave.
import { DEFAULT_FETCH_USER_AGENT } from "@pomtree/core";
import type { SandboxBackendDeps, SandboxBackendProvider } from "@pomtree/core";
import type { SandboxConformanceWorld, SandboxUnderTest } from "@pomtree/testing";
import { startLoopbackServer } from "./conformance/loopback-server.mts";
import type { LoopbackServer } from "./conformance/loopback-server.mts";

export default function conformance(ctx: { provider: SandboxBackendProvider; deps: SandboxBackendDeps; base: SandboxUnderTest }): SandboxUnderTest {
  const { provider, deps, base } = ctx;
  const servers = new Map<SandboxConformanceWorld, LoopbackServer>();
  return {
    ...base,
    // The backend is not told which daemon host or generation started a sandbox, so its listings carry null for both (wire.mts).
    listingTags: "optional",
    // The provider fingerprints each create body, so a key reused for a different spec is refused (enables idempotency-conflict).
    startConflict: true,
    async make() {
      // The command's offline deps read a sentinel for the declared credential; the server accepts exactly that value.
      const server = await startLoopbackServer({ token: await deps.credential("apiKey") });
      const sandbox = provider.create({ ...deps, config: { ...deps.config, baseUrl: server.url } });
      const world: SandboxConformanceWorld = {
        sandbox,
        hooks: {
          unknownOutcome: (applied) => server.armUnknownOutcome(applied),
          preempt: (id) => server.preempt(id),
          // The command stamps the default fetch identity on deps.request, so that is the value every request must carry.
          requests: { expectedUserAgent: DEFAULT_FETCH_USER_AGENT, observe: () => server.userAgents() },
        },
      };
      servers.set(world, server);
      return world;
    },
    async cleanup(world) {
      await servers.get(world)?.close();
      servers.delete(world);
    },
  };
}
