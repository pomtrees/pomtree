import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DEFAULTS,
  CONFIG_REGISTRY,
  containerConfigEnv,
  type AgentId,
  type MountProvider,
  type MountSpec,
  type ResolvedMount,
  type WorkspaceId,
} from "@pomtree/core";

// Test-only trivial MountProvider that maps a mount to a given host path.
// Local stub instead of FakeMountProvider from @pomtree/testing; maps a mount to a given host path.
export function stubMounts(workspaceHost: string | (() => string) = "/p"): MountProvider {
  return {
    async resolve(_agent: AgentId, m: MountSpec): Promise<ResolvedMount> {
      switch (m.kind) {
        case "workspace":
          return {
            type: "bind",
            hostPath: typeof workspaceHost === "function" ? workspaceHost() : workspaceHost,
            containerPath: m.containerPath,
            readOnly: m.readOnly ?? false,
          };
        case "session":
          return { type: "bind", hostPath: `/host/session/${m.agent}`, containerPath: m.containerPath, readOnly: m.readOnly ?? false };
        case "scratch":
          return { type: "tmpfs", containerPath: m.containerPath, ...(m.sizeBytes !== undefined ? { sizeBytes: m.sizeBytes } : {}) };
        case "bind":
          return { type: "bind", hostPath: m.hostPath, containerPath: m.containerPath, readOnly: m.readOnly ?? false };
      }
    },
  };
}

export const resolvedWs = (containerPath: string, hostPath = "/p"): ResolvedMount => ({ type: "bind", hostPath, containerPath, readOnly: false });

// The offline scripted-provider Pi extension (agent-image test-fixtures), bind-mounted read-only where the browser worker's extension
// allowlist (browser-run.ts BROWSER_EXT_ROOT) admits it. The image does not carry it: the production ext directory and the allowlist are
// unchanged, and a `bind` mount is the operator-only escape hatch, so only a caller that can already replace image files can add it.
export const OFFLINE_BROWSER_EXT = "/opt/pomtree/ext/test-offline-browser.ts";
export const offlineBrowserExtMount = () => ({
  kind: "bind" as const,
  hostPath: realpathSync(fileURLToPath(new URL("../../agent-image/test-fixtures/offline-browser.ts", import.meta.url))),
  containerPath: OFFLINE_BROWSER_EXT,
  readOnly: true,
});

// The relay-reach probe fixture (agent-image test-fixtures), mounted the same way: Pi calls a relay authority itself and a Chromium page
// script requests it too, so one worker run shows the two listeners differ.
export const OFFLINE_RELAY_PROBE_EXT = "/opt/pomtree/ext/test-offline-relay-probe.ts";
export const offlineRelayProbeExtMount = () => ({
  kind: "bind" as const,
  hostPath: realpathSync(fileURLToPath(new URL("../../agent-image/test-fixtures/offline-relay-probe.ts", import.meta.url))),
  containerPath: OFFLINE_RELAY_PROBE_EXT,
  readOnly: true,
});

// The resolved container config document (PTREE_CONFIG_JSON) pomtreed writes on every start, built by core's one producer from the
// registry defaults. A gated test that starts the browser worker directly adds it to the spec env: the worker fails closed without it.
export const containerConfigTestEnv = () => containerConfigEnv(CONFIG_REGISTRY, CONFIG_DEFAULTS);

export const wsMount = (containerPath: string, workspace: WorkspaceId = "ws-test") => ({ kind: "workspace" as const, workspace, containerPath });

// The model-free capture worker and the modules it imports (agent-image src), bind-mounted read-only over /opt/pomtree/ in the
// existing image, so a Docker-gated run exercises this worktree's sources with no image rebuild. The worker's own modules are matched by
// name; the image's three shared modules are re-mounted from the worktree so they cannot lag it.
const CAPTURE_WORKER_FILE = /^(?:capture-.+|cdp-.+|warc|cdxj|zip|wacz|browser-run|browser-capture|main-content|container-contract\.gen)\.ts$/;
export const captureWorkerMounts = () => {
  const dir = fileURLToPath(new URL("../../agent-image/src/", import.meta.url));
  return readdirSync(dir)
    .filter((f) => CAPTURE_WORKER_FILE.test(f) && !f.endsWith(".test.ts"))
    .map((f) => ({ kind: "bind" as const, hostPath: realpathSync(join(dir, f)), containerPath: `/opt/pomtree/${f}`, readOnly: true }));
};

// The worktree's real worker-ready.ts (the capture launch path), mounted over the image copy: a source mount like the agent-image sources.
export const workerReadyMount = () => ({
  kind: "bind" as const,
  hostPath: realpathSync(fileURLToPath(new URL("./worker-ready.ts", import.meta.url))),
  containerPath: "/opt/pomtree/egress/worker-ready.ts",
  readOnly: true,
});
