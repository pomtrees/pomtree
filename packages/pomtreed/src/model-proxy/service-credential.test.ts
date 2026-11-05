import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_PROXY_CREDENTIAL_EXPIRED, MODEL_PROXY_INVALID_CREDENTIAL } from "@pomtree/core";
import type { ModelDebitStore } from "@pomtree/core";
import { FakeModelDebitStore } from "@pomtree/testing";
import { formatAccessLine } from "../accesslog.ts";
import { encodeGatewayCredential } from "../gateway.ts";
import { RequestBudget } from "./request-budget.ts";
import { ModelProxy, RESERVE_REFUSAL_MESSAGES } from "./service.ts";
import type { ModelProxyOptions } from "./service.ts";

// credential-expired: a refused key answers 401 with MODEL_PROXY_CREDENTIAL_EXPIRED only when the store says it is expired;
// tampered, unknown and revoked keys keep MODEL_PROXY_INVALID_CREDENTIAL. The body is the code alone.
// Every model id these tests send: the credential allows them all (model_not_allowed has its own tests).
const TEST_MODELS = ["m", "ds", "nope", "big", "deepseek/deepseek-v4-pro", "DS", " ds", "ds:free", "p/ds", "ds\u0000"];
const secret = "controller-secret";
let clock = 1_000;
const now = () => clock;
const key = (expiresAt = 2_000) =>
  encodeGatewayCredential(secret, { agent: "agent-1", id: "a".repeat(32), budgetMicros: 100, expiresAt, issuedAt: 1_000, models: TEST_MODELS });
const noUpstream = async (): Promise<Response> => {
  throw new Error("must not call");
};

function proxy(budget: ModelProxyOptions["budget"], estimate?: ModelProxyOptions["estimate"]): ModelProxy {
  return new ModelProxy({
    upstream: { baseUrl: "https://provider.example/v1/", key: "provider-secret" },
    budget,
    maximumRequestMicros: 50,
    price: () => ({ micros: 20, basis: "catalog" }),
    fetch: noUpstream,
    estimate,
  });
}
const call = (p: ModelProxy, credential: string) =>
  p.forward({ credential, requestId: "r1", path: "/chat/completions", body: new TextEncoder().encode('{"model":"m"}') });
const tampered = () => `${key().slice(0, -2)}xx`;
// A request-shape refusal (authorize before the estimate) rather than the reserve path.
const refuseShape: ModelProxyOptions["estimate"] = () => ({ refuse: "no output limit" });

test("model proxy: an expired key gets 401 credential-expired on the reserve path, a tampered or unknown one invalid-credential", async () => {
  clock = 1_000;
  const p = proxy(new RequestBudget({ secret, now }));
  clock = 2_000; // expiresAt <= now
  assert.deepEqual(await call(p, key()), { status: 401, error: MODEL_PROXY_CREDENTIAL_EXPIRED });
  assert.deepEqual(await call(p, tampered()), { status: 401, error: MODEL_PROXY_INVALID_CREDENTIAL });
  assert.deepEqual(await call(p, "pg1.unknown.key"), { status: 401, error: MODEL_PROXY_INVALID_CREDENTIAL });
});

test("model proxy: the request-shape refusal path tells expired from invalid", async () => {
  clock = 2_000;
  const withAuthorize = proxy(new RequestBudget({ secret, now }), refuseShape);
  assert.deepEqual(await call(withAuthorize, key()), { status: 401, error: MODEL_PROXY_CREDENTIAL_EXPIRED });
  assert.deepEqual(await call(withAuthorize, tampered()), { status: 401, error: MODEL_PROXY_INVALID_CREDENTIAL });
  // A valid key is still the 400 shape refusal.
  assert.deepEqual(await call(withAuthorize, key(5_000)), { status: 400, error: "no output limit" });
});

test("model proxy: a revoked key is unchanged (invalid-credential), and a store without checkCredential never says expired", async () => {
  clock = 1_500;
  const store = new FakeModelDebitStore({ secret, now });
  store.revoke("agent-1");
  assert.deepEqual(await call(proxy(store), key()), { status: 401, error: MODEL_PROXY_INVALID_CREDENTIAL });
  assert.deepEqual(await call(proxy(store, refuseShape), key()), { status: 401, error: MODEL_PROXY_INVALID_CREDENTIAL });
  // Expired and revoked reads expired (expiry is judged first).
  clock = 3_000;
  assert.deepEqual(await call(proxy(store), key()), { status: 401, error: MODEL_PROXY_CREDENTIAL_EXPIRED });
  const rb = new RequestBudget({ secret, now });
  const debitOnlyStore: ModelDebitStore & Pick<RequestBudget, "authorize"> = {
    reserve: (k, id, m) => rb.reserve(k, id, m),
    settle: (r, c) => rb.settle(r, c),
    cancel: (r) => rb.cancel(r),
    authorize: (k) => rb.authorize(k),
  };
  assert.deepEqual(await call(proxy(debitOnlyStore), key()), { status: 401, error: MODEL_PROXY_INVALID_CREDENTIAL });
});

test("model proxy: other reserve refusals keep their 409 mapping", async () => {
  clock = 1_000;
  const p = proxy(new RequestBudget({ secret, now }));
  const ok = await p.forward({ credential: key(), requestId: "", path: "/chat/completions", body: new TextEncoder().encode('{"model":"m"}') });
  assert.deepEqual(ok, { status: 409, error: RESERVE_REFUSAL_MESSAGES["invalid-request"] });
  assert.match(RESERVE_REFUSAL_MESSAGES["invalid-request"], /^model request refused by the debit store \(invalid-request\): /);
});

test("access log classes a 401 credential-expired apart from invalid-credential", () => {
  const base = {
    at: new Date(0),
    listener: "model-proxy" as const,
    method: "POST",
    url: "/v1/chat/completions",
    durationMs: 1,
    principal: null,
    hadCredential: true,
  };
  assert.match(formatAccessLine({ ...base, status: 401, error: MODEL_PROXY_CREDENTIAL_EXPIRED }), / auth=credential-expired error="credential-expired"$/);
  assert.match(formatAccessLine({ ...base, status: 401, error: MODEL_PROXY_INVALID_CREDENTIAL }), / auth=invalid-credential /);
  // Without a credential the error code cannot promote a 401 to credential-expired.
  assert.match(formatAccessLine({ ...base, hadCredential: false, status: 401, error: MODEL_PROXY_CREDENTIAL_EXPIRED }), / auth=missing-credential /);
});
