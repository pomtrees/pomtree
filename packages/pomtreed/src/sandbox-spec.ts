// Metadata-only summary of the SandboxSpec the daemon asked for, journaled on the `started` entry of `ext.pomtreed.sandbox` so the
// requested isolation can be checked after the fact. Pure: no fs, no Docker. Never carries env values, secret ids, host paths, cmd
// (it holds the prompt) or label values; only names, kinds, container paths and numbers.
import type { MountSpec, SandboxSpec } from "@pomtree/core";

export interface SandboxSpecSummary {
  image: string;
  tty: boolean;
  resources?: { cpus?: number; memoryBytes?: number; shmBytes?: number; diskBytes?: number; accelerators?: number };
  // `none`: no egress block requested (adapter default network). `default-deny`: allow/relay target counts, and whether public destinations are audited.
  egress: { mode: "none" } | { mode: "default-deny"; allow: number; relay: number; auditedPublic: boolean };
  mounts: { kind: MountSpec["kind"]; containerPath: string; readOnly: boolean }[];
  envKeys: string[];
  runtimeKeys: string[];
}

export function describeSandboxSpec(spec: SandboxSpec): SandboxSpecSummary {
  const r = spec.resources;
  const resources = r && {
    ...(r.cpus !== undefined && { cpus: r.cpus }),
    ...(r.memoryBytes !== undefined && { memoryBytes: r.memoryBytes }),
    ...(r.shmBytes !== undefined && { shmBytes: r.shmBytes }),
    ...(r.diskBytes !== undefined && { diskBytes: r.diskBytes }),
    ...(r.accelerators !== undefined && { accelerators: r.accelerators.length }),
  };
  return {
    image: spec.image,
    tty: spec.tty !== undefined,
    ...(resources && { resources }),
    egress: spec.egress
      ? { mode: "default-deny", allow: spec.egress.allow.length, relay: spec.egress.relay?.length ?? 0, auditedPublic: spec.egress.auditedPublic !== undefined }
      : { mode: "none" },
    mounts: spec.mounts.map((m) => ({ kind: m.kind, containerPath: m.containerPath, readOnly: m.readOnly === true })),
    envKeys: Object.keys(spec.env).sort(),
    runtimeKeys: Object.keys(spec.runtime ?? {}).sort(),
  };
}
