// Real local-Docker gates. Never pulls/builds images or calls a model/external application.
// Requires the ONE normally rebuilt agent image; unsupported permissions/sandboxing fail honestly.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DEFAULTS } from "@pomtree/core";
import { buildRunArgs, chromiumSeccompProfile, runEnv } from "./args.ts";
import { DockerSandbox } from "./docker.ts";
import { DiskEgressAudit } from "./audit.ts";
import { IMAGE, pinnedImage, gate, gateEngine, gateExecFile, gateExecFileSync, gateSandboxDeps, testEgressNetwork } from "./docker-gate.ts";
import { containerConfigTestEnv, OFFLINE_RELAY_PROBE_EXT, offlineRelayProbeExtMount, stubMounts, wsMount } from "./test-mounts.ts";

const skip = gate();
const egressNetwork = testEgressNetwork();
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-docker-uds-")));
  const work = join(root, "work");
  mkdirSync(work, { mode: 0o755 });
  // Worker uid1000 can traverse this test-only workspace; no world-writable paths.
  chmodSync(root, 0o755);
  const sb = new DockerSandbox({
    ...gateSandboxDeps(),
    mounts: stubMounts(() => work),
    egressProxyImage: pinnedImage(),
    egressAuditRoot: join(root, "audit"),
    egressNetwork,
    startRetries: 0,
    startTimeoutMs: 30000,
  });
  return { root, sb, clean: () => rmSync(root, { recursive: true, force: true }) };
}
async function output(handle: Awaited<ReturnType<DockerSandbox["start"]>>) {
  let text = "";
  for await (const part of handle.output()) text += part.chunk;
  return text;
}
async function wait(handle: Awaited<ReturnType<DockerSandbox["start"]>>, ms = 30000) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      handle.wait(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("local Docker gate timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function spec(cmd: string[], env: Record<string, string> = {}) {
  return { host: "host-test", generation: 0, agent: "local-gate", image: IMAGE, env, mounts: [wsMount("/work")], cmd };
}

test("Docker network-none worker lifecycle uses the packaged bridge and nonroot identity", { skip, timeout: 60000 }, async () => {
  const f = fixture();
  const h = await f.sb.start(spec(["sh", "-c", "echo local-lifecycle; id -u"]), `lifecycle:${Date.now()}`);
  try {
    assert.equal((await wait(h)).exitCode, 0);
    assert.match(await output(h), /local-lifecycle\n1000/);
    assert.equal(gateExecFileSync(["inspect", "-f", "{{.HostConfig.NetworkMode}}", `pomtree-${h.id}`], { timeout: 10000 }).trim(), "none");
  } finally {
    await f.sb.kill(h.id, `test-kill:${h.id}`);
    f.clean();
  }
});

const OOM_ATTEMPTS = 5;

test("Docker wait captures OOM state before cleanup", { skip, timeout: 150000 }, async (t) => {
  // Docker can record a real OOM kill as State.OOMKilled=false with exit 137 under CPU contention (issue #532).
  // Retrying only that exact result lowers the failure rate (about 0.1% per run at a 25% loss rate) but does not remove it,
  // and the product still reports such a kill without oomKilled by decision: oomKilled is advisory and is never inferred from exit 137.
  for (let attempt = 1; attempt <= OOM_ATTEMPTS; attempt++) {
    const f = fixture();
    const h = await f.sb.start(
      { ...spec(["node", "-e", "const a=[];setInterval(()=>a.push(Buffer.alloc(8*1024*1024,1)),5)"]), resources: { memoryBytes: 64 * 1024 ** 2 } },
      `oom:${Date.now()}:${attempt}`,
    );
    try {
      const r = await wait(h);
      if (r.oomKilled !== true && r.exitCode === 137) {
        t.diagnostic(`OOM attempt ${attempt}/${OOM_ATTEMPTS}: exit code ${r.exitCode}, oomKilled ${String(r.oomKilled)}; retrying (issue #532)`);
        continue;
      }
      assert.equal(r.oomKilled, true, `expected an OOM kill, got exit code ${r.exitCode} and oomKilled ${String(r.oomKilled)}`);
      return;
    } finally {
      await f.sb.kill(h.id, `test-kill:${h.id}`);
      f.clean();
    }
  }
  assert.fail(
    `Docker reported exit 137 without OOMKilled on all ${OOM_ATTEMPTS} attempts (the Docker/containerd OOM-event race, issue #532); check host load or the Docker/containerd version; if this repeats on an idle host, suspect the product's OOMKilled read (readState)`,
  );
});

test("real Docker confines TCP/IPv6/DNS/UDP and socket mutation; scoped relay and Node proxy env still work", { skip, timeout: 90000 }, async () => {
  const f = fixture();
  const server = createServer((_q, res) => res.end("LOCAL-ONLY"));
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  const target = `http://host.docker.internal:${port}`;
  const hostAddress =
    Object.values(networkInterfaces())
      .flatMap((v) => v ?? [])
      .find((a) => a.family === "IPv4" && !a.internal)?.address ?? "192.0.2.1";
  const script = `
    const assert=require('node:assert/strict'),net=require('node:net'),os=require('node:os'),fs=require('node:fs'),dns=require('node:dns'),dgram=require('node:dgram');
    const closed=(host,port)=>new Promise((resolve,reject)=>{const s=net.connect({host,port});s.setTimeout(300,()=>{s.destroy();resolve()});s.once('error',()=>resolve());s.once('connect',()=>{s.destroy();reject(Error('direct bypass '+host))})});
    (async()=>{
      assert.ok(Object.values(os.networkInterfaces()).flat().every(a=>!a||a.internal),'non-loopback interface');
      for(const host of [${JSON.stringify(hostAddress)},'169.254.169.254','10.0.0.1','198.18.0.1','fd00::1','2001:db8::1']) await closed(host,${port});
      assert.throws(()=>fs.unlinkSync('/run/pomtree-egress/proxy.sock'),e=>e.code==='EROFS');
      assert.throws(()=>fs.chmodSync('/run/pomtree-egress/proxy.sock',0o666),e=>e.code==='EROFS');
      const resolver=new dns.Resolver({timeout:100,tries:1});resolver.setServers([${JSON.stringify(`${hostAddress}:53535`)}]);
      await new Promise((resolve,reject)=>resolver.resolve4('local-gate.invalid',(e)=>e?resolve():reject(Error('direct DNS succeeded'))));
      await new Promise((resolve,reject)=>{const s=dgram.createSocket('udp4');s.send(Buffer.from('local-only'),53535,${JSON.stringify(hostAddress)},e=>{s.close();e?resolve():reject(Error('direct UDP admitted'))})});
      assert.equal(await (await fetch(${JSON.stringify(target)})).text(),'LOCAL-ONLY');
      try { await fetch('http://169.254.169.254/'); throw Error('metadata admitted'); } catch(e) { if(e.message==='metadata admitted')throw e; }
      console.log('tcp-ipv6-dns-udp-readonly-proxy-ok');
    })().catch(e=>{console.error(e);process.exit(1)});
  `;
  const h = await f.sb.start(
    { ...spec(["node", "-e", script]), egress: { allow: [], relay: [{ host: "host.docker.internal", port }] } },
    `confinement:${Date.now()}`,
  );
  try {
    assert.equal((await wait(h)).exitCode, 0, await output(h));
    assert.match(await output(h), /tcp-ipv6-dns-udp-readonly-proxy-ok/);
    // Sidecar has NO TCP listener, even on its own loopback/external bridge.
    gateExecFileSync(
      [
        "exec",
        `pomtree-egress-proxy-${h.id}`,
        "node",
        "-e",
        "const s=require('node:net').connect(3128,'127.0.0.1');s.once('connect',()=>process.exit(1));s.once('error',()=>process.exit(0));setTimeout(()=>process.exit(1),1000)",
      ],
      { timeout: 5000 },
    );
  } finally {
    await f.sb.kill(h.id, `test-kill:${h.id}`);
    server.closeAllConnections();
    server.close();
    f.clean();
  }
});

test("audited-public Docker: public HTTP/HTTPS fetch is allowed and audited; metadata, private and host aliases are denied and audited; no direct route", {
  skip: skip || (process.getuid?.() === 0 && "audited-public requires unprivileged host uid"),
  timeout: 90000,
}, async () => {
  const f = fixture();
  const script = `
    const assert=require('node:assert/strict'),net=require('node:net'),os=require('node:os');
    const closed=(host,port)=>new Promise((resolve,reject)=>{const s=net.connect({host,port});s.setTimeout(500,()=>{s.destroy();resolve()});s.once('error',()=>resolve());s.once('connect',()=>{s.destroy();reject(Error('direct route '+host))})});
    (async()=>{
      assert.ok(Object.values(os.networkInterfaces()).flat().every(a=>!a||a.internal),'non-loopback interface');
      await closed('1.1.1.1',80);await closed('1.1.1.1',443);
      assert.equal((await fetch('http://example.com/')).status,200);
      assert.equal((await fetch('https://example.com/')).status,200);
      for (const url of ['http://169.254.169.254/','http://10.0.0.1/','http://host.docker.internal:8080/']) {
        let status; try { status=(await fetch(url)).status; } catch { status=0; }
        assert.ok(status===403||status===0,url+' admitted: '+status);
      }
      console.log('public-egress-audited-ok');
    })().catch(e=>{console.error(e);process.exit(1)});
  `;
  const h = await f.sb.start(
    { ...spec(["node", "-e", script]), egress: { allow: [], auditedPublic: { host: "local-host", generation: 2 } } },
    `public-egress:${Date.now()}`,
  );
  try {
    assert.equal((await wait(h, 60000)).exitCode, 0, await output(h));
    assert.match(await output(h), /public-egress-audited-ok/);
    const rows = await new DiskEgressAudit({ root: join(f.root, "audit") }).read(h.id, 0);
    const admission = (authority: string, outcome: string) => rows.some((r) => r.phase === "admission" && r.authority === authority && r.outcome === outcome);
    assert.ok(admission("example.com:80", "allowed"));
    assert.ok(admission("example.com:443", "allowed"));
    for (const authority of ["169.254.169.254:80", "10.0.0.1:80", "host.docker.internal:8080"]) assert.ok(admission(authority, "denied"), authority);
    assert.ok(rows.every((r) => r.agent === "local-gate" && r.host === "local-host" && r.generation === 2));
  } finally {
    await f.sb.kill(h.id, `test-kill:${h.id}`).catch(() => {});
    f.clean();
  }
});

// Chromium has its own proxy listener without relay authorities. The relay authority is the report/model
// relay the sidecar grants on proxy.sock; a page loads only from a public host now, so the page here is a data: document (no network)
// whose script requests that authority, while the real Pi in the same worker calls it through HTTP_PROXY. No page can be served from a
// local host and captured any more: that is the property, and the public-page capture is covered by browser-real-article.test.ts.
test("browser worker: page script is denied and audited at a relay authority that Pi's own call still reaches", {
  skip: skip || (process.getuid?.() === 0 && "audited-public requires unprivileged host uid"),
  timeout: 120000,
}, async () => {
  const f = fixture();
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("relay-ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  const authority = `host.docker.internal:${port}`;
  const h = await f.sb.start(
    {
      ...spec(
        [
          "pi",
          "--mode",
          "json",
          "--provider",
          "pomtree-offline-relay-probe",
          "--model",
          "scripted",
          "--no-extensions",
          "--no-session",
          "--no-skills",
          "--no-context-files",
          "--extension",
          OFFLINE_RELAY_PROBE_EXT,
          "relay probe",
        ],
        {
          ...containerConfigTestEnv(),
          PTREE_BROWSER: "1",
          PTREE_BROWSER_MAX_STEPS: "8",
          PTREE_BROWSER_MAX_MS: "60000",
          PTREE_BROWSER_USER_AGENT: CONFIG_DEFAULTS["workflow.fetch.userAgent"], // the resolved identity pomtreed's browserEnv passes, at the registry default
          PTREE_TEST_RELAY_URL: `http://${authority}`,
          POMTREE_AGENT_ID: "local-gate",
          POMTREE_AGENT_GENERATION: "7",
          POMTREE_API: `http://${authority}`,
          POMTREE_TOKEN: "local-offline-report-token",
        },
      ),
      mounts: [wsMount("/work"), offlineRelayProbeExtMount()],
      egress: { allow: [], relay: [{ host: "host.docker.internal", port }], auditedPublic: { host: "local-host", generation: 7 } },
    },
    `browser:${Date.now()}-${randomUUID()}`,
  );
  try {
    const result = await wait(h, 90000);
    const logs = await output(h);
    assert.equal(result.exitCode, 0, logs);
    // Pi reached the relay through HTTP_PROXY; the page's script ran to completion (its title) and its requests were refused.
    assert.match(logs, /probe pi=200 page=done:/, logs);
    assert.ok(hits.includes("/pi-relay-ok"), "Pi's relay call reached the relay endpoint");
    assert.deepEqual(
      hits.filter((u) => u !== "/pi-relay-ok"),
      [],
      "no page request reached the relay endpoint",
    );
    // The real worker path: Chromium came up under the custom profile with every capability dropped, no sandbox fallback.
    assert.doesNotMatch(logs, /No usable sandbox/);
    const info = JSON.parse(gateExecFileSync(["inspect", `pomtree-${h.id}`], { timeout: 10000 }))[0].HostConfig;
    assert.ok(
      info.SecurityOpt.some((o: string) => o.startsWith("seccomp=")),
      "browser worker runs under the custom profile",
    );
    assert.deepEqual(info.CapDrop, ["ALL"]);
    const disk = new DiskEgressAudit({ root: join(f.root, "audit") });
    const rows = await disk.read(h.id, 0);
    const admission = (a: string, outcome: string) => rows.filter((r) => r.phase === "admission" && r.authority === a && r.outcome === outcome);
    assert.ok(admission(authority, "allowed").length >= 1, "Pi's call through the main listener is an allowed, audited row");
    assert.ok(admission(authority, "denied").length >= 1, "the page's request through the browser listener is a denied, audited row");
    assert.ok(admission("127.0.0.1:9222", "denied").length >= 1, "page-originated loopback CDP request reaches proxy denial, not Chromium's implicit bypass");
    assert.ok(rows.every((r) => r.agent === "local-gate" && r.host === "local-host" && r.generation === 7));
    await f.sb.kill(h.id, `test-kill:${h.id}`);
    assert.ok((await disk.read(h.id, 0)).length >= rows.length, "audit survives cleanup");
  } finally {
    await f.sb.kill(h.id, `test-kill-cleanup:${h.id}`).catch(() => {});
    server.closeAllConnections();
    server.close();
    f.clean();
  }
});

// Chromium itself, not the worker: the browser worker always runs the real Pi (browser-run.ts PI_BIN), so a direct proof that Chromium
// starts under chromiumSeccompProfile() runs the adapter's own buildRunArgs argv for a browser spec with only the entrypoint swapped for
// Chromium. Seccomp, dropped capabilities, no-new-privileges, user and read-only rootfs are therefore the worker's; without an egress spec
// the container keeps Docker's default network and host-gateway alias, so the page is a local host server (no public site, no wording drift).
// The audited-public path with Chromium is covered by the real-Pi capture test above; a public page by browser-real-article.test.ts.
const SECCOMP_PAGE = "<!doctype html><main id=s>static</main><script>document.getElementById('s').textContent='SECCOMP-'+'RENDERED'</script>";
test("Chromium starts under the custom seccomp profile and renders a local page with JavaScript", { skip, timeout: 120000 }, async () => {
  const f = fixture();
  const server = createServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(SECCOMP_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  const id = `chromium-seccomp-${Date.now()}`;
  const s = spec(
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--user-data-dir=/tmp/pomtree-chromium",
      "--dump-dom",
      `http://host.docker.internal:${port}/`,
    ],
    { PTREE_BROWSER: "1" },
  );
  const argv = buildRunArgs(
    id,
    s,
    { mounts: [{ type: "bind", hostPath: join(f.root, "work"), containerPath: "/work", readOnly: false }] },
    gateEngine().profile,
  );
  const sep = argv.indexOf("--");
  const docker = (args: string[], ms: number) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) =>
      // Async so this process's HTTP server keeps serving while the container runs.
      gateExecFile(args, { timeout: ms, env: { ...process.env, ...runEnv(s) } }, (err, stdout, stderr) =>
        err ? reject(Error(`${gateEngine().profile.binary} ${args[0]}: ${stderr || err.message}`)) : resolve({ stdout, stderr }),
      ),
    );
  try {
    await docker([...argv.slice(0, sep), "--entrypoint", "/usr/bin/chromium", ...argv.slice(sep)], 30000);
    const code = (await docker(["wait", `pomtree-${id}`], 60000)).stdout.trim();
    const logs = await docker(["logs", `pomtree-${id}`], 10000);
    assert.equal(code, "0", logs.stderr);
    assert.match(logs.stdout, /<main id="s">SECCOMP-RENDERED<\/main>/, "renderer executed the page's script");
    assert.doesNotMatch(logs.stderr, /No usable sandbox/);
    const info = JSON.parse((await docker(["inspect", `pomtree-${id}`], 10000)).stdout)[0].HostConfig;
    const profile = info.SecurityOpt.find((o: string) => o.startsWith("seccomp="));
    assert.ok(profile, "browser spec runs under a custom seccomp profile");
    assert.deepEqual(
      JSON.parse(profile.slice("seccomp=".length)),
      JSON.parse(readFileSync(chromiumSeccompProfile(), "utf8")),
      "it is chromiumSeccompProfile()",
    );
    assert.deepEqual(info.CapDrop, ["ALL"]);
    assert.ok(info.SecurityOpt.includes("no-new-privileges"));
    assert.equal(info.ReadonlyRootfs, true);
  } finally {
    await docker(["rm", "-f", `pomtree-${id}`], 20000).catch(() => {});
    server.closeAllConnections();
    server.close();
    f.clean();
  }
});
