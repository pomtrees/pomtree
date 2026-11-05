import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type AddressInfo } from "node:net";
import { attachByteBridge } from "./worker.ts";

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function openClient(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
}

// Resolves with the bytes received once the socket closes or ends. A reset counts as closed.
function drainUntilClosed(s: Socket): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    s.on("data", (d) => (data += d.toString()));
    s.once("error", () => {});
    s.once("close", () => resolve(data));
  });
}

function echoOnce(s: Socket, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const onData = (d: Buffer) => {
      data += d.toString();
      if (data.length >= text.length) {
        s.off("data", onData);
        resolve(data);
      }
    };
    s.on("data", onData);
    s.once("error", reject);
    s.write(text);
  });
}

test("byte bridge caps client connections at 32 (33rd destroyed before dialing upstream); slots free after close", { timeout: 15000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-cap-")));
  const upstreamPath = join(root, "up.sock");
  const upstreamLive = new Set<Socket>();
  let upstreamTotal = 0;
  const upstream: Server = createServer((s) => {
    upstreamTotal++;
    upstreamLive.add(s);
    s.on("close", () => upstreamLive.delete(s));
    s.on("error", () => {});
    s.on("data", (d) => s.write(d));
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamPath, resolve));
  const bridge = attachByteBridge(upstreamPath, 0);
  await bridge.listen();
  const { port } = bridge.server.address() as AddressInfo;
  const clients: Socket[] = [];
  try {
    // Fill all 32 slots; each must be bridged end to end.
    for (let i = 0; i < 32; i++) {
      const c = await openClient(port);
      clients.push(c);
      assert.equal(await echoOnce(c, `c${i}`), `c${i}`);
    }
    await waitFor(() => upstreamLive.size === 32, "32 live upstream sockets");

    // The 33rd client is destroyed: no bytes relayed, and no upstream dial happens.
    const extra = await openClient(port);
    const extraClosed = drainUntilClosed(extra);
    extra.write("overflow");
    const extraData = await Promise.race([
      extraClosed,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("33rd client was not closed")), 3000)),
    ]);
    assert.equal(extraData, "");
    assert.equal(upstreamTotal, 32, "33rd client must not dial upstream");
    assert.equal(upstreamLive.size, 32);

    // Freeing one slot lets a new client through again.
    clients[0]?.destroy();
    await waitFor(() => upstreamLive.size === 31, "upstream count to drop to 31");
    const again = await openClient(port);
    clients.push(again);
    assert.equal(await echoOnce(again, "again"), "again");
    assert.equal(upstreamTotal, 33);
    assert.equal(upstreamLive.size, 32);
  } finally {
    for (const c of clients) c.destroy();
    bridge.close();
    for (const s of upstreamLive) s.destroy();
    upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
});
