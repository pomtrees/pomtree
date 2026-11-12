// Real rootless-Podman gate for the egress path (engineGate on the podman backend: Podman plus the agent image's node and proxy; no model, no
// pulls). Drives the real DockerSandbox adapter code path (no hand-written podman argv); the only seam is an execFile wrapper that adds the
// `pomtree-test=1` label (and a per-run label) to every container and volume the adapter creates, because spec.labels reserves the `pomtree`
// prefix. Run: PTREE_DOCKER_TESTS=1 PTREE_SANDBOX_BACKEND=podman (CONTAINER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock) PTREE_AGENT_TEST_IMAGE=<tag>.
// Every denial below is paired with a control that reaches the same listener through a grant, so a denial cannot be an unreachable listener;
// each listener also counts the requests it received, so a denied request is shown never to have arrived.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { lookup } from "node:dns/promises";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxEgress } from "@pomtree/core";
import { emptyManifest } from "../../agent-image/src/manifest.ts";
import { egressPolicy } from "../../pomtreed/src/egress.ts";
import { DockerSandbox, type Exec, type ExecFileFn } from "./docker.ts";
import { EGRESS_PROXY_PORT } from "./container-contract.gen.ts";
import { egressProxyName, egressSocketVolumeName, EGRESS_PROXY_MEMORY_BYTES, EGRESS_SOCKET_PATH } from "./egress.ts";
import { engineGate, gateBackend, gateEngine, gateExecFile, gateExecFileSync, gateSandboxDeps, IMAGE, optInSkip, pinnedImage } from "./docker-gate.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

// Podman-only: the Docker egress path has its own suite (network-docker.test.ts). Opt-in first, then the backend, then the engine (engineGate
// verifies the answering engine identifies as the requested backend and throws on a mismatch).
const skip: string | false =
  optInSkip() ||
  (gateBackend() !== "podman"
    ? `PTREE_SANDBOX_BACKEND is ${gateBackend()}; this suite needs rootless Podman (set PTREE_SANDBOX_BACKEND=podman)`
    : engineGate());

const RUN = randomUUID().slice(0, 8);
const TEST_LABELS = ["--label", "pomtree-test=1", "--label", `pomtree-test-run=${RUN}`];
// The adapter's own argv, plus the test labels on the commands that create a container or a volume.
const labelledExecFile: ExecFileFn = (file, args, options, callback) => {
  const at = args[0] === "run" ? 1 : args[0] === "volume" && args[1] === "create" ? 2 : 0;
  return execFile(file, at ? [...args.slice(0, at), ...TEST_LABELS, ...args.slice(at)] : args, options, callback);
};

const cli = (args: string[]) => gateExecFileSync(args, { timeout: 20000 }).trim();
const exec: Exec = (args) =>
  new Promise((resolve, reject) =>
    gateExecFile(args, {}, (err, stdout, stderr) =>
      err ? reject(new Error(`${gateEngine().profile.binary} ${args[0]} failed: ${stderr || err.message}`)) : resolve(stdout.trim()),
    ),
  );
const swept = () => ({
  containers: cli(["ps", "-a", "-q", "--filter", `label=pomtree-test-run=${RUN}`]),
  volumes: cli(["volume", "ls", "-q", "--filter", `label=pomtree-test-run=${RUN}`]),
});
after(() => {
  if (skip) return;
  // Safety net for a failed assertion: only this run's labelled resources.
  try {
    const { containers, volumes } = swept();
    for (const c of containers.split("\n").filter(Boolean)) cli(["rm", "-f", c]);
    for (const v of volumes.split("\n").filter(Boolean)) cli(["volume", "rm", "-f", v]);
  } catch {
    /* nothing left to reap */
  }
});

type Handle = Awaited<ReturnType<DockerSandbox["start"]>>;

interface Listener {
  server: Server;
  port: number;
  hits: string[];
}
async function listen(host: string, label: string): Promise<Listener> {
  const hits: string[] = [];
  const server = createServer((q, res) => {
    hits.push(`${q.method} ${q.url}`);
    res.end(`HOST-OK-${label}`);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return { server, port: (server.address() as AddressInfo).port, hits };
}

// This host's own addresses a pasta container also sees as its own: the LAN address and, when Docker is installed, docker0.
const v4 = (name: string) => networkInterfaces()[name]?.find((a) => a.family === "IPv4")?.address;
const lanAddress = (): string | undefined =>
  Object.entries(networkInterfaces())
    .filter(([n]) => !/^(lo|docker0|br-|veth|cni|podman|virbr)/.test(n))
    .flatMap(([, a]) => a ?? [])
    .find((a) => a.family === "IPv4" && !a.internal)?.address;

// Inside a container: a TCP connect that sends a minimal HTTP request; prints OPEN:<status line> or BLOCKED:<reason> after a bounded wait.
const probe = (host: string, port: number, ms = 3000) =>
  `const s=require('node:net').connect(${port},${JSON.stringify(host)},()=>s.write('GET / HTTP/1.0\\r\\n\\r\\n'));s.setTimeout(${ms},()=>{console.log('BLOCKED:timeout');process.exit(0)});s.once('data',d=>{console.log('OPEN:'+String(d).split('\\r\\n')[0]);process.exit(0)});s.once('error',e=>{console.log('BLOCKED:'+e.code);process.exit(0)})`;
const probeFrom = (container: string, host: string, port: number) => exec(["exec", container, "node", "-e", probe(host, port)]);

// Worker-side fetch helper: resolves to "<status>:<body>"; a proxy refusal (the worker's fetch tunnels through CONNECT, so a denial surfaces as
// an error carrying "Proxy response (403)") is reported as "403:proxy-denied", and any other failure as "ERR:<code>".
const FETCH_JS = `const F=async(u,o)=>{try{const r=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(10000),...o});return r.status+':'+(await r.text()).trim().slice(0,24)}catch(e){const m=[e,e.cause,e.cause&&e.cause.cause].map(x=>(x&&x.message)||'').join(' ');const p=/Proxy response \\((\\d+)\\)/.exec(m);return p?p[1]+':proxy-denied':'ERR:'+((e.cause&&e.cause.code)||e.name)}};`;
// Worker-side request that always goes THROUGH the egress proxy bridge (absolute-form to 127.0.0.1:3128, the port the worker's proxy env names),
// which fetch does not do for 127.0.0.1 because NO_PROXY exempts it. Resolves to "<status>:<body>" like F.
const PROXIED_JS = `const P=(u)=>new Promise(r=>{const x=new URL(u);const q=require('node:http').request({host:'127.0.0.1',port:${EGRESS_PROXY_PORT},method:'GET',path:u,headers:{host:x.host}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>r(res.statusCode+':'+b.trim().slice(0,24)))});q.setTimeout(10000,()=>{q.destroy();r('ERR:timeout')});q.on('error',e=>r('ERR:'+e.code));q.end()});`;
// The worker script: fetch each URL (through the sidecar, the worker has no network of its own) and print `RESULT:{url: "<status>:<body>"}`.
const fetchScript = (urls: string[], through: boolean) =>
  `${FETCH_JS}${PROXIED_JS}const urls=${JSON.stringify(urls)};(async()=>{const out={};for(const u of urls)out[u]=await ${through ? "P" : "F"}(u);console.log('RESULT:'+JSON.stringify(out))})()`;

async function text(h: Handle): Promise<string> {
  let out = "";
  for await (const part of h.output()) out += part.chunk;
  return out;
}

interface Rig {
  sb: DockerSandbox;
  start(egress: SandboxEgress, cmd: string[], n?: string): Promise<Handle>;
  run(egress: SandboxEgress, cmd: string[]): Promise<{ handle: Handle; out: string; exitCode: number }>;
  fetches(egress: SandboxEgress, urls: string[], through?: boolean): Promise<Record<string, string>>;
  loopback: Listener; // 127.0.0.1 only
  wildcard: Listener; // 0.0.0.0
}

// One sandbox adapter, two host listeners and a work directory; every started sandbox is killed in the finally.
async function withRig(fn: (rig: Rig) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-net-podman-")));
  const work = join(root, "work");
  mkdirSync(work, { mode: 0o755 });
  chmodSync(root, 0o755);
  const loopback = await listen("127.0.0.1", "L");
  const wildcard = await listen("0.0.0.0", "W");
  const sb = new DockerSandbox({
    ...gateSandboxDeps(),
    execFile: labelledExecFile,
    mounts: stubMounts(() => work),
    egressProxyImage: pinnedImage(),
    startRetries: 0,
    startTimeoutMs: 60000,
  });
  const ids: string[] = [];
  let n = 0;
  const start = async (egress: SandboxEgress, cmd: string[], tag = `s${n++}`) => {
    const h = await sb.start(
      { host: "host-test", generation: 0, agent: "net-podman", image: IMAGE, env: {}, mounts: [wsMount("/work")], cmd, egress },
      `net-podman:${RUN}:${tag}`,
    );
    ids.push(h.id);
    return h;
  };
  const run: Rig["run"] = async (egress, cmd) => {
    const handle = await start(egress, cmd);
    const exitCode = (await handle.wait()).exitCode;
    return { handle, out: await text(handle), exitCode };
  };
  const fetches: Rig["fetches"] = async (egress, urls, through = false) => {
    const r = await run(egress, ["node", "-e", fetchScript(urls, through)]);
    assert.equal(r.exitCode, 0, r.out);
    return JSON.parse(/RESULT:(.*)/.exec(r.out)![1]!) as Record<string, string>;
  };
  try {
    await fn({ sb, start, run, fetches, loopback, wildcard });
  } finally {
    for (const id of ids) await sb.kill(id, `test-kill:${id}`).catch(() => {});
    for (const l of [loopback, wildcard]) {
      l.server.closeAllConnections();
      l.server.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const sidecarOf = (h: Handle) => egressProxyName(h.id);
const workerOf = (h: Handle) => `pomtree-${h.id}`;

const publicReachable = async (): Promise<boolean> => {
  try {
    await lookup("example.com");
    const r = await fetch("http://example.com/", { signal: AbortSignal.timeout(8000), redirect: "manual" });
    return r.status === 200;
  } catch {
    return false;
  }
};
const noPublic = async (): Promise<string | false> =>
  (await publicReachable())
    ? false
    : "http://example.com/ is unreachable from this host; the public-host checks need one plain request to it (environment limit)";

test("the engine under test is rootless Podman", { skip, timeout: 60000 }, () => {
  assert.equal(gateEngine().profile.id, "podman");
  const info = JSON.parse(cli(["info", "--format", "json"])) as {
    host: { security: { rootless: boolean }; rootlessNetworkCmd: string };
    version: { Version: string };
  };
  assert.equal(info.host.security.rootless, true);
  assert.equal(info.host.rootlessNetworkCmd, "pasta");
});

test("E1/E2 worker has only lo; the socket volume is 1000:1000 mode 0770 and read-only (EROFS); the sidecar socket is ready", {
  skip,
  timeout: 120000,
}, async () => {
  await withRig(async ({ run }) => {
    const dir = EGRESS_SOCKET_PATH.slice(0, EGRESS_SOCKET_PATH.lastIndexOf("/"));
    const script = `
      const fs=require('node:fs'),os=require('node:os'),net=require('node:net');
      const out={};
      out.ifaces=Object.entries(os.networkInterfaces()).filter(([,a])=>a.some(x=>!x.internal)).map(([n])=>n);
      const st=fs.statSync(${JSON.stringify(dir)});out.dir=[st.uid,st.gid,(st.mode&0o7777).toString(8)];
      out.socket=fs.statSync(${JSON.stringify(EGRESS_SOCKET_PATH)}).isSocket();
      const code=(f)=>{try{f();return 'ALLOWED'}catch(e){return e.code}};
      out.create=code(()=>fs.writeFileSync(${JSON.stringify(dir)}+'/x','1'));
      out.mkdir=code(()=>fs.mkdirSync(${JSON.stringify(dir)}+'/d'));
      out.unlink=code(()=>fs.unlinkSync(${JSON.stringify(EGRESS_SOCKET_PATH)}));
      out.chmod=code(()=>fs.chmodSync(${JSON.stringify(EGRESS_SOCKET_PATH)},0o666));
      const direct=(h,p)=>new Promise(r=>{const s=net.connect({host:h,port:p});s.setTimeout(1500,()=>{s.destroy();r('blocked')});s.once('error',e=>r('blocked'));s.once('connect',()=>{s.destroy();r('CONNECTED')})});
      (async()=>{out.direct=[await direct('1.1.1.1',80),await direct('169.254.1.2',80),await direct('10.0.2.2',80)];console.log('RESULT:'+JSON.stringify(out))})();`;
    const r = await run({ allow: [] }, ["node", "-e", script]);
    assert.equal(r.exitCode, 0, r.out);
    const out = JSON.parse(/RESULT:(.*)/.exec(r.out)![1]!);
    assert.deepEqual(out.ifaces, [], "E1: no non-loopback interface");
    assert.deepEqual(out.direct, ["blocked", "blocked", "blocked"], "E1: no direct route to a public or host address");
    assert.equal(cli(["inspect", "-f", "{{.HostConfig.NetworkMode}}", workerOf(r.handle)]), "none");
    assert.deepEqual(out.dir, [1000, 1000, "770"], "E2: socket volume owner and mode");
    assert.equal(out.socket, true, "E2: the sidecar's socket exists in the worker's view");
    for (const op of ["create", "mkdir", "unlink", "chmod"]) assert.equal(out[op], "EROFS", `E2: ${op} on the read-only volume`);
    // Sidecar start evidence: the proxy's startup check (socket directory owner equals the user it runs as, under keep-id) passed on real Podman
    // when the sidecar is still running and its socket answers a connect from inside it (the adapter's own readiness probe says the same at start).
    const sc = sidecarOf(r.handle);
    assert.equal(cli(["inspect", "-f", "{{.State.Running}}", sc]), "true", "the sidecar is running, so its startup ownership check passed");
    assert.equal(
      await exec([
        "exec",
        sc,
        "node",
        "-e",
        `require('node:net').connect(${JSON.stringify(EGRESS_SOCKET_PATH)},function(){console.log('SOCKET-ANSWERS');process.exit(0)}).on('error',function(e){console.log('SOCKET-'+e.code);process.exit(0)})`,
      ]),
      "SOCKET-ANSWERS",
    );
    assert.equal(cli(["inspect", "-f", "{{.Config.User}}", sidecarOf(r.handle)]).split(":")[1], "1000", "sidecar shares gid 1000 with the worker");
  });
});

test("E3 the sidecar reaches an allowed public host (one plain request to example.com), a worker gets it only through the proxy", {
  skip: skip || (await noPublic()),
  timeout: 120000,
}, async () => {
  await withRig(async ({ start, fetches }) => {
    const keep = await start({ allow: [{ host: "example.com", port: 80 }] }, ["sleep", "60"]);
    assert.match(
      await probeFrom(sidecarOf(keep), "example.com", 80),
      /^OPEN:HTTP\/1\.[01] \d{3}/,
      "the sidecar's own route to the allowed host (any HTTP answer: the origin may refuse a header-less request)",
    );
    const r = await fetches({ allow: [{ host: "example.com", port: 80 }] }, ["http://example.com/"]);
    assert.match(r["http://example.com/"]!, /^200:/);
  });
});

test("E4 a relay grant on host.docker.internal reaches a host listener bound only to 127.0.0.1", { skip, timeout: 120000 }, async () => {
  await withRig(async ({ fetches, loopback, wildcard }) => {
    const url = (p: number) => `http://host.docker.internal:${p}/`;
    const r = await fetches(
      {
        allow: [],
        relay: [
          { host: "host.docker.internal", port: loopback.port },
          { host: "host.docker.internal", port: wildcard.port },
        ],
      },
      [url(loopback.port), url(wildcard.port)],
    );
    assert.equal(r[url(loopback.port)], "200:HOST-OK-L");
    assert.equal(r[url(wildcard.port)], "200:HOST-OK-W");
    assert.equal(loopback.hits.length, 1);
    assert.equal(wildcard.hits.length, 1);
  });
});

test("E5 allow: [] denies the public host, 169.254.1.2, the LAN address, docker0 and 127.0.0.1 at the proxy (and they stay denied beside a relay grant)", {
  skip,
  timeout: 180000,
}, async (t) => {
  await withRig(async ({ fetches, loopback, wildcard }) => {
    const lan = lanAddress();
    const docker0 = v4("docker0");
    if (!lan)
      return t.skip(
        "E5 needs a non-loopback IPv4 address on a LAN-class interface (not docker0, br-*, veth*, podman*, virbr*) to prove the host's own address is denied; this host has none (environment limit), so connect a network to run it",
      );
    // Every request goes through the proxy bridge explicitly (fetchScript through=true): fetch would send 127.0.0.1 to the worker's own loopback (NO_PROXY).
    const targets = [
      "http://example.com/",
      `http://169.254.1.2:${loopback.port}/`,
      `http://169.254.1.2:${wildcard.port}/`,
      `http://${lan}:${wildcard.port}/`,
      `http://127.0.0.1:${loopback.port}/`,
      `http://host.docker.internal:${loopback.port}/`,
      ...(docker0 ? [`http://${docker0}:${wildcard.port}/`] : []),
    ];
    const denied = await fetches({ allow: [] }, targets, true);
    for (const t of targets) assert.match(denied[t]!, /^403:/, `denied by the proxy: ${t} (got ${denied[t]})`);
    assert.equal(loopback.hits.length + wildcard.hits.length, 0, "no denied request reached a host listener");
    // Separate assertion: a plain fetch to 127.0.0.1 never leaves the worker (NO_PROXY), so it only reaches the worker's own empty loopback.
    const own = await fetches({ allow: [] }, [`http://127.0.0.1:${loopback.port}/`]);
    assert.match(own[`http://127.0.0.1:${loopback.port}/`]!, /^ERR:ECONNREFUSED/, "worker loopback is not the host's");
    // Control (the negative control for every denial above): a relay grant reaches the very same listeners through
    // host.docker.internal by the same proxied path, so they were reachable, and every other address of the host stays denied beside the grant.
    const via = `http://host.docker.internal:${loopback.port}/`;
    const viaW = `http://host.docker.internal:${wildcard.port}/`;
    const others = targets.filter((x) => !x.startsWith("http://host.docker.internal"));
    const granted = await fetches(
      {
        allow: [],
        relay: [
          { host: "host.docker.internal", port: loopback.port },
          { host: "host.docker.internal", port: wildcard.port },
        ],
      },
      [via, viaW, ...others],
      true,
    );
    assert.equal(granted[via], "200:HOST-OK-L", "control: the loopback listener answers through its relay grant");
    assert.equal(granted[viaW], "200:HOST-OK-W");
    for (const t of others) assert.match(granted[t]!, /^403:/, `still denied beside a relay: ${t}`);
    assert.equal(loopback.hits.length, 1);
    assert.equal(wildcard.hits.length, 1);
  });
});

test("E6 an allow grant admits exactly host:port; another port, another host and an IP literal are denied", {
  skip: skip || (await noPublic()),
  timeout: 180000,
}, async () => {
  await withRig(async ({ fetches }) => {
    const ip = (await lookup("example.com", { family: 4 })).address;
    const targets = ["http://example.com/", "http://example.com:8080/", "http://example.org/", `http://${ip}/`];
    const r = await fetches({ allow: [{ host: "example.com", port: 80 }] }, targets);
    assert.match(r["http://example.com/"]!, /^200:/, "control: the granted host:port works");
    for (const t of targets.slice(1)) assert.match(r[t]!, /^403:/, `denied: ${t} (got ${r[t]})`);
  });
});

test("E7 two sidecars cannot reach each other (pasta isolation)", { skip, timeout: 180000 }, async () => {
  await withRig(async ({ start, wildcard }) => {
    const grant: SandboxEgress = { allow: [] };
    const [a, b] = await Promise.all([start(grant, ["sleep", "120"]), start(grant, ["sleep", "120"])]);
    const [sa, sb2] = [sidecarOf(a), sidecarOf(b)];
    const port = 18081;
    await exec(["exec", "-d", sa, "node", "-e", `require('node:net').createServer(s=>s.end('SIDECAR-A')).listen(${port},'0.0.0.0')`]);
    let own = "";
    for (let i = 0; i < 30 && !own.startsWith("OPEN"); i++) {
      own = await probeFrom(sa, "127.0.0.1", port);
      if (!own.startsWith("OPEN")) await new Promise((r) => setTimeout(r, 200));
    }
    assert.match(own, /^OPEN:/, "control: A's listener answers inside A");
    const addresses = ["169.254.1.2", lanAddress(), v4("docker0")].filter((x): x is string => x !== undefined);
    for (const addr of addresses) assert.match(await probeFrom(sb2, addr, port), /^BLOCKED:/, `B cannot reach A's listener at ${addr}`);
    // Control: B's own network does reach the host (the mapped loopback alias to the 0.0.0.0 listener), so BLOCKED is isolation.
    assert.match(await probeFrom(sb2, "169.254.1.2", wildcard.port), /^OPEN:HTTP\/1\.1 200/, "control: B reaches a host listener");
  });
});

test("E8 killing a sandbox leaves no container or volume behind", { skip, timeout: 120000 }, async () => {
  await withRig(async ({ sb, start }) => {
    const h = await start({ allow: [] }, ["sleep", "120"], "cleanup");
    assert.notEqual(cli(["ps", "-a", "-q", "--filter", `label=pomtree-test-run=${RUN}`]), "");
    assert.equal(cli(["volume", "ls", "-q", "--filter", `name=^${egressSocketVolumeName(h.id)}$`]), egressSocketVolumeName(h.id));
    await sb.kill(h.id, `test-kill:${h.id}`);
    assert.deepEqual(swept(), { containers: "", volumes: "" });
    assert.equal(cli(["ps", "-a", "-q", "--filter", "label=pomtree-test=1", "--filter", `label=pomtree-test-run=${RUN}`]), "");
  });
});

test("E9 the sidecar's memory and pids limits are enforced by the rootless cgroup", { skip, timeout: 120000 }, async () => {
  await withRig(async ({ start }) => {
    const h = await start({ allow: [] }, ["sleep", "60"]);
    const sc = sidecarOf(h);
    assert.equal(Number(cli(["inspect", "-f", "{{.HostConfig.Memory}}", sc])), EGRESS_PROXY_MEMORY_BYTES);
    assert.equal(Number(cli(["inspect", "-f", "{{.HostConfig.PidsLimit}}", sc])), 64);
    const cg = await exec([
      "exec",
      sc,
      "node",
      "-e",
      "const f=require('node:fs');console.log(['memory.max','pids.max'].map(n=>f.readFileSync('/sys/fs/cgroup/'+n,'utf8').trim()).join(' '))",
    ]);
    assert.equal(cg, `${EGRESS_PROXY_MEMORY_BYTES} 64`, "the limits are in the container's own cgroup, not only in its config");
  });
});

test("an untemplated spawn under agent.untemplatedEgress registry reaches the model-proxy listener and nothing else", { skip, timeout: 180000 }, async () => {
  await withRig(async ({ run, loopback, wildcard }) => {
    // The sandbox egress pomtreed derives for `registry` with an empty manifest: no registry host, the model proxy as relay (and allow).
    const egress = egressPolicy({ policy: { kind: "registry" }, manifest: emptyManifest(), modelBaseUrl: `http://host.docker.internal:${loopback.port}/v1` });
    assert.deepEqual(egress.relay, [{ host: "host.docker.internal", port: loopback.port }]);
    const model = `http://host.docker.internal:${loopback.port}/v1/messages`;
    const other = `http://host.docker.internal:${wildcard.port}/`;
    const script = `${FETCH_JS}(async()=>{const r=await F(${JSON.stringify(model)},{method:'POST',body:'{"model":"stub"}'});const o=await F(${JSON.stringify(other)});console.log('RESULT:'+r+'|'+o)})()`;
    const r = await run(egress, ["node", "-e", script]);
    assert.equal(r.exitCode, 0, r.out);
    assert.match(r.out, /RESULT:200:HOST-OK-L\|403:proxy-denied/);
    assert.deepEqual(loopback.hits, ["POST /v1/messages"], "the stub model received exactly the model call");
    assert.equal(wildcard.hits.length, 0, "a second host port the policy never named was not reached");
  });
});
