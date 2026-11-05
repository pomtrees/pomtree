// CRD (S0, in-process, no Docker): the per-task credential rules against pomtreed's REAL model proxy server over the scripted fake model,
// wired to a real Daemon with the real credential gateway (proxy-rig.ts). The agent's credential is what the daemon issued and staged
// for Pi, captured at the staging call. Covers CRD-2 at S0 (a canary scan of the env, command, mounts, harness arguments, journal and
// state files), CRD-3 (revoked at reap, expired versus invalid) and CRD-4 (model allowlist; a resume gets a fresh key and the
// pre-yield key is refused). The container half of each is cli-scenarios / docker-proxy-path. Run: node --test packages/e2e/src/proxy-credentials.test.ts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MODEL_PROXY_CREDENTIAL_EXPIRED, MODEL_PROXY_INVALID_CREDENTIAL, decodeGatewayCredential } from "@pomtree/core";
import type { AgentId } from "@pomtree/core";
import { SECRET, until } from "./harness.ts";
import { MODEL, OTHER_MODEL, proxyRig } from "./proxy-rig.ts";
import type { CallResult, ProxyRig } from "./proxy-rig.ts";

const text = (marker: string, times = 1) =>
  ({ id: marker, when: { marker }, times, reply: { kind: "text", text: marker.toUpperCase(), usage: { input: 100, output: 50 } } }) as const;
const OK = { status: "succeeded", result: null } as const;
const POOL = 100_000;

// ---------------------------------------------------------------------------------------------------------------------------------
// CRD-2 at S0

interface Scan {
  hits: string[]; // where the canary was found
  looked: string[]; // everywhere the scan looked, so a scan that looked nowhere cannot pass
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// Looks for `canary` in everything the daemon recorded or staged. Names every place it looked.
async function scanFor(canary: string, px: ProxyRig, extra: Record<string, string> = {}): Promise<Scan> {
  const needle = Buffer.from(canary);
  const scan: Scan = { hits: [], looked: [] };
  const look = (where: string, bytes: string | Buffer) => {
    scan.looked.push(where);
    if (Buffer.from(bytes).includes(needle)) scan.hits.push(where);
  };
  px.r.sandbox.started.forEach((spec, i) => {
    look(`sandbox create #${i} env`, JSON.stringify(spec.env));
    look(`sandbox create #${i} command`, JSON.stringify(spec.cmd ?? []));
    look(`sandbox create #${i} mounts`, JSON.stringify(spec.mounts));
    look(`sandbox create #${i} whole spec (labels, runtime, egress, resources)`, JSON.stringify(spec));
  });
  for (const [i, args] of px.harnessCalls.entries()) look(`harness start/resume arguments #${i}`, args);
  for (const a of await px.r.daemon.deps.registry.list({})) {
    for (const e of await px.journalOf(a.id)) look(`journal row seq ${e.seq} of ${a.id}`, JSON.stringify(e));
  }
  for (const file of walk(px.stateDir)) look(`state file ${file.slice(px.stateDir.length + 1)}`, readFileSync(file));
  for (const [where, bytes] of Object.entries(extra)) look(where, bytes);
  return scan;
}

const assertClean = (scan: Scan, when: string) => {
  for (const place of ["sandbox create #0 env", "sandbox create #0 command", "sandbox create #0 mounts", "harness start/resume arguments #0"])
    assert.ok(scan.looked.includes(place), `${when}: the scan must have looked at "${place}"; it looked at ${scan.looked.length} places`);
  assert.ok(
    scan.looked.some((w) => w.startsWith("journal row ")),
    `${when}: the scan must have read journal rows`,
  );
  assert.ok(
    scan.looked.some((w) => w.startsWith("state file pomtreed.sqlite")),
    `${when}: the scan must have read the state database`,
  );
  assert.deepEqual(
    scan.hits,
    [],
    `${when}: the upstream key canary appears in ${scan.hits.length} place(s): ${scan.hits.join("; ")}. Stop, do not share the evidence, and tell the coordinator`,
  );
};

test("CRD-2: a random upstream-key canary appears in no sandbox env/command/mount, harness argument, journal row or state file, live or after reap", {
  timeout: 60_000,
}, async () => {
  const canary = randomBytes(24).toString("base64");
  const responses: CallResult[] = [];
  let called!: () => void;
  const callDone = new Promise<void>((r) => (called = r));
  const px: ProxyRig = await proxyRig({
    script: { name: "crd-2", rules: [text("c1")] },
    upstreamKey: canary,
    rootBudgetMicros: POOL,
    play: (agent) => ({
      run: async () => {
        responses.push(await px.call(px.keyOf(agent), { requestId: "r1", marker: "c1" }));
        called();
      },
      hold: px.hold(),
      result: OK,
    }),
  });
  try {
    const root = await px.r.daemon.root();
    const a = await px.r.daemon.spawn(root.id, { name: "a", task: "t", idempotencyKey: "a", budgetMicros: 10_000 });
    await callDone;
    assert.equal(responses[0]!.status, 200, `the agent's proxied call must succeed through the real proxy: ${responses[0]!.text.slice(0, 200)}`);
    assert.equal(px.stub.calls.length, 1);
    // Positive control: the proxy really presented the canary upstream, so the clean scans below mean it was held back, not unused.
    assert.deepEqual(px.upstreamCarriedKey, [true], "the proxy's upstream call must carry the canary as its Bearer key");
    await px.settlement(a.id, "r1");

    // Live: the staged credential files exist now. The scan must cover them, and they hold the ISSUED key, never the upstream one.
    const staged = walk(px.stateDir).filter((f) => f.includes(`${join("agents", a.id, "pi")}`));
    assert.ok(
      staged.some((f) => f.endsWith("auth.json")),
      `the live agent's staged auth.json must exist under the state dir; found ${staged.map((f) => f.slice(px.stateDir.length + 1)).join(", ")}`,
    );
    assert.ok(
      readFileSync(staged.find((f) => f.endsWith("auth.json"))!, "utf8").includes(px.keyOf(a.id)),
      "the staged auth.json must carry the issued per-agent key",
    );
    const live = await scanFor(canary, px, {
      "the proxied response body returned to the agent": responses[0]!.text,
      "the proxied response headers returned to the agent": JSON.stringify([...responses[0]!.headers]),
    });
    assertClean(live, "while the agent runs");

    // Negative control: the same scan, with the canary planted in one scratch file inside the scanned tree, must find exactly that file.
    const scratch = join(px.stateDir, "scratch-canary.txt");
    writeFileSync(scratch, `planted ${canary}`);
    const control = await scanFor(canary, px);
    rmSync(scratch, { force: true });
    assert.deepEqual(
      control.hits,
      ["state file scratch-canary.txt"],
      "negative control: the scan must find the canary planted in the state dir, and nothing else",
    );
    const controlText = await scanFor(canary, px, { "planted text": `x${canary}y` });
    assert.deepEqual(controlText.hits, ["planted text"], "negative control: the scan must find a canary in a planted text source");

    // Result and reap, then scan again: the journal now holds the whole run, and the staged credential files are gone.
    px.releaseHolds();
    await px.r.orchestrator.idle();
    await until(async () => (await px.r.daemon.get(a.id))?.state === "reaped", `${a.id} to be reaped`);
    const after = await scanFor(canary, px);
    assertClean(after, "after the agent was reaped");
    assert.ok(
      after.looked.some((w) => w.startsWith(`journal row `) && w.endsWith(`of ${a.id}`)),
      "the after-reap scan must have read the reaped agent's own journal rows",
    );
  } finally {
    await px.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// CRD-3

const refusal = (res: CallResult, status: number, code: string, what: string) => {
  assert.equal(res.status, status, `${what}: expected ${status}, got ${res.status} ${res.text.slice(0, 200)}`);
  assert.equal(res.error, code, `${what}: expected the proxy error code "${code}", got ${JSON.stringify(res.error)}`);
};

test("CRD-3: a credential that worked while its agent ran gets 401 invalid-credential after the agent is reaped, and never reaches the upstream", {
  timeout: 60_000,
}, async () => {
  let before: CallResult | undefined;
  const px: ProxyRig = await proxyRig({
    script: { name: "crd-3", rules: [text("c1", 2)] },
    rootBudgetMicros: POOL,
    play: (agent) => ({
      run: async () => {
        before = await px.call(px.keyOf(agent), { requestId: "live", marker: "c1" });
      },
      result: OK,
    }),
  });
  try {
    const root = await px.r.daemon.root();
    const a = await px.r.daemon.spawn(root.id, { name: "a", task: "t", idempotencyKey: "a", budgetMicros: 10_000 });
    await px.r.orchestrator.idle();
    await until(async () => (await px.r.daemon.get(a.id))?.state === "reaped", `${a.id} to be reaped`);
    assert.equal(before?.status, 200, `control: the same credential must work while the agent runs; got ${before?.status} ${before?.text.slice(0, 200)}`);
    assert.equal(px.stub.calls.length, 1);
    const key = px.keyOf(a.id);
    refusal(await px.call(key, { requestId: "replay", marker: "c1" }), 401, MODEL_PROXY_INVALID_CREDENTIAL, "replay after reap");
    assert.equal(px.stub.calls.length, 1, "a replay with a dead credential must not reach the upstream");
    assert.ok(!(await px.settlements(a.id)).some((s) => s.requestId === "replay"), "a refused replay must not settle");
  } finally {
    await px.close();
  }
});

test("CRD-3: a credential past its ttl gets 401 credential-expired, a tampered one 401 invalid-credential; neither reaches the upstream", {
  timeout: 60_000,
}, async () => {
  const TTL = 5_000;
  const px: ProxyRig = await proxyRig({
    script: { name: "crd-3-ttl", rules: [text("c1", 3)] },
    tokenTtlMs: TTL,
    rootBudgetMicros: POOL,
    play: () => ({ hold: px.hold(), result: OK }),
  });
  try {
    const root = await px.r.daemon.root();
    const a = await px.r.daemon.spawn(root.id, { name: "a", task: "t", idempotencyKey: "a", budgetMicros: 10_000 });
    await until(() => px.keysOf(a.id).length > 0, "the agent to start with a credential");
    const key = px.keyOf(a.id);
    const cred = decodeGatewayCredential(SECRET, key, px.clock.t);
    assert.ok(cred, "the issued credential must decode under the daemon's secret");
    assert.equal(cred.expiresAt - cred.issuedAt, TTL, "the credential's lifetime must be the gateway's tokenTtlMs");

    // Control: inside the ttl the credential works.
    px.clock.t += TTL - 1_000;
    assert.equal((await px.call(key, { requestId: "inside", marker: "c1" })).status, 200);
    assert.equal(px.stub.calls.length, 1);

    // Tampered: a different, distinct code from expiry.
    const tampered = `${key.slice(0, -2)}${key.endsWith("AA") ? "BB" : "AA"}`;
    refusal(await px.call(tampered, { requestId: "tampered", marker: "c1" }), 401, MODEL_PROXY_INVALID_CREDENTIAL, "tampered credential");

    px.clock.t += 2_000; // now past expiresAt
    refusal(await px.call(key, { requestId: "late", marker: "c1" }), 401, MODEL_PROXY_CREDENTIAL_EXPIRED, "expired credential");
    assert.equal(px.stub.calls.length, 1, "neither refused call may reach the upstream");
  } finally {
    await px.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// CRD-4

test("CRD-4: a model outside the allowlist gets model_not_allowed with no upstream call; after yield and resume the pre-yield key is refused and the fresh key works", {
  timeout: 60_000,
}, async () => {
  const seen: Record<string, CallResult> = {};
  let first!: AgentId;
  const px: ProxyRig = await proxyRig({
    script: { name: "crd-4", rules: [text("c1", 3)] },
    rootBudgetMicros: POOL,
    play: (agent) => ({
      run: async (api) => {
        first = agent;
        const key = px.keyOf(agent);
        seen.foreign = await px.call(key, { requestId: "foreign", marker: "c1", model: OTHER_MODEL });
        seen.allowed = await px.call(key, { requestId: "allowed", marker: "c1" });
        await api("POST", "/v1/agents/self/yield", { wait: { kind: "timer", at: Date.now() + 300 }, idempotencyKey: "y1" });
      },
    }),
    resume: () => ({ hold: px.hold(), result: OK }),
  });
  try {
    const root = await px.r.daemon.root();
    const a = await px.r.daemon.spawn(root.id, { name: "a", task: "t", idempotencyKey: "a", budgetMicros: 10_000 });
    await until(() => px.keysOf(a.id).length >= 2, "the agent to be resumed with a second credential");
    assert.equal(first, a.id);

    assert.equal(seen.foreign!.status, 400, seen.foreign!.text);
    assert.ok(
      seen.foreign!.error?.includes("model_not_allowed"),
      `a foreign model must be refused as model_not_allowed; got ${seen.foreign!.text.slice(0, 300)}`,
    );
    assert.equal(seen.allowed!.status, 200, `control: the allowed model must be served; got ${seen.allowed!.text.slice(0, 200)}`);
    assert.equal(px.stub.calls.length, 1, "the foreign-model call must not reach the upstream");
    assert.deepEqual(
      px.stub.calls.map((c) => c.model),
      [MODEL],
    );

    const [old, fresh] = px.keysOf(a.id) as [string, string];
    assert.notEqual(old, fresh, "a resume must issue a new key");
    const [oc, fc] = [decodeGatewayCredential(SECRET, old, px.clock.t), decodeGatewayCredential(SECRET, fresh, px.clock.t)];
    assert.ok(oc && fc, "both keys must decode under the daemon's secret");
    assert.deepEqual([oc.models, fc.models], [[MODEL], [MODEL]], "both keys are bound to the agent's one model");
    assert.ok(fc.issuedAt > oc.issuedAt, "the fresh key must be issued strictly after the old one");

    refusal(await px.call(old, { requestId: "stale", marker: "c1" }), 401, MODEL_PROXY_INVALID_CREDENTIAL, "pre-yield credential after resume");
    assert.equal(px.stub.calls.length, 1, "the pre-yield key must not reach the upstream");
    assert.equal((await px.call(fresh, { requestId: "fresh", marker: "c1" })).status, 200, "the post-resume key must work");
    const again = await px.call(fresh, { requestId: "fresh-foreign", marker: "c1", model: OTHER_MODEL });
    assert.ok(
      again.status === 400 && again.error?.includes("model_not_allowed"),
      `the post-resume key keeps the allowlist; got ${again.status} ${again.text.slice(0, 200)}`,
    );
    assert.equal(px.stub.calls.length, 2);
  } finally {
    await px.close();
  }
});
