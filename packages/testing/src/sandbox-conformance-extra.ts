import assert from "node:assert/strict";
import type { Clause, ClauseId } from "./sandbox-conformance.ts";

// The extended conformance clauses: the checks that need an observer the Sandbox port cannot carry. Each reads a hook the descriptor
// supplies (`hooks.requests`, `hooks.secrets`), and a descriptor without the hook skips the clause with a printed reason, never silently.
// The clause bodies live here and are registered through `SANDBOX_CONFORMANCE_CLAUSES` in sandbox-conformance.ts. This file imports only
// types from it, so the two do not form a runtime import cycle.
//
// How the provider stub supplies the hooks: it records, for every request the adapter makes, the `user-agent` header value (`undefined`
// when absent), so `requests.observe()` returns that list for the world's stub, and `requests.expectedUserAgent` is the value injected
// as `workflow.fetch.userAgent` (default `pomtree`). It also records the environment of each create-time call, so `secrets.createEnv(id)`
// returns the `env` of the create request for that sandbox, or `undefined` when no create request for it was recorded.

// The one prefix for a clause that cannot run because the backend or descriptor does not provide what it needs; the runner uses it for
// capability misses and `needsHook` for every missing hook, so a reader tells "not provided" from "failed" by it.
export const NOT_DECLARED = "conformance not declared: ";
export const needsHook = (name: string, present: boolean, why = "the clause cannot make the backend misbehave") =>
  present ? null : `${NOT_DECLARED}descriptor provides no ${name} hook (${why})`;

export const EXTENDED_CONFORMANCE_CLAUSES = [
  {
    id: "user-agent-stamped",
    title: "every request the adapter makes carries the configured User-Agent",
    needs: [],
    targets: ["start", "list", "stop", "kill"],
    fix: "stamp workflow.fetch.userAgent on every request the adapter makes (start, list, stop, kill and the rest) through one shared request helper, not per call site",
    skip: (_sut, world) =>
      needsHook("requests", world.hooks?.requests !== undefined, "the clause cannot observe the User-Agent of the requests the adapter makes"),
    async check(ctx) {
      const { requests } = ctx.hooks;
      assert.ok(requests !== undefined, "the requests hook disappeared after the skip check");
      const h = await ctx.sandbox.start(ctx.spec("ua"), ctx.key("ua-start"));
      await ctx.sandbox.list(ctx.owner);
      await ctx.sandbox.stop(h.id, 1000, ctx.key("ua-stop"));
      await ctx.sandbox.kill(h.id, ctx.key("ua-kill"));
      const seen = await requests.observe();
      assert.ok(
        seen.length > 0,
        "the requests hook observed no request after start, list, stop and kill, so the clause proves nothing; make the hook return the requests the adapter made to the provider",
      );
      const bad = seen.flatMap((ua, i) => (ua === requests.expectedUserAgent ? [] : [{ ua, i }]));
      assert.equal(
        bad.length,
        0,
        `${bad.length} of ${seen.length} requests went out without the configured User-Agent ${JSON.stringify(requests.expectedUserAgent)} (request ${bad.map((b) => b.i).join(", ")} sent ${bad.map((b) => JSON.stringify(b.ua ?? "no User-Agent")).join(", ")})`,
      );
    },
  },
  {
    id: "no-sentinel-in-env",
    title: "a planted secret is absent from the create-time environment (names and values) unless sandbox.secretsInEnv is set, and present when it is",
    needs: [],
    targets: ["start"],
    fix: "deliver secrets by proxy swap, else after start into a 0400 file, and put one in the create-time environment only when the operator sets sandbox.secretsInEnv (the scan is a plain-text match only: encoded leaks, such as base64 or URL-encoded, are not detected)",
    skip: (_sut, world) => needsHook("secrets", world.hooks?.secrets !== undefined, "the clause cannot plant a secret or observe the create-time environment"),
    async check(ctx) {
      const { secrets } = ctx.hooks;
      assert.ok(secrets !== undefined, "the secrets hook disappeared after the skip check");
      const sentinel = `conformance-sentinel-${ctx.key("sentinel")}`;
      await secrets.plant(sentinel);
      const marker = { CONFORMANCE_ENV_MARKER: "1" };
      const h = await ctx.sandbox.start(ctx.spec("sentinel", { env: marker }), ctx.key("sentinel"));
      const env = await secrets.createEnv(h.id);
      // An environment that was never inspected cannot show a leak, so it fails rather than passing vacuously.
      assert.ok(
        env !== undefined,
        `the create-time environment of sandbox ${h.id} could not be observed, so the clause cannot show whether the secret leaked; make the secrets hook return the env the adapter sent at create time`,
      );
      assert.equal(
        env.CONFORMANCE_ENV_MARKER,
        "1",
        "the observed create-time environment lacks the variable the clause set, so the adapter never sent the spec's env (or the hook reads the wrong sandbox); send spec.env at create time and observe that",
      );
      const holders = Object.entries(env)
        .filter(([k, v]) => k.includes(sentinel) || v.includes(sentinel))
        .map(([k]) => k.replaceAll(sentinel, "<secret>"));
      if (secrets.secretsInEnv) {
        assert.ok(
          holders.length > 0,
          "sandbox.secretsInEnv is set but the planted secret is absent from the create-time environment; with the option on the adapter must deliver the secret there",
        );
      } else {
        assert.deepEqual(
          holders,
          [],
          `the planted secret appears in the create-time environment variable(s) ${holders.join(", ")} while sandbox.secretsInEnv is off; deliver it by proxy swap or after start into a 0400 file instead`,
        );
      }
    },
  },
] as const satisfies readonly (Clause & { id: ClauseId })[];
