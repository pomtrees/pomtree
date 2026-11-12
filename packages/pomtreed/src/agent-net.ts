// Agent TCP endpoint addressing (TODO(agent-endpoint)). Pure logic; the container engine CLI, sockets and the platform are injected.
// Every text and command names the selected engine (its EngineProfile, default Docker); the host alias is the one constant HOST_ALIAS.
//
// Containers reach the daemon at host.docker.internal:<port>. On Linux, `--add-host host.docker.internal:host-gateway`
// resolves that to the docker bridge gateway (docker0, normally 172.17.0.1), so a listener bound to 127.0.0.1 is
// unreachable from a container. Binding 0.0.0.0 would fix it but also exposes the (token-gated) agent API to the LAN,
// so the default binds the bridge gateway IP instead: reachable from containers, not from other machines.
// Docker Desktop (macOS/Windows) forwards host.docker.internal to the host's loopback, so 127.0.0.1 keeps working.
import { DOCKER_PROFILE, type EngineProfile, gatewayInspectArgs, HOST_ALIAS, hostGatewayArgs } from "@pomtree/sandbox-docker";

export const FALLBACK_BRIDGE_GATEWAY = "172.17.0.1";
export type ExecFn = (cmd: string, args: string[]) => Promise<string>;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export const isIpv4 = (s: string): boolean => {
  const m = IPV4.exec(s);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
};

let cachedGateway: Promise<string | undefined> | undefined;

// The engine's default-network gateway IP (Docker's bridge, Podman's `podman` network), or undefined when it cannot be determined
// (engine missing/failing, odd output). `exec` receives the engine's binary. Cached per process; pass `fresh` (tests) to bypass it.
export function detectBridgeGateway(exec: ExecFn, fresh = false, engine: EngineProfile = DOCKER_PROFILE): Promise<string | undefined> {
  if (!fresh && cachedGateway) return cachedGateway;
  const p = exec(engine.binary, gatewayInspectArgs(engine))
    .then((out) => {
      const ip = out.trim();
      return isIpv4(ip) ? ip : undefined;
    })
    .catch(() => undefined);
  if (!fresh) cachedGateway = p;
  return p;
}

export interface AgentListenPlan {
  mode: "off" | "explicit" | "gateway" | "loopback";
  host: string; // primary bind host ("" when off)
  port: number; // 0 = ephemeral (or the pinned port)
  extraHosts: string[]; // additional hosts to bind on the same port (best effort)
  warning?: string;
}

// POMTREED_AGENT_LISTEN (host:port | off) always wins. Otherwise: Linux binds the bridge gateway (plus loopback on the
// same port, harmless and handy for host-side tools); other platforms bind loopback. An undeterminable gateway on
// Linux falls back to loopback with a warning (containers will not reach it).
export function planAgentListen(o: { listen: string | undefined; platform: string; gateway: string | undefined; engine?: EngineProfile }): AgentListenPlan {
  if (o.listen === "off") return { mode: "off", host: "", port: 0, extraHosts: [] };
  if (o.listen !== undefined && o.listen !== "") {
    const i = o.listen.lastIndexOf(":");
    return { mode: "explicit", host: o.listen.slice(0, i), port: Number(o.listen.slice(i + 1)), extraHosts: [] };
  }
  if (o.platform !== "linux") return { mode: "loopback", host: "127.0.0.1", port: 0, extraHosts: [] };
  if (o.gateway) return { mode: "gateway", host: o.gateway, port: 0, extraHosts: ["127.0.0.1"] };
  return {
    mode: "loopback",
    host: "127.0.0.1",
    port: 0,
    extraHosts: [],
    warning: `could not determine the ${(o.engine ?? DOCKER_PROFILE).binary} bridge gateway (is ${(o.engine ?? DOCKER_PROFILE).binary} running?); agent endpoint bound to 127.0.0.1, which Linux containers CANNOT reach. Set POMTREED_AGENT_LISTEN=<bridge-gateway-ip>:0 (e.g. 172.17.0.1:0).`,
  };
}

// The plan every container-reachable listener uses (no explicit listen); `detect` runs only on Linux.
export async function agentBindPlan(platform: string, detect: () => Promise<string | undefined>, engine?: EngineProfile): Promise<AgentListenPlan> {
  return planAgentListen({ listen: undefined, platform, gateway: platform === "linux" ? await detect() : undefined, ...(engine && { engine }) });
}

// Can a Linux container (host-gateway = bridge gateway) reach a listener bound to `host`? Wildcards yes, gateway yes, loopback no.
export function containerReachable(o: { platform: string; boundHosts: string[]; gateway: string | undefined }): boolean {
  if (o.platform !== "linux") return true;
  return o.boundHosts.some((h) => h === "0.0.0.0" || h === "::" || (o.gateway !== undefined && h === o.gateway));
}

// Where the host should connect to prove the listener is up where containers will look.
export function probeTarget(o: { platform: string; boundHosts: string[]; gateway: string | undefined }): string {
  if (o.platform === "linux" && o.gateway && o.boundHosts.includes(o.gateway)) return o.gateway;
  const h = o.boundHosts[0] ?? "127.0.0.1";
  return h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h;
}

export interface AgentEndpointStatus {
  bind: string[]; // host:port strings
  apiUrl: string;
  containerReachable: boolean; // by address analysis (Linux) or platform rule
  hostProbe: boolean; // a TCP connect to the probe target succeeded
  probe: string; // host:port that was connected to
  message?: string;
}

// Actionable text naming the bound address, the POMTREE_API containers use and the fix.
export function unreachableMessage(o: { bind: string[]; apiUrl: string; probe: string; listenable: boolean; engine?: EngineProfile }): string {
  const engine = o.engine ?? DOCKER_PROFILE;
  const b = engine.binary;
  const inspect = gatewayInspectArgs(engine).slice(0, 3).join(" ");
  return (
    `agent endpoint unreachable: pomtreed bound ${o.bind.join(", ") || "nothing"}, containers use POMTREE_API=${o.apiUrl} (host-gateway = ${b} bridge), probe ${o.probe} ${o.listenable ? "connected but loopback is not routable from containers" : "failed"}. ` +
    `Fix: leave POMTREED_AGENT_LISTEN unset (binds the ${b} bridge gateway on Linux) or set POMTREED_AGENT_LISTEN=<bridge-gateway-ip>:<port> (${b} ${inspect}), and check the firewall allows ${engine.id === "podman" ? "the podman network" : "docker0"} -> that port.`
  );
}

// `<engine> run` args for a throwaway probe from a container's network perspective: exit 0 iff HOST_ALIAS:<port> accepts a TCP
// connection. This catches host firewalls (e.g. ufw dropping docker0 -> host ports), which bind analysis cannot. Podman adds the
// alias itself, so it gets no --add-host (hostGatewayArgs).
export function containerProbeArgs(image: string, port: number, engine: EngineProfile = DOCKER_PROFILE): string[] {
  return [
    "run",
    "--rm",
    "--user",
    "1000:1000",
    ...hostGatewayArgs(engine),
    "--entrypoint",
    "node",
    image,
    "-e",
    `const s=require("net").connect({host:"${HOST_ALIAS}",port:${port},timeout:3000},()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1))`,
  ];
}

// Actionable text for a container probe that failed because a host firewall drops docker0 -> host TCP (bind analysis
// cannot see it). `hostUid` tailors the unix-socket fallback: it works only when the host uid is 1000.
export function firewallHint(port: number, hostUid?: number): string {
  const socketFallback =
    hostUid === undefined
      ? "Falling back to the unix-socket mount (works when the host uid is 1000)."
      : hostUid === 1000
        ? "Falling back to the unix-socket mount (host uid is 1000, so the fallback works)."
        : `The unix-socket mount fallback needs host uid 1000 but the host uid is ${hostUid}; run pomtreed as uid 1000 or open the firewall (the socket mount will not work otherwise).`;
  // Both rules are the ones verified on a ufw host (TODO(agent-endpoint)); deploy/INSTALL.md states the same two verbatim.
  return `A host firewall is probably dropping docker0 -> host traffic. With ufw, allow the default bridge and the user-defined bridges (interface pattern br-+, used by the egress sidecar networks): \`sudo ufw allow in on docker0\` and \`sudo ufw allow in on br-+\` (deploy/INSTALL.md); POMTREED_AGENT_LISTEN=<bridge-gateway-ip>:${port} pins the bind. ${socketFallback}`;
}

// Pure summary of the bound agent endpoint: the object `doctor` embeds and the source of the `endpoint_unreachable`
// preflight event message. The caller measures `hostProbe` (a host TCP connect to the probe target) and
// `containerProbe` (a throwaway `<engine> run` via containerProbeArgs); no sockets or engine calls here. `message` is present
// only when the endpoint is not reachable.
export function summarizeAgentEndpoint(o: {
  platform: string;
  boundHosts: string[];
  port: number;
  apiUrl: string;
  gateway: string | undefined;
  hostProbe: boolean; // host TCP connect to the probe target succeeded
  containerProbe: boolean | undefined; // real docker probe; false = a firewall dropped docker0 -> host traffic
  hostUid?: number; // unix-socket mount fallback needs 1000 (undefined = unknown; keep the generic phrasing)
  engine?: EngineProfile; // names the engine in the message (default Docker)
}): AgentEndpointStatus {
  const bind = o.boundHosts.map((h) => `${h}:${o.port}`);
  const target = probeTarget({ platform: o.platform, boundHosts: o.boundHosts, gateway: o.gateway });
  const probe = `${target}:${o.port}`;
  const reachable = containerReachable({ platform: o.platform, boundHosts: o.boundHosts, gateway: o.gateway }) && o.containerProbe !== false;
  const ok = o.hostProbe && reachable;
  const message = ok
    ? undefined
    : unreachableMessage({ bind, apiUrl: o.apiUrl, probe, listenable: o.hostProbe, ...(o.engine && { engine: o.engine }) }) +
      (o.containerProbe === false ? ` Container probe failed. ${firewallHint(o.port, o.hostUid)}` : "");
  return {
    bind,
    apiUrl: o.apiUrl,
    containerReachable: reachable,
    hostProbe: o.hostProbe,
    probe,
    ...(message !== undefined && { message }),
  };
}
