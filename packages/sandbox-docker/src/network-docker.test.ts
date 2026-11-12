// Real local-Docker gate for the shared egress network (engineGate: Docker plus the agent image's node and proxy; no
// model, no pulls). Creates only `pomtree-test-` named resources and removes them.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerSandbox, type Exec } from "./docker.ts";
import { egressProxyName } from "./egress.ts";
import { engineGate, gateEngine, gateExecFile, gateExecFileSync, gateSandboxDeps, IMAGE, pinnedImage } from "./docker-gate.ts";
import { ICC_OPTION, removeEgressNetwork } from "./network.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

const skip = engineGate();
const docker = (args: string[]) => gateExecFileSync(args, { timeout: 20000 }).trim();
const exec: Exec = (args) =>
  new Promise((resolve, reject) =>
    gateExecFile(args, {}, (err, stdout, stderr) =>
      err ? reject(new Error(`${gateEngine().profile.binary} ${args[0]} failed: ${stderr || err.message}`)) : resolve(stdout.trim()),
    ),
  );

// Runs inside a container: a TCP connect (sending a minimal HTTP request, so an HTTP peer answers too) that prints
// OPEN:<first bytes>, or BLOCKED:<reason> after a bounded wait.
const probe = (host: string, port: number, ms = 3000) =>
  `const s=require('node:net').connect(${port},${JSON.stringify(host)},()=>s.write('GET / HTTP/1.0\\r\\n\\r\\n'));s.setTimeout(${ms},()=>{console.log('BLOCKED:timeout');process.exit(0)});s.once('data',d=>{console.log('OPEN:'+String(d).split('\\r\\n')[0]);process.exit(0)});s.once('error',e=>{console.log('BLOCKED:'+e.code);process.exit(0)})`;
// Async: the host service under test lives in this process, so a synchronous docker exec would block its event loop.
const probeFrom = (container: string, host: string, port: number) => exec(["exec", container, "node", "-e", probe(host, port)]);

test("two sidecars on the shared ICC-off network: policy-path and direct outbound work, sidecar-to-sidecar is blocked", { skip, timeout: 120000 }, async () => {
  const network = `pomtree-test-egress-${randomUUID().slice(0, 8)}`;
  const controlNet = `${network}-icc-on`;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-net-icc-")));
  const work = join(root, "work");
  mkdirSync(work, { mode: 0o755 });
  chmodSync(root, 0o755);
  const server = createServer((_q, res) => res.end("HOST-OK"));
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  const sb = new DockerSandbox({
    ...gateSandboxDeps(),
    mounts: stubMounts(() => work),
    egressProxyImage: pinnedImage(),
    egressNetwork: network,
    startRetries: 0,
    startTimeoutMs: 30000,
  });
  const ids: string[] = [];
  try {
    // The worker (network none) reaches the host service only through its sidecar's policy (an exact relay grant).
    const worker = `fetch('http://host.docker.internal:${port}/').then(r=>r.text()).then(t=>{console.log('RELAY:'+t)}).catch(e=>{console.error(e);process.exit(1)})`;
    const start = (n: number) =>
      sb.start(
        {
          host: "host-test",
          generation: 0,
          agent: "net-gate",
          image: IMAGE,
          env: {},
          mounts: [wsMount("/work")],
          cmd: ["node", "-e", worker],
          egress: { allow: [], relay: [{ host: "host.docker.internal", port }] },
        },
        `net-icc:${network}:${n}`,
      );
    // Concurrent starts race the lazy network creation (one creates, the other sees "already exists" and validates).
    const handles = await Promise.all([start(1), start(2)]);
    for (const h of handles) ids.push(h.id);
    const opts = JSON.parse(docker(["network", "inspect", "--format", "{{json .Options}}", network])) as Record<string, string>;
    assert.equal(opts[ICC_OPTION], "false");
    for (const h of handles) {
      assert.equal((await h.wait()).exitCode, 0);
      let text = "";
      for await (const part of h.output()) text += part.chunk;
      assert.match(text, /RELAY:HOST-OK/);
    }
    const [a, b] = handles.map((h) => egressProxyName(h.id)) as [string, string];
    for (const c of [a, b]) assert.equal(docker(["inspect", "-f", "{{.HostConfig.NetworkMode}}", c]), network);
    const ipA = docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, a]);
    assert.match(ipA, /^\d+\.\d+\.\d+\.\d+$/);
    // A test-only listener inside sidecar A on its shared-network address (the proxy itself listens on no TCP port).
    docker(["exec", "-d", a, "node", "-e", "require('node:net').createServer(s=>s.end('SIDECAR-A')).listen(18080,'0.0.0.0')"]);
    let self = "";
    for (let i = 0; i < 30 && !self.startsWith("OPEN"); i++) {
      self = await probeFrom(a, ipA, 18080);
      if (!self.startsWith("OPEN")) await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(self, "OPEN:SIDECAR-A", "positive control: A's listener answers on its own shared-network address");
    assert.match(await probeFrom(b, ipA, 18080), /^BLOCKED:/, "ICC off: sidecar B cannot reach sidecar A's port");
    assert.match(await probeFrom(b, a, 18080), /^BLOCKED:/, "ICC off: by container name too");
    // Negative control: the same two sidecars on a test network with ICC ON do connect, so the block above is the ICC
    // option and not something inside the sidecars.
    docker(["network", "create", "--label", "pomtree.test=1", controlNet]);
    for (const c of [a, b]) docker(["network", "connect", controlNet, c]);
    const ipAOn = docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${controlNet}").IPAddress}}`, a]);
    assert.equal(await probeFrom(b, ipAOn, 18080), "OPEN:SIDECAR-A", "control: ICC on admits sidecar-to-sidecar");
    for (const c of [a, b]) docker(["network", "disconnect", controlNet, c]);
    docker(["network", "rm", controlNet]);
    // The sidecar's own outbound route (bridge gateway / host alias) is unaffected.
    assert.equal(await probeFrom(b, "host.docker.internal", port), "OPEN:HTTP/1.1 200 OK");
    // Per-sandbox teardown leaves the shared network; only the explicit helper removes it.
    for (const id of ids.splice(0)) await sb.kill(id, `test-kill:${id}`);
    assert.equal(docker(["network", "inspect", "--format", "{{.Name}}", network]), network);
    assert.equal(await removeEgressNetwork(exec, network), true);
    assert.equal(docker(["network", "ls", "-q", "--filter", `name=^${network}$`]), "");
  } finally {
    for (const id of ids) await sb.kill(id, `test-kill:${id}`).catch(() => {});
    await removeEgressNetwork(exec, network).catch(() => {});
    await exec(["network", "rm", controlNet]).catch(() => {});
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
