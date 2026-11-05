import { existsSync, mkdirSync, realpathSync } from "node:fs";
import type {
  AgentId,
  HostId,
  HostRecord,
  HostStore,
  MountProvider,
  MountSpec,
  ResolvedMount,
  Resources,
  Sandbox,
  WorkspaceId,
  Workspace,
} from "@pomtree/core";

export interface LocalNodeOptions {
  hostId: HostId;
  labels?: Record<string, string>;
  capacity: Resources & { maxSessions: number };
  sandbox: Sandbox;
  workspace: Workspace;
  // The daemon image, recorded as the host's cached image.
  image?: string;
  // Distinguishes one boot from the next in the register idempotency key (default: boot time).
  bootEpoch?: string;
  // Host realizations, injected so this module stays free of adapter coupling: main.ts passes
  // GitWorkspace.hostPath. `workspacePath` throws for an unknown id.
  workspacePath(id: WorkspaceId): string;
  sessionDir(agent: AgentId): string;
}

// The in-process node: one code path for single-host installs. It
// holds the host's identity and capacity, its sandbox and workspace adapters, and resolves MountSpecs to
// host realizations. Host paths exist only on this side of MountProvider: errors name ids, never paths.
export class LocalNode implements MountProvider {
  readonly hostId: HostId;
  readonly labels: Record<string, string>;
  readonly capacity: Resources & { maxSessions: number };
  readonly sandbox: Sandbox;
  readonly workspace: Workspace;
  private readonly opts: LocalNodeOptions;
  private readonly epoch: string;

  constructor(opts: LocalNodeOptions) {
    this.opts = opts;
    this.hostId = opts.hostId;
    this.labels = { ...opts.labels };
    this.capacity = { ...opts.capacity };
    this.sandbox = opts.sandbox;
    this.workspace = opts.workspace;
    this.epoch = opts.bootEpoch ?? String(Date.now());
  }

  async resolve(_agent: AgentId, mount: MountSpec): Promise<ResolvedMount> {
    const containerPath = mount.containerPath;
    switch (mount.kind) {
      case "workspace": {
        let path: string;
        try {
          path = realpathSync(this.opts.workspacePath(mount.workspace));
        } catch {
          throw new Error(`workspace ${mount.workspace} is not available on host ${this.hostId}`);
        }
        return { type: "bind", hostPath: path, containerPath, readOnly: mount.readOnly ?? false };
      }
      case "session": {
        const dir = this.opts.sessionDir(mount.agent);
        mkdirSync(dir, { recursive: true });
        return { type: "bind", hostPath: realpathSync(dir), containerPath, readOnly: mount.readOnly ?? false };
      }
      case "scratch":
        return { type: "tmpfs", containerPath, ...(mount.sizeBytes !== undefined && { sizeBytes: mount.sizeBytes }) };
      case "bind":
        // Operator-only: only the daemon authors bind specs. A path that does not exist yet passes through unchanged.
        return {
          type: "bind",
          hostPath: existsSync(mount.hostPath) ? realpathSync(mount.hostPath) : mount.hostPath,
          containerPath,
          readOnly: mount.readOnly ?? false,
        };
    }
  }

  // Upsert this host's row at boot: ready, capacity from config, the daemon image cached. Idempotent per boot.
  register(hosts: HostStore): Promise<HostRecord> {
    return hosts.upsertHost(
      {
        id: this.hostId,
        labels: this.labels,
        capacity: this.capacity,
        images: this.opts.image !== undefined ? [this.opts.image] : [],
        state: "ready",
      },
      `localnode:${this.hostId}:${this.epoch}`,
    );
  }
}
