import test from "node:test";
import assert from "node:assert/strict";
import { wsMount } from "./test-mounts.ts";
import { EGRESS_PROXY_PORT, PROXY_ENV_NAMES } from "@pomtree/core";
import { buildNetworkArgs, defaultDenyEgress, egressAllowCsv, egressSocketVolumeName, egressProxyName, proxyEnv } from "./egress.ts";
const spec = { host: "host-test", generation: 0, agent: "ag1", image: "img", env: {}, mounts: [wsMount("/w")] };
test("buildNetworkArgs: empty without resolved egress; DockerSandbox always resolves default-deny", () => {
  assert.deepEqual(buildNetworkArgs("sb-1", spec), []);
  const restricted = defaultDenyEgress(spec);
  assert.deepEqual(restricted.egress, { allow: [] });
  assert.deepEqual(buildNetworkArgs("sb-1", restricted), [
    "--network",
    "none",
    "--mount",
    "type=volume,source=pomtree-egress-socket-sb-1,target=/run/pomtree-egress,readonly",
  ]);
  assert.equal(egressAllowCsv(restricted), "");
});
test("all resolved policies use network-none and a sandbox-specific read-only socket mount", () => {
  for (const egress of [{ allow: [] }, { allow: [{ host: "pypi.org" }] }, { allow: [], auditedPublic: { host: "host", generation: 2 } }]) {
    const args = buildNetworkArgs("sb-1", { ...spec, egress });
    assert.deepEqual(args.slice(0, 2), ["--network", "none"]);
    assert.match(args[3]!, /source=pomtree-egress-socket-sb-1,.*readonly$/);
  }
});
test("proxyEnv: local byte bridge, no Docker DNS or external-network proxy listener", () => {
  assert.deepEqual(proxyEnv("sb-1", spec), {});
  const s = { ...spec, egress: { allow: [] } };
  assert.deepEqual(proxyEnv("sb-1", s), {
    HTTP_PROXY: `http://127.0.0.1:${EGRESS_PROXY_PORT}`,
    HTTPS_PROXY: `http://127.0.0.1:${EGRESS_PROXY_PORT}`,
    http_proxy: `http://127.0.0.1:${EGRESS_PROXY_PORT}`,
    https_proxy: `http://127.0.0.1:${EGRESS_PROXY_PORT}`,
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  });
  // The key set is exactly the image fact the scrubbed in-image pomtree envs pass through.
  assert.deepEqual(Object.keys(proxyEnv("sb-1", s)).sort(), [...PROXY_ENV_NAMES].sort());
});
test("lifecycle names derive from sandbox id, and allow CSV does not include private relay grants", () => {
  const s = { ...spec, egress: { allow: [{ host: "pypi.org" }], relay: [{ host: "host.docker.internal", port: 4321 }] } };
  assert.equal(egressSocketVolumeName("sb-1"), "pomtree-egress-socket-sb-1");
  assert.equal(egressProxyName("sb-1"), "pomtree-egress-proxy-sb-1");
  assert.notEqual(egressSocketVolumeName("sb-1"), egressSocketVolumeName("sb-2"));
  assert.equal(egressAllowCsv(s), "pypi.org:443");
  assert.equal(egressAllowCsv(spec), "");
});
