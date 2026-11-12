// Pure builders for the Kubernetes backend: the sandbox Pod, its labels and annotations, the spec
// hash used for idempotent create, the default-deny NetworkPolicy and the canary pod that checks policy enforcement.
//
// No fs, no network. A built Pod never carries a secret: the per-agent token reaches the worker after start over `connect`, so env names that look like credentials are refused rather than copied. That refusal is a NAME
// heuristic only: a secret under an innocent name passes, so callers must not rely on it as the control.
//
// Egress. The namespace-wide policy (`buildNetworkPolicy`) denies all ingress and all egress for every pod carrying
// `pomtree.sandbox-pod=1`, and all worker traffic rides the exec mux to the daemon-side proxy, which enforces host allowlists.
// So every `SandboxSpec.egress` shape (allow, relay, auditedPublic) is covered by the namespace policy plus
// the daemon-side proxy, and the pod itself carries no network field for it; `egress` is only part of the spec hash so a changed
// policy is a changed spec. The optional proxy allowance in the policy is addressed by IP-reachable pod labels and a port only:
// DNS is blocked by default-deny (and `enableServiceLinks` is false), so nothing in the pod may rely on a service name.
//
// Sweeps. The canary pods carry the sandbox-pod label ON PURPOSE (the policy must select them). Any sweep or reclaim by that
// label must therefore also exclude `pomtree.canary` (selector `pomtree.sandbox-pod=1,!pomtree.canary`). The canaries carry no
// host or generation tag; the sweeper (which reclaims by owner selector) does not need them, so they are not added.

import { createHash } from "node:crypto";
import { SANDBOX_TAGS } from "@pomtree/core";
import type { MountSpec, SandboxId, SandboxSpec } from "@pomtree/core";
import { KUBERNETES_NAME_LIMITS, KUBERNETES_TAG_LIMITS, encodeTags } from "@pomtree/sandbox-kit";
import { type KubernetesRuntimeBlock, parseRuntimeBlock } from "./runtime-block.ts";

export class PodBuildError extends Error {
  override name = "PodBuildError";
}

export const BACKEND_ID = "kubernetes";
export const POD_NAME_PREFIX = "pomtree-";
export const WORKER_CONTAINER = "worker";
export const SANDBOX_POD_LABEL = "pomtree.sandbox-pod";
export const SPEC_HASH_ANNOTATION = "pomtree.dev/spec-sha256";
export const DEFAULT_SERVICE_ACCOUNT = "pomtree-sandbox";
export const NETWORK_POLICY_NAME = "pomtree-sandbox-default-deny";
// The user and group the Docker floor runs as.
export const WORKER_ID = 1000;
// Memory-backed directory the worker writes the post-start secret file into.
export const SECRET_DIR = "/run/pomtree";
// Default sizes for volumes the caller did not size. Memory-backed volumes count against the container memory limit, so they are
// small; the workspace is disk-backed and gets a larger bound. Scratch follows the Docker tmpfs idiom.
export const DEFAULT_TMP_SIZE = "256Mi";
export const DEFAULT_HOME_SIZE = "64Mi";
export const DEFAULT_SCRATCH_SIZE = "256Mi";
export const DEFAULT_WORKSPACE_SIZE = "10Gi";
const RESERVED_MOUNT_PATHS = ["/tmp", "/home/node", SECRET_DIR, "/dev/shm"];

export interface PodContext {
  namespace: string;
  // sandboxIdForKey(idempotencyKey): 64 hex, carried in full by the pod name.
  sandboxId: SandboxId;
  host: string;
  generation: number;
  // Becomes activeDeadlineSeconds, the dead-man switch.
  maxLifetimeSeconds: number;
  // RuntimeClass names the probe found, passed to the runtime block check.
  knownRuntimeClasses?: readonly string[];
  serviceAccountName?: string;
}

interface Volume {
  name: string;
  emptyDir: { medium?: "Memory"; sizeLimit?: string };
}
interface VolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
}
interface SecurityContext {
  allowPrivilegeEscalation: false;
  capabilities: { drop: ["ALL"] };
  readOnlyRootFilesystem: true;
  runAsNonRoot: true;
  runAsUser: number;
  runAsGroup: number;
  seccompProfile: { type: "RuntimeDefault" };
}
interface Container {
  name: string;
  image: string;
  imagePullPolicy: "IfNotPresent";
  command?: string[];
  args?: string[];
  env?: { name: string; value: string }[];
  securityContext: SecurityContext;
  resources?: { requests: Record<string, string>; limits: Record<string, string> };
  volumeMounts?: VolumeMount[];
  stdin?: boolean;
  tty?: boolean;
  workingDir?: string;
}
export interface PodManifest {
  apiVersion: "v1";
  kind: "Pod";
  metadata: { name: string; namespace: string; labels: Record<string, string>; annotations: Record<string, string> };
  spec: {
    restartPolicy: "Never";
    activeDeadlineSeconds: number;
    automountServiceAccountToken: false;
    enableServiceLinks: false;
    serviceAccountName: string;
    securityContext: { runAsNonRoot: true; runAsUser: number; runAsGroup: number; fsGroup: number; seccompProfile: { type: "RuntimeDefault" } };
    runtimeClassName?: string;
    nodeSelector?: Record<string, string>;
    tolerations?: KubernetesRuntimeBlock["tolerations"];
    priorityClassName?: string;
    containers: Container[];
    volumes: Volume[];
  };
}

// ---- shared hardening ----

const containerSecurityContext = (): SecurityContext => ({
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
  readOnlyRootFilesystem: true,
  runAsNonRoot: true,
  runAsUser: WORKER_ID,
  runAsGroup: WORKER_ID,
  seccompProfile: { type: "RuntimeDefault" },
});

const podSecurityContext = (): PodManifest["spec"]["securityContext"] => ({
  runAsNonRoot: true,
  runAsUser: WORKER_ID,
  runAsGroup: WORKER_ID,
  fsGroup: WORKER_ID,
  seccompProfile: { type: "RuntimeDefault" },
});

function checkName(what: string, name: string): void {
  if (name.length > KUBERNETES_NAME_LIMITS.maxLength || !KUBERNETES_NAME_LIMITS.pattern.test(name)) {
    throw new PodBuildError(
      `${what} "${name.slice(0, 80)}" is not a valid Kubernetes name (lowercase a-z, 0-9, "-" or ".", at most 253 characters); fix the value`,
    );
  }
}

function checkNamespace(ns: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(ns)) {
    throw new PodBuildError(`namespace "${ns.slice(0, 80)}" is not a valid DNS label (at most 63 characters, a-z, 0-9, "-"); fix sandbox.kubernetes.namespace`);
  }
}

// Whole-word segments (split on anything not alphanumeric), so MAX_TOKENS and TOKENIZER pass and POMTREE_TOKEN does not.
const SECRET_SEGMENTS = new Set([
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASS",
  "CREDENTIAL",
  "CREDENTIALS",
  "APIKEY",
  "AUTH",
  "AUTHORIZATION",
  "BEARER",
  "COOKIE",
  "SESSION",
  "DSN",
]);
const SECRET_PAIRS = [
  ["API", "KEY"],
  ["PRIVATE", "KEY"],
  ["ACCESS", "KEY"],
  ["DATABASE", "URL"],
];

export function looksLikeCredentialName(name: string): boolean {
  const segs = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((x) => x !== "");
  if (segs.some((x) => SECRET_SEGMENTS.has(x))) return true;
  return SECRET_PAIRS.some(([a, b]) => segs.some((x, i) => x === a && segs[i + 1] === b));
}
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function buildEnv(env: Readonly<Record<string, string>>): { name: string; value: string }[] {
  return Object.keys(env)
    .sort()
    .map((name) => {
      if (!ENV_NAME.test(name)) throw new PodBuildError(`env name ${JSON.stringify(name.slice(0, 80))} is not a valid environment variable name; rename it`);
      if (looksLikeCredentialName(name)) {
        throw new PodBuildError(
          `env "${name}" looks like a credential and a pod spec is stored in etcd and readable by anyone who can read pods; do not pass it in SandboxSpec.env, deliver it after start over connect`,
        );
      }
      const value = env[name];
      if (typeof value !== "string") throw new PodBuildError(`env "${name}" must be a string; fix the spec`);
      return { name, value };
    });
}

// ---- mounts and resources ----

function absolutePath(p: string): string {
  if (!p.startsWith("/") || p.split("/").includes("..")) {
    throw new PodBuildError(`mount path ${JSON.stringify(p.slice(0, 80))} must be absolute and contain no ".."; fix the mount's containerPath`);
  }
  return p;
}

const workspaceVolumeName = (id: string): string => `ws-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;

function buildMounts(mounts: readonly MountSpec[], shmBytes: number | undefined): { volumes: Volume[]; volumeMounts: VolumeMount[]; workingDir?: string } {
  const volumes: Volume[] = [
    { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: DEFAULT_TMP_SIZE } },
    { name: "home", emptyDir: { medium: "Memory", sizeLimit: DEFAULT_HOME_SIZE } },
    { name: "secrets", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
  ];
  const volumeMounts: VolumeMount[] = [
    { name: "tmp", mountPath: "/tmp" },
    { name: "home", mountPath: "/home/node" },
    { name: "secrets", mountPath: SECRET_DIR },
  ];
  if (shmBytes !== undefined) {
    volumes.push({ name: "shm", emptyDir: { medium: "Memory", sizeLimit: String(shmBytes) } });
    volumeMounts.push({ name: "shm", mountPath: "/dev/shm" });
  }
  let workingDir: string | undefined;
  mounts.forEach((m, i) => {
    const mountPath = absolutePath(m.containerPath);
    const clash = RESERVED_MOUNT_PATHS.find((r) => mountPath === r || mountPath.startsWith(`${r}/`));
    if (clash !== undefined) {
      throw new PodBuildError(`mount path ${mountPath} is inside ${clash}, which the pod reserves for its own volume; choose a different containerPath`);
    }
    let name: string;
    if (m.kind === "workspace") {
      // The mount of kind "workspace" is the working directory (SandboxSpec.mounts).
      name = workspaceVolumeName(m.workspace);
      if (volumes.some((v) => v.name === name)) throw new PodBuildError(`workspace ${m.workspace} is mounted twice; mount each workspace once`);
      volumes.push({ name, emptyDir: { sizeLimit: DEFAULT_WORKSPACE_SIZE } });
      workingDir ??= mountPath;
    } else if (m.kind === "scratch") {
      name = `scratch-${i}`;
      volumes.push({ name, emptyDir: { medium: "Memory", sizeLimit: m.sizeBytes !== undefined ? String(m.sizeBytes) : DEFAULT_SCRATCH_SIZE } });
    } else if (m.kind === "session") {
      throw new PodBuildError(
        "a session mount has no Kubernetes equivalent yet: the daemon tails Pi's event file from a host directory and a pod has none; use a template without a session mount on this backend",
      );
    } else {
      throw new PodBuildError(
        `a bind mount would need a hostPath volume, which the pod security floor forbids; use a workspace or scratch mount on the kubernetes backend`,
      );
    }
    volumeMounts.push({ name, mountPath, ...(m.readOnly ? { readOnly: true } : {}) });
  });
  return { volumes, volumeMounts, ...(workingDir !== undefined ? { workingDir } : {}) };
}

function buildResources(r: SandboxSpec["resources"]): Container["resources"] | undefined {
  if (r === undefined) return undefined;
  if (r.diskBytes !== undefined) {
    throw new PodBuildError(
      "resources.diskBytes (ephemeral-storage limits) is not enforced on the kubernetes backend until it is proven on a live cluster; remove diskBytes from the template",
    );
  }
  if (r.accelerators !== undefined && r.accelerators.length > 0) {
    throw new PodBuildError("accelerators are not supported by the kubernetes backend; remove them from the template or pick a backend that declares them");
  }
  const limits: Record<string, string> = {};
  if (r.cpus !== undefined) {
    if (!(r.cpus > 0)) throw new PodBuildError(`resources.cpus must be positive, got ${r.cpus}; fix the template`);
    limits.cpu = `${Math.max(1, Math.round(r.cpus * 1000))}m`;
  }
  if (r.memoryBytes !== undefined) {
    if (!Number.isInteger(r.memoryBytes) || r.memoryBytes <= 0)
      throw new PodBuildError(`resources.memoryBytes must be a positive integer, got ${r.memoryBytes}; fix the template`);
    limits.memory = String(r.memoryBytes);
  }
  if (Object.keys(limits).length === 0) return undefined;
  // requests equal limits: the Guaranteed QoS class.
  return { requests: { ...limits }, limits };
}

// ---- labels, annotations and the spec hash ----

function ownerTags(spec: SandboxSpec, ctx: PodContext): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.labels ?? {})) {
    if (!/^[A-Za-z0-9_.-]{1,63}$/.test(k) || k.startsWith("pomtree")) {
      throw new PodBuildError(
        `label key ${JSON.stringify(k.slice(0, 80))} must be [A-Za-z0-9_.-], at most 63 characters, and not start with "pomtree" (reserved); rename the label`,
      );
    }
    tags[k] = v;
  }
  tags[SANDBOX_TAGS.sandbox] = ctx.sandboxId;
  tags[SANDBOX_TAGS.agent] = spec.agent;
  tags[SANDBOX_TAGS.backend] = BACKEND_ID;
  tags[SANDBOX_TAGS.host] = ctx.host;
  tags[SANDBOX_TAGS.generation] = String(ctx.generation);
  return tags;
}

// Key-order-independent JSON: object keys sorted, undefined dropped. The input to the spec hash.
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

// sha256 over the pod without its own hash annotation plus the parts of the spec the pod does not carry (egress, the mounts'
// workspace ids). Any change to an image, env, command, resource, runtime, mount, lifetime or hardening field changes it.
export function specHash(pod: PodManifest, spec: SandboxSpec): string {
  const annotations = { ...pod.metadata.annotations };
  delete annotations[SPEC_HASH_ANNOTATION];
  const body = { ...pod, metadata: { ...pod.metadata, annotations } };
  return createHash("sha256")
    .update(canonicalJson({ pod: body, egress: spec.egress ?? null, mounts: spec.mounts }))
    .digest("hex");
}

// ---- the sandbox Pod ----

export function buildPod(spec: SandboxSpec, ctx: PodContext): PodManifest {
  const name = `${POD_NAME_PREFIX}${ctx.sandboxId}`;
  checkName("pod name", name);
  checkNamespace(ctx.namespace);
  if (!Number.isInteger(ctx.maxLifetimeSeconds) || ctx.maxLifetimeSeconds <= 0) {
    throw new PodBuildError(`maxLifetimeSeconds must be a positive integer, got ${ctx.maxLifetimeSeconds}; fix sandbox.kubernetes.maxLifetimeSeconds`);
  }
  if (spec.image.length === 0) throw new PodBuildError("the sandbox spec has no image; pass the pinned image reference");
  const runtime = parseRuntimeBlock(spec.runtime, { knownRuntimeClasses: ctx.knownRuntimeClasses ?? [] });
  const encoded = encodeTags(ownerTags(spec, ctx), KUBERNETES_TAG_LIMITS);
  const { volumes, volumeMounts, workingDir } = buildMounts(spec.mounts, spec.resources?.shmBytes);
  const resources = buildResources(spec.resources);
  if (resources?.limits.memory === undefined) {
    throw new PodBuildError(
      "the pod has memory-backed volumes (/tmp, /home/node, the secret directory) that count against the container memory, and the spec sets no resources.memoryBytes, so they would be unbounded; set resources.memoryBytes in the template",
    );
  }
  const container: Container = {
    name: WORKER_CONTAINER,
    image: spec.image,
    imagePullPolicy: "IfNotPresent",
    ...(workingDir !== undefined ? { workingDir } : {}),
    ...(spec.cmd !== undefined ? { args: [...spec.cmd] } : {}),
    env: buildEnv(spec.env),
    securityContext: containerSecurityContext(),
    ...(resources !== undefined ? { resources } : {}),
    volumeMounts,
    ...(spec.tty !== undefined ? { stdin: true, tty: true } : {}),
  };
  const pod: PodManifest = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: ctx.namespace,
      labels: { ...encoded.labels, [SANDBOX_POD_LABEL]: "1" },
      annotations: { ...encoded.annotations },
    },
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: ctx.maxLifetimeSeconds,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      serviceAccountName: ctx.serviceAccountName ?? DEFAULT_SERVICE_ACCOUNT,
      securityContext: podSecurityContext(),
      ...(runtime.runtimeClassName !== undefined ? { runtimeClassName: runtime.runtimeClassName } : {}),
      ...(runtime.nodeSelector !== undefined ? { nodeSelector: runtime.nodeSelector } : {}),
      ...(runtime.tolerations !== undefined ? { tolerations: runtime.tolerations } : {}),
      ...(runtime.priorityClassName !== undefined ? { priorityClassName: runtime.priorityClassName } : {}),
      containers: [container],
      volumes,
    },
  };
  pod.metadata.annotations[SPEC_HASH_ANNOTATION] = specHash(pod, spec);
  return pod;
}

// ---- NetworkPolicy ----

export interface EgressProxyAllowance {
  // Labels of the egress proxy pods in the same namespace, and the one TCP port they accept.
  podLabels: Readonly<Record<string, string>>;
  port: number;
}

export interface NetworkPolicyManifest {
  apiVersion: "networking.k8s.io/v1";
  kind: "NetworkPolicy";
  metadata: { name: string; namespace: string };
  spec: {
    podSelector: { matchLabels: Record<string, string> };
    policyTypes: ["Ingress", "Egress"];
    // No ingress rules at all: ingress is denied.
    egress?: { to: { podSelector: { matchLabels: Record<string, string> } }[]; ports: { protocol: "TCP"; port: number }[] }[];
  };
}

// Default-deny for every sandbox pod. With no `proxy`, egress is denied entirely (all reach-back rides exec). With one, the only
// allowance is TCP to the named proxy pods on one port; ingress stays denied.
export function buildNetworkPolicy(namespace: string, proxy?: EgressProxyAllowance): NetworkPolicyManifest {
  checkNamespace(namespace);
  const policy: NetworkPolicyManifest = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: NETWORK_POLICY_NAME, namespace },
    spec: { podSelector: { matchLabels: { [SANDBOX_POD_LABEL]: "1" } }, policyTypes: ["Ingress", "Egress"] },
  };
  if (proxy !== undefined) {
    const labels = Object.keys(proxy.podLabels).sort();
    if (labels.length === 0) {
      throw new PodBuildError(
        "the egress proxy allowance has no pod labels, which would select every pod in the namespace; name the proxy pods' labels or pass no proxy",
      );
    }
    if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
      throw new PodBuildError(`the egress proxy port must be an integer from 1 to 65535, got ${proxy.port}; fix the proxy port`);
    }
    const matchLabels: Record<string, string> = {};
    for (const k of labels) matchLabels[k] = proxy.podLabels[k] as string;
    policy.spec.egress = [{ to: [{ podSelector: { matchLabels } }], ports: [{ protocol: "TCP", port: proxy.port }] }];
  }
  return policy;
}

// ---- canary ----

// Exit codes of the canary's connect script.
export const CANARY_EXIT = { blocked: 0, reached: 10, error: 11 } as const;

export type CanaryVerdict = { enforced: true; reason: string } | { enforced: false; reason: string };

// Admission contract: a cluster is admitted as enforcing NetworkPolicy only when the CONTROL pod (same script, same target, NO
// sandbox-pod label, so no policy applies) exits `reached` AND the policy-selected canary exits `blocked`. A timeout alone proves
// nothing: a wrong target or a black-holed route times out too, so a canary exit of 0 with a failed control reads as NOT enforced.
// Any other exit (error 11, a kill such as 137, 1, or no exit code at all) is NOT enforced. Fail closed.
export function canaryVerdict(r: { control: number | null | undefined; canary: number | null | undefined }): CanaryVerdict {
  const show = (v: number | null | undefined) => (v === null || v === undefined ? "no exit code" : `exit ${v}`);
  if (r.control !== CANARY_EXIT.reached) {
    return {
      enforced: false,
      reason: `the control pod (no policy) did not reach the target (${show(r.control)}), so the canary result proves nothing; fix the canary target address or the cluster's pod network, then re-run the probe`,
    };
  }
  if (r.canary === CANARY_EXIT.blocked) return { enforced: true, reason: "the control pod reached the target and the policy-selected canary was blocked" };
  return {
    enforced: false,
    reason:
      r.canary === CANARY_EXIT.reached
        ? "the policy-selected canary reached the target, so the network plugin is not enforcing NetworkPolicy; install an enforcing plugin (Calico, Cilium) or run sandboxes elsewhere"
        : `the policy-selected canary ended with ${show(r.canary)}, not a clean timeout, so enforcement is unproven; check the canary pod's logs and events, then re-run the probe`,
  };
}
const CANARY_SCRIPT = [
  "const net = require('node:net');",
  "const [host, port, ms] = process.argv.slice(1);",
  "const s = net.connect({ host, port: Number(port) });",
  "s.setTimeout(Number(ms));",
  "s.on('connect', () => process.exit(10));",
  "s.on('timeout', () => process.exit(0));",
  "s.on('error', (e) => process.exit(e.code === 'ECONNREFUSED' ? 10 : 11));",
].join(" ");

export interface CanaryContext {
  namespace: string;
  // Distinguishes concurrent probes; lowercase alphanumerics and "-".
  runId: string;
  // The sandbox image, so the canary needs no extra image.
  image: string;
  // The in-cluster address the policy must block, normally the API server's ClusterIP.
  targetHost: string;
  targetPort: number;
  timeoutMs?: number;
  serviceAccountName?: string;
  // true builds the CONTROL: no sandbox-pod label, so the default-deny policy does not select it. Run it beside the canary.
  control?: boolean;
}

// A pod carrying the sandbox-pod label (so the default-deny policy selects it) that tries one TCP connect. Exit CANARY_EXIT.blocked
// = the connect timed out; CANARY_EXIT.reached = it connected or was refused. Read the two exits together with `canaryVerdict`,
// never alone. With `control: true` the pod omits the sandbox-pod label and must exit `reached`. Both carry `pomtree.canary`,
// which sweeps by the sandbox-pod label must exclude.
export function buildCanaryPod(ctx: CanaryContext): PodManifest {
  checkNamespace(ctx.namespace);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/.test(ctx.runId)) {
    throw new PodBuildError(`canary runId "${ctx.runId.slice(0, 80)}" must be lowercase a-z, 0-9 or "-", at most 42 characters; fix the probe's run id`);
  }
  if (!/^[A-Za-z0-9.:-]{1,253}$/.test(ctx.targetHost)) {
    throw new PodBuildError(`canary target host "${ctx.targetHost.slice(0, 80)}" is not an address or DNS name; pass the API server's ClusterIP`);
  }
  if (!Number.isInteger(ctx.targetPort) || ctx.targetPort < 1 || ctx.targetPort > 65535) {
    throw new PodBuildError(`canary target port must be an integer from 1 to 65535, got ${ctx.targetPort}; fix the probe's target`);
  }
  const timeoutMs = ctx.timeoutMs ?? 3000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new PodBuildError(`canary timeoutMs must be a positive integer, got ${timeoutMs}; fix the probe's timeout`);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `${POD_NAME_PREFIX}canary-${ctx.control === true ? "control-" : ""}${ctx.runId}`,
      namespace: ctx.namespace,
      labels: {
        ...(ctx.control === true ? {} : { [SANDBOX_POD_LABEL]: "1" }),
        [SANDBOX_TAGS.backend]: BACKEND_ID,
        "pomtree.canary": ctx.control === true ? "control" : "policy",
      },
      annotations: {},
    },
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: 60,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      serviceAccountName: ctx.serviceAccountName ?? DEFAULT_SERVICE_ACCOUNT,
      securityContext: podSecurityContext(),
      containers: [
        {
          name: "canary",
          image: ctx.image,
          imagePullPolicy: "IfNotPresent",
          command: ["node", "-e", CANARY_SCRIPT, ctx.targetHost, String(ctx.targetPort), String(timeoutMs)],
          securityContext: containerSecurityContext(),
        },
      ],
      volumes: [],
    },
  };
}
