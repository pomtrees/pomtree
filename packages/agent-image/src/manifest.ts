import { createHash } from "node:crypto";

export type Ecosystem = "npm" | "pip" | "cargo";
export const ECOSYSTEMS: readonly Ecosystem[] = ["npm", "pip", "cargo"];

export interface EcosystemEntry {
  specs: string[]; // pinned: npm `name@1.2.3`, pip `name==1.2.3`, cargo `name@1.2.3`
  lockfileHash?: string;
}

// TODO(env-system): a `system` section (micromamba) is not modelled; only npm/pip/cargo ecosystems exist.
export interface EnvManifest {
  ecosystems: Partial<Record<Ecosystem, EcosystemEntry>>;
}

export interface Override {
  ecosystem: Ecosystem;
  name: string;
  from: string;
  to: string;
}

const PINNED: Record<Ecosystem, RegExp> = {
  npm: /^((?:@[^/@\s]+\/)?[^/@\s]+)@(\d[^\s]*)$/,
  pip: /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\d[^\s]*)$/,
  cargo: /^([A-Za-z0-9_-]+)@(\d[^\s]*)$/,
};

export function parseSpec(ecosystem: Ecosystem, spec: string): { name: string; version: string } {
  const m = PINNED[ecosystem].exec(spec);
  if (!m) throw new Error(`unpinned or malformed ${ecosystem} spec: ${JSON.stringify(spec)}`);
  return { name: m[1]!, version: m[2]! };
}

export const emptyManifest = (): EnvManifest => ({ ecosystems: {} });

// Validates, dedupes, sorts specs, and drops empty ecosystems, so equal environments compare and hash equal.
export function normalize(m: EnvManifest): EnvManifest {
  const ecosystems: EnvManifest["ecosystems"] = {};
  for (const eco of ECOSYSTEMS) {
    const e = m.ecosystems[eco];
    if (!e) continue;
    const byName = new Map<string, string>();
    for (const spec of e.specs) {
      const { name } = parseSpec(eco, spec);
      const prev = byName.get(name);
      if (prev !== undefined && prev !== spec) throw new Error(`conflicting ${eco} specs for ${name}: ${prev} vs ${spec}`);
      byName.set(name, spec);
    }
    const specs = [...byName.values()].sort();
    if (specs.length === 0 && !e.lockfileHash) continue;
    ecosystems[eco] = e.lockfileHash ? { specs, lockfileHash: e.lockfileHash } : { specs };
  }
  return { ecosystems };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function hashManifest(m: EnvManifest): string {
  const n = normalize(m);
  const canonical = { ecosystems: Object.fromEntries(ECOSYSTEMS.flatMap((e) => (n.ecosystems[e] ? [[e, n.ecosystems[e]]] : []))) };
  return sha256(JSON.stringify(canonical));
}

// The child inherits every parent entry; a child spec for the same package name overrides and is reported.
// A parent lockfileHash is kept only when the child changes nothing in that ecosystem, since it would be stale otherwise.
export function extend(parent: EnvManifest, additions: Partial<Record<Ecosystem, EcosystemEntry>>): { manifest: EnvManifest; overrides: Override[] } {
  const p = normalize(parent);
  const overrides: Override[] = [];
  const ecosystems: EnvManifest["ecosystems"] = {};
  for (const eco of ECOSYSTEMS) {
    const base = p.ecosystems[eco];
    const add = additions[eco];
    if (!add) {
      if (base) ecosystems[eco] = base;
      continue;
    }
    const byName = new Map((base?.specs ?? []).map((s) => [parseSpec(eco, s).name, s]));
    let changed = false;
    for (const spec of add.specs) {
      const { name } = parseSpec(eco, spec);
      const prev = byName.get(name);
      if (prev === spec) continue;
      if (prev !== undefined) overrides.push({ ecosystem: eco, name, from: prev, to: spec });
      byName.set(name, spec);
      changed = true;
    }
    const lockfileHash = add.lockfileHash ?? (changed ? undefined : base?.lockfileHash);
    ecosystems[eco] = lockfileHash ? { specs: [...byName.values()], lockfileHash } : { specs: [...byName.values()] };
  }
  return { manifest: normalize({ ecosystems }), overrides };
}

export const cacheKey = (ecosystem: Ecosystem, spec: string): string => {
  parseSpec(ecosystem, spec);
  return `${ecosystem}/${sha256(`${ecosystem}\0${spec}`)}`;
};
