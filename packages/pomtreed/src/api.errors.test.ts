// Every failure class pomtreed answers with a machine-readable `code`: the exact code and message per class, driven through the real
// API (handle) over the daemon with fakes, each with a negative variant (the neighbouring success or class carries no code).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord, Template } from "@pomtree/core";
import { IdempotencyConflictError } from "@pomtree/core";
import { FakeDeterministicExecutor } from "@pomtree/testing";
import { DirTemplateStore } from "@pomtree/template-dir";
import { handle } from "./api.ts";
import { issueToken } from "./auth.ts";
import { API_ERROR_CODES } from "./error-codes.ts";
import { SECRET, setup } from "./test-setup.ts";

type Body = { error?: string; code?: string } & Record<string, unknown>;
const body = (r: { body: unknown }) => r.body as Body;
const done = async (c: { api: (m: string, u: string, b?: unknown) => Promise<unknown> }) =>
  void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok" } }));

function templateDir(files: Record<string, unknown>): { store: DirTemplateStore; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pomtreed-tpl-"));
  for (const [name, manifest] of Object.entries(files)) writeFileSync(join(root, `${name}.json`), JSON.stringify(manifest));
  return { store: new DirTemplateStore({ root }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("GET /v1/templates lists valid templates as before and each broken file as { id, error } (the New agent form's row shape)", async (t) => {
  const dir = templateDir({ good: { provider: "p", model: "m" }, bad: { cpus: "two" } });
  t.after(dir.cleanup);
  const s = setup(done, { templates: dir.store });
  const r = await s.operator("GET", "/v1/templates");
  assert.equal(r.status, 200);
  const rows = r.body as (Template | { id: string; error: string })[];
  const bad = rows.find((x) => x.id === "bad");
  // TODO(contract-drift): pinned here because the observe form's reader is an inline script; both sides must read `error` as a string.
  assert.deepEqual(bad, { id: "bad", error: "template error: bad: cpus must be a non-negative number" });
  const good = rows.find((x) => x.id === "good") as Template;
  assert.equal(good.model, "m");
  assert.ok(!("error" in good));
  // Negative: an all-valid store yields no error rows.
  const clean = templateDir({ only: {} });
  t.after(clean.cleanup);
  const c = setup(done, { templates: clean.store });
  assert.deepEqual(
    ((await c.operator("GET", "/v1/templates")).body as object[]).map((x) => "error" in x),
    [false],
  );
});

test("a broken template is 422 template_error on spawn and on GET /v1/templates/:id; an unknown one is 404 unknown_template", async (t) => {
  const dir = templateDir({ good: {}, bad: { egress: { kind: "wide-open" } } });
  t.after(dir.cleanup);
  const s = setup(done, { templates: dir.store });
  const spawn = await s.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "k-bad", template: "bad" });
  assert.equal(spawn.status, 422);
  assert.deepEqual(body(spawn), { error: 'template error: bad: unknown egress kind: "wide-open"', code: "template_error" });
  const get = await s.operator("GET", "/v1/templates/bad");
  assert.equal(get.status, 422);
  assert.equal(body(get).code, "template_error");
  const unknown = await s.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "k-none", template: "nope" });
  assert.equal(unknown.status, 404);
  assert.equal(body(unknown).code, "unknown_template");
  assert.match(body(unknown).error!, /^no such template: nope; /);
  // Negative: a valid template spawns (201) with no error code.
  const ok = await s.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "k-good", template: "good" });
  assert.equal(ok.status, 201);
  assert.equal(body(ok).code, undefined);
  await s.orchestrator.idle();
});

test("templates not configured names the setting; it is a plain 400 without a code", async () => {
  const s = setup(done, { templates: undefined });
  const r = await s.operator("GET", "/v1/templates");
  assert.equal(r.status, 400);
  assert.deepEqual(body(r), { error: "templates are not configured: set POMTREED_TEMPLATES_DIR, or create <state>/templates, and restart pomtreed" });
  const spawn = await s.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "k", template: "researcher" });
  assert.equal(spawn.status, 400);
  assert.match(body(spawn).error!, /POMTREED_TEMPLATES_DIR/);
});

test("an unknown model is 400 unknown_model with a pomtree models hint; a listed model spawns", async () => {
  const models = { list: async () => ({ models: [{ provider: "p", id: "m" }], source: "settings", default: { provider: "p", id: "m" } }) };
  const s = setup(done, { models: models as never });
  const r = await s.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "k1", model: { provider: "p", id: "zz" } });
  assert.equal(r.status, 400);
  assert.deepEqual(body(r), { error: "unknown model: p/zz; run `pomtree models` to list the models this host can use", code: "unknown_model" });
  const ok = await s.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "k2", model: { provider: "p", id: "m" } });
  assert.equal(ok.status, 201);
  assert.equal(body(ok).code, undefined);
  await s.orchestrator.idle();
});

test("a child budget over what the parent has left is 409 budget_exceeds_parent in dollars and micros", async () => {
  const s = setup(done);
  const r = await s.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "k", budgetMicros: 2_000_000 });
  assert.equal(r.status, 409);
  assert.equal(body(r).code, "budget_exceeds_parent");
  assert.match(body(r).error!, /^budget \$2\.00 \(2000000 micros\) exceeds the \$1\.00 \(1000000 micros\) the parent has left; /);
});

test("a keyed spawn of a finished agent is 409 idempotency_conflict; the first spawn has no code", async () => {
  const s = setup(done);
  const first = await s.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "k" });
  assert.equal(first.status, 201);
  assert.equal(body(first).code, undefined);
  await s.orchestrator.idle();
  const again = await s.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "k" });
  assert.equal(again.status, 409);
  assert.equal(body(again).code, "idempotency_conflict");
  assert.match(body(again).error!, /^already ran: (exited|reaped)\/succeeded; /);
});

test("a key replayed with a different request (store IdempotencyConflictError) is 409 idempotency_conflict naming the key and the remedy", async () => {
  const s = setup(done);
  // The spawn route's first store read throws the store's conflict, as store-sqlite once() does on a fingerprint mismatch.
  const root = s.daemon.root.bind(s.daemon);
  let conflict = true;
  s.daemon.root = async () => {
    if (conflict) {
      conflict = false;
      throw new IdempotencyConflictError("spawn", "reused");
    }
    return root();
  };
  const r = await s.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "reused" });
  assert.equal(r.status, 409);
  assert.equal(body(r).code, "idempotency_conflict");
  assert.match(body(r).error!, /idempotency key "reused" was already used for a different spawn request; .*unchanged, or use a new key/);
  // Negative: another key spawns with no code.
  const fresh = await s.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "fresh" });
  assert.equal(fresh.status, 201);
  assert.equal(body(fresh).code, undefined);
});

test("401: missing and forged credentials are token_invalid, an expired agent credential is token_revoked_or_expired; nothing is echoed", async () => {
  const s = setup(async () => {});
  const missing = await handle(s.daemon, { method: "GET", url: "/v1/whoami" });
  assert.equal(missing.status, 401);
  assert.deepEqual(body(missing), { error: "missing or invalid token", code: "token_invalid" });
  const forged = "ag.ag-1.0.99999999999999.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const bad = await handle(s.daemon, { method: "GET", url: "/v1/whoami", token: forged });
  assert.equal(bad.status, 401);
  assert.equal(body(bad).code, "token_invalid");
  const expiredToken = issueToken(SECRET, { scope: "agent", agent: "ag-1", generation: 0, expiry: Date.now() - 1 });
  const expired = await handle(s.daemon, { method: "GET", url: "/v1/whoami", token: expiredToken });
  assert.equal(expired.status, 401);
  assert.equal(body(expired).code, "token_revoked_or_expired");
  for (const [r, tok] of [
    [bad, forged],
    [expired, expiredToken],
  ] as const) {
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes(tok) && !text.includes(tok.slice(-64)), "the credential is never echoed");
    assert.doesNotMatch(text, /operator\.token/, "an agent credential is not told to check the operator token");
  }
  // Negative: an expired-looking token whose MAC is not ours is invalid, not expired; a valid operator call has no code.
  const notOurs = issueToken("other-secret", { scope: "agent", agent: "ag-1", generation: 0, expiry: Date.now() - 1 });
  assert.equal(body(await handle(s.daemon, { method: "GET", url: "/v1/whoami", token: notOurs })).code, "token_invalid");
  const fine = await s.operator("GET", "/v1/summary");
  assert.equal(fine.status, 200);
  assert.equal(body(fine).code, undefined);
});

test("a superseded run's credential is 409 stale_generation telling the agent to stop; the current one is served", async () => {
  const s = setup(async () => {});
  const root = await s.daemon.root();
  const a = await s.daemon.spawn(root.id, { name: "w", task: "t", idempotencyKey: "k" });
  const oldToken = s.daemon.agentToken(a.id, a.generation);
  await s.daemon.deps.registry.bumpGeneration(a.id, "h1", "bump-1");
  const r = await handle(s.daemon, { method: "GET", url: "/v1/whoami", token: oldToken });
  assert.equal(r.status, 409);
  assert.deepEqual(body(r), {
    error: `stale generation for ${a.id}: this run was superseded (generation ${a.generation}, current ${a.generation + 1}); stop`,
    code: "stale_generation",
  });
  const cur = await handle(s.daemon, { method: "GET", url: "/v1/whoami", token: s.daemon.agentToken(a.id, a.generation + 1) });
  assert.notEqual(cur.status, 409);
  assert.equal(body(cur).code, undefined);
});

test("every code pomtreed sets is in the closed API_ERROR_CODES set", () => {
  assert.deepEqual(
    [...API_ERROR_CODES].sort(),
    [
      "budget_exceeds_parent",
      "delegation_exceeds_parent",
      "idempotency_conflict",
      "stale_generation",
      "template_error",
      "token_invalid",
      "token_revoked_or_expired",
      "uncommitted_work",
      "unknown_model",
      "unknown_template",
    ].sort(),
  );
});

// The trace header's template comes from the `spawned` entry every spawn path journals (spawnedPayload), driven by real spawns.
test("trace header names the template of a real templated spawn, `code` for an untemplated one, and none for a deterministic task", async () => {
  const det = new FakeDeterministicExecutor("det");
  const s = setup(done, { deterministicExecutors: new Map([[det.driver, det]]) });
  s.fakes.hooks.raw.templates.templates.set("researcher", { id: "researcher", provider: "p", model: "m" });
  const trace = async (id: string) => (body(await s.operator("GET", `/v1/agents/${id}/trace?format=json`)) as { markdown: string }).markdown;
  const tpl = await s.spawn("k-tpl", { template: "researcher" });
  const plain = await s.spawn("k-plain");
  await s.orchestrator.idle();
  assert.match(await trace(tpl.id), /^- template: researcher; /m);
  assert.match(await trace(plain.id), /^- template: code; /m);
  const root = await s.daemon.root();
  const d = (await s.daemon.startDeterministic(root.id, {
    name: "det",
    task: "t",
    idempotencyKey: "k-det",
    executor: "deterministic",
    spec: { driver: "det", input: {} },
    budgetMicros: 10,
  })) as AgentRecord;
  await s.orchestrator.idle();
  assert.match(await trace(d.id), /^- template: none; /m);
});
