// A container start failure ends the run with its classified cause, a journal `error` entry naming the kind and whether a retry
// could help, and a parent handoff that says what happened; Docker being down also holds admission. Plus the provider errors
// that stop a run at once (auth, funding, config) and the ones that do not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxStartError, SandboxUnavailableError } from "@pomtree/core";
import type { AgentRecord, HarnessEvent } from "@pomtree/core";
import { MODEL_BUDGET_EXHAUSTED } from "./model-proxy/service.ts";
import { kinds, setup, until } from "./test-setup.ts";

type Setup = ReturnType<typeof setup>;
const errors = async (t: Setup, id: string) =>
  (await t.journal.read({ agent: id })).filter((e) => e.payload.kind === "error").map((e) => (e.payload as { message: string }).message);
const exited = async (t: Setup, id: string) =>
  (await t.journal.read({ agent: id })).find((e) => e.payload.kind === "exited")?.payload as { exit: string; cause?: string } | undefined;
const summary = (r: AgentRecord) => (r.result as { summary?: string } | null)?.summary ?? "";

for (const [kind, retryable, cause] of [
  ["image_unavailable", false, "image_unavailable"],
  ["pull_failed", true, "pull_failed"],
  ["unknown", false, "start_failed"],
  ["egress_start_failed", false, "start_failed"],
] as const) {
  test(`a ${kind} start failure ends failed (${cause}) terminally, with the kind in the journal and the handoff`, async () => {
    const t = setup(async () => {});
    t.fakes.hooks.raw.sandbox.startErrors.push(new SandboxStartError(kind, `boom \u001b[31mred\u001b[0m ${kind}`, retryable));
    const a = await t.spawn();
    await t.orchestrator.idle();
    const rec = (await t.daemon.get(a.id)) as AgentRecord;
    assert.equal(rec.exit, "failed");
    assert.deepEqual(await exited(t, a.id), { kind: "exited", exit: "failed", cause } as never);
    const msg = (await errors(t, a.id))[0] ?? "";
    assert.ok(msg?.startsWith(`sandbox start failed (kind=${kind}, retryable=${retryable}): boom `), msg);
    assert.ok(!msg.includes("\u001b"), "control characters are stripped from the journaled start error");
    assert.match(summary(rec), new RegExp(`ended failed \\(${cause}\\)`));
    // Retryable or not, a failed start is not retried by pomtreed (the adapter already retried pulls): one start attempt, no resume.
    assert.equal(t.fakes.hooks.raw.sandbox.started.length, 0);
    assert.ok(!kinds(await t.journal.read({ agent: a.id })).includes("resumed"));
    // Negative: only Docker-down failures hold admission.
    assert.equal((await t.daemon.doctor()).sandboxUp, true);
  });
}

for (const [label, err] of [
  ["a typed endpoint_unreachable start failure", new SandboxStartError("endpoint_unreachable", "sandbox unavailable", true)],
  ["a bare SandboxUnavailableError", new SandboxUnavailableError()],
] as const) {
  test(`${label} (Docker down) ends sandbox_unavailable, marks the sandbox down and holds admission`, async (ctx) => {
    const t = setup(async () => {});
    // The held admission of `b` polls until the sandbox recovers or the daemon drains; drain so the file can exit.
    ctx.after(() => t.daemon.shutdown(Date.now() + 10_000));
    const root = await t.daemon.root();
    t.fakes.hooks.raw.sandbox.startErrors.push(err);
    const a = await t.spawn();
    await t.orchestrator.idle();
    const rec = (await t.daemon.get(a.id)) as AgentRecord;
    assert.equal(rec.exit, "failed");
    assert.equal((await exited(t, a.id))?.cause, "sandbox_unavailable");
    assert.match(
      (await errors(t, a.id))[0] ?? "",
      /^sandbox start failed \(kind=(endpoint_unreachable, retryable=true|unavailable)\): .*sandbox backend was unreachable/,
    );
    assert.match(summary(rec), /ended failed \(sandbox_unavailable\).*local engine, start it/);
    assert.equal((await t.daemon.doctor()).sandboxUp, false);
    assert.ok((await t.journal.read({ agent: root.id })).some((e) => e.payload.kind === "host_error"));
    const b = await t.spawn("k2");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await t.daemon.get(b.id))!.state, "pending", "admission holds while the sandbox is down");
  });
}

const providerRun = async (ev: HarnessEvent) => {
  const t = setup(async (c) => {
    c.emit(ev);
    await until(async () => (await t.daemon.get(c.agent))?.state !== "running", 1500).catch(() => {});
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  return { t, id: a.id, rec: (await t.daemon.get(a.id)) as AgentRecord };
};

test("provider funding and config stop the run at once with provider_error and a journaled reason naming the fix", async () => {
  for (const [code, re] of [
    ["funding", /^provider funding: the model provider account is out of credits; /],
    ["config", /^provider config: .*POMTREED_MODEL_BASE_URL and the model/],
  ] as const) {
    const { t, id, rec } = await providerRun({ kind: "provider_error", code, message: "402 insufficient credits", retryable: false });
    assert.equal(rec.exit, "failed", code);
    assert.equal((await exited(t, id))?.cause, "provider_error", code);
    assert.ok(
      (await errors(t, id)).some((m) => re.test(m)),
      code,
    );
    assert.ok(!kinds(await t.journal.read({ agent: id })).includes("yielded"), `${code} is not retried`);
  }
});

test("negative: auth stops without a funding/config reason; outage backs off instead of stopping", async () => {
  const auth = await providerRun({ kind: "provider_error", code: "auth", message: "bad key", retryable: false });
  assert.equal((await exited(auth.t, auth.id))?.cause, "provider_error");
  assert.ok(!(await errors(auth.t, auth.id)).some((m) => /^provider (funding|config):/.test(m)));
  const outage = await providerRun({ kind: "provider_error", code: "outage", message: "503", retryable: true });
  assert.ok(kinds(await outage.t.journal.read({ agent: outage.id })).includes("yielded"), "outage yields to back off");
  assert.ok(!(await errors(outage.t, outage.id)).some((m) => /^provider (funding|config):/.test(m)));
});

test("negative: our own proxy's budget refusal is the budget path, never provider funding", async () => {
  const { t, id, rec } = await providerRun({ kind: "error", message: `402 ${MODEL_BUDGET_EXHAUSTED}: 5 micro-USD remain after in-flight requests` });
  assert.notEqual((await exited(t, id))?.cause, "provider_error");
  assert.ok(rec);
  assert.ok(!(await errors(t, id)).some((m) => /^provider funding:/.test(m)));
});
