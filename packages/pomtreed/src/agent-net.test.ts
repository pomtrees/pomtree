import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentBindPlan,
  containerReachable,
  detectBridgeGateway,
  firewallHint,
  planAgentListen,
  probeTarget,
  summarizeAgentEndpoint,
  unreachableMessage,
} from "./agent-net.ts";
import { PODMAN_PROFILE } from "@pomtree/sandbox-docker";

test("detectBridgeGateway parses docker output, rejects junk, falls back to undefined on failure", async () => {
  let args: string[] = [];
  assert.equal(
    await detectBridgeGateway(async (_c, a) => {
      args = a;
      return "172.18.0.1\n";
    }, true),
    "172.18.0.1",
  );
  assert.deepEqual(args.slice(0, 3), ["network", "inspect", "bridge"]);
  assert.equal(await detectBridgeGateway(async () => "<no value>", true), undefined);
  assert.equal(
    await detectBridgeGateway(async () => {
      throw new Error("no docker");
    }, true),
    undefined,
  );
});

test("detectBridgeGateway caches", async () => {
  let n = 0;
  const exec = async () => {
    n++;
    return "172.17.0.1";
  };
  await detectBridgeGateway(exec, true);
  const before = n;
  await detectBridgeGateway(exec);
  await detectBridgeGateway(exec);
  assert.ok(n - before <= 1);
});

test("planAgentListen: linux binds the gateway plus loopback; never 0.0.0.0 by default", () => {
  const p = planAgentListen({ listen: undefined, platform: "linux", gateway: "172.17.0.1" });
  assert.deepEqual([p.mode, p.host, p.extraHosts], ["gateway", "172.17.0.1", ["127.0.0.1"]]);
  assert.notEqual(p.host, "0.0.0.0");
});

test("planAgentListen: linux without a gateway falls back to loopback with a warning", () => {
  const p = planAgentListen({ listen: undefined, platform: "linux", gateway: undefined });
  assert.equal(p.host, "127.0.0.1");
  assert.match(p.warning ?? "", /CANNOT reach/);
});

test("agentBindPlan: linux detects the gateway; other platforms never call detect and keep loopback; undetected gateway warns", async () => {
  let calls = 0;
  const detect = (gw: string | undefined) => async () => {
    calls++;
    return gw;
  };
  const p = await agentBindPlan("linux", detect("172.17.0.1"));
  assert.deepEqual(p, planAgentListen({ listen: undefined, platform: "linux", gateway: "172.17.0.1" }));
  assert.equal(calls, 1);
  for (const platform of ["darwin", "win32"]) {
    const q = await agentBindPlan(platform, detect("172.17.0.1"));
    assert.equal(q.mode, "loopback");
    assert.equal(q.host, "127.0.0.1");
  }
  assert.equal(calls, 1);
  const w = await agentBindPlan("linux", detect(undefined));
  assert.equal(w.mode, "loopback");
  assert.match(w.warning ?? "", /could not determine the docker bridge gateway/);
});

test("planAgentListen: darwin/win32 keep loopback; explicit and off win", () => {
  for (const platform of ["darwin", "win32"]) assert.equal(planAgentListen({ listen: undefined, platform, gateway: "172.17.0.1" }).host, "127.0.0.1");
  assert.deepEqual(planAgentListen({ listen: "10.0.0.5:4000", platform: "linux", gateway: "172.17.0.1" }), {
    mode: "explicit",
    host: "10.0.0.5",
    port: 4000,
    extraHosts: [],
  });
  assert.equal(planAgentListen({ listen: "off", platform: "linux", gateway: "172.17.0.1" }).mode, "off");
});

test("containerReachable / probeTarget", () => {
  const g = "172.17.0.1";
  assert.equal(containerReachable({ platform: "linux", boundHosts: ["127.0.0.1"], gateway: g }), false);
  assert.equal(containerReachable({ platform: "linux", boundHosts: [g, "127.0.0.1"], gateway: g }), true);
  assert.equal(containerReachable({ platform: "linux", boundHosts: ["0.0.0.0"], gateway: g }), true);
  assert.equal(containerReachable({ platform: "darwin", boundHosts: ["127.0.0.1"], gateway: undefined }), true);
  assert.equal(probeTarget({ platform: "linux", boundHosts: [g, "127.0.0.1"], gateway: g }), g);
  assert.equal(probeTarget({ platform: "linux", boundHosts: ["0.0.0.0"], gateway: g }), "127.0.0.1");
});

test("unreachableMessage names bind, POMTREE_API and the fix", () => {
  const m = unreachableMessage({ bind: ["127.0.0.1:41781"], apiUrl: "http://host.docker.internal:41781", probe: "127.0.0.1:41781", listenable: true });
  assert.match(m, /127\.0\.0\.1:41781/);
  assert.match(m, /POMTREE_API=http:\/\/host\.docker\.internal:41781/);
  assert.match(m, /POMTREED_AGENT_LISTEN/);
});

test("firewallHint names the ufw fix and the uid-1000 socket fallback", () => {
  const m = firewallHint(41781, 1000);
  assert.match(m, /`sudo ufw allow in on docker0`/);
  assert.match(m, /POMTREED_AGENT_LISTEN=<bridge-gateway-ip>:41781/);
  assert.match(m, /host uid is 1000, so the fallback works/);
});

test("firewallHint names both verified ufw rules: the default bridge docker0 and the user-defined bridges br-+", () => {
  const m = firewallHint(41781);
  assert.match(m, /`sudo ufw allow in on docker0`/);
  assert.match(m, /`sudo ufw allow in on br-\+`/);
  assert.match(m, /deploy\/INSTALL\.md/);
});

test("firewallHint warns the socket fallback needs uid 1000 when it is not", () => {
  const m = firewallHint(41781, 1001);
  assert.match(m, /needs host uid 1000 but the host uid is 1001/);
  assert.match(m, /`sudo ufw allow in on docker0`/);
});

test("firewallHint without a uid keeps the generic socket-fallback phrasing", () => {
  assert.match(firewallHint(41781), /works when the host uid is 1000/);
});

test("summarizeAgentEndpoint: firewall drop names docker0 -> host drop, the ufw fix and the socket fallback", () => {
  const s = summarizeAgentEndpoint({
    platform: "linux",
    boundHosts: ["172.17.0.1", "127.0.0.1"],
    port: 41781,
    apiUrl: "http://host.docker.internal:41781",
    gateway: "172.17.0.1",
    hostProbe: true,
    containerProbe: false,
    hostUid: 1000,
  });
  assert.equal(s.containerReachable, false);
  assert.match(s.message ?? "", /A host firewall is probably dropping docker0 -> host traffic/);
  assert.match(s.message ?? "", /Container probe failed/);
  assert.match(s.message ?? "", /`sudo ufw allow in on docker0`/);
  assert.match(s.message ?? "", /host uid is 1000, so the fallback works/);
});

test("summarizeAgentEndpoint: firewall drop with a non-1000 uid says the socket fallback will not work", () => {
  const s = summarizeAgentEndpoint({
    platform: "linux",
    boundHosts: ["172.17.0.1", "127.0.0.1"],
    port: 41781,
    apiUrl: "http://host.docker.internal:41781",
    gateway: "172.17.0.1",
    hostProbe: true,
    containerProbe: false,
    hostUid: 1001,
  });
  assert.match(s.message ?? "", /needs host uid 1000 but the host uid is 1001/);
});

test("summarizeAgentEndpoint: reachable endpoint has no message", () => {
  const s = summarizeAgentEndpoint({
    platform: "linux",
    boundHosts: ["172.17.0.1", "127.0.0.1"],
    port: 41781,
    apiUrl: "http://host.docker.internal:41781",
    gateway: "172.17.0.1",
    hostProbe: true,
    containerProbe: true,
    hostUid: 1000,
  });
  assert.equal(s.containerReachable, true);
  assert.equal(s.hostProbe, true);
  assert.equal(s.message, undefined);
});

test("summarizeAgentEndpoint: no firewall hint when the endpoint is reachable or the container probe did not fail", () => {
  const base = {
    platform: "linux",
    boundHosts: ["172.17.0.1", "127.0.0.1"],
    port: 41781,
    apiUrl: "http://host.docker.internal:41781",
    gateway: "172.17.0.1",
    hostProbe: true,
    hostUid: 1000,
  };
  assert.equal(summarizeAgentEndpoint({ ...base, containerProbe: true }).message, undefined);
  assert.equal(summarizeAgentEndpoint({ ...base, containerProbe: undefined }).message, undefined);
  // Unreachable for a bind reason (loopback only), with no failed container probe: the bind fix, not the ufw rules.
  const loop = summarizeAgentEndpoint({ ...base, boundHosts: ["127.0.0.1"], containerProbe: undefined });
  assert.ok(loop.message);
  assert.doesNotMatch(loop.message, /ufw|br-\+/);
});

test("summarizeAgentEndpoint: loopback bind is unreachable from Linux containers even when the host probe connects", () => {
  const s = summarizeAgentEndpoint({
    platform: "linux",
    boundHosts: ["127.0.0.1"],
    port: 41781,
    apiUrl: "http://host.docker.internal:41781",
    gateway: "172.17.0.1",
    hostProbe: true,
    containerProbe: undefined,
    hostUid: 1000,
  });
  assert.equal(s.containerReachable, false);
  assert.match(s.message ?? "", /connected but loopback is not routable from containers/);
});

test("Podman: the default plan binds loopback only, ignores a gateway and carries no warning; an explicit listen still wins", () => {
  const p = planAgentListen({ listen: undefined, platform: "linux", gateway: "172.17.0.1", engine: PODMAN_PROFILE });
  assert.deepEqual([p.mode, p.host, p.extraHosts, p.warning], ["loopback", "127.0.0.1", [], undefined]);
  const none = planAgentListen({ listen: undefined, platform: "linux", gateway: undefined, engine: PODMAN_PROFILE });
  assert.equal(none.warning, undefined);
  const e = planAgentListen({ listen: "10.0.0.5:7000", platform: "linux", gateway: undefined, engine: PODMAN_PROFILE });
  assert.deepEqual([e.mode, e.host, e.port], ["explicit", "10.0.0.5", 7000]);
  assert.equal(planAgentListen({ listen: "off", platform: "linux", gateway: undefined, engine: PODMAN_PROFILE }).mode, "off");
});

test("Podman: detectBridgeGateway never runs the engine; loopback counts as container-reachable only for Podman", async () => {
  let calls = 0;
  const exec = async () => {
    calls++;
    return "172.17.0.1\n";
  };
  assert.equal(await detectBridgeGateway(exec, true, PODMAN_PROFILE), undefined);
  assert.equal(calls, 0);
  assert.equal(containerReachable({ platform: "linux", boundHosts: ["127.0.0.1"], gateway: undefined, engine: PODMAN_PROFILE }), true);
  assert.equal(containerReachable({ platform: "linux", boundHosts: ["10.0.0.5"], gateway: undefined, engine: PODMAN_PROFILE }), false);
  assert.equal(containerReachable({ platform: "linux", boundHosts: ["127.0.0.1"], gateway: undefined }), false);
  const st = summarizeAgentEndpoint({
    platform: "linux",
    boundHosts: ["127.0.0.1"],
    port: 7,
    apiUrl: "http://host.docker.internal:7",
    gateway: undefined,
    hostProbe: true,
    containerProbe: undefined,
    engine: PODMAN_PROFILE,
  });
  assert.equal(st.containerReachable, true);
  assert.equal(st.message, undefined);
});
