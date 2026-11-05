import type { HostId, HostStore, MountProvider, Resources, Sandbox, TemplateId, Workspace } from "@pomtree/core";
import { join } from "node:path";
import { LocalNode } from "./local-node.ts";
import { HostPlacement } from "./placement.ts";

export interface LocalHostOptions {
  hostId: HostId;
  hosts: HostStore;
  // Builds the sandbox from the node's own mount provider (the node holds the sandbox and the sandbox resolves
  // mounts through the node, so the provider is late-bound).
  makeSandbox: (mounts: MountProvider) => Sandbox;
  workspace: Workspace & { hostPath(id: string): string }; // GitWorkspace
  sessionRoot: string;
  capacity: Resources & { maxSessions: number };
  labels?: Record<string, string>;
  image?: string;
  bootEpoch?: string;
  requires?: (template: TemplateId) => Promise<string[]>;
}

// The single-host composition shared by pomtreed's main and the real-adapter e2e rigs: one LocalNode (mount
// provider, sandbox, workspace) and a HostPlacement over the host table that registers the node before first use.
export function wireLocalHost(o: LocalHostOptions): { node: LocalNode; sandbox: Sandbox; placement: HostPlacement } {
  let node!: LocalNode;
  const sandbox = o.makeSandbox({ resolve: (agent, mount) => node.resolve(agent, mount) });
  node = new LocalNode({
    hostId: o.hostId,
    sandbox,
    workspace: o.workspace,
    capacity: o.capacity,
    ...(o.labels !== undefined && { labels: o.labels }),
    ...(o.image !== undefined && { image: o.image }),
    ...(o.bootEpoch !== undefined && { bootEpoch: o.bootEpoch }),
    workspacePath: (id) => o.workspace.hostPath(id),
    sessionDir: (agent) => join(o.sessionRoot, agent),
  });
  const placement = new HostPlacement({
    hosts: o.hosts,
    host: o.hostId,
    ready: () => node.register(o.hosts),
    ...(o.requires !== undefined && { requires: o.requires }),
  });
  return { node, sandbox, placement };
}
