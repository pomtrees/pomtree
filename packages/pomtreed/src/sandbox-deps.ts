import type { DockerDeps, LocalEngine } from "@pomtree/sandbox-docker";
import type { DaemonConfig } from "./daemon-config.ts";

export interface DockerSandboxDepsInput {
  mounts: DockerDeps["mounts"];
  egressAuditRoot: string;
  cfg: Pick<DaemonConfig, "agent.egressProxyImage" | "push.maxBytes">;
  // The selected engine: its profile and resolved socket select the adapter's CLI, dialect and terminal transport.
  engine: Pick<LocalEngine, "sandboxDeps">;
  // Final sink for adapter warnings; the caller stamps and prints them, so this module stays free of console and fs.
  warn: (message: string) => void;
}

/**
 * The options pomtreed passes to DockerSandbox, built in one pure place so a test can pin them. Ownership is not an option: the Daemon stamps
 * store_id and daemon_epoch on agent containers, and reconcile and reclaim pass the same values as the owner argument (sandboxOwner).
 */
export function dockerSandboxDeps(input: DockerSandboxDepsInput): DockerDeps {
  const { mounts, egressAuditRoot, cfg, warn, engine } = input;
  return {
    ...engine.sandboxDeps(),
    mounts,
    egressAuditRoot,
    egressProxyImage: cfg["agent.egressProxyImage"], // never empty: boot refuses an unset value (safety-boot.ts)
    egressRelayMaxBytes: cfg["push.maxBytes"],
    warn,
  };
}
