import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { type SandboxSpec, sandboxIdForKey } from "@pomtree/core";
import { KUBERNETES_TAG_LIMITS, tagSelector } from "@pomtree/sandbox-kit";
import { checkSchema, kubernetesPodCreate } from "@pomtree/testing";
import {
  CANARY_EXIT,
  type CanaryVerdict,
  DEFAULT_HOME_SIZE,
  DEFAULT_SCRATCH_SIZE,
  DEFAULT_TMP_SIZE,
  DEFAULT_WORKSPACE_SIZE,
  NETWORK_POLICY_NAME,
  type PodContext,
  PodBuildError,
  type PodManifest,
  SANDBOX_POD_LABEL,
  SECRET_DIR,
  SPEC_HASH_ANNOTATION,
  buildCanaryPod,
  buildNetworkPolicy,
  buildPod,
  canaryVerdict,
  looksLikeCredentialName,
  canonicalJson,
  specHash,
} from "./pod.ts";

const SENTINEL = "sentinel-token-7f3a9c1e5b2d4086";
const LABEL_VALUE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const ID = sandboxIdForKey("agent-1:1:start");
const HOST_300 = `host-${"h".repeat(295)}`;

const baseSpec = (): SandboxSpec => ({
  host: "host-a",
  generation: 3,
  agent: "agent-1",
  image: "registry.internal:5000/pomtree/agent@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  env: { PTREE_BROWSER: "0", POMTREE_AGENT: "agent-1" },
  mounts: [{ kind: "workspace", workspace: "ws-1", containerPath: "/work" }],
  cmd: ["pi", "--print"],
  resources: { cpus: 2, memoryBytes: 2147483648, shmBytes: 67108864 },
  labels: { store_id: "store-1", daemon_epoch: "7" },
});
const baseCtx = (): PodContext => ({ namespace: "pomtree-sandboxes", sandboxId: ID, maxLifetimeSeconds: 86400 });

// The vendored Pod schema is a strict subset (no securityContext, volumes or resources), so a full manifest is projected onto the
// fields that schema names before it is checked.
function schemaProjection(pod: PodManifest): unknown {
  return JSON.parse(
    JSON.stringify({
      apiVersion: pod.apiVersion,
      kind: pod.kind,
      metadata: pod.metadata,
      spec: {
        restartPolicy: pod.spec.restartPolicy,
        activeDeadlineSeconds: pod.spec.activeDeadlineSeconds,
        containers: pod.spec.containers.map((c) => ({ name: c.name, image: c.image, command: c.command, args: c.args, env: c.env })),
      },
    }),
  );
}

test("pod: satisfies the PSA restricted field set", () => {
  const pod = buildPod(baseSpec(), baseCtx());
  const c = pod.spec.containers[0];
  assert.ok(c);
  assert.deepEqual(c.securityContext, {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    seccompProfile: { type: "RuntimeDefault" },
  });
  assert.equal(pod.spec.securityContext.runAsNonRoot, true);
  assert.deepEqual(pod.spec.securityContext.seccompProfile, { type: "RuntimeDefault" });
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.restartPolicy, "Never");
  assert.equal(pod.spec.activeDeadlineSeconds, 86400);
  assert.equal(pod.spec.containers.length, 1);
});

test("pod: carries no host namespaces, hostPath, hostPort, privileged or added capabilities", () => {
  const text = JSON.stringify(buildPod(baseSpec(), baseCtx()));
  for (const forbidden of [
    "hostNetwork",
    "hostPID",
    "hostIPC",
    "hostPath",
    "hostPort",
    "privileged",
    '"add"',
    "procMount",
    "sysctls",
    "shareProcessNamespace",
  ]) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
  for (const v of buildPod(baseSpec(), baseCtx()).spec.volumes) assert.deepEqual(Object.keys(v).sort(), ["emptyDir", "name"]);
});

test("pod: scratch space is memory-backed emptyDir and the root filesystem stays read-only", () => {
  const pod = buildPod(baseSpec(), baseCtx());
  const mounts = pod.spec.containers[0]?.volumeMounts ?? [];
  for (const path of ["/tmp", "/home/node", SECRET_DIR, "/dev/shm", "/work"])
    assert.ok(
      mounts.some((m) => m.mountPath === path),
      path,
    );
  const byName = new Map(pod.spec.volumes.map((v) => [v.name, v]));
  for (const n of ["tmp", "home", "secrets", "shm"]) assert.equal(byName.get(n)?.emptyDir.medium, "Memory", n);
  assert.equal(byName.get("shm")?.emptyDir.sizeLimit, "67108864");
});

test("pod: name is pomtree-<64 hex> and within 253 characters", () => {
  const pod = buildPod(baseSpec(), baseCtx());
  assert.equal(pod.metadata.name, `pomtree-${ID}`);
  assert.ok(pod.metadata.name.length <= 253);
  assert.throws(() => buildPod(baseSpec(), { ...baseCtx(), sandboxId: "UPPER" }), PodBuildError);
  assert.throws(() => buildPod(baseSpec(), { ...baseCtx(), sandboxId: "a".repeat(250) }), /valid Kubernetes name/);
});

test("pod: every label value is at most 63 characters and legal for a 64-hex id and a 300-character host id", () => {
  assert.equal(ID.length, 64);
  assert.equal(HOST_300.length, 300);
  const pod = buildPod({ ...baseSpec(), host: HOST_300 }, baseCtx());
  const labels = pod.metadata.labels;
  for (const [k, v] of Object.entries(labels)) {
    assert.ok(k.length <= 63, `key ${k}`);
    assert.ok(v.length <= 63, `${k} is ${v.length}`);
    assert.match(v, LABEL_VALUE, k);
  }
  const sha40 = (s: string) => `h.${createHash("sha256").update(s).digest("hex").slice(0, 40)}`;
  assert.equal(labels["pomtree.sandbox"], sha40(ID), "the 64-hex id is always encoded");
  assert.equal(labels["pomtree.host"], sha40(HOST_300));
  assert.equal(pod.metadata.annotations["pomtree.dev/tag.pomtree.sandbox"], ID, "the full id lives in an annotation");
  assert.equal(pod.metadata.annotations["pomtree.dev/tag.pomtree.host"], HOST_300);
  // Short values stay readable.
  assert.equal(labels["pomtree.agent"], "agent-1");
  assert.equal(labels["pomtree.backend"], "kubernetes");
  assert.equal(labels["pomtree.generation"], "3");
  assert.equal(labels.store_id, "store-1");
  assert.equal(labels.daemon_epoch, "7");
  assert.equal(labels[SANDBOX_POD_LABEL], "1");
});

test("pod: a host or generation that cannot be stamped is refused before a pod is built, naming the cause and the action", () => {
  for (const host of ["", "a\nb"])
    assert.throws(
      () => buildPod({ ...baseSpec(), host }, baseCtx()),
      (e: unknown) => e instanceof PodBuildError && /host id.*pass the daemon's host id/s.test(e.message),
    );
  for (const generation of [-1, 1.5]) {
    assert.throws(
      () => buildPod({ ...baseSpec(), generation }, baseCtx()),
      (e: unknown) => e instanceof PodBuildError && /generation.*pass the agent's generation/s.test(e.message),
    );
  }
});

test("pod: label values that start with h. are encoded so the prefix always means hashed", () => {
  const pod = buildPod({ ...baseSpec(), agent: "h.agent" }, baseCtx());
  assert.match(pod.metadata.labels["pomtree.agent"] as string, /^h\.[0-9a-f]{40}$/);
  assert.equal(pod.metadata.annotations["pomtree.dev/tag.pomtree.agent"], "h.agent");
});

test("pod: the selector the codec produces for the owner tags matches the pod's labels", () => {
  const spec = { ...baseSpec(), host: HOST_300 };
  const ctx = baseCtx();
  const pod = buildPod(spec, ctx);
  const sel = tagSelector({ "pomtree.sandbox": ctx.sandboxId, "pomtree.host": spec.host, "pomtree.generation": "3" }, KUBERNETES_TAG_LIMITS);
  for (const [k, v] of Object.entries(sel)) assert.equal(pod.metadata.labels[k], v, k);
});

test("pod: reserved or malformed spec label keys are refused", () => {
  assert.throws(() => buildPod({ ...baseSpec(), labels: { "pomtree.host": "x" } }, baseCtx()), /reserved/);
  assert.throws(() => buildPod({ ...baseSpec(), labels: { "bad key": "x" } }, baseCtx()), PodBuildError);
});

test("pod: the built manifest passes the vendored Pod create schema (projected), and the schema can fail", () => {
  const pod = buildPod(baseSpec(), baseCtx());
  assert.deepEqual(checkSchema(schemaProjection(pod), kubernetesPodCreate), []);
  const wrong = schemaProjection(pod) as { spec: Record<string, unknown> };
  wrong.spec.restartPolicy = "Sometimes";
  assert.ok(checkSchema(wrong, kubernetesPodCreate).length > 0, "a bad restartPolicy must fail the schema");
  assert.ok(checkSchema({ ...(schemaProjection(pod) as object), hostNetwork: true }, kubernetesPodCreate).length > 0, "an unknown top-level field must fail");
});

test("pod: resources set requests equal to limits; unsupported resources are refused", () => {
  const c = buildPod(baseSpec(), baseCtx()).spec.containers[0];
  assert.deepEqual(c?.resources, { requests: { cpu: "2000m", memory: "2147483648" }, limits: { cpu: "2000m", memory: "2147483648" } });
  // Memory-backed volumes need a memory limit to be bounded.
  assert.throws(() => buildPod({ ...baseSpec(), resources: undefined }, baseCtx()), /memory-backed volumes.*set resources.memoryBytes/);
  assert.throws(() => buildPod({ ...baseSpec(), resources: { cpus: 1 } }, baseCtx()), /resources.memoryBytes/);
  assert.throws(() => buildPod({ ...baseSpec(), resources: { diskBytes: 1 } }, baseCtx()), /diskBytes/);
  assert.throws(() => buildPod({ ...baseSpec(), resources: { accelerators: ["gpu"] } }, baseCtx()), /accelerators/);
  assert.throws(() => buildPod({ ...baseSpec(), resources: { cpus: 0 } }, baseCtx()), PodBuildError);
});

test("pod: session and bind mounts are refused with cause and action", () => {
  assert.throws(
    () => buildPod({ ...baseSpec(), mounts: [{ kind: "session", agent: "agent-1", containerPath: "/session" }] }, baseCtx()),
    /session mount.*use a template without a session mount/,
  );
  assert.throws(
    () => buildPod({ ...baseSpec(), mounts: [{ kind: "bind", hostPath: "/etc", containerPath: "/x" }] }, baseCtx()),
    /hostPath volume.*use a workspace or scratch/,
  );
  assert.throws(() => buildPod({ ...baseSpec(), mounts: [{ kind: "scratch", containerPath: "relative" }] }, baseCtx()), /absolute/);
});

test("pod: tty maps to stdin and tty", () => {
  const c = buildPod({ ...baseSpec(), tty: { cols: 80, rows: 24 } }, baseCtx()).spec.containers[0];
  assert.equal(c?.tty, true);
  assert.equal(c?.stdin, true);
  assert.equal(buildPod(baseSpec(), baseCtx()).spec.containers[0]?.tty, undefined);
});

// ---- runtime block ----

test("pod: runtimeClassName appears only when the template declares it and the cluster has it", () => {
  const plain = buildPod(baseSpec(), baseCtx());
  assert.equal("runtimeClassName" in plain.spec, false);
  const sel = buildPod({ ...baseSpec(), runtime: { runtimeClassName: "gvisor" } }, { ...baseCtx(), knownRuntimeClasses: ["gvisor"] });
  assert.equal(sel.spec.runtimeClassName, "gvisor");
  assert.throws(() => buildPod({ ...baseSpec(), runtime: { runtimeClassName: "gvisor" } }, baseCtx()), /was not found on the cluster/);
  assert.throws(() => buildPod({ ...baseSpec(), runtime: { privileged: true } }, baseCtx()), /not accepted by the kubernetes backend/);
});

// ---- spec hash ----

test("spec hash: is stored as the annotation and equals specHash of the pod", () => {
  const spec = baseSpec();
  const pod = buildPod(spec, baseCtx());
  assert.match(pod.metadata.annotations[SPEC_HASH_ANNOTATION] as string, /^[0-9a-f]{64}$/);
  assert.equal(pod.metadata.annotations[SPEC_HASH_ANNOTATION], specHash(pod, spec));
});

test("spec hash: is deterministic and independent of key order", () => {
  const a = baseSpec();
  const b: SandboxSpec = {
    generation: 3,
    host: "host-a",
    labels: { daemon_epoch: "7", store_id: "store-1" },
    resources: { shmBytes: 67108864, memoryBytes: 2147483648, cpus: 2 },
    cmd: ["pi", "--print"],
    mounts: [{ containerPath: "/work", workspace: "ws-1", kind: "workspace" }],
    env: { POMTREE_AGENT: "agent-1", PTREE_BROWSER: "0" },
    image: a.image,
    agent: "agent-1",
  };
  const hashOf = (s: SandboxSpec) => buildPod(s, baseCtx()).metadata.annotations[SPEC_HASH_ANNOTATION];
  assert.equal(hashOf(a), hashOf(b));
  assert.equal(hashOf(a), hashOf(baseSpec()));
  assert.equal(
    hashOf({ ...baseSpec(), runtime: { nodeSelector: { a: "1", b: "2" } } }),
    hashOf({ ...baseSpec(), runtime: { nodeSelector: { b: "2", a: "1" } } }),
  );
  assert.equal(canonicalJson({ b: 1, a: { d: 1, c: undefined } }), canonicalJson({ a: { d: 1 }, b: 1 }));
});

const hashFor = (spec: SandboxSpec, ctx: PodContext = baseCtx()) =>
  buildPod(spec, { knownRuntimeClasses: ["gvisor"], ...ctx }).metadata.annotations[SPEC_HASH_ANNOTATION];

test("spec hash: changes when any security-relevant spec or context field changes (mutation)", () => {
  const base = hashFor(baseSpec());
  const mutations: Record<string, () => string | undefined> = {
    image: () => hashFor({ ...baseSpec(), image: `${baseSpec().image.slice(0, -1)}0` }),
    "env value": () => hashFor({ ...baseSpec(), env: { ...baseSpec().env, PTREE_BROWSER: "1" } }),
    "env added": () => hashFor({ ...baseSpec(), env: { ...baseSpec().env, EXTRA: "1" } }),
    cmd: () => hashFor({ ...baseSpec(), cmd: ["pi"] }),
    "cmd absent": () => hashFor({ ...baseSpec(), cmd: undefined }),
    memory: () => hashFor({ ...baseSpec(), resources: { cpus: 2, memoryBytes: 1, shmBytes: 67108864 } }),
    cpus: () => hashFor({ ...baseSpec(), resources: { cpus: 3, memoryBytes: 2147483648, shmBytes: 67108864 } }),
    shm: () => hashFor({ ...baseSpec(), resources: { cpus: 2, memoryBytes: 2147483648 } }),
    runtimeClass: () => hashFor({ ...baseSpec(), runtime: { runtimeClassName: "gvisor" } }),
    nodeSelector: () => hashFor({ ...baseSpec(), runtime: { nodeSelector: { pool: "x" } } }),
    mountPath: () => hashFor({ ...baseSpec(), mounts: [{ kind: "workspace", workspace: "ws-1", containerPath: "/other" }] }),
    "mount workspace id": () => hashFor({ ...baseSpec(), mounts: [{ kind: "workspace", workspace: "ws-2", containerPath: "/work" }] }),
    "mount readOnly": () => hashFor({ ...baseSpec(), mounts: [{ kind: "workspace", workspace: "ws-1", containerPath: "/work", readOnly: true }] }),
    egress: () => hashFor({ ...baseSpec(), egress: { allow: [{ host: "example.com" }] } }),
    tty: () => hashFor({ ...baseSpec(), tty: { cols: 80, rows: 24 } }),
    agent: () => hashFor({ ...baseSpec(), agent: "agent-2" }),
    label: () => hashFor({ ...baseSpec(), labels: { store_id: "store-2", daemon_epoch: "7" } }),
    lifetime: () => hashFor(baseSpec(), { ...baseCtx(), maxLifetimeSeconds: 3600 }),
    generation: () => hashFor({ ...baseSpec(), generation: 4 }),
    host: () => hashFor({ ...baseSpec(), host: "host-b" }),
    namespace: () => hashFor(baseSpec(), { ...baseCtx(), namespace: "other" }),
    serviceAccount: () => hashFor(baseSpec(), { ...baseCtx(), serviceAccountName: "other" }),
  };
  for (const [name, mutate] of Object.entries(mutations)) assert.notEqual(mutate(), base, `${name} must change the hash`);
});

test("spec hash: covers the hardening fields of the built pod, not only the inputs", () => {
  const spec = baseSpec();
  const pod = buildPod(spec, baseCtx());
  const stored = pod.metadata.annotations[SPEC_HASH_ANNOTATION];
  const weaker = structuredClone(pod);
  (weaker.spec.containers[0] as { securityContext: { readOnlyRootFilesystem: boolean } }).securityContext.readOnlyRootFilesystem = false;
  assert.notEqual(specHash(weaker, spec), stored);
  const rooted = structuredClone(pod);
  (rooted.spec.securityContext as { runAsNonRoot: boolean }).runAsNonRoot = false;
  assert.notEqual(specHash(rooted, spec), stored);
});

test("spec hash: a conflict on the derived name is decided by comparing hashes (same adopts, different conflicts)", () => {
  const first = buildPod(baseSpec(), baseCtx());
  const retry = buildPod(baseSpec(), baseCtx());
  const changed = buildPod({ ...baseSpec(), image: `${baseSpec().image.slice(0, -1)}1` }, baseCtx());
  const h = (p: PodManifest) => p.metadata.annotations[SPEC_HASH_ANNOTATION];
  assert.equal(first.metadata.name, changed.metadata.name, "same key, same derived name");
  assert.equal(h(first), h(retry));
  assert.notEqual(h(first), h(changed));
});

// ---- NetworkPolicy ----

test("network policy: default deny selects sandbox pods with no ingress and no egress rules", () => {
  const np = buildNetworkPolicy("pomtree-sandboxes");
  assert.equal(np.metadata.name, NETWORK_POLICY_NAME);
  assert.deepEqual(np.spec.podSelector, { matchLabels: { [SANDBOX_POD_LABEL]: "1" } });
  assert.deepEqual(np.spec.policyTypes, ["Ingress", "Egress"]);
  assert.equal("egress" in np.spec, false);
  assert.equal("ingress" in np.spec, false);
});

test("network policy: the only allowance is TCP to the named proxy pods", () => {
  const np = buildNetworkPolicy("pomtree-sandboxes", { podLabels: { app: "egress-proxy", tier: "a" }, port: 3128 });
  assert.deepEqual(np.spec.egress, [{ to: [{ podSelector: { matchLabels: { app: "egress-proxy", tier: "a" } } }], ports: [{ protocol: "TCP", port: 3128 }] }]);
  assert.equal("ingress" in np.spec, false);
  assert.deepEqual(np.spec.policyTypes, ["Ingress", "Egress"]);
});

test("network policy: an allowance that would select every pod or use a bad port is refused", () => {
  assert.throws(() => buildNetworkPolicy("pomtree-sandboxes", { podLabels: {}, port: 3128 }), /every pod/);
  for (const port of [0, 70000, 1.5]) assert.throws(() => buildNetworkPolicy("pomtree-sandboxes", { podLabels: { a: "b" }, port }), /port/);
  assert.throws(() => buildNetworkPolicy("Bad_NS"), PodBuildError);
});

// ---- canary ----

const canaryCtx = () => ({ namespace: "pomtree-sandboxes", runId: "r1", image: baseSpec().image, targetHost: "10.96.0.1", targetPort: 443 });

test("canary: carries the sandbox-pod label so the default-deny policy applies, and the same hardening", () => {
  const pod = buildCanaryPod(canaryCtx());
  assert.equal(pod.metadata.name, "pomtree-canary-r1");
  assert.equal(pod.metadata.labels[SANDBOX_POD_LABEL], "1");
  const c = pod.spec.containers[0];
  assert.equal(c?.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(c?.securityContext.capabilities, { drop: ["ALL"] });
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.activeDeadlineSeconds, 60);
  assert.deepEqual(c?.command?.slice(2 + 1), ["10.96.0.1", "443", "3000"], "target passed as argv, never interpolated into the script");
  assert.deepEqual(checkSchema(schemaProjection(pod), kubernetesPodCreate), []);
});

test("canary: bad targets are refused", () => {
  assert.throws(() => buildCanaryPod({ ...canaryCtx(), targetHost: "1.2.3.4; rm -rf /" }), /not an address/);
  assert.throws(() => buildCanaryPod({ ...canaryCtx(), targetPort: 0 }), /port/);
  assert.throws(() => buildCanaryPod({ ...canaryCtx(), runId: "Bad Id" }), /runId/);
  assert.throws(() => buildCanaryPod({ ...canaryCtx(), timeoutMs: 0 }), /timeoutMs/);
});

// Runs the canary's inline script against a fake `net` (no sockets) and returns the exit code it asks for.
function runCanaryScript(event: "connect" | "timeout" | "error", code?: string): { exit: number | undefined; connectedTo: unknown } {
  const cmd = buildCanaryPod({ ...canaryCtx(), targetHost: "10.96.0.1", targetPort: 443, timeoutMs: 2500 }).spec.containers[0]?.command as string[];
  const socket = new EventEmitter() as EventEmitter & { setTimeout: (ms: number) => void; timeoutMs?: number };
  socket.setTimeout = (ms) => {
    socket.timeoutMs = ms;
  };
  let connectedTo: unknown;
  let exit: number | undefined;
  const fakeNet = {
    connect: (o: unknown) => {
      connectedTo = o;
      return socket;
    },
  };
  const proc = {
    argv: ["node", ...cmd.slice(3)],
    exit: (c: number) => {
      if (exit === undefined) exit = c;
    },
  };
  new Function("require", "process", cmd[2] as string)((m: string) => (m === "node:net" ? fakeNet : assert.fail(`unexpected require ${m}`)), proc);
  assert.equal(socket.timeoutMs, 2500);
  socket.emit(event, event === "error" ? Object.assign(new Error("x"), { code }) : undefined);
  return { exit, connectedTo };
}

test("canary: the script exits reached on a connect or a refusal, blocked on a timeout, error otherwise", () => {
  const connect = runCanaryScript("connect");
  assert.equal(connect.exit, CANARY_EXIT.reached);
  assert.deepEqual(connect.connectedTo, { host: "10.96.0.1", port: 443 });
  assert.equal(runCanaryScript("error", "ECONNREFUSED").exit, CANARY_EXIT.reached);
  assert.equal(runCanaryScript("timeout").exit, CANARY_EXIT.blocked);
  assert.equal(runCanaryScript("error", "ENETUNREACH").exit, CANARY_EXIT.error);
  assert.notEqual(CANARY_EXIT.blocked, CANARY_EXIT.reached);
});

// ---- secrets ----

type Leaky = PodContext & { token: string };
const withSecrets = <T extends object>(o: T): T => ({ ...o, token: SENTINEL, credentials: { apiKey: SENTINEL }, secrets: [SENTINEL] });

function assertNoSentinel(what: string, manifest: unknown): void {
  const text = JSON.stringify(manifest);
  assert.ok(!text.includes(SENTINEL), `${what} contains the sentinel token`);
  assert.ok(!text.includes(Buffer.from(SENTINEL).toString("base64")), `${what} contains the base64 sentinel`);
}

test("secrets: a token passed alongside the spec and context never reaches any builder's output", () => {
  const spec = withSecrets(baseSpec());
  const ctx = withSecrets(baseCtx());
  assertNoSentinel("pod", buildPod(spec, ctx));
  assertNoSentinel("network policy", buildNetworkPolicy("pomtree-sandboxes"));
  assertNoSentinel("canary", buildCanaryPod(withSecrets(canaryCtx())));
});

test("secrets: env names that look like credentials are refused, and the error does not echo the value", () => {
  for (const name of ["POMTREE_TOKEN", "MODEL_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "CLIENT_SECRET", "AWS_ACCESS_KEY_ID"]) {
    assert.throws(
      () => buildPod({ ...baseSpec(), env: { [name]: SENTINEL } }, baseCtx()),
      (e: Error) =>
        e instanceof PodBuildError && e.message.includes(name) && /deliver it after start over connect/.test(e.message) && !e.message.includes(SENTINEL),
      name,
    );
  }
  assert.throws(() => buildPod({ ...baseSpec(), env: { "bad name": "x" } }, baseCtx()), /valid environment variable name/);
});

test("secrets: negative control, a leaky builder makes the assertion fail", () => {
  const leakyBuildPod = (spec: SandboxSpec, ctx: Leaky): PodManifest => {
    const pod = buildPod(spec, ctx);
    pod.spec.containers[0]?.env?.push({ name: "LEAK", value: ctx.token });
    return pod;
  };
  assert.throws(() => assertNoSentinel("leaky pod", leakyBuildPod(baseSpec(), { ...baseCtx(), token: SENTINEL })), /contains the sentinel token/);
  const leakyAnnotation = buildPod(baseSpec(), baseCtx());
  leakyAnnotation.metadata.annotations.note = Buffer.from(SENTINEL).toString("base64");
  assert.throws(() => assertNoSentinel("leaky annotation", leakyAnnotation), /base64 sentinel/);
  // And the honest builder passes the same assertion.
  assertNoSentinel("honest pod", buildPod(baseSpec(), { ...baseCtx(), token: SENTINEL } as Leaky));
});

// ---- review fixes ----

test("canary verdict: admitted only when the control reached AND the canary was blocked", () => {
  const table: [number | null | undefined, number | null | undefined, boolean][] = [
    [10, 0, true],
    [10, 10, false],
    [10, 11, false],
    [10, 137, false],
    [10, 1, false],
    [10, undefined, false],
    [10, null, false],
    [0, 0, false], // the fail-open case: both time out, so the target or route is wrong
    [11, 0, false],
    [137, 0, false],
    [undefined, 0, false],
    [null, 0, false],
    [1, 0, false],
  ];
  const check = (verdict: (r: { control: number | null | undefined; canary: number | null | undefined }) => CanaryVerdict) => {
    for (const [control, canary, want] of table) assert.equal(verdict({ control, canary }).enforced, want, `control=${control} canary=${canary}`);
  };
  check(canaryVerdict);
  // Negative control: a verdict that treats a canary timeout as enforced is caught by the same table.
  assert.throws(() => check(({ canary }) => ({ enforced: canary === CANARY_EXIT.blocked, reason: "naive" })), /control=0 canary=0/);
});

test("canary verdict: every refusal names the cause and the action", () => {
  for (const r of [
    { control: 0, canary: 0 },
    { control: 10, canary: 10 },
    { control: 10, canary: 137 },
    { control: undefined, canary: undefined },
  ]) {
    const v = canaryVerdict(r);
    assert.equal(v.enforced, false);
    assert.match(v.reason, /fix|install|check|run/i);
  }
  assert.match(canaryVerdict({ control: 0, canary: 0 }).reason, /control pod.*did not reach/);
  assert.match(canaryVerdict({ control: 10, canary: 10 }).reason, /not enforcing NetworkPolicy/);
});

test("canary control: same script and target, no sandbox-pod label, still marked as a canary", () => {
  const policy = buildCanaryPod(canaryCtx());
  const control = buildCanaryPod({ ...canaryCtx(), control: true });
  assert.equal(control.metadata.name, "pomtree-canary-control-r1");
  assert.equal(SANDBOX_POD_LABEL in control.metadata.labels, false, "the policy must not select the control");
  assert.equal(policy.metadata.labels[SANDBOX_POD_LABEL], "1");
  assert.ok(control.metadata.labels["pomtree.canary"] && policy.metadata.labels["pomtree.canary"], "sweeps exclude both by pomtree.canary");
  assert.deepEqual(control.spec.containers[0]?.command, policy.spec.containers[0]?.command);
  assert.deepEqual(control.spec.containers[0]?.securityContext, policy.spec.containers[0]?.securityContext);
});

test("workspace mount: is the working directory and the volume is named for the workspace", () => {
  const pod = buildPod(baseSpec(), baseCtx());
  assert.equal(pod.spec.containers[0]?.workingDir, "/work");
  const other = buildPod({ ...baseSpec(), mounts: [{ kind: "workspace", workspace: "ws-2", containerPath: "/work" }] }, baseCtx());
  const names = (p: PodManifest) => p.spec.volumes.map((v) => v.name).filter((n) => n.startsWith("ws-"));
  assert.equal(names(pod).length, 1);
  assert.notDeepEqual(names(pod), names(other), "the volume name carries the workspace identity");
  const mount = pod.spec.containers[0]?.volumeMounts?.find((m) => m.mountPath === "/work");
  assert.equal(mount?.name, names(pod)[0]);
  // No workspace mount: nothing to honor, no workingDir.
  const none = buildPod({ ...baseSpec(), mounts: [{ kind: "scratch", containerPath: "/s" }] }, baseCtx());
  assert.equal(none.spec.containers[0]?.workingDir, undefined);
  assert.throws(
    () =>
      buildPod(
        {
          ...baseSpec(),
          mounts: [
            { kind: "workspace", workspace: "ws-1", containerPath: "/a" },
            { kind: "workspace", workspace: "ws-1", containerPath: "/b" },
          ],
        },
        baseCtx(),
      ),
    /mounted twice/,
  );
});

test("egress: every shape is covered by the namespace policy, builds, and only changes the hash", () => {
  const plain = buildPod(baseSpec(), baseCtx());
  for (const egress of [
    { allow: [{ host: "example.com", port: 443 }] },
    { allow: [], relay: [{ host: "controller.internal" }] },
    { allow: [], auditedPublic: { host: "host-a", generation: 3 } },
  ]) {
    const pod = buildPod({ ...baseSpec(), egress }, baseCtx());
    assert.notEqual(pod.metadata.annotations[SPEC_HASH_ANNOTATION], plain.metadata.annotations[SPEC_HASH_ANNOTATION]);
    const strip = (p: PodManifest) => ({ ...p, metadata: { ...p.metadata, annotations: {} } });
    assert.deepEqual(strip(pod), strip(plain), "egress is realized by the namespace policy, not by pod fields");
  }
  const np = buildNetworkPolicy("pomtree-sandboxes");
  assert.deepEqual(np.spec.policyTypes, ["Ingress", "Egress"]);
  assert.equal("egress" in np.spec, false, "deny-all covers every egress shape");
});

test("volumes: memory-backed and workspace volumes carry default size limits", () => {
  const pod = buildPod(
    { ...baseSpec(), mounts: [...baseSpec().mounts, { kind: "scratch", containerPath: "/s" }, { kind: "scratch", containerPath: "/s2", sizeBytes: 4096 }] },
    baseCtx(),
  );
  const by = new Map(pod.spec.volumes.map((v) => [v.name, v.emptyDir]));
  assert.equal(by.get("tmp")?.sizeLimit, DEFAULT_TMP_SIZE);
  assert.equal(by.get("home")?.sizeLimit, DEFAULT_HOME_SIZE);
  assert.equal(by.get("scratch-1")?.sizeLimit, DEFAULT_SCRATCH_SIZE);
  assert.equal(by.get("scratch-2")?.sizeLimit, "4096");
  assert.equal([...by.entries()].find(([n]) => n.startsWith("ws-"))?.[1].sizeLimit, DEFAULT_WORKSPACE_SIZE);
  for (const v of pod.spec.volumes) assert.ok(v.emptyDir.sizeLimit, `${v.name} has a size limit`);
});

test("mounts: paths at or inside the pod's reserved directories are refused", () => {
  for (const containerPath of ["/tmp", "/tmp/x", "/home/node", "/home/node/.cache", SECRET_DIR, `${SECRET_DIR}/f`, "/dev/shm"]) {
    assert.throws(
      () => buildPod({ ...baseSpec(), mounts: [{ kind: "scratch", containerPath }] }, baseCtx()),
      /reserves for its own volume.*choose a different containerPath/,
      containerPath,
    );
  }
  // Near misses are allowed.
  for (const containerPath of ["/tmpfoo", "/home/nodex", "/home"]) {
    assert.doesNotThrow(() => buildPod({ ...baseSpec(), mounts: [{ kind: "scratch", containerPath }] }, baseCtx()), containerPath);
  }
});

test("env credential heuristic: matches whole-word segments only", () => {
  for (const bad of [
    "POMTREE_TOKEN",
    "AUTH",
    "GH_AUTH",
    "BEARER",
    "SESSION_COOKIE",
    "SENTRY_DSN",
    "DB_PASS",
    "DB_PASSWD",
    "DATABASE_URL",
    "OPENAI_API_KEY",
    "APIKEY",
    "SSH_PRIVATE_KEY",
    "AWS_ACCESS_KEY_ID",
    "client-secret",
    "x.token",
  ]) {
    assert.equal(looksLikeCredentialName(bad), true, bad);
    assert.throws(() => buildPod({ ...baseSpec(), env: { [bad]: "v" } }, baseCtx()), /looks like a credential/, bad);
  }
  for (const ok of ["MAX_TOKENS", "TOKENIZER", "GIT_AUTHOR_NAME", "PASSTHROUGH", "PTREE_BROWSER", "SESSIONS_DIR", "KEY_COUNT", "DATABASE_NAME", "COMPASS"]) {
    assert.equal(looksLikeCredentialName(ok), false, ok);
    assert.doesNotThrow(() => buildPod({ ...baseSpec(), env: { [ok]: "v" } }, baseCtx()), ok);
  }
});
