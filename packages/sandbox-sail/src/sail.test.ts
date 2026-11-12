import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import {
  type SandboxListing,
  type SandboxOwner,
  SandboxCapabilityError,
  SandboxOutcomeUnknownError,
  SandboxQuotaError,
  SandboxUnavailableError,
  type SandboxSpec,
  sandboxIdForKey,
} from "@pomtree/core";
import { REDACTED } from "@pomtree/sandbox-kit";
import { FixtureError, assertAllRequestsCarry, assertFixtureFresh, parseFixture } from "@pomtree/testing";
import { SAIL_LIST_PAGE_SIZE, SailApi, SailHttpError, SailListTruncatedError, canonicalJson } from "./api.ts";
import { SAIL_TAGS_ENV, classify, listingState } from "./sail.ts";
import { PLANTED_TOKEN, SAIL_RESOURCE, TEST_IMAGE, TEST_USER_AGENT, fixture, fixturePath, stubWorld } from "./stub-world.ts";

// The key, agent, generation and daemon owner labels the documentation fixtures were written for (their create bodies hash to these
// values). The labels are the ones the daemon stamps (lifecycle.ts ownerLabels: daemon_epoch, store_id).
const KEY = "agent-a:1:start";
const DAEMON_LABELS = { daemon_epoch: "1", store_id: "store-a" };
const spec = (extra: Partial<SandboxSpec> = {}): SandboxSpec => ({
  agent: "agent-a",
  image: TEST_IMAGE,
  env: {},
  labels: DAEMON_LABELS,
  mounts: [{ kind: "workspace", workspace: "ws-a", containerPath: "/w", generation: 1 }],
  ...extra,
});
const OWNER = { host: "host-a", storeId: "store-a", epoch: 1 };

test("every fixture has a complete provenance header for provider sail and is fresh", () => {
  const names = readdirSync(new URL("./fixtures/", import.meta.url)).filter((f) => f.endsWith(".jsonl"));
  assert.ok(names.length >= 5, `expected the documentation fixtures, found ${names.join(", ")}`);
  for (const n of names) {
    const f = fixture(n);
    assert.equal(f.header.provider, "sail", n);
    // Nothing here was recorded from the live API: every fixture is written from the documentation.
    assert.equal(f.header.provenance, "inferred", n);
    assert.match(f.header.source, /docs\.sailresearch\.com/, n);
    assertFixtureFresh(f, new Date("2026-11-11T12:00:00Z"));
  }
  // Negative control: the loader refuses a fixture without the header.
  assert.throws(() => parseFixture('{"seq":1,"method":"GET","path":"/v1/sailboxes","status":200}\n', "x"), FixtureError);
});

test("a replayed duplicate Idempotency-Key returns the first sandbox, and the stub's key-ignoring break shows the check can fail", async (t) => {
  for (const broken of [false, true]) {
    await t.test(broken ? "broken provider" : "correct provider", async () => {
      const w = await stubWorld();
      try {
        // The first create is applied but its reply is lost (503); the adapter replays the same key inside the window.
        w.stub.faults.arm("server-error-after-apply", { method: "POST", path: SAIL_RESOURCE.collection });
        if (broken) w.stub.faults.arm("idempotent-create", { method: "POST", path: SAIL_RESOURCE.collection, times: 2 });
        const h = await w.sandbox.start(spec(), KEY);
        assert.equal(h.id, sandboxIdForKey(KEY));
        const posts = w.stub.requests().filter((r) => r.method === "POST");
        assert.equal(posts.length, 2, "one create and one replay");
        assert.equal(posts[0]?.idempotencyKey, posts[1]?.idempotencyKey, "the replay carries the same Idempotency-Key");
        const created = w.stub.model.resources(SAIL_RESOURCE.collection).length;
        if (broken) assert.equal(created, 2, "a provider that ignores the key makes a second sailbox, so a count of one is evidence");
        else assert.equal(created, 1, "the replay returned the first sailbox instead of creating a second");
        w.stub.assertNoUnmatched();
      } finally {
        await w.close();
      }
    });
  }
});

test("a retried create is byte-identical (fixture match.requestBodySha256), and a different body does not match", async () => {
  const w = await stubWorld({ fixture: fixture("create-replay.jsonl"), resources: false });
  try {
    const h = await w.sandbox.start(spec(), KEY);
    assert.equal(h.id, sandboxIdForKey(KEY));
    w.stub.assertNoUnmatched();
    w.stub.assertFixtureConsumed();
    const posts = w.stub.requests().filter((r) => r.method === "POST");
    assert.equal(posts.length, 2);
    assert.equal(posts[0]?.rawBody, posts[1]?.rawBody, "the raw bytes of the retry equal the first attempt's");
  } finally {
    await w.close();
  }
  // Negative control: the same key with one more env var hashes differently, so the fixture does not match and the start fails.
  const bad = await stubWorld({ fixture: fixture("create-replay.jsonl"), resources: false });
  try {
    await assert.rejects(() => bad.sandbox.start(spec({ env: { EXTRA: "1" } }), KEY));
    assert.match(bad.stub.model.unmatched.map((u) => u.reason).join("\n"), /requestBodySha256/);
  } finally {
    await bad.close();
  }
});

test("canonical JSON sorts keys at every depth and drops undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[{"y":2,"z":1}]},"b":1}');
});

test("429 maps to SandboxQuotaError with the provider's wait, and nothing is created", async () => {
  const w = await stubWorld();
  try {
    w.stub.faults.arm("rate-limit", { method: "POST", path: SAIL_RESOURCE.collection, retryAfterS: 7 });
    const err = await w.sandbox.start(spec(), KEY).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof SandboxQuotaError, `expected SandboxQuotaError, got ${String(err)}`);
    assert.equal(err.backend, "sail");
    assert.equal(err.retryAfterMs, 7000);
    assert.equal(w.stub.model.resources(SAIL_RESOURCE.collection).length, 0);
  } finally {
    await w.close();
  }
});

test("an unknown create outcome reconciles: every reply lost, the lookup finds the applied sailbox and adopts it", async () => {
  const w = await stubWorld();
  try {
    w.stub.faults.arm("server-error-after-apply", { method: "POST", path: SAIL_RESOURCE.collection, times: Number.POSITIVE_INFINITY });
    const h = await w.sandbox.start(spec(), KEY);
    assert.equal(h.id, sandboxIdForKey(KEY));
    assert.equal(w.stub.model.resources(SAIL_RESOURCE.collection).length, 1);
    assert.ok(w.logs.some((l) => l.event === "sail.adopt"));
    const listed = await w.sandbox.list(OWNER);
    assert.deepEqual(
      listed.map((l) => [l.id, l.agent, l.host, l.generation]),
      [[h.id, "agent-a", "host-a", 1]],
    );
  } finally {
    await w.close();
  }
  // And when the create never landed and the lookups fail too, the outcome stays unknown, carrying the derived id.
  const lost = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const dark = await stubWorld({
    wrap: (inner) => async (url, init) => {
      if (init.method === "POST" || new URL(url).pathname === SAIL_RESOURCE.collection) {
        if (init.method === "POST" || dark.stub.requests().length > 0) throw lost;
      }
      return inner(url, init);
    },
  });
  try {
    const err = await dark.sandbox.start(spec(), KEY).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof SandboxOutcomeUnknownError, `expected SandboxOutcomeUnknownError, got ${String(err)}`);
    assert.equal(err.id, sandboxIdForKey(KEY));
    assert.equal(dark.stub.model.resources(SAIL_RESOURCE.collection).length, 0);
  } finally {
    await dark.close();
  }
});

test("the API token never reaches an error, a probe result or a log line, even when the provider echoes it", async () => {
  const w = await stubWorld({ fixture: fixture("provider-errors.jsonl"), resources: false });
  try {
    const probe = await w.sandbox.probe();
    assert.equal(probe.problems[0]?.code, "auth");
    assert.ok(probe.problems[0]?.cause.includes(REDACTED), "the echoed token is replaced, not dropped silently");
    const err = await w.sandbox.start(spec(), KEY).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof Error);
    assert.match(err.message, /HTTP 500/);
    for (const text of [JSON.stringify(probe), err.message, String(err.stack), JSON.stringify(w.logs)]) {
      assert.ok(!text.includes(PLANTED_TOKEN), `the token leaked into: ${text.slice(0, 200)}`);
    }
    w.stub.assertFixtureConsumed();
  } finally {
    await w.close();
  }
});

test("every request, the tunnel upgrade included, carries the configured fetch identity", async () => {
  const w = await stubWorld({ fixture: fixture("tunnel.jsonl"), resources: false });
  try {
    const id = sandboxIdForKey(KEY);
    const ch = await w.sandbox.connect.open(id, "daemon-api");
    await ch.write("hello");
    const got: string[] = [];
    for await (const c of ch.output()) got.push(Buffer.from(c).toString("utf8"));
    assert.deepEqual(got, ["world"]);
    assert.deepEqual(await ch.closed, { reason: "remote" });
    ch.close();
    w.stub.assertNoUnmatched();
    w.stub.assertFixtureConsumed();
    assert.ok(w.ids.seen().some((s) => s.upgrade));
    assertAllRequestsCarry(w.ids, TEST_USER_AGENT);
    // Negative control: the collector rejects a value the requests did not carry.
    assert.throws(() => assertAllRequestsCarry(w.ids, "someone-else"));
  } finally {
    await w.close();
  }
});

test("a command runs as a background exec whose exit code wait() reports", async () => {
  const w = await stubWorld({ fixture: fixture("exec-wait.jsonl"), resources: false });
  try {
    const h = await w.sandbox.start(spec({ cmd: ["/worker", "run"] }), KEY);
    assert.deepEqual(await h.wait(), { exitCode: 3 });
    w.stub.assertNoUnmatched();
    w.stub.assertFixtureConsumed();
  } finally {
    await w.close();
  }
});

test("lifecycle on the stub: stop ends the sailbox, inspect and wait agree, a provider-side end is not a clean exit", async () => {
  const w = await stubWorld();
  try {
    const a = await w.sandbox.start(spec(), KEY);
    assert.deepEqual(await w.sandbox.inspect(a.id), { running: true, exitCode: null, status: "running" });
    await w.sandbox.stop(a.id, 1000, "stop-1");
    assert.deepEqual(await a.wait(), { exitCode: 137 });
    assert.deepEqual(await w.sandbox.inspect(a.id), { running: false, exitCode: 137, status: "exited" });
    await w.sandbox.kill(a.id, "kill-again"); // already gone: success
    const b = await w.sandbox.start(spec({ agent: "agent-b" }), "agent-b:1:start");
    const sb = w.stub.model.resources(SAIL_RESOURCE.collection).find((r) => r.name === `pomtree-${b.id.slice(0, 32)}`);
    await w.request(`${w.stub.baseUrl}/v1/sailboxes/${String(sb?.sailbox_id)}`, { method: "DELETE", headers: { authorization: "Bearer x" } });
    assert.deepEqual(await w.sandbox.inspect(b.id), { running: false, exitCode: null, status: "terminated" });
    await assert.rejects(() => b.wait(), SandboxUnavailableError);
    await assert.rejects(() => w.sandbox.attach(b.id, "agent-b"), SandboxUnavailableError);
  } finally {
    await w.close();
  }
});

test("list skips sailboxes that are not pomtree's or whose name and tags disagree", async () => {
  const w = await stubWorld();
  try {
    const h = await w.sandbox.start(spec(), KEY);
    const mine = w.stub.model.resources(SAIL_RESOURCE.collection)[0] as { env: Record<string, string> };
    const tags = mine.env[SAIL_TAGS_ENV] as string;
    const post = (body: unknown) =>
      w.request(`${w.stub.baseUrl}/v1/sailboxes`, {
        method: "POST",
        headers: { authorization: "Bearer x", "idempotency-key": canonicalJson(body), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post({ name: "someone-elses-box", env: {} });
    await post({ name: "pomtree-0123456789abcdef0123456789abcdef", env: { [SAIL_TAGS_ENV]: tags } }); // copied tags, wrong name
    await post({ name: `pomtree-${h.id.slice(0, 32)}`, env: { [SAIL_TAGS_ENV]: "not json" } });
    const listed = await w.sandbox.list(OWNER);
    assert.deepEqual(
      listed.map((l) => l.id),
      [h.id],
    );
  } finally {
    await w.close();
  }
});

test("start refuses what a sailbox cannot honour, before any request", async () => {
  const w = await stubWorld();
  try {
    const cases: [Partial<SandboxSpec>, RegExp][] = [
      [{ egress: { allow: [{ host: "example.org" }] } }, /cannot enforce the template's egress allowlist/],
      [{ runtime: { ociRuntime: "runsc" } }, /no runtime block/],
      [{ mounts: [{ kind: "bind", hostPath: "/x", containerPath: "/x" }] }, /bind mount needs a host directory/],
      [{ env: { [SAIL_TAGS_ENV]: "x" } }, /reserved/],
      [{ env: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`V${i}`, "1"])) }, /at most 100/],
      [{ labels: { "pomtree.x": "1" } }, /label name/],
    ];
    for (const [extra, re] of cases) await assert.rejects(() => w.sandbox.start(spec(extra), KEY), re);
    assert.equal(w.stub.requests().length, 0);
    // image.digestAttest is not declared, so identity is the daemon's to resolve from the registry, pinned reference or not.
    for (const ref of ["registry.example/agent:latest", TEST_IMAGE]) {
      await assert.rejects(
        () => w.sandbox.imageIdentity(ref),
        (e: unknown) => e instanceof SandboxCapabilityError && e.capability === "image.digestAttest" && /registry/.test(e.action),
      );
    }
  } finally {
    await w.close();
  }
});

test("create failures are classified: 5xx and lost connections are unknown, everything else definite", () => {
  assert.equal(classify(Object.assign(new Error("x"), { code: "ECONNRESET" })), "unknown");
  assert.equal(classify(new Error("request POST x failed: no complete response within 5 ms")), "unknown");
  assert.equal(classify(new SandboxQuotaError("sail", "rate", null)), "failed");
  assert.equal(classify(new SandboxUnavailableError("auth")), "failed");
  assert.equal(classify(new Error("certificate has expired")), "failed");
  // A request timeout or a conflict may hide a create that landed, so the tag lookup decides; other 4xx are definite.
  assert.equal(classify(new SailHttpError(408, "x")), "unknown");
  assert.equal(classify(new SailHttpError(409, "x")), "unknown");
  assert.equal(classify(new SailHttpError(400, "x")), "failed");
  assert.equal(classify(new SailHttpError(422, "x")), "failed");
  assert.equal(classify(new SailHttpError(503, "x")), "unknown");
});

test("provider states map to listing states; undocumented ones are unknown", () => {
  assert.equal(listingState(undefined), "running");
  assert.equal(listingState("sleeping"), "running");
  assert.equal(listingState("paused"), "paused");
  assert.equal(listingState("terminated"), "exited");
  assert.equal(listingState("melted"), "unknown");
  assert.ok(fixturePath("tunnel.jsonl").endsWith("tunnel.jsonl"));
});

// A mirror of ownedByUs in packages/pomtreed/src/daemon/reconcile-remote.ts (the predicate remote reconcile adopts by). This package
// does not depend on pomtreed, so the rules are copied here; keep them in step with that function.
function ownedByUsRules(s: SandboxListing, owner: SandboxOwner): true | string {
  const labels = s.labels;
  if (labels?.store_id === undefined || labels.daemon_epoch === undefined) return "no pomtree owner tags";
  if (labels.store_id !== owner.storeId || owner.storeId === "") return "tagged for another store";
  if (!/^\d+$/.test(labels.daemon_epoch) || Number(labels.daemon_epoch) > owner.epoch) return "epoch tag foreign or newer";
  if (s.host === null || s.generation === null || !Number.isSafeInteger(s.generation)) return "no host or generation tag";
  if (s.host !== owner.host) return `owned by host ${s.host}`;
  return true;
}

test("the daemon's owner labels round-trip: list(owner) returns them and remote reconcile's ownership rules accept the sandbox", async () => {
  // As the daemon builds them: sandboxOwner gives { host, storeId, epoch: Number(epoch) }, ownerLabels gives store_id and
  // daemon_epoch (the epoch as a millisecond-timestamp string), and the workspace mount carries the generation.
  const epoch = 1_762_900_000_000;
  const owner: SandboxOwner = { host: "host-a", storeId: "store-7", epoch };
  const w = await stubWorld();
  try {
    const labels = { store_id: owner.storeId, daemon_epoch: String(epoch) };
    const s = spec({ labels, mounts: [{ kind: "workspace", workspace: "ws-a", containerPath: "/w", generation: 4 }] });
    const h = await w.sandbox.start(s, "agent-a:4:start");
    const listed = await w.sandbox.list(owner);
    assert.equal(listed.length, 1);
    const l = listed[0] as SandboxListing;
    assert.deepEqual([l.id, l.host, l.generation, l.labels], [h.id, "host-a", 4, labels]);
    assert.equal(ownedByUsRules(l, owner), true);
    // Negative controls: the same listing is not ours for another store or an older daemon epoch.
    assert.notEqual(ownedByUsRules(l, { ...owner, storeId: "store-8" }), true);
    assert.notEqual(ownedByUsRules(l, { ...owner, epoch: epoch - 1 }), true);
  } finally {
    await w.close();
  }
});

test("a listing that may be partial is refused, so kill, attach and list never treat a box past the first page as gone", async () => {
  // A next marker in the reply.
  const w = await stubWorld({ fixture: fixture("list-truncated.jsonl"), resources: false });
  try {
    await assert.rejects(() => w.sandbox.kill(sandboxIdForKey("agent-z:1:start"), "kill-z"), SailListTruncatedError);
    w.stub.assertFixtureConsumed();
  } finally {
    await w.close();
  }
  // A full page (the inferred default page size).
  const full = await stubWorld();
  try {
    for (let i = 0; i < SAIL_LIST_PAGE_SIZE; i++) {
      const r = await full.request(`${full.stub.baseUrl}/v1/sailboxes`, {
        method: "POST",
        headers: { authorization: "Bearer x", "idempotency-key": `k${i}`, "content-type": "application/json" },
        body: JSON.stringify({ name: `other-${i}`, env: {} }),
      });
      assert.equal(r.status, 201);
    }
    const id = sandboxIdForKey("agent-z:1:start");
    for (const call of [() => full.sandbox.kill(id, "k"), () => full.sandbox.attach(id, "agent-z"), () => full.sandbox.list(OWNER)]) {
      await assert.rejects(call, (e: unknown) => e instanceof SailListTruncatedError && /first page/.test(e.message) && /README/.test(e.message));
    }
  } finally {
    await full.close();
  }
});

test("a sandbox absent from a complete listing is gone: kill and stop succeed (the port's already-gone rule)", async () => {
  const w = await stubWorld();
  try {
    await w.sandbox.kill(sandboxIdForKey("agent-z:1:start"), "k");
    await w.sandbox.stop(sandboxIdForKey("agent-z:1:start"), 1000, "s");
  } finally {
    await w.close();
  }
});

test("an echoed create-time env is redacted from provider errors, not only the token", async () => {
  const planted = "planted-env-value-4242";
  const w = await stubWorld({
    wrap: (inner) => async (url, init) => {
      if (init.method !== "POST") return inner(url, init);
      const echo = { error: "invalid", message: "bad request", request: { name: "x", env: { GIT_AUTHOR: planted, NESTED: { env: { A: planted } } } } };
      return { status: 422, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(echo)) };
    },
  });
  try {
    const err = await w.sandbox.start(spec({ env: { GIT_AUTHOR: planted } }), KEY).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof SailHttpError, `expected SailHttpError, got ${String(err)}`);
    assert.equal(err.status, 422);
    assert.ok(!err.message.includes(planted), `the echoed env value leaked: ${err.message}`);
    assert.match(err.message, /bad request/, "the rest of the body is kept for the operator");
  } finally {
    await w.close();
  }
});

test("baseUrl must be https; plain http is accepted only for a loopback address", () => {
  const o = {
    request: Object.assign(async () => ({ status: 200, headers: {}, body: new Uint8Array() }), {
      openWebSocket: (): WebSocket => {
        throw new Error("no");
      },
    }),
    token: async () => "t",
  };
  for (const ok of ["https://sailbox-api.sailresearch.com/v1", "http://127.0.0.1:9/v1", "http://localhost:9/v1", "http://[::1]:9/v1"])
    new SailApi({ ...o, baseUrl: ok });
  for (const bad of ["http://sailbox-api.sailresearch.com/v1", "http://10.0.0.5/v1", "ftp://x/v1"]) {
    assert.throws(() => new SailApi({ ...o, baseUrl: bad }), /sandbox\.sail\.baseUrl .*https.*set it to/);
  }
});
