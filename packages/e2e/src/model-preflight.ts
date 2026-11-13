import type { Sandbox, SandboxEgress, SandboxSpec } from "@pomtree/core";
import type { EngineProfile } from "@pomtree/sandbox-docker";
import { sandboxOpKey } from "../../pomtreed/src/daemon/sandbox-ops.ts";

// Reachability of the scoped model proxy from a worker's network, checked before any spend. The live scripts bind the proxy on the
// host and hand workers `baseUrl`; a mismatch between the two (or an egress policy that grants no relay to it) makes Pi retry
// with only "Connection error." and zero tokens. The relation is pure (`modelRouteProblem`); the live check runs an injected probe.

const WILDCARDS = new Set(["0.0.0.0", "::", ""]);

// Why a worker with `egress` cannot reach `baseUrl` when the proxy listens on `bind` on `platform`, or undefined when the route is
// consistent. Workers are network-none: the only route is the egress sidecar, which dials host.docker.internal (Docker Desktop:
// host loopback; Linux: the docker bridge gateway, so loopback is unreachable) and only for an exact relay grant. Rootless Podman has no
// bridge gateway: its sidecar maps the host loopback through pasta (planAgentListen binds loopback there), so with `engine` podman a
// loopback bind is the consistent one on Linux too.
export function modelRouteProblem(o: {
  platform: string;
  engine?: Pick<EngineProfile, "id">;
  bind: { host: string; port: number };
  baseUrl: string;
  egress: SandboxEgress | undefined;
}): string | undefined {
  const url = new URL(o.baseUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (WILDCARDS.has(o.bind.host)) return `model proxy bound on ${o.bind.host || "all interfaces"}: reachable but exposed beyond the container route`;
  if (url.hostname !== "host.docker.internal") return `model proxy URL host ${url.hostname} is not the sidecar's host alias host.docker.internal`;
  if (port !== o.bind.port) return `model proxy URL port ${port} differs from the bound port ${o.bind.port}`;
  if (!o.egress?.relay?.some((t) => t.host === url.hostname && (t.port ?? 443) === port))
    return `egress policy grants no relay to ${url.hostname}:${port} (policy none resolves to no relay)`;
  const loopback = o.bind.host === "127.0.0.1" || o.bind.host === "::1";
  if (loopback && o.platform === "linux" && o.engine?.id !== "podman")
    return `proxy bound on loopback ${o.bind.host}: a Linux container's host-gateway is the bridge gateway, not loopback`;
  return undefined;
}

// `probe` runs one unauthenticated request to `baseUrl` from a container with the worker's network shape and resolves to the HTTP
// status (any status proves the route; the proxy answers 401 without a credential) or rejects when the connection fails.
export type ModelRouteProbe = (baseUrl: string) => Promise<number>;

export async function assertModelProxyReachable(o: {
  platform: string;
  engine?: Pick<EngineProfile, "id">;
  bind: { host: string; port: number };
  baseUrl: string;
  egress: SandboxEgress | undefined;
  probe: ModelRouteProbe;
}): Promise<void> {
  const problem = modelRouteProblem(o);
  if (problem) throw new Error(`model proxy unreachable from container via ${o.baseUrl}: ${problem}`);
  try {
    await o.probe(o.baseUrl);
  } catch (e) {
    throw new Error(`model proxy unreachable from container via ${o.baseUrl}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// The real probe: one short container started through `sandbox` with the worker's network shape (`spec` carries the same egress,
// image and mounts the worker gets), fetching `baseUrl` with no credential. No model call, no spend.
export function sandboxModelRouteProbe(
  sandbox: Pick<Sandbox, "start" | "kill">,
  spec: Pick<SandboxSpec, "agent" | "image" | "mounts" | "egress">,
): ModelRouteProbe {
  return async (baseUrl) => {
    const script = `fetch(${JSON.stringify(`${baseUrl}/chat/completions`)},{method:"POST",signal:AbortSignal.timeout(15000)}).then(r=>console.log("STATUS "+r.status)).catch(e=>console.log("ERR "+e.message))`;
    // A throwaway probe belongs to no daemon host; the stamp keeps a leaked probe container from reading as a pre-stamp (legacy) one.
    const h = await sandbox.start(
      { host: "model-route-probe", generation: 0, ...spec, env: {}, cmd: ["node", "-e", script] },
      `model-route-probe:${Date.now()}`,
    );
    let out = "";
    try {
      for await (const part of h.output()) out += part.chunk;
      await h.wait().catch(() => {});
    } finally {
      await sandbox.kill(h.id, sandboxOpKey("kill", h.id)).catch(() => {});
    }
    const m = /STATUS (\d+)/.exec(out);
    if (!m) throw new Error(out.match(/ERR (.*)/)?.[1] ?? "no response");
    return Number(m[1]);
  };
}
