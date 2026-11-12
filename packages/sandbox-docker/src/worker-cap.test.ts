import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type AddressInfo } from "node:net";
import { createConnectTerminator } from "@pomtree/sandbox-kit/terminate";
import { until } from "@pomtree/testing";
import { BRIDGE_MAX_CONNECTIONS, attachByteBridge } from "./worker.ts";

// The deadline is the shared scaled test budget (POMTREE_TEST_TIMEOUT_SCALE), not a fixed real-time margin.
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  await until(predicate, 3000, { what: label });
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

// One cap definition: the docker bridge and the kit's CONNECT terminator are both fed BRIDGE_MAX_CONNECTIONS. The terminator's cap is
// observed through behavior (the first refused tunnel), the bridge's through the listener it builds and the 33rd-client test above.
// NOTE: the single definition is nominal until the worker program wires the terminator and the worker stream from this constant
// (both take the cap as a required option); this test proves each side honours the value it is given, not the wiring itself.
test("the kit terminator and the docker bridge enforce the same BRIDGE_MAX_CONNECTIONS", async () => {
  assert.equal(BRIDGE_MAX_CONNECTIONS, 32, "the cap value is pinned so a change is deliberate and reviewed with the bridge test above");
  const bridge = attachByteBridge("/nonexistent/unused.sock", 0);
  assert.equal(bridge.server.maxConnections, BRIDGE_MAX_CONNECTIONS);

  const open: Array<() => void> = [];
  const refusals: number[] = [];
  const term = createConnectTerminator({
    allow: () => true,
    maxConnections: BRIDGE_MAX_CONNECTIONS,
    dial: async () => ({
      write: async () => {},
      output: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<Uint8Array>>((resolve) => open.push(() => resolve({ done: true, value: undefined }))),
        }),
      }),
      close: () => {},
    }),
    audit: (r) => {
      if (r.status === 503) refusals.push(r.active);
    },
    now: () => 0,
    sleep: (_ms, signal) => new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
  });
  const request = new TextEncoder().encode("CONNECT a.test:443 HTTP/1.1\r\n\r\n");
  const clients: Array<Promise<void>> = [];
  let accepted = 0;
  const client = () => {
    let wake: (() => void) | undefined;
    const input = new Promise<void>((r) => (wake = r));
    clients.push(
      term.handle({
        write: async (data) => {
          if (new TextDecoder().decode(data).startsWith("HTTP/1.1 200")) accepted++;
        },
        output: () =>
          (async function* () {
            yield request;
            await input;
          })(),
        close: () => wake?.(),
      }),
    );
  };
  for (let i = 0; i < BRIDGE_MAX_CONNECTIONS; i++) client();
  await waitFor(() => accepted === BRIDGE_MAX_CONNECTIONS, "every tunnel up to the cap to be accepted");
  assert.equal(term.active, BRIDGE_MAX_CONNECTIONS);
  client();
  await waitFor(() => refusals.length === 1, "the tunnel past the cap to be refused");
  assert.deepEqual(refusals, [BRIDGE_MAX_CONNECTIONS]);
  assert.equal(term.active, BRIDGE_MAX_CONNECTIONS);
  for (const release of open) release();
  await Promise.all(clients);
  assert.equal(term.active, 0);
  bridge.close();
});
