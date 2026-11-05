import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "node:test";
import type { Daemon } from "@pomtree/pomtreed";
import { listenAgentEndpoint } from "./agent-endpoint.ts";

const daemon = {} as Daemon;

function fakeBind(opts: { failOn?: number } = {}) {
  const calls: { host: string; port: number }[] = [];
  const closed: number[] = [];
  const bind = async (host: string, port: number) => {
    const n = calls.length;
    calls.push({ host, port });
    if (opts.failOn === n) throw new Error("EADDRNOTAVAIL");
    const server = { close: () => closed.push(n) } as unknown as Server;
    return { server, port: port || 4321 };
  };
  return { bind, calls, closed };
}

test("linux with a detected gateway binds the gateway, then loopback on the same port", async () => {
  const f = fakeBind();
  const ep = await listenAgentEndpoint(daemon, {
    platform: "linux",
    detect: async () => "172.17.0.1",
    listen: "",
    bind: f.bind,
    warn: () => assert.fail("no warning"),
  });
  assert.deepEqual(f.calls, [
    { host: "172.17.0.1", port: 0 },
    { host: "127.0.0.1", port: 4321 },
  ]);
  assert.equal(ep.apiUrl, "http://host.docker.internal:4321");
  assert.equal(ep.port, 4321);
  assert.deepEqual(ep.hosts, ["172.17.0.1", "127.0.0.1"]);
});

test("linux with no detectable gateway binds loopback and warns once", async () => {
  const f = fakeBind();
  const warnings: string[] = [];
  await listenAgentEndpoint(daemon, { platform: "linux", detect: async () => undefined, listen: "", bind: f.bind, warn: (m) => warnings.push(m) });
  assert.deepEqual(f.calls, [{ host: "127.0.0.1", port: 0 }]);
  assert.equal(warnings.length, 1);
});

test("darwin binds loopback and never runs gateway detection", async () => {
  const f = fakeBind();
  await listenAgentEndpoint(daemon, {
    platform: "darwin",
    detect: async () => assert.fail("detect must not run off Linux"),
    listen: "",
    bind: f.bind,
  });
  assert.deepEqual(f.calls, [{ host: "127.0.0.1", port: 0 }]);
});

test("an explicit listen override binds exactly that host and port", async () => {
  const f = fakeBind();
  const ep = await listenAgentEndpoint(daemon, { platform: "linux", detect: async () => "172.17.0.1", listen: "10.0.0.5:4555", bind: f.bind });
  assert.deepEqual(f.calls, [{ host: "10.0.0.5", port: 4555 }]);
  assert.equal(ep.apiUrl, "http://host.docker.internal:4555");
});

test("listen=off is refused with the cause and the action", async () => {
  const f = fakeBind();
  await assert.rejects(
    listenAgentEndpoint(daemon, { platform: "linux", detect: async () => "172.17.0.1", listen: "off", bind: f.bind }),
    /POMTREED_AGENT_LISTEN/,
  );
  assert.equal(f.calls.length, 0);
});

test("close() closes every bound server", async () => {
  const f = fakeBind();
  const ep = await listenAgentEndpoint(daemon, { platform: "linux", detect: async () => "172.17.0.1", listen: "", bind: f.bind });
  assert.deepEqual(f.closed, []);
  ep.close();
  assert.deepEqual(f.closed, [0, 1]);
});

test("negative control: a failing extra bind closes the first server and rethrows", async () => {
  const f = fakeBind({ failOn: 1 });
  await assert.rejects(listenAgentEndpoint(daemon, { platform: "linux", detect: async () => "172.17.0.1", listen: "", bind: f.bind }), /EADDRNOTAVAIL/);
  assert.deepEqual(f.closed, [0]);
});
