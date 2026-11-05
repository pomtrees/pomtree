import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import { type Daemon, listenAgents } from "@pomtree/pomtreed";
import { detectBridgeGateway, planAgentListen } from "../../../pomtreed/src/agent-net.ts";

// The demos' agent endpoint, bound by pomtreed's own plan (`planAgentListen`): the docker bridge gateway plus loopback on Linux,
// loopback elsewhere, POMTREED_AGENT_LISTEN overriding. Decision: the planner replaces the old `?? FALLBACK_BRIDGE_GATEWAY` guess,
// so an undetectable gateway binds loopback and prints the planner's warning, as pomtreed does. Every demo goes through here
// (demo-wiring.test.ts enforces it).
export interface AgentEndpoint {
  apiUrl: string; // what containers use: host.docker.internal on the bound port
  port: number;
  hosts: string[]; // bound hosts, in bind order
  close(): void;
}

export interface AgentEndpointOptions {
  platform?: string;
  detect?: () => Promise<string | undefined>;
  listen?: string;
  bind?: (host: string, port: number) => Promise<{ server: Server; port: number }>;
  warn?: (msg: string) => void;
}

export async function listenAgentEndpoint(daemon: Daemon, options: AgentEndpointOptions = {}): Promise<AgentEndpoint> {
  const platform = options.platform ?? process.platform;
  const listen = options.listen ?? process.env.POMTREED_AGENT_LISTEN;
  const detect = options.detect ?? (() => detectBridgeGateway(async (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 5000 })));
  const bind = options.bind ?? ((host: string, port: number) => listenAgents(daemon, host, port));
  const warn = options.warn ?? ((msg: string) => console.error(msg));
  const plan = planAgentListen({ listen, platform, gateway: platform === "linux" ? await detect() : undefined });
  if (plan.warning) warn(plan.warning);
  if (plan.mode === "off")
    throw new Error("the demo needs an agent endpoint but POMTREED_AGENT_LISTEN=off disables it; unset POMTREED_AGENT_LISTEN or set it to host:port");
  const first = await bind(plan.host, plan.port);
  const servers = [first.server];
  const hosts = [plan.host];
  try {
    for (const h of plan.extraHosts) {
      servers.push((await bind(h, first.port)).server);
      hosts.push(h);
    }
  } catch (e) {
    for (const s of servers) s.close();
    throw e;
  }
  return {
    apiUrl: `http://host.docker.internal:${first.port}`,
    port: first.port,
    hosts,
    close: () => {
      for (const s of servers) s.close();
    },
  };
}
