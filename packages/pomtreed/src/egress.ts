import type { EnvManifest } from "@pomtree/agent-image";
import { registryAllowlist } from "@pomtree/agent-image";
import type { EgressPolicy, EgressTarget, HostId, SandboxEgress } from "@pomtree/core";

// Split a URL into its host and port for the egress allowlist. Only TCP URLs (http/https) are
// meaningful for a sandbox proxy; anything else (file:, unix: sockets, malformed) yields nothing.
function tcpHostPort(url: string): { host: string; port: number } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  return { host: u.hostname, port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80 };
}

function allowlistHost(host: string): { host: string; port: number } {
  let target: URL;
  try {
    target = new URL(`https://${host}`);
  } catch {
    throw new Error(`invalid egress allowlist host: ${JSON.stringify(host)}`);
  }
  if (target.username || target.password || target.pathname !== "/" || target.search || target.hash || target.port || target.hostname !== host) {
    throw new Error(`invalid egress allowlist host: ${JSON.stringify(host)}`);
  }
  return { host, port: 443 };
}

// Resolve the durable SpawnSpec policy into the default-deny sandbox allowlist. A registry policy
// means exactly the registries named by its manifest plus the node-local relay endpoints the
// sandbox needs for pomtree and its model. An empty manifest consequently grants no registry target;
// it never falls back to the Docker bridge network.
//
// Public Internet access is an explicit audited policy, never the default. Unknown policies fail closed.
// Template authorization is controlled by Daemon.mayUseTemplate; attribution comes from the immutable spawning record.
export function egressPolicy(opts: {
  policy: EgressPolicy;
  manifest: EnvManifest;
  agentApiUrl?: string;
  modelBaseUrl?: string;
  host?: HostId;
  generation?: number;
}): SandboxEgress {
  const byHostPort = new Map<string, EgressTarget>();
  const add = (host: string, port: number) => {
    const key = `${host}:${port}`;
    if (!byHostPort.has(key)) byHostPort.set(key, { host, port });
  };

  switch (opts.policy.kind) {
    case "none":
      // TODO(model-egress): 'none' grants no model relay by design; model-capable templates (hn-content grounded-model) must use a relay-only grant (e.g. registry with an empty manifest) until an explicit model-only egress kind is decided in core. Current behavior: none => allow [], no relay.
      return { allow: [] };
    case "registry":
      for (const host of registryAllowlist(opts.manifest)) add(host, 443);
      break;
    case "audited-public":
      if (!opts.host || !Number.isSafeInteger(opts.generation) || opts.generation! < 0)
        throw new Error("audited-public egress requires immutable host and generation attribution");
      break;
    case "allowlist":
      for (const raw of opts.policy.hosts) {
        const target = allowlistHost(raw);
        add(target.host, target.port);
      }
      break;
    default:
      return { allow: [] }; // an unknown policy fails closed: no targets at all
  }

  // The node relay is not general Internet egress. These controller-provided endpoints are needed
  // to operate a networked template, and remain behind the same per-sandbox proxy.
  const relay: EgressTarget[] = [];
  for (const url of [opts.agentApiUrl, opts.modelBaseUrl]) {
    const endpoint = url && tcpHostPort(url);
    if (endpoint && !relay.some((t) => t.host === endpoint.host && t.port === endpoint.port)) {
      relay.push(endpoint);
      add(endpoint.host, endpoint.port);
    }
  }

  // Model calls go through the controller's model proxy (`modelBaseUrl`, added above), which holds the provider
  // credentials. Nothing adds a provider API host automatically; a raw provider host is allowed only when an operator
  // names it in an explicit `allowlist`.

  return {
    allow: [...byHostPort.values()].sort((a, b) => (a.host === b.host ? (a.port ?? 0) - (b.port ?? 0) : a.host < b.host ? -1 : 1)),
    ...(relay.length > 0 && { relay }),
    ...(opts.policy.kind === "audited-public" && { auditedPublic: { host: opts.host!, generation: opts.generation! } }),
  };
}
