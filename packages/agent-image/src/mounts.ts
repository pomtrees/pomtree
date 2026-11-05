import type { MountSpec } from "@pomtree/core";
import { hashManifest, type EnvManifest } from "./manifest.ts";

// Container-side paths; the Dockerfile's env vars point package-manager caches at ENV_LAYER_PATH.
export const ENV_LAYER_PATH = "/opt/pomtree/env-layer";
export const ENV_PARENT_PATH = "/opt/pomtree/env-parent";

// hostPath values are adapter-internal and never enter a checkpoint; checkpoints hold only the manifest hash.
// `cacheRoot` must already be a realpath (this module is pure and resolves nothing); layers are `<cacheRoot>/<manifestHash>`
// and the caller creates them. The parent's layer is mounted read-only, the agent's own layer read-write.
// Agents sharing an identical manifest share a layer, so concurrent installs rely on the package managers' own cache locking.
// TODO(env): pomtreed spawn does not call this yet (needs a parent manifest hash on AgentRecord/checkpoint, a core field).
// Layers are `bind` mounts because MountSpec has no `layer` kind; switch when core adds it, so hostPath leaves this module.
export function mountPlan(manifest: EnvManifest, opts: { cacheRoot: string; parent?: EnvManifest | null }): MountSpec[] {
  const layer = (m: EnvManifest) => `${opts.cacheRoot.replace(/\/+$/, "")}/${hashManifest(m)}`;
  const mounts: MountSpec[] = [{ kind: "bind", hostPath: layer(manifest), containerPath: ENV_LAYER_PATH }];
  if (opts.parent) mounts.push({ kind: "bind", hostPath: layer(opts.parent), containerPath: ENV_PARENT_PATH, readOnly: true });
  return mounts;
}
