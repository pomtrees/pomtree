import assert from "node:assert/strict";
import test from "node:test";
import { SandboxOutcomeUnknownError, type SandboxSpec, sandboxIdForKey } from "@pomtree/core";
import { DedupError } from "@pomtree/sandbox-kit/dedup";
import { scaled } from "@pomtree/testing";
import { E2BApi } from "./api.ts";
import { E2BSandbox } from "./sandbox.ts";
import { API_KEY_PLACEHOLDER, type E2BStubWorld, startE2BStub } from "./stub-world.ts";

// Create deduplication through the stateful stub: E2B has no idempotency token, so a repeated or uncertain create is reconciled by
// listing on the pomtree.sandbox metadata tag (the kit's createOnce, tag-lookup mechanism).

const UA = "pomtree-e2b-test/1";
const spec = (agent: string, extra: Partial<SandboxSpec> = {}): SandboxSpec => ({ agent, image: "base", env: {}, mounts: [], ...extra });

async function world(): Promise<{ w: E2BStubWorld; sandbox: E2BSandbox }> {
  const w = await startE2BStub({ userAgent: UA });
  const api = new E2BApi({
    baseUrl: w.stub.baseUrl,
    request: w.request,
    apiKey: async () => API_KEY_PLACEHOLDER,
    timeoutMs: scaled(500),
    retry: { maxAttempts: 1 },
  });
  return { w, sandbox: new E2BSandbox({ api, template: "", timeoutS: 900, pollMs: 10, probe: { probes: 2, intervalMs: 0 } }) };
}
const created = (w: E2BStubWorld) => w.stub.model.resources("/sandboxes").length;
const creates = (w: E2BStubWorld) => w.stub.requests().filter((r) => r.method === "POST").length;

test("a replayed start with the same key adopts the sandbox its metadata names instead of creating a second one", async () => {
  const { w, sandbox } = await world();
  try {
    const a = await sandbox.start(spec("agent-1"), "key-1");
    const b = await sandbox.start(spec("agent-1"), "key-1");
    assert.equal(b.id, a.id);
    assert.equal(a.id, sandboxIdForKey("key-1"));
    assert.equal(created(w), 1, "one sandbox exists");
    assert.equal(creates(w), 1, "the replay listed and adopted; it sent no second create");
    // A fresh adapter instance (a restarted daemon) also finds it by its metadata.
    const again = await new E2BSandbox({
      api: new E2BApi({ baseUrl: w.stub.baseUrl, request: w.request, apiKey: async () => API_KEY_PLACEHOLDER }),
      template: "",
      timeoutS: 900,
    }).start(spec("agent-1"), "key-1");
    assert.equal(again.id, a.id);
    assert.equal(created(w), 1);
    assert.deepEqual(w.schemaFailures, [], "every create body fits the vendored E2B create schema");
    w.stub.assertNoUnmatched();
  } finally {
    await w.close();
  }
});

test("a create answered with a 5xx after it was applied reconciles to the one sandbox it made", async () => {
  const { w, sandbox } = await world();
  try {
    w.stub.faults.arm("server-error-after-apply", { method: "POST", path: "/sandboxes" });
    const h = await sandbox.start(spec("agent-2"), "key-2");
    assert.equal(h.id, sandboxIdForKey("key-2"));
    assert.equal(created(w), 1);
    assert.equal(creates(w), 1, "the uncertain create was not repeated");
    assert.deepEqual(await sandbox.inspect(h.id), { running: true, exitCode: null, status: "running" });
    w.stub.assertNoUnmatched();
  } finally {
    await w.close();
  }
});

test("a create with no reply that was not applied is an unknown outcome; the retry with the same key creates exactly one", async () => {
  const { w, sandbox } = await world();
  try {
    w.stub.faults.arm("timeout", { method: "POST", path: "/sandboxes" });
    const err = await sandbox.start(spec("agent-3"), "key-3").then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof SandboxOutcomeUnknownError, String(err));
    assert.equal(err.id, sandboxIdForKey("key-3"));
    assert.equal(err.idempotencyKey, "key-3");
    assert.equal(created(w), 0);
    const h = await sandbox.start(spec("agent-3"), "key-3");
    assert.equal(h.id, err.id);
    assert.equal(created(w), 1);
    w.stub.assertNoUnmatched();
  } finally {
    await w.close();
  }
});

test("a sandbox under the same key but another agent is refused, never adopted", async () => {
  const { w, sandbox } = await world();
  try {
    await sandbox.start(spec("agent-4"), "key-4");
    await assert.rejects(() => sandbox.start(spec("agent-intruder"), "key-4"), DedupError);
    assert.equal(created(w), 1);
  } finally {
    await w.close();
  }
});

test("a sandbox E2B removed on its own (timeout) is reported expired, never as a clean exit", async () => {
  const { w, sandbox } = await world();
  try {
    const h = await sandbox.start(spec("agent-5"), "key-5");
    await w.vanish(h.id);
    assert.deepEqual(await sandbox.inspect(h.id), { running: false, exitCode: null, status: "expired" });
    await assert.rejects(() => h.wait(), /ended without pomtree stopping it.*timeout expired/);
    await sandbox.stop(h.id, 1000, "stop-5"); // already gone: success
  } finally {
    await w.close();
  }
});

test("list(owner) fails closed: another store's sandbox and one without a store label are never returned", async () => {
  const { w, sandbox } = await world();
  try {
    const owner = { host: "h", storeId: "store-1", epoch: 2 };
    const mine = await sandbox.start(spec("agent-6", { labels: { store_id: "store-1", daemon_epoch: "2" } }), "key-6a");
    await sandbox.start(spec("agent-6", { labels: { store_id: "store-2" } }), "key-6b");
    await sandbox.start(spec("agent-6"), "key-6c");
    await sandbox.start(spec("agent-6", { labels: { store_id: "store-1", daemon_epoch: "3" } }), "key-6d");
    assert.deepEqual(
      (await sandbox.list(owner)).map((l) => l.id),
      [mine.id],
      "only the owner's store, at an epoch not newer than its own, is listed",
    );
    assert.equal(created(w), 4);
  } finally {
    await w.close();
  }
});

test("output() yields nothing and ends when the sandbox ends (no envd stream yet)", async () => {
  const { w, sandbox } = await world();
  try {
    const h = await sandbox.start(spec("agent-7"), "key-7");
    const chunks: unknown[] = [];
    const reading = (async () => {
      for await (const c of h.output()) chunks.push(c);
    })();
    await sandbox.kill(h.id, "kill-7");
    await reading;
    assert.deepEqual(chunks, []);
  } finally {
    await w.close();
  }
});
