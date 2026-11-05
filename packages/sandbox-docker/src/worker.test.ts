import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, request, type IncomingMessage, type RequestOptions } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { attachProxy } from "./proxy.ts";
import { attachByteBridge } from "./worker.ts";
import type { EgressAuditEvent } from "./audit.ts";

test("real loopback byte bridge -> private UDS -> same audited parser; actual Node24 fetch/http obey proxy env", { timeout: 10000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-uds-")));
  const path = join(root, "s");
  const upstream = createServer((_q, res) => res.end("LOCAL-FIXTURE"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upPort = (upstream.address() as AddressInfo).port;
  const events: EgressAuditEvent[] = [];
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    auditedPublic: {
      append: (e) => {
        events.push(e);
      },
    },
    resolve: async () => ["8.8.8.8"],
    connect: (_port, ip) => {
      assert.equal(ip, "8.8.8.8");
      return connect(upPort, "127.0.0.1");
    },
    request: ((options: RequestOptions, callback: (res: IncomingMessage) => void) =>
      request({ ...options, host: "127.0.0.1", port: upPort }, callback)) as typeof request,
  });
  await new Promise<void>((resolve) => proxy.listen(path, resolve));
  const bridge = attachByteBridge(path, 0);
  await bridge.listen();
  const address = bridge.server.address() as AddressInfo;
  assert.equal(address.address, "127.0.0.1");
  assert.equal(typeof proxy.address(), "string", "proxy has no TCP listener");
  try {
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        [
          "-e",
          `
      const http = require('node:http');
      (async () => {
        const a = await fetch('http://fixture.invalid/page');
        if (await a.text() !== 'LOCAL-FIXTURE') throw Error('fetch proxy failed');
        console.log('fetch-ok');
        await new Promise((resolve,reject) => http.get('http://fixture.invalid/other', r => {
          let b='';r.on('data',d=>b+=d);r.on('end',()=>b==='LOCAL-FIXTURE'?resolve():reject(Error('http proxy failed')));
        }).on('error',reject));
        console.log('http-ok');
        let denied = false;
        try { denied = (await fetch('http://169.254.169.254/metadata')).status === 403; } catch { denied = true; }
        if (!denied) throw Error('metadata not denied');
        console.log('fetch+http+deny-ok');
      })().catch(e=>{console.error(e.message);process.exit(1)});
    `,
        ],
        {
          timeout: 5000,
          env: {
            PATH: process.env.PATH,
            HTTP_PROXY: `http://127.0.0.1:${address.port}`,
            HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
            NO_PROXY: "",
            NODE_USE_ENV_PROXY: "1",
          },
        },
        (err, stdout, stderr) => (err ? reject(new Error(`${err.message}: stdout=${stdout}; stderr=${stderr}`)) : resolve(stdout)),
      ),
    );
    assert.match(stdout, /fetch\+http\+deny-ok/);
    assert.equal(events.filter((e) => e.phase === "admission" && e.outcome === "allowed").length, 2);
    assert.ok(events.some((e) => e.outcome === "denied"));
  } finally {
    bridge.close();
    control.close();
    proxy.closeAllConnections();
    proxy.close();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// The bridge owns no limits (the sidecar proxy does, per traffic class): a quiet connection outlives the old 60 s idle and 120 s
// absolute bridge timers. mock.timers covers the global setTimeout the absolute timer used; the idle timer was a socket timeout,
// which mock.timers cannot drive, so the test asserts no socket timeout is armed on either end.
test("the byte bridge never times out a quiet connection", { timeout: 10000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-uds-")));
  const path = join(root, "s");
  const echo = createNetServer((s) => {
    s.on("error", () => {});
    s.pipe(s);
  });
  await new Promise<void>((resolve) => echo.listen(path, resolve));
  mock.timers.enable({ apis: ["setTimeout"] });
  const bridge = attachByteBridge(path, 0);
  await bridge.listen();
  const accepted: Socket[] = [];
  bridge.server.on("connection", (s) => accepted.push(s));
  const client = connect((bridge.server.address() as AddressInfo).port, "127.0.0.1");
  client.on("error", () => {});
  try {
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write("a");
    await new Promise<void>((resolve) => client.once("data", () => resolve()));
    mock.timers.tick(10 * 60_000);
    assert.equal(client.destroyed, false);
    assert.equal(accepted[0]?.timeout, undefined, "no idle timeout on the bridge's client end");
    client.write("b");
    const [echoed] = await new Promise<Buffer[]>((resolve) => client.once("data", (d: Buffer) => resolve([d])));
    assert.equal(echoed?.toString(), "b");
  } finally {
    mock.timers.reset();
    client.destroy();
    bridge.close();
    echo.close();
    rmSync(root, { recursive: true, force: true });
  }
});
