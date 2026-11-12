import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { loadFixture } from "./fixture-loader.ts";
import {
  execMessage,
  execStatus,
  type KubernetesShapeOptions,
  type KubernetesShaper,
  kubernetesShape,
  parseLabelSelector,
  podSecurityViolations,
  statusFailure,
} from "./kubernetes-shaper.ts";

const FIXTURES = join(fileURLToPath(new URL("../../../sandbox-kubernetes/src/fixtures", import.meta.url)));
const fx = (name: string) => loadFixture(join(FIXTURES, `${name}.jsonl`));
const AUTH = { authorization: "Bearer <TOKEN>", "content-type": "application/json" };
const P = "/api/v1/namespaces/default/pods";
const IMAGE = "registry.example/sandbox:1";
const podBody = (name: string, extra: Record<string, unknown> = {}, labels: Record<string, string> = { "pomtree.sandbox-pod": "1" }) => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name, labels },
  spec: { restartPolicy: "Never", containers: [{ name: "worker", image: IMAGE }], ...extra },
});

async function withShaper(opts: KubernetesShapeOptions, body: (k: KubernetesShaper) => Promise<void>): Promise<void> {
  const k = await kubernetesShape(opts);
  try {
    await body(k);
  } finally {
    await k.close();
  }
}

async function call(k: KubernetesShaper, method: string, path: string, body?: unknown, headers: Record<string, string> = AUTH) {
  const res = await fetch(`${k.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, text };
}

const phase = (j: any) => j.status.phase;
const reasonOf = (j: any) => j.status.containerStatuses?.[0]?.state?.terminated?.reason;

// ---- create / get / conflict ----

test("create returns 201 with the object, Pending with a waiting container, and GET retrieves it", async () => {
  await withShaper({}, async (k) => {
    const c = await call(k, "POST", P, podBody("pomtree-a"));
    assert.equal(c.status, 201);
    assert.equal(c.json.kind, "Pod");
    assert.equal(c.json.metadata.namespace, "default");
    assert.equal(phase(c.json), "Pending");
    assert.equal(c.json.status.containerStatuses[0].state.waiting.reason, "ContainerCreating");
    const g = await call(k, "GET", `${P}/pomtree-a`);
    assert.equal(g.status, 200);
    assert.deepEqual(g.json, c.json);
    k.assertNoUnmatched();
  });
});

test("a duplicate pod name is 409 AlreadyExists as a Status, and the existing object stays retrievable and unchanged", async () => {
  await withShaper({}, async (k) => {
    const first = await call(k, "POST", P, podBody("pomtree-a"));
    const dup = await call(k, "POST", P, podBody("pomtree-a", { activeDeadlineSeconds: 5 }));
    assert.equal(dup.status, 409);
    assert.deepEqual(dup.json, statusFailure(409, "AlreadyExists", 'pods "pomtree-a" already exists', { name: "pomtree-a", kind: "pods" }));
    assert.equal(dup.json.kind, "Status");
    assert.equal(dup.json.apiVersion, "v1");
    assert.equal(dup.json.status, "Failure");
    const got = await call(k, "GET", `${P}/pomtree-a`);
    assert.deepEqual(got.json, first.json);
    assert.equal(k.pods("default").length, 1);
    k.assertNoUnmatched();
  });
});

test("negative control: the 409 test fails against a shaper that silently overwrites (the duplicate would return 201)", async () => {
  // A deliberately wrong server stands in for a shaper without name uniqueness; the same assertion must reject it.
  const overwrite = createServer((_req, res) => res.writeHead(201, { "content-type": "application/json" }).end("{}"));
  await new Promise<void>((r) => overwrite.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(overwrite.address() as any).port}${P}`;
    const dup = await fetch(url, { method: "POST", headers: AUTH, body: "{}" });
    assert.throws(() => assert.equal(dup.status, 409));
  } finally {
    overwrite.close();
  }
});

test("a missing pod is 404 NotFound as a Status; a missing namespace is 404 on namespaces", async () => {
  await withShaper({}, async (k) => {
    const g = await call(k, "GET", `${P}/nope`);
    assert.equal(g.status, 404);
    assert.deepEqual(g.json, statusFailure(404, "NotFound", 'pods "nope" not found', { name: "nope", kind: "pods" }));
    const ns = await call(k, "GET", "/api/v1/namespaces/ghost/pods/x");
    assert.equal(ns.status, 404);
    assert.equal(ns.json.message, 'namespaces "ghost" not found');
    k.assertNoUnmatched();
  });
});

test("422 Invalid for missing containers, a bad name and an over-long label value, with causes", async () => {
  await withShaper({}, async (k) => {
    const none = await call(k, "POST", P, { kind: "Pod", metadata: { name: "ok" }, spec: {} });
    assert.equal(none.status, 422);
    assert.equal(none.json.reason, "Invalid");
    assert.equal(none.json.message, 'Pod "ok" is invalid: spec.containers: Required value');
    assert.deepEqual(none.json.details.causes[0], { reason: "FieldValueRequired", message: "Required value", field: "spec.containers" });
    const badName = await call(k, "POST", P, podBody("Bad_Name"));
    assert.equal(badName.status, 422);
    assert.match(badName.json.message, /metadata\.name: Invalid value: "Bad_Name"/);
    const label = await call(k, "POST", P, podBody("lbl", {}, { k: "x".repeat(64) }));
    assert.equal(label.status, 422);
    assert.equal(k.pods("default").length, 0);
    k.assertNoUnmatched();
  });
});

test("PSA: restricted refuses a bare pod with the real admission message, and admits a compliant one", async () => {
  await withShaper({ podSecurity: "restricted" }, async (k) => {
    const bad = await call(k, "POST", P, podBody("pomtree-psa"));
    assert.equal(bad.status, 403);
    assert.equal(bad.json.reason, "Forbidden");
    assert.match(
      bad.json.message,
      /^pods "pomtree-psa" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false \(container "worker" must set /,
    );
    assert.match(
      bad.json.message,
      /seccompProfile \(pod or container "worker" must set securityContext\.seccompProfile\.type to "RuntimeDefault" or "Localhost"\)/,
    );
    const good = await call(
      k,
      "POST",
      P,
      podBody("pomtree-ok", {
        securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
        containers: [{ name: "worker", image: IMAGE, securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } } }],
      }),
    );
    assert.equal(good.status, 201);
    assert.equal(k.pods("default").length, 1);
    k.assertNoUnmatched();
  });
  assert.deepEqual(podSecurityViolations({ containers: [{ name: "w", securityContext: { privileged: true } }], hostNetwork: true }, "baseline"), [
    'privileged (container "w" must not set securityContext.privileged=true)',
    "host namespaces (hostNetwork=true)",
  ]);
  assert.deepEqual(podSecurityViolations({ containers: [{ name: "w" }] }, "baseline"), []);
});

test("dry-run create validates and applies PSA but stores nothing", async () => {
  await withShaper({ podSecurity: "restricted" }, async (k) => {
    assert.equal((await call(k, "POST", `${P}?dryRun=All`, podBody("dry"))).status, 403);
    const ok = await call(
      k,
      "POST",
      `${P}?dryRun=All`,
      podBody("dry", {
        securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
        containers: [{ name: "w", image: IMAGE, securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } } }],
      }),
    );
    assert.equal(ok.status, 201);
    assert.equal(k.pods("default").length, 0);
    k.assertNoUnmatched();
  });
});

// ---- list / selectors ----

test("list filters by label selector (equality, set, existence) and by field selector", async () => {
  await withShaper({}, async (k) => {
    await call(k, "POST", P, podBody("a", {}, { "pomtree.sandbox-pod": "1", env: "dev" }));
    await call(k, "POST", P, podBody("b", {}, { "pomtree.sandbox-pod": "1", "pomtree.canary": "x" }));
    await call(k, "POST", P, podBody("c", {}, { other: "1" }));
    const names = async (q: string) => (await call(k, "GET", `${P}?${q}`)).json.items.map((p: any) => p.metadata.name);
    assert.deepEqual(await names("labelSelector=pomtree.sandbox-pod%3D1"), ["a", "b"]);
    assert.deepEqual(await names(`labelSelector=${encodeURIComponent("pomtree.sandbox-pod=1,!pomtree.canary")}`), ["a"]);
    assert.deepEqual(await names(`labelSelector=${encodeURIComponent("env in (dev,prod)")}`), ["a"]);
    assert.deepEqual(await names(`labelSelector=${encodeURIComponent("env!=dev")}`), ["b", "c"]);
    assert.deepEqual(await names("fieldSelector=metadata.name%3Dc"), ["c"]);
    assert.deepEqual(await names("fieldSelector=status.phase%3DRunning"), []);
    assert.equal((await call(k, "GET", P)).json.kind, "PodList");
    k.assertNoUnmatched();
  });
});

test("a malformed selector is 400 and unmatched; an unsupported field label is 400", async () => {
  await withShaper({}, async (k) => {
    assert.equal((await call(k, "GET", `${P}?labelSelector=${encodeURIComponent("a b c")}`)).status, 400);
    assert.equal(k.unmatched.length, 1);
    const f = await call(k, "GET", `${P}?fieldSelector=spec.nodeName%3Dx`);
    assert.equal(f.status, 400);
    assert.equal(f.json.message, "field label not supported: spec.nodeName");
    assert.throws(() => k.assertNoUnmatched(), /unmatched request/);
  });
  assert.ok("test" in (parseLabelSelector("a=b,c") as object));
  assert.ok("error" in (parseLabelSelector("a b c") as object));
});

// ---- delete ----

test("delete: graceful keeps a terminating Running pod until reaped; grace 0 and never-started pods go at once; missing is 404", async () => {
  await withShaper({}, async (k) => {
    await call(k, "POST", P, podBody("run"));
    k.setOutcome("default", "run", { kind: "running" });
    const d = await call(k, "DELETE", `${P}/run`);
    assert.equal(d.status, 200);
    assert.equal(d.json.kind, "Pod");
    assert.ok(d.json.metadata.deletionTimestamp);
    assert.equal(d.json.metadata.deletionGracePeriodSeconds, 30);
    assert.equal((await call(k, "GET", `${P}/run`)).status, 200);
    k.reap("default", "run");
    assert.equal((await call(k, "GET", `${P}/run`)).status, 404);

    await call(k, "POST", P, podBody("force"));
    k.setOutcome("default", "force", { kind: "running" });
    const f = await call(k, "DELETE", `${P}/force?gracePeriodSeconds=0`);
    assert.equal(f.json.kind, "Status");
    assert.equal(f.json.status, "Success");
    assert.equal((await call(k, "GET", `${P}/force`)).status, 404);

    await call(k, "POST", P, podBody("pending"));
    assert.equal((await call(k, "DELETE", `${P}/pending`)).json.status, "Success");
    const gone = await call(k, "DELETE", `${P}/pending`);
    assert.equal(gone.status, 404);
    assert.equal(gone.json.reason, "NotFound");
    k.assertNoUnmatched();
  });
});

// ---- lifecycle ----

test("lifecycle: Pending to Running to Succeeded / Failed with exit code", async () => {
  await withShaper({}, async (k) => {
    await call(k, "POST", P, podBody("p"));
    assert.equal(phase((await call(k, "GET", `${P}/p`)).json), "Pending");
    k.setOutcome("default", "p", { kind: "running" });
    const run = (await call(k, "GET", `${P}/p`)).json;
    assert.equal(phase(run), "Running");
    assert.ok(run.status.containerStatuses[0].state.running.startedAt);
    assert.equal(run.status.containerStatuses[0].ready, true);
    assert.ok(run.spec.nodeName);
    k.setOutcome("default", "p", { kind: "succeeded" });
    const ok = (await call(k, "GET", `${P}/p`)).json;
    assert.equal(phase(ok), "Succeeded");
    assert.equal(ok.status.containerStatuses[0].state.terminated.exitCode, 0);
    assert.equal(reasonOf(ok), "Completed");
    k.setOutcome("default", "p", { kind: "failed", exitCode: 3 });
    const bad = (await call(k, "GET", `${P}/p`)).json;
    assert.equal(phase(bad), "Failed");
    assert.equal(bad.status.containerStatuses[0].state.terminated.exitCode, 3);
    assert.throws(() => k.setOutcome("default", "ghost", { kind: "running" }), /does not exist/);
    k.assertNoUnmatched();
  });
});

test("OOMKilled: Failed, container terminated with reason OOMKilled and exit 137", async () => {
  await withShaper({}, async (k) => {
    await call(k, "POST", P, podBody("oom"));
    k.setOutcome("default", "oom", { kind: "oom-killed" });
    const j = (await call(k, "GET", `${P}/oom`)).json;
    assert.equal(phase(j), "Failed");
    assert.deepEqual({ reason: reasonOf(j), exit: j.status.containerStatuses[0].state.terminated.exitCode }, { reason: "OOMKilled", exit: 137 });
    assert.notEqual(reasonOf(j), "Error", "a plain failure must not read as OOM");
  });
});

test("DeadlineExceeded, Evicted and preemption carry the reasons and conditions the adapter maps", async () => {
  await withShaper({}, async (k) => {
    for (const n of ["dl", "ev", "pr"]) await call(k, "POST", P, podBody(n));
    k.setOutcome("default", "dl", { kind: "deadline-exceeded" });
    k.setOutcome("default", "ev", { kind: "evicted" });
    k.setOutcome("default", "pr", { kind: "preempted" });
    const dl = (await call(k, "GET", `${P}/dl`)).json;
    assert.deepEqual([phase(dl), dl.status.reason], ["Failed", "DeadlineExceeded"]);
    const ev = (await call(k, "GET", `${P}/ev`)).json;
    assert.deepEqual([phase(ev), ev.status.reason], ["Failed", "Evicted"]);
    assert.match(ev.status.message, /^The node was low on resource: memory\./);
    const pr = (await call(k, "GET", `${P}/pr`)).json;
    assert.equal(phase(pr), "Failed");
    assert.equal(pr.status.conditions[0].type, "DisruptionTarget");
    assert.equal(pr.status.conditions[0].reason, "PreemptionByScheduler");
  });
});

test("PATCH may lower activeDeadlineSeconds only", async () => {
  await withShaper({}, async (k) => {
    await call(k, "POST", P, podBody("d", { activeDeadlineSeconds: 100 }));
    const patch = (spec: unknown) => call(k, "PATCH", `${P}/d`, { spec }, { ...AUTH, "content-type": "application/merge-patch+json" });
    const lowered = await patch({ activeDeadlineSeconds: 10 });
    assert.equal(lowered.status, 200);
    assert.equal(lowered.json.spec.activeDeadlineSeconds, 10);
    const raised = await patch({ activeDeadlineSeconds: 50 });
    assert.equal(raised.status, 422);
    assert.match(raised.json.message, /activeDeadlineSeconds may only be lowered/);
    assert.equal((await patch({ containers: [] })).status, 422);
    k.assertNoUnmatched();
  });
});

// ---- faults ----

test("rate-limit is 429 TooManyRequests with Retry-After and applies nothing; after it the call works", async () => {
  await withShaper({}, async (k) => {
    k.faults.arm("rate-limit", { times: 1, retryAfterS: 7 });
    const r = await call(k, "POST", P, podBody("rl"));
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "7");
    assert.equal(r.json.reason, "TooManyRequests");
    assert.equal(r.json.details.retryAfterSeconds, 7);
    assert.equal(k.pods("default").length, 0);
    assert.equal((await call(k, "POST", P, podBody("rl"))).status, 201);
  });
});

test("server-error-after-apply: the create took effect but the caller sees 503, and a retry meets 409", async () => {
  await withShaper({}, async (k) => {
    k.faults.arm("server-error-after-apply", { times: 1 });
    const lost = await call(k, "POST", P, podBody("lost"));
    assert.equal(lost.status, 503);
    assert.equal(lost.json.kind, "Status");
    assert.equal(k.pods("default").length, 1);
    assert.equal((await call(k, "POST", P, podBody("lost"))).status, 409);
  });
});

test("timeout never answers", async () => {
  await withShaper({}, async (k) => {
    k.faults.arm("timeout", { times: 1 });
    await assert.rejects(fetch(`${k.baseUrl}${P}`, { headers: AUTH, signal: AbortSignal.timeout(150) }));
    assert.equal(k.requests().at(-1)?.served, "fault:timeout");
  });
});

// ---- network policy and canary ----

test("NetworkPolicy: create 201, duplicate 409, get, list, delete", async () => {
  await withShaper({}, async (k) => {
    const NP = "/apis/networking.k8s.io/v1/namespaces/default/networkpolicies";
    const body = { metadata: { name: "deny" }, spec: { podSelector: { matchLabels: { "pomtree.sandbox-pod": "1" } }, policyTypes: ["Ingress", "Egress"] } };
    assert.equal((await call(k, "POST", NP, body)).status, 201);
    const dup = await call(k, "POST", NP, body);
    assert.equal(dup.status, 409);
    assert.equal(dup.json.reason, "AlreadyExists");
    assert.equal((await call(k, "GET", `${NP}/deny`)).json.kind, "NetworkPolicy");
    assert.equal((await call(k, "GET", NP)).json.items.length, 1);
    assert.equal((await call(k, "DELETE", `${NP}/deny`)).json.status, "Success");
    assert.equal((await call(k, "GET", `${NP}/deny`)).status, 404);
    k.assertNoUnmatched();
  });
});

test("canary: with an enforcing plugin and a deny-all policy the policy-selected canary is blocked and the control reaches the target", async () => {
  const policy = { metadata: { name: "deny" }, spec: { podSelector: {}, policyTypes: ["Egress"] } };
  const NP = "/apis/networking.k8s.io/v1/namespaces/default/networkpolicies";
  const exitOf = async (k: KubernetesShaper, n: string) => (await call(k, "GET", `${P}/${n}`)).json.status.containerStatuses[0].state.terminated.exitCode;
  await withShaper({ enforcesNetworkPolicy: true }, async (k) => {
    await call(k, "POST", NP, policy);
    await call(k, "POST", P, podBody("canary", {}, { "pomtree.sandbox-pod": "1", "pomtree.canary": "1" }));
    await call(k, "POST", P, podBody("control", {}, { "pomtree.canary": "1" }));
    assert.equal(await exitOf(k, "canary"), 0);
    assert.equal(await exitOf(k, "control"), 10);
    assert.equal(phase((await call(k, "GET", `${P}/canary`)).json), "Succeeded");
    assert.equal(phase((await call(k, "GET", `${P}/control`)).json), "Failed");
  });
  await withShaper({ enforcesNetworkPolicy: false }, async (k) => {
    await call(k, "POST", NP, policy);
    await call(k, "POST", P, podBody("canary", {}, { "pomtree.sandbox-pod": "1", "pomtree.canary": "1" }));
    assert.equal(await exitOf(k, "canary"), 10, "a non-enforcing plugin lets the canary through");
  });
});

// ---- strictness ----

test("an unmatched route is recorded, answered 501 NotImplemented and fails assertNoUnmatched", async () => {
  await withShaper({}, async (k) => {
    const r = await call(k, "GET", "/api/v1/nodes");
    assert.equal(r.status, 501);
    assert.equal(r.json.kind, "Status");
    assert.equal(k.requests().at(-1)?.served, "UNMATCHED");
    assert.throws(() => k.assertNoUnmatched(), /unmatched request\(s\).*\/api\/v1\/nodes/s);
  });
});

test("unknown query parameters and unserved verbs are unmatched", async () => {
  await withShaper({}, async (k) => {
    assert.equal((await call(k, "POST", `${P}?bogus=1`, podBody("x"))).status, 501);
    assert.equal((await call(k, "PUT", `${P}/x`, podBody("x"))).status, 501);
    assert.equal(k.unmatched.length, 2);
    assert.equal(k.pods("default").length, 0);
  });
});

test("a request without the credential header is 401 and unmatched; the recorder keeps header names, never values", async () => {
  await withShaper({}, async (k) => {
    const r = await call(k, "GET", P, undefined, { "x-trace": "v" });
    assert.equal(r.status, 401);
    assert.equal(r.json.reason, "Unauthorized");
    assert.equal(k.unmatched.length, 1);
    await call(k, "GET", P, undefined, { authorization: "Bearer SECRET-CANARY-VALUE" });
    const names = k.requests().flatMap((q) => q.headerNames);
    assert.ok(names.includes("authorization"));
    assert.ok(!JSON.stringify(k.requests()).includes("SECRET-CANARY-VALUE"));
  });
});

/** The unmatched check, factored so a permissive server can be run through the identical assertion. */
async function refusesUnknown(baseUrl: string, assertNoUnmatched: () => void): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/definitely-not-a-route`, { headers: AUTH });
  assert.equal(res.status, 501);
  assert.throws(assertNoUnmatched);
}

test("the unmatched check passes on the shaper", async () => {
  await withShaper({}, async (k) => refusesUnknown(k.baseUrl, () => k.assertNoUnmatched()));
});

test("negative control: a permissive shaper that accepts anything fails the unmatched check", async () => {
  const permissive = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
  await new Promise<void>((r) => permissive.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(refusesUnknown(`http://127.0.0.1:${(permissive.address() as any).port}`, () => {}));
  } finally {
    permissive.close();
  }
});

// ---- exec ----

interface WsResult {
  readonly head: string;
  readonly frames: { ch: number; text: string }[];
  readonly closed: boolean;
}

/** A raw v5.channel.k8s.io client: handshake, optional stdin, then reads until the server closes or `ms` passes. */
function wsExec(k: KubernetesShaper, path: string, opts: { protocol?: string; stdin?: string; halfClose?: boolean; ms?: number } = {}): Promise<WsResult> {
  return new Promise((resolve, reject) => {
    const s = connect(Number(new URL(k.baseUrl).port), "127.0.0.1");
    const frames: { ch: number; text: string }[] = [];
    let raw = Buffer.alloc(0);
    let head = "";
    let headDone = false;
    let closed = false;
    const mask = (op: number, payload: Buffer) => {
      const m = randomBytes(4);
      const body = Buffer.from(payload.map((b, i) => b ^ m[i % 4]!));
      return Buffer.concat([Buffer.from([0x80 | op, 0x80 | payload.length]), m, body]);
    };
    const done = () => {
      s.destroy();
      resolve({ head, frames, closed });
    };
    const timer = setTimeout(done, opts.ms ?? 1500);
    s.on("connect", () => {
      const proto = opts.protocol ?? "v5.channel.k8s.io";
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer <TOKEN>\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${proto}\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`,
      );
    });
    s.on("data", (d) => {
      raw = Buffer.concat([raw, d]);
      if (!headDone) {
        const at = raw.indexOf("\r\n\r\n");
        if (at < 0) return;
        head = raw.subarray(0, at).toString("utf8");
        raw = raw.subarray(at + 4);
        headDone = true;
        if (!head.startsWith("HTTP/1.1 101")) return; // a refusal ends the socket; its body is folded into `head` on close
        if (opts.stdin !== undefined) s.write(mask(2, execMessage(0, opts.stdin)));
        if (opts.halfClose) s.write(mask(2, Buffer.from([255, 0])));
      }
      for (;;) {
        if (raw.length < 2) return;
        const op = raw[0]! & 0x0f;
        let len = raw[1]! & 0x7f;
        let off = 2;
        if (len === 126) {
          if (raw.length < 4) return;
          len = raw.readUInt16BE(2);
          off = 4;
        }
        if (raw.length < off + len) return;
        const payload = raw.subarray(off, off + len);
        raw = raw.subarray(off + len);
        if (op === 8) {
          closed = true;
          s.write(mask(8, Buffer.from([0x03, 0xe8])));
          clearTimeout(timer);
          setTimeout(done, 30);
          return;
        }
        if (op === 2) frames.push({ ch: payload[0]!, text: payload.subarray(1).toString("utf8") });
      }
    });
    s.on("close", () => {
      clearTimeout(timer);
      if (headDone && !head.startsWith("HTTP/1.1 101")) head += `\n${raw.toString("utf8")}`;
      resolve({ head, frames, closed });
    });
    s.on("error", reject);
  });
}

const execPath = (pod: string, q: string) => `${P}/${pod}/exec?${q}`;

async function runningPod(k: KubernetesShaper, name = "x") {
  await call(k, "POST", P, podBody(name));
  k.setOutcome("default", name, { kind: "running" });
}

test("exec speaks v5: stdout on channel 1, stderr on 2, Success status JSON on channel 3, then a clean close", async () => {
  await withShaper({}, async (k) => {
    await runningPod(k);
    k.scriptExec("default", "x", { command: ["echo", "hi"], stdout: "hi\n", stderr: "warn\n" });
    const r = await wsExec(k, execPath("x", "command=echo&command=hi&container=worker&stdout=true&stderr=true"));
    assert.match(r.head, /^HTTP\/1\.1 101/);
    assert.match(r.head, /Sec-WebSocket-Protocol: v5\.channel\.k8s\.io/i);
    assert.deepEqual(
      r.frames.filter((f) => f.ch !== 255).map((f) => [f.ch, f.text]),
      [
        [1, "hi\n"],
        [2, "warn\n"],
        [3, JSON.stringify({ metadata: {}, status: "Success" })],
      ],
    );
    assert.equal(r.closed, true);
    assert.deepEqual(
      k.execs().map((e) => [e.pod, e.command, e.container]),
      [["x", ["echo", "hi"], "worker"]],
    );
    k.assertNoUnmatched();
  });
});

test("exec non-zero exit is a Failure/NonZeroExitCode status with the code in details.causes", async () => {
  await withShaper({}, async (k) => {
    await runningPod(k);
    k.scriptExec("default", "x", { exitCode: 7 });
    const r = await wsExec(k, execPath("x", "command=false"));
    const status: any = JSON.parse(r.frames.find((f) => f.ch === 3)!.text);
    assert.deepEqual(status, execStatus(7));
    assert.equal(status.reason, "NonZeroExitCode");
    assert.equal((status as any).details.causes[0].message, "7");
  });
});

test("exec waits for the stdin half-close and echoes the stdin it received; the shaper records it", async () => {
  await withShaper({}, async (k) => {
    await runningPod(k);
    k.scriptExec("default", "x", { waitForStdin: true, echoStdin: true });
    const r = await wsExec(k, execPath("x", "command=cat&stdin=true"), { stdin: "payload", halfClose: true });
    assert.deepEqual(
      r.frames.find((f) => f.ch === 1),
      { ch: 1, text: "payload" },
    );
    assert.equal(k.execs()[0]!.stdin, "payload");
  });
});

test("a scripted drop sends output and no status frame, so a truncated stream is distinguishable from exit 0", async () => {
  await withShaper({}, async (k) => {
    await runningPod(k);
    k.scriptExec("default", "x", { stdout: "partial", drop: true });
    const r = await wsExec(k, execPath("x", "command=run"));
    assert.deepEqual(
      r.frames.map((f) => f.ch),
      [1],
    );
  });
});

test("exec on a missing pod is 404, on a Pending pod 400 (no host), on a completed pod 400 with the phase; none is unmatched", async () => {
  await withShaper({}, async (k) => {
    assert.match((await wsExec(k, execPath("ghost", "command=x"))).head, /404 Not Found/);
    await call(k, "POST", P, podBody("pend"));
    const pend = await wsExec(k, execPath("pend", "command=x"));
    assert.match(pend.head, /400 Bad Request/);
    assert.match(pend.head, /pod does not have a host assigned/);
    await runningPod(k, "done");
    k.setOutcome("default", "done", { kind: "succeeded" });
    assert.match((await wsExec(k, execPath("done", "command=x"))).head, /cannot exec in a container in a completed pod; current phase is Succeeded/);
    k.assertNoUnmatched();
  });
});

test("exec with no script, no command, an unknown container or the wrong subprotocol is refused and recorded as unmatched", async () => {
  await withShaper({}, async (k) => {
    await runningPod(k);
    assert.match((await wsExec(k, execPath("x", "command=x"))).head, /501/);
    assert.equal(k.unmatched.length, 1);
    assert.match((await wsExec(k, execPath("x", "container=worker"))).head, /you must specify at least 1 command/);
    assert.match((await wsExec(k, execPath("x", "command=x&container=nope"))).head, /container nope is not valid for pod x/);
    k.scriptExec("default", "x", {});
    assert.match((await wsExec(k, execPath("x", "command=x"), { protocol: "v4.channel.k8s.io" })).head, /400 Bad Request/);
    // all four are adapter faults: no script, no command, a container not in the pod, a subprotocol the shaper does not speak
    assert.equal(k.unmatched.length, 4);
    assert.equal(k.execs().length, 0);
  });
});

test("a plain GET on pods/exec (no upgrade) is unmatched", async () => {
  await withShaper({}, async (k) => {
    await runningPod(k);
    assert.equal((await call(k, "GET", execPath("x", "command=x"))).status, 501);
    assert.equal(k.unmatched.length, 1);
  });
});

// ---- fixtures ----

test("every fixture has a complete inferred-provenance header for provider kubernetes", () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const h = loadFixture(join(FIXTURES, f)).header;
    assert.deepEqual([h.provenance, h.provider], ["inferred", "kubernetes"], f);
    assert.ok(h.source !== "" && h.apiVersion === "v1" && Array.isArray(h.placeholders), f);
  }
});

test("replay: pod-already-exists is served verbatim, in order, and the exchange is consumed", async () => {
  const fixture = fx("pod-already-exists");
  await withShaper({ replay: fixture }, async (k) => {
    const [create, dup, get, missing] = fixture.entries;
    const send = async (e: (typeof fixture.entries)[number]) => call(k, e.method, e.path, "requestBody" in e ? e.requestBody : undefined);
    for (const e of [create!, dup!, get!, missing!]) {
      const r = await send(e);
      assert.equal(r.status, e.status);
      assert.deepEqual(r.json, e.responseBody);
    }
    k.assertReplayConsumed();
    assert.equal(k.pods("default").length, 0, "replayed exchanges never touch the model");
    k.assertNoUnmatched();
  });
  await withShaper({ replay: fixture }, async (k) => {
    assert.throws(() => k.assertReplayConsumed(), /never requested/);
  });
});

test("parity: the shaper's live bodies equal the hand-written fixtures (409, 404, PSA 403, OOMKilled pod)", async () => {
  const dup = fx("pod-already-exists").entries;
  await withShaper({}, async (k) => {
    const first = await call(k, "POST", P, dup[0]!.requestBody);
    assert.deepEqual(first.json, dup[0]!.responseBody);
    assert.deepEqual((await call(k, "POST", P, dup[1]!.requestBody)).json, dup[1]!.responseBody);
    assert.deepEqual((await call(k, "GET", dup[2]!.path)).json, dup[2]!.responseBody);
    assert.deepEqual((await call(k, "GET", dup[3]!.path)).json, dup[3]!.responseBody);
  });
  const psa = fx("pod-forbidden-psa").entries[0]!;
  await withShaper({ podSecurity: "restricted" }, async (k) => {
    assert.deepEqual((await call(k, "POST", P, psa.requestBody)).json, psa.responseBody);
  });
  const oom = fx("pod-oom-killed").entries[0]!;
  await withShaper({}, async (k) => {
    await call(k, "POST", P, { ...podBody("pomtree-sbx-3") });
    k.setOutcome("default", "pomtree-sbx-3", { kind: "oom-killed" });
    const live = (await call(k, "GET", oom.path)).json;
    assert.deepEqual(live.status, (oom.responseBody as any).status);
  });
});

test("parity: the exec fixture frames equal what the shaper sends for the same script", async () => {
  const e = fx("exec-success").entries[0]!;
  const want = e.stream!.map((s) => Buffer.from(s.data, "base64"));
  assert.equal(createHash("sha256").update(Buffer.concat(want)).digest("hex").length, 64);
  await withShaper({}, async (k) => {
    await runningPod(k, "pomtree-sbx-1");
    k.scriptExec("default", "pomtree-sbx-1", { stdout: "hi\n" });
    const r = await wsExec(k, `${e.path}?command=echo&container=worker`);
    const got = r.frames.filter((f) => f.ch !== 255).map((f) => Buffer.concat([Buffer.from([f.ch]), Buffer.from(f.text)]));
    assert.deepEqual(got, want);
  });
});
