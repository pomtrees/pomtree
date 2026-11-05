import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, createServer as tcpServer, Socket, type AddressInfo } from "node:net";
import { attachProxy } from "./proxy.ts";
import type { EgressAuditEvent } from "./audit.ts";

// A CONNECT admission has exactly one terminal record: an outcome-phase event other than the
// intermediate "connected" marker. Every connection id that was admitted must end with one.
function terminalsByConnection(events: EgressAuditEvent[]): Map<string, EgressAuditEvent[]> {
  const out = new Map<string, EgressAuditEvent[]>();
  for (const e of events) {
    if (e.phase !== "outcome" || e.outcome === "connected") continue;
    out.set(e.connection, [...(out.get(e.connection) ?? []), e]);
  }
  return out;
}

// Polls a condition the proxy will reach on its own. The bound only keeps a broken proxy from hanging the run.
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function listen(server: ReturnType<typeof createServer> | ReturnType<typeof tcpServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

// Sends CONNECT and resolves once the client socket closes (proxy-side or test-side).
function sendConnect(port: number, authority: string, onOpen?: (s: Socket) => void): Promise<{ data: string; socket: Socket }> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1", () => {
      s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      onOpen?.(s);
    });
    let data = "";
    s.setEncoding("utf8");
    s.on("data", (d) => {
      data += d;
    });
    s.on("close", () => resolve({ data, socket: s }));
    // The proxy may reset a client it has already closed; the close event still settles the promise.
    s.on("error", () => {});
  });
}

test("client closing while admission is pending yields one terminal record, no admission and no dial", { timeout: 3000 }, async () => {
  const events: EgressAuditEvent[] = [];
  let dials = 0;
  let releaseDns: (ips: string[]) => void = () => {};
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    auditedPublic: {
      append: (e) => {
        events.push(e);
      },
    },
    resolve: () =>
      new Promise<string[]>((resolve) => {
        releaseDns = resolve;
      }),
    connect: () => {
      dials++;
      throw Error("must not dial");
    },
  });
  const port = await listen(proxy);
  try {
    // The client gives up before DNS answers; the late answer must not admit or dial.
    const { socket } = await sendConnect(port, "public.test:443", (s) => setTimeout(() => s.destroy(), 20));
    assert.equal(socket.destroyed, true);
    // The proxy ends the flow when it observes the client's close; wait for that record before DNS answers.
    await waitFor(() => terminalsByConnection(events).size === 1, "client-close terminal record");
    releaseDns(["8.8.8.8"]);
    // Absence check below: a late DNS answer that wrongly admitted or dialed has no event to wait on.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(dials, 0);
    assert.equal(
      events.some((e) => e.phase === "admission"),
      false,
    );
    const terminals = terminalsByConnection(events);
    assert.equal(terminals.size, 1);
    const [only] = [...terminals.values()];
    assert.equal(only?.length, 1);
    assert.equal(only?.[0]?.outcome, "complete");
  } finally {
    control.close();
    proxy.close();
  }
});

test("abort during admission cancels the flow once, releases the client, and a late DNS answer is ignored", { timeout: 3000 }, async () => {
  const events: EgressAuditEvent[] = [];
  const abort = new AbortController();
  let dials = 0;
  let releaseDns: (ips: string[]) => void = () => {};
  let markDnsCalled: () => void = () => {};
  const dnsCalled = new Promise<void>((resolve) => {
    markDnsCalled = resolve;
  });
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    signal: abort.signal,
    auditedPublic: {
      append: (e) => {
        events.push(e);
      },
    },
    resolve: () => {
      markDnsCalled();
      return new Promise<string[]>((resolve) => {
        releaseDns = resolve;
      });
    },
    connect: () => {
      dials++;
      throw Error("must not dial");
    },
  });
  const port = await listen(proxy);
  try {
    const pending = sendConnect(port, "public.test:443");
    // Abort only once admission is underway (DNS has been asked), so the flow exists when the signal fires.
    await dnsCalled;
    abort.abort();
    const { socket } = await pending;
    assert.equal(socket.destroyed, true);
    releaseDns(["8.8.8.8"]);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(dials, 0);
    assert.equal(
      events.some((e) => e.phase === "admission"),
      false,
    );
    const terminals = terminalsByConnection(events);
    assert.equal(terminals.size, 1);
    assert.equal([...terminals.values()][0]?.length, 1);
    assert.equal([...terminals.values()][0]?.[0]?.outcome, "cancelled");
  } finally {
    control.close();
    proxy.close();
  }
});

test("CONNECT after the proxy is closed is dropped without an admission record or dial", { timeout: 3000 }, async () => {
  const events: EgressAuditEvent[] = [];
  let dials = 0;
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    auditedPublic: {
      append: (e) => {
        events.push(e);
      },
    },
    resolve: async () => ["8.8.8.8"],
    connect: () => {
      dials++;
      throw Error("must not dial");
    },
  });
  const port = await listen(proxy);
  try {
    control.close();
    const { data } = await sendConnect(port, "public.test:443");
    assert.equal(data, "");
    assert.equal(dials, 0);
    assert.equal(events.length, 0);
  } finally {
    proxy.close();
  }
});

test("a connect event that arrives after the deadline finished the flow neither writes 200 nor audits connected", { timeout: 3000 }, async () => {
  const events: EgressAuditEvent[] = [];
  const fake = new Socket();
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    deadlineMs: 30,
    auditedPublic: {
      append: (e) => {
        events.push(e);
      },
    },
    resolve: async () => ["8.8.8.8"],
    connect: () => fake,
  });
  const port = await listen(proxy);
  try {
    const { data, socket } = await sendConnect(port, "public.test:443");
    assert.equal(socket.destroyed, true);
    assert.equal(data.startsWith("HTTP/1.1 200"), false);
    // The deadline already tore the upstream down; a late handshake completion must be ignored.
    assert.equal(fake.destroyed, true);
    await waitFor(() => terminalsByConnection(events).size === 1, "deadline terminal record");
    fake.emit("connect");
    // Absence check below: a late connected audit has no event to wait on.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      events.some((e) => e.outcome === "connected"),
      false,
    );
    const terminals = terminalsByConnection(events);
    assert.equal(terminals.size, 1);
    assert.equal([...terminals.values()][0]?.length, 1);
    assert.equal([...terminals.values()][0]?.[0]?.outcome, "limit");
  } finally {
    control.close();
    proxy.close();
  }
});

test("upstream destroyed before its handshake completes yields one terminal record and closes the client", { timeout: 3000 }, async () => {
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
    connect: () => {
      const up = new Socket();
      setTimeout(() => up.destroy(), 10);
      return up;
    },
  });
  const port = await listen(proxy);
  try {
    const { socket } = await sendConnect(port, "public.test:443");
    assert.equal(socket.destroyed, true);
    assert.equal(
      events.some((e) => e.outcome === "connected"),
      false,
    );
    const terminals = terminalsByConnection(events);
    assert.equal(terminals.size, 1);
    assert.equal([...terminals.values()][0]?.length, 1);
  } finally {
    control.close();
    proxy.close();
  }
});

test("every admitted connection, across allowed, denied, deadline and client-close flows, has exactly one terminal record", { timeout: 5000 }, async () => {
  const upstream = tcpServer((s) => s.pipe(s));
  const upPort = await listen(upstream);
  const events: EgressAuditEvent[] = [];
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    deadlineMs: 150,
    auditedPublic: {
      append: (e) => {
        events.push(e);
      },
    },
    resolve: async (host) => (host === "private.test" ? ["10.0.0.1"] : ["8.8.8.8"]),
    connect: () => new Socket().connect(upPort, "127.0.0.1"),
  });
  const port = await listen(proxy);
  try {
    // Allowed tunnel that the client closes after the echo.
    await sendConnect(port, "ok.test:443", (s) => s.once("data", () => s.destroy()));
    // Denied: private answer.
    await sendConnect(port, "private.test:443");
    // Deadline: tunnel open, never closed by the client, so the 150ms deadline ends it.
    await sendConnect(port, "slow.test:443", (s) => s.on("data", () => {}));
    const terminals = terminalsByConnection(events);
    const admitted = new Set(events.filter((e) => e.phase === "admission").map((e) => e.connection));
    assert.equal(terminals.size, admitted.size);
    for (const id of admitted) assert.equal(terminals.get(id)?.length, 1, id);
    const outcomes = [...terminals.values()].map((v) => v[0]?.outcome).sort();
    assert.deepEqual(outcomes, ["complete", "denied", "limit"]);
  } finally {
    control.close();
    proxy.close();
    upstream.close();
  }
});

test("bytes a client pipelines before the tunnel opens are held during admission and forwarded in order", { timeout: 3000 }, async () => {
  const upstream = tcpServer((s) => s.pipe(s));
  const upPort = await listen(upstream);
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    auditedPublic: { append() {} },
    resolve: () => new Promise((resolve) => setTimeout(() => resolve(["8.8.8.8"]), 30)),
    connect: () => new Socket().connect(upPort, "127.0.0.1"),
  });
  const port = await listen(proxy);
  try {
    const echoed = await new Promise<string>((resolve, reject) => {
      const s = connect(port, "127.0.0.1", () => {
        s.write("CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n");
        s.write("first-");
        setTimeout(() => s.write("second"), 5);
      });
      let data = "";
      s.setEncoding("utf8");
      s.on("data", (d) => {
        data += d;
        if (data.includes("first-second")) {
          const body = data.slice(data.indexOf("\r\n\r\n") + 4);
          s.destroy();
          resolve(body);
        }
      });
      s.on("error", reject);
      s.on("close", () => reject(new Error(`closed before echo: ${data}`)));
    });
    assert.equal(echoed, "first-second");
  } finally {
    control.close();
    proxy.close();
    upstream.close();
  }
});
