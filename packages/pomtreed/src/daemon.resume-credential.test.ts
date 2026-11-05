import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "@pomtree/store-sqlite";
import { tmpDir } from "@pomtree/testing";
import { ProxyCredentialGateway } from "./gateway.ts";
import { get, kinds, SECRET, setup, until } from "./test-setup.ts";

// The resume-after-provider-backoff credential path over the real gateway and the durable sqlite debit store (a regression here
// rejects every resumed agent's model calls): the retryable provider_error yields on a timer, the wake resumes the agent, the
// yielded generation's key is refused as revoked and the resumed generation's key is accepted.
test("a resume after a provider-backoff yield issues a fresh model key and the old one is refused, over the sqlite debit store", async () => {
  const store = openStore(join(tmpDir("resume-credential-"), "store.sqlite"));
  try {
    const debits = store.modelDebit({ secret: SECRET });
    const gateway = new ProxyCredentialGateway({
      journal: store.journal,
      registry: store.registry,
      secret: SECRET,
      proxyBaseUrl: "http://model.invalid",
      tokenTtlMs: 3_600_000,
      debits,
    });
    const keys: string[] = [];
    const issue = gateway.issueKey.bind(gateway);
    gateway.issueKey = async (agent, budget, idem) => {
      const k = await issue(agent, budget, idem);
      keys.push(k.key);
      return k;
    };
    let aId = "";
    const t = setup(
      async (c) => {
        if (c.wake !== undefined) return void (await c.stopped); // the resumed generation stays running
        aId = c.agent;
        c.emit({ kind: "provider_error", code: "outage", message: "down", retryable: true });
      },
      {
        registry: store.registry,
        journal: store.journal,
        checkpoints: store.checkpoints,
        sessions: store.sessions,
        gateway,
        limits: { providerBackoffMs: 20, maxProviderBackoffMs: 100, maxProviderRetries: 3 },
        random: () => 0.5,
      },
    );
    await t.spawn();
    await until(async () => aId !== "" && kinds(await store.journal.read({ agent: aId })).includes("resumed") && keys.length === 2, 30_000).catch(() => {
      throw new Error("the provider-backoff yield never resumed the agent with a freshly issued model key within 30s");
    });
    await until(async () => (await get(t, aId)).state === "running", 30_000);
    const [old, fresh] = keys as [string, string];
    assert.notEqual(old, fresh, "the resume issues a new key");
    assert.deepEqual(gateway.checkCredential(old), { ok: false, reason: "revoked" }, "the yielded generation's key is refused");
    assert.deepEqual(debits.reserve(old, "r-old", 1), { ok: false, reason: "invalid-credential" }, "the proxy's reserve refuses the old key");
    assert.ok(gateway.authorize(fresh), "the resumed generation's key is accepted");
    assert.equal(debits.reserve(fresh, "r-new", 1).ok, true, "the proxy's reserve accepts the resumed key");
    await t.daemon.kill(aId);
    await t.orchestrator.idle();
  } finally {
    store.close();
  }
});
