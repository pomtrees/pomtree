// Validation of the template's opaque `runtime` block for the Kubernetes backend. Pure.
//
// The closed key set is runtimeClassName, nodeSelector, tolerations and priorityClassName. Any other key is refused so placement
// policy has one home; a pass-through pod-spec patch could weaken the PSA floor. A runtimeClassName is accepted only when the
// caller lists it among the classes the probe found on the cluster: an unlisted name would leave the pod Pending forever.

import { KUBERNETES_TAG_LIMITS } from "@pomtree/sandbox-kit";

export class RuntimeBlockError extends Error {
  override name = "RuntimeBlockError";
}

export interface Toleration {
  key?: string;
  operator?: "Exists" | "Equal";
  value?: string;
  effect?: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
  tolerationSeconds?: number;
}

export interface KubernetesRuntimeBlock {
  runtimeClassName?: string;
  nodeSelector?: Record<string, string>;
  tolerations?: Toleration[];
  priorityClassName?: string;
}

export interface RuntimeBlockOptions {
  // RuntimeClass names the probe found (`kubectl get runtimeclass`). Empty or absent means no class is usable.
  knownRuntimeClasses?: readonly string[];
}

export const RUNTIME_BLOCK_KEYS = ["runtimeClassName", "nodeSelector", "tolerations", "priorityClassName"] as const;

// DNS subdomain: the rule for RuntimeClass and PriorityClass names.
const DNS_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
// Qualified name for nodeSelector and toleration keys: optional DNS prefix + "/" + name of up to 63 characters.
const QUALIFIED_NAME = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/)?[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const EFFECTS = ["NoSchedule", "PreferNoSchedule", "NoExecute"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function dnsName(field: string, v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 253 || !DNS_SUBDOMAIN.test(v)) {
    throw new RuntimeBlockError(
      `runtime.${field} must be a lowercase DNS name of at most 253 characters (a-z, 0-9, "-", "."), got ${JSON.stringify(v)}; fix the template's runtime block`,
    );
  }
  return v;
}

function labelValue(field: string, v: unknown): string {
  if (typeof v !== "string" || v.length > KUBERNETES_TAG_LIMITS.maxValueLength || (v !== "" && !KUBERNETES_TAG_LIMITS.valuePattern.test(v))) {
    throw new RuntimeBlockError(`runtime.${field} must be a string of at most 63 characters from [A-Za-z0-9._-]; fix the template's runtime block`);
  }
  return v;
}

function qualifiedKey(field: string, v: unknown): string {
  if (typeof v !== "string" || !QUALIFIED_NAME.test(v)) {
    throw new RuntimeBlockError(`runtime.${field} key ${JSON.stringify(v)} is not a valid Kubernetes label key; fix the template's runtime block`);
  }
  return v;
}

function parseToleration(raw: unknown, i: number): Toleration {
  const where = `runtime.tolerations[${i}]`;
  if (!isRecord(raw)) throw new RuntimeBlockError(`${where} must be an object; fix the template's runtime block`);
  const allowed = ["key", "operator", "value", "effect", "tolerationSeconds"];
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) throw new RuntimeBlockError(`${where} has unknown key "${k}"; allowed keys are ${allowed.join(", ")}`);
  }
  const t: Toleration = {};
  if (raw.key !== undefined) t.key = qualifiedKey(`${where}.key`, raw.key);
  if (raw.operator !== undefined) {
    if (raw.operator !== "Exists" && raw.operator !== "Equal") throw new RuntimeBlockError(`${where}.operator must be "Exists" or "Equal"; fix the template`);
    t.operator = raw.operator;
  }
  if (raw.value !== undefined) t.value = labelValue(`${where}.value`, raw.value);
  if (raw.effect !== undefined) {
    if (typeof raw.effect !== "string" || !EFFECTS.includes(raw.effect)) {
      throw new RuntimeBlockError(`${where}.effect must be one of ${EFFECTS.join(", ")}; fix the template`);
    }
    t.effect = raw.effect as Toleration["effect"];
  }
  if (raw.tolerationSeconds !== undefined) {
    if (!Number.isInteger(raw.tolerationSeconds) || (raw.tolerationSeconds as number) < 0) {
      throw new RuntimeBlockError(`${where}.tolerationSeconds must be a non-negative integer; fix the template`);
    }
    t.tolerationSeconds = raw.tolerationSeconds as number;
  }
  if (t.operator === "Exists" && t.value !== undefined) {
    throw new RuntimeBlockError(`${where} sets a value with operator "Exists", which the API server rejects; drop the value or use operator "Equal"`);
  }
  if (t.key === undefined && t.operator !== "Exists") {
    throw new RuntimeBlockError(`${where} has no key, which is valid only with operator "Exists"; add a key or set operator "Exists"`);
  }
  return t;
}

// Returns the validated block (only keys that were present). `raw` is SandboxSpec.runtime; undefined or empty means no placement
// policy and the cluster defaults apply.
export function parseRuntimeBlock(raw: unknown, opts: RuntimeBlockOptions = {}): KubernetesRuntimeBlock {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new RuntimeBlockError("the runtime block must be an object; fix the template's runtime block");
  for (const k of Object.keys(raw)) {
    if ((RUNTIME_BLOCK_KEYS as readonly string[]).includes(k)) continue;
    throw new RuntimeBlockError(
      `runtime key "${k}" is not accepted by the kubernetes backend (allowed: ${RUNTIME_BLOCK_KEYS.join(", ")}); remove it, because placement policy has one home and a pass-through patch could weaken the pod security floor`,
    );
  }
  const out: KubernetesRuntimeBlock = {};
  if (raw.runtimeClassName !== undefined) {
    const name = dnsName("runtimeClassName", raw.runtimeClassName);
    const known = opts.knownRuntimeClasses ?? [];
    if (!known.includes(name)) {
      throw new RuntimeBlockError(
        `RuntimeClass "${name}" was not found on the cluster (known: ${known.length === 0 ? "none" : known.join(", ")}); a pod naming it would stay Pending, so install the RuntimeClass or fix the template's runtimeClassName`,
      );
    }
    out.runtimeClassName = name;
  }
  if (raw.nodeSelector !== undefined) {
    if (!isRecord(raw.nodeSelector)) throw new RuntimeBlockError("runtime.nodeSelector must be an object of strings; fix the template's runtime block");
    const sel: Record<string, string> = {};
    for (const k of Object.keys(raw.nodeSelector).sort()) sel[qualifiedKey("nodeSelector", k)] = labelValue(`nodeSelector.${k}`, raw.nodeSelector[k]);
    out.nodeSelector = sel;
  }
  if (raw.tolerations !== undefined) {
    if (!Array.isArray(raw.tolerations)) throw new RuntimeBlockError("runtime.tolerations must be an array; fix the template's runtime block");
    out.tolerations = raw.tolerations.map(parseToleration);
  }
  if (raw.priorityClassName !== undefined) out.priorityClassName = dnsName("priorityClassName", raw.priorityClassName);
  return out;
}
