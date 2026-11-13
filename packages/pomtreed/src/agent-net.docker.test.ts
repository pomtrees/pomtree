// Docker-gated (PTREE_DOCKER_TESTS=1): proves the Linux bug behind TODO(agent-endpoint) — a loopback-bound host
// listener is unreachable from a container via host-gateway, while one bound to the bridge gateway IP is reachable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { gateEngine, gateExecFile, runtimeSkip } from "../../sandbox-docker/src/docker-gate.ts";
import { detectBridgeGateway, planAgentListen } from "./agent-net.ts";

const run = (args: string[]) =>
  new Promise<string>((res, rej) => gateExecFile(args, { timeout: 60_000 }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))));
// The opt-in and the engine named by PTREE_SANDBOX_BACKEND (docker or podman): the CLI calls and the bridge-gateway lookup target that engine.
const gateSkip = runtimeSkip();
const linux = process.platform === "linux";
const image = process.env.POMTREED_AGENT_IMAGE ?? "pomtree/agent:dev";

function listenOn(host: string): Promise<{ server: Server; port: number }> {
  const server = createServer((_q, r) => r.end("pong"));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}
// HTTP status of GET http://host.docker.internal:<port>/ from a container (000 = unreachable), via node in the agent image.
const fromContainer = (port: number) =>
  run([
    "run",
    "--rm",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--entrypoint",
    "node",
    image,
    "-e",
    `fetch("http://host.docker.internal:${port}/",{signal:AbortSignal.timeout(4000)}).then(r=>console.log(r.status),()=>console.log("000"))`,
  ]).then((o) => o.trim());

test("container reaches a gateway-bound listener (fails on a host firewall that blocks docker0) but never a loopback-bound one", {
  skip:
    gateSkip ||
    (!linux
      ? "not Linux (see the Docker Desktop test below)"
      : gateEngine().profile.id !== "docker"
        ? "the bridge-gateway bind is Docker-only; Podman binds loopback (planAgentListen)"
        : false),
}, async () => {
  const gw = await detectBridgeGateway((_c, a) => run(a), true, gateEngine().profile);
  assert.ok(gw, "bridge gateway detected");
  const good = await listenOn(gw!);
  const bad = await listenOn("127.0.0.1");
  const wild = await listenOn("0.0.0.0");
  try {
    // The gateway-bound listener is the production bind. Any result but 200 means every Linux agent's `pomtree` call fails
    // at runtime, so this is a failure, never a diagnostic. A host with no firewall returns 200 and passes; only a host
    // that drops docker0 -> host TCP (ufw) lands here.
    const viaGw = await fromContainer(good.port);
    if (viaGw !== "200") {
      const viaWild = await fromContainer(wild.port);
      const cause =
        viaWild === "000"
          ? "0.0.0.0 is unreachable too, so a host firewall (typically ufw) is dropping docker0 -> host TCP"
          : "0.0.0.0 IS reachable, so this is not a firewall: check the bridge gateway detected above is the one host-gateway resolves to";
      assert.fail(
        `container could not reach the listener bound to the bridge gateway ${gw} (got ${viaGw}); ${cause}. ` +
          "Action: on a ufw host run `sudo ufw allow in on docker0` and `sudo ufw allow in on br-+` (deploy/INSTALL.md, Linux firewall), then rerun; pomtreed would otherwise fall back to the socket mount. " +
          "This test is meaningful only when it fails on a blocked host: do not skip or soften it.",
      );
    }
    assert.equal(await fromContainer(bad.port), "000", "loopback-bound listener is NOT reachable from a container (the bug)");
  } finally {
    good.server.close();
    bad.server.close();
    wild.server.close();
  }
});

// Non-Linux (Docker Desktop): verifies containerReachable's "non-Linux is always reachable" assumption against the
// production plan — the listener planAgentListen binds (loopback) must be reachable from a container.
test("container reaches the listener planAgentListen binds on a non-Linux host (Docker Desktop)", {
  skip: gateSkip || (linux ? "Linux (see the bridge-gateway test above)" : false),
}, async () => {
  const plan = planAgentListen({ listen: undefined, platform: process.platform, gateway: undefined, engine: gateEngine().profile });
  assert.notEqual(plan.mode, "off");
  const { server, port } = await listenOn(plan.host);
  try {
    assert.equal(await fromContainer(port), "200", `listener bound to ${plan.host} is reachable at host.docker.internal`);
  } finally {
    server.close();
  }
});
