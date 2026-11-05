import type { DockerDeps } from "@pomtree/sandbox-docker";
import type { DaemonConfig } from "./daemon-config.ts";

export interface DockerSandboxDepsInput {
  mounts: DockerDeps["mounts"];
  egressAuditRoot: string;
  storeId: string;
  bootEpoch: string;
  cfg: Pick<DaemonConfig, "agent.egressProxyImage" | "push.maxBytes">;
  // Final sink for adapter warnings; the caller stamps and prints them, so this module stays free of console and fs.
  warn: (message: string) => void;
}

/** The options pomtreed passes to DockerSandbox, built in one pure place so a test can pin them. */
export function dockerSandboxDeps(input: DockerSandboxDepsInput): DockerDeps {
  const { mounts, egressAuditRoot, storeId, bootEpoch, cfg, warn } = input;
  return {
    mounts,
    egressAuditRoot,
    egressProxyImage: cfg["agent.egressProxyImage"], // never empty: boot refuses an unset value (safety-boot.ts)
    egressRelayMaxBytes: cfg["push.maxBytes"],
    // The same storeId and bootEpoch the Daemon stamps on agent containers (store_id, daemon_epoch), so the orphan sweep and reconcile agree on ownership.
    owner: { storeId, epoch: bootEpoch },
    warn,
  };
}
