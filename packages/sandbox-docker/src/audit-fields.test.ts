import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer as tcpServer, Socket, type AddressInfo, type Server as NetServer } from "node:net";
import { attachProxy, type ProxyOptions } from "./proxy.ts";
import {
  DiskEgressAudit,
  FileEgressAuditWriter,
  auditChainGenesis,
  auditChainNext,
  prepareEgressSpool,
  type EgressAuditEvent,
  type EgressAuditIdentity,
  type EgressAuditWriter,
} from "./audit.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function listen(server: NetServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function tcp(handler: (s: Socket) => void): Promise<{ port: number; close(): void }> {
  const server = tcpServer(handler);
  const port = await listen(server);
  return { port, close: () => server.close() };
}

// Sends CONNECT and resolves once the client socket closes; `onOpen` runs right after the request is written.
function sendConnect(port: number, authority: string, onOpen?: (s: Socket) => void): Promise<void> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1", () => {
      s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      onOpen?.(s);
    });
    // Drain replies: a paused socket never observes the proxy's FIN, so 'close' would not fire.
    s.on("data", () => {});
    s.on("error", () => {});
    s.on("close", () => resolve());
  });
}

// Plain absolute-form GET; resolves when the client request closes, whatever the proxy answered.
function httpGet(port: number, target: string): Promise<void> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: target, agent: false }, (res) => {
      res.resume();
    });
    req.on("error", () => {});
    req.on("close", () => resolve());
    req.end();
  });
}

interface DriveOptions {
  publicMode?: boolean;
  allow?: string[];
  writer?: EgressAuditWriter;
}

// Runs the real proxy with the given seams and returns the audit rows it emitted during `act`.
// `publicMode` selects auditedPublic (default) versus the allowlist-only audit sink. A supplied writer replaces the in-memory sink.
async function drive(
  opts: Partial<ProxyOptions>,
  act: (port: number) => Promise<void>,
  { publicMode = true, allow = [], writer }: DriveOptions = {},
): Promise<EgressAuditEvent[]> {
  const events: EgressAuditEvent[] = [];
  const sink: EgressAuditWriter = writer ?? {
    append: (e) => {
      events.push(e);
    },
  };
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(allow), {
    ...opts,
    hostAddresses: new Set<string>(),
    ...(publicMode ? { auditedPublic: sink } : { audit: sink }),
  });
  const port = await listen(proxy);
  let snapshot: EgressAuditEvent[] = [];
  try {
    await act(port);
    await sleep(40);
    snapshot = [...events];
  } finally {
    control.close();
    proxy.closeAllConnections();
    proxy.close();
  }
  return snapshot;
}

function assertDenied(events: EgressAuditEvent[], reason: string, count = 1): void {
  const admissions = events.filter((e) => e.phase === "admission" && e.outcome === "denied");
  assert.equal(admissions.length, count);
  for (const admission of admissions) {
    const outcomes = events.filter((e) => e.connection === admission.connection && e.phase === "outcome");
    assert.equal(outcomes.length, 1, "denied flow has one outcome row");
    assert.equal(admission.denyReason, reason, "admission row");
    assert.equal(outcomes[0]?.denyReason, reason, "outcome row");
  }
}

function assertLimit(events: EgressAuditEvent[], kind: string): void {
  // Connections-limit refusals are admission-phase rows; every other limit is an outcome row. Both carry outcome "limit".
  const rows = events.filter((e) => e.outcome === "limit");
  assert.ok(rows.length >= 1, "a limit row was emitted");
  for (const row of rows) {
    assert.equal(row.limitKind, kind);
    assert.equal(row.trafficClass, "public", "these tests dial no relay");
  }
}

function assertError(events: EgressAuditEvent[], errorClass: string): void {
  const rows = events.filter((e) => e.outcome === "error");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.errorClass, errorClass);
}

function isIso(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

// denyReason: one test per value. Every denied flow writes an admission row and an outcome row; both must carry the reason.

test("denyReason dns: a resolver that throws or answers with no addresses", { timeout: 5000 }, async () => {
  const events = await drive(
    {
      resolve: async (host) => {
        if (host === "empty.test") return [];
        throw Error("ENOTFOUND");
      },
    },
    async (port) => {
      await sendConnect(port, "throws.test:443");
      await sendConnect(port, "empty.test:443");
    },
  );
  assertDenied(events, "dns", 2);
});

test("denyReason private: a private resolved address is denied", { timeout: 5000 }, async () => {
  const events = await drive({ resolve: async () => ["10.0.0.1"] }, (port) => sendConnect(port, "private.test:443"));
  assertDenied(events, "private");
});

test("denyReason hard-class: metadata and other hard-denied addresses", { timeout: 5000 }, async () => {
  const events = await drive({ resolve: async () => ["169.254.169.254"] }, (port) => sendConnect(port, "meta.test:443"));
  assertDenied(events, "hard-class");
});

test("denyReason not-allowlisted: host outside the allowlist, plus non-http absolute-form", { timeout: 5000 }, async () => {
  const events = await drive({}, (port) => sendConnect(port, "other.test:443"), { publicMode: false, allow: ["allowed.test:443"] });
  assertDenied(events, "not-allowlisted");
  // A non-http absolute-form request writes only an admission row (no flow, so no outcome row).
  const absolute = await drive({}, (port) => httpGet(port, "https://example.test/"), { publicMode: false, allow: ["allowed.test:443"] });
  assert.equal(absolute.find((e) => e.transport === "http")?.denyReason, "not-allowlisted");
});

test("denyReason reserved: localhost and other reserved names never reach DNS", { timeout: 5000 }, async () => {
  let lookups = 0;
  const events = await drive(
    {
      resolve: async () => {
        lookups++;
        return ["8.8.8.8"];
      },
    },
    (port) => sendConnect(port, "localhost:443"),
  );
  assertDenied(events, "reserved");
  assert.equal(lookups, 0);
});

test("denyReason resolver-limit: a stalled lookup keeps its reservation after the client leaves", { timeout: 5000 }, async () => {
  let release: (ips: string[]) => void = () => {};
  let first: Socket | undefined;
  const events = await drive(
    {
      maxConnections: 1,
      resolve: (host) => (host === "stall.test" ? new Promise<string[]>((r) => (release = r)) : Promise.resolve(["8.8.8.8"])),
    },
    async (port) => {
      const pending = sendConnect(port, "stall.test:443", (s) => {
        first = s;
      });
      await sleep(20);
      first?.destroy();
      await pending;
      await sleep(30); // let the proxy observe the disconnect so the flow slot is free
      await sendConnect(port, "other.test:443");
      release(["8.8.8.8"]);
    },
  );
  assertDenied(events, "resolver-limit");
});

// limitKind: one test per value.

test("limitKind deadline: deadlineMs ends a tunnel the client keeps open", { timeout: 5000 }, async () => {
  const upstream = await tcp((s) => s.pipe(s));
  try {
    const events = await drive({ deadlineMs: 60, resolve: async () => ["8.8.8.8"], connect: () => new Socket().connect(upstream.port, "127.0.0.1") }, (port) =>
      sendConnect(port, "slow.test:443", (s) => {
        s.on("data", () => {});
      }),
    );
    assertLimit(events, "deadline");
  } finally {
    upstream.close();
  }
});

test("limitKind idle: idleTimeoutMs ends a silent tunnel", { timeout: 5000 }, async () => {
  const upstream = await tcp((s) => s.pipe(s));
  try {
    const events = await drive(
      { idleTimeoutMs: 50, resolve: async () => ["8.8.8.8"], connect: () => new Socket().connect(upstream.port, "127.0.0.1") },
      (port) =>
        sendConnect(port, "idle.test:443", (s) => {
          s.on("data", () => {});
        }),
    );
    assertLimit(events, "idle");
  } finally {
    upstream.close();
  }
});

test("limitKind bytes: maxConnectionBytes ends a tunnel that exceeds it", { timeout: 5000 }, async () => {
  const upstream = await tcp((s) => s.pipe(s));
  try {
    const events = await drive(
      { maxConnectionBytes: 10, resolve: async () => ["8.8.8.8"], connect: () => new Socket().connect(upstream.port, "127.0.0.1") },
      (port) =>
        sendConnect(port, "big.test:443", (s) => {
          s.on("data", (d: Buffer) => {
            if (d.toString().startsWith("HTTP/1.1 200")) s.write("x".repeat(100));
          });
        }),
    );
    assertLimit(events, "bytes");
  } finally {
    upstream.close();
  }
});

test("limitKind connections: a flow beyond maxConnections is refused at admission", { timeout: 5000 }, async () => {
  let release: (ips: string[]) => void = () => {};
  let first: Socket | undefined;
  const events = await drive(
    {
      maxConnections: 1,
      resolve: () =>
        new Promise<string[]>((r) => {
          release = r;
        }),
    },
    async (port) => {
      const pending = sendConnect(port, "a.test:443", (s) => {
        first = s;
      });
      await sleep(20);
      await sendConnect(port, "b.test:443");
      first?.destroy();
      await pending;
      release(["8.8.8.8"]); // the abandoned first admission must now be ignored, never dialled
    },
  );
  assertLimit(events, "connections");
});

// errorClass: one test per value.

test("errorClass dial: the upstream refuses before connecting", { timeout: 5000 }, async () => {
  const dead = await tcp(() => {});
  dead.close();
  const events = await drive({ resolve: async () => ["8.8.8.8"], connect: () => new Socket().connect(dead.port, "127.0.0.1") }, (port) =>
    sendConnect(port, "dial.test:443"),
  );
  assertError(events, "dial");
});

test("errorClass reset: the upstream resets an established tunnel", { timeout: 5000 }, async () => {
  const upstream = await tcp((s) => {
    s.once("data", () => s.resetAndDestroy());
  });
  try {
    const events = await drive({ resolve: async () => ["8.8.8.8"], connect: () => new Socket().connect(upstream.port, "127.0.0.1") }, (port) =>
      sendConnect(port, "rst.test:443", (s) => {
        s.on("data", (d: Buffer) => {
          if (d.toString().startsWith("HTTP/1.1 200")) s.write("ping");
        });
      }),
    );
    assertError(events, "reset");
  } finally {
    upstream.close();
  }
});

test("errorClass timeout: an upstream error carrying code ETIMEDOUT", { timeout: 5000 }, async () => {
  const events = await drive(
    {
      resolve: async () => ["8.8.8.8"],
      connect: () => {
        const up = new Socket();
        setImmediate(() => up.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
        return up;
      },
    },
    (port) => sendConnect(port, "timeout.test:443"),
  );
  assertError(events, "timeout");
});

test("errorClass protocol: an upstream that answers an absolute-form request with garbage", { timeout: 5000 }, async () => {
  const raw = await tcp((s) => {
    s.end("garbage\r\n\r\n");
  });
  try {
    const events = await drive(
      {
        resolve: async () => ["8.8.8.8"],
        request: ((options: RequestOptions, cb: (res: IncomingMessage) => void) =>
          httpRequest({ ...options, host: "127.0.0.1", port: raw.port }, cb)) as typeof httpRequest,
      },
      (port) => httpGet(port, "http://public.test:8081/"),
    );
    assertError(events, "protocol");
  } finally {
    raw.close();
  }
});

test("errorClass internal: the connect seam throws synchronously", { timeout: 5000 }, async () => {
  const events = await drive(
    {
      resolve: async () => ["8.8.8.8"],
      connect: () => {
        throw Error("seam boom");
      },
    },
    (port) => sendConnect(port, "internal.test:443"),
  );
  assertError(events, "internal");
});

test("admittedAt is one ISO stamp shared by admission and outcome rows; peers is the validated set capped at 8", { timeout: 5000 }, async () => {
  const echo = await tcp((s) => s.pipe(s));
  const pubs = ["8.8.8.8", "1.1.1.1", "9.9.9.9", "4.4.4.4", "5.5.5.5", "6.6.6.6", "7.7.7.7", "3.3.3.3", "2.2.2.2", "11.11.11.11"];
  const allowed = (ips: string[]) =>
    drive({ resolve: async () => ips, connect: () => new Socket().connect(echo.port, "127.0.0.1") }, (port) =>
      sendConnect(port, "ok.test:443", (s) => {
        s.once("data", () => s.destroy());
      }),
    );
  try {
    const two = await allowed(["8.8.8.8", "1.1.1.1"]);
    const admission = two.find((e) => e.phase === "admission" && e.outcome === "allowed");
    const connected = two.find((e) => e.outcome === "connected");
    const complete = two.find((e) => e.phase === "outcome" && e.outcome === "complete");
    assert.ok(isIso(admission?.admittedAt), "admission admittedAt is ISO 8601");
    assert.equal(connected?.admittedAt, admission?.admittedAt);
    assert.equal(complete?.admittedAt, admission?.admittedAt);
    assert.equal(admission?.peer, "8.8.8.8", "peer stays the dialled (first) address");
    assert.deepEqual(admission?.peers, ["8.8.8.8", "1.1.1.1"]);
    assert.deepEqual(connected?.peers, ["8.8.8.8", "1.1.1.1"]);
    assert.deepEqual(complete?.peers, ["8.8.8.8", "1.1.1.1"]);

    const denied = await drive({ resolve: async () => ["10.0.0.1"] }, (port) => sendConnect(port, "priv.test:443"));
    const deniedAdmission = denied.find((e) => e.phase === "admission");
    assert.ok(isIso(deniedAdmission?.admittedAt), "denied admission admittedAt is ISO 8601");
    assert.equal(denied.find((e) => e.phase === "outcome")?.admittedAt, deniedAdmission?.admittedAt);

    const ten = await allowed(pubs);
    const tenAdmission = ten.find((e) => e.phase === "admission" && e.outcome === "allowed");
    assert.equal(tenAdmission?.peer, pubs[0]);
    assert.deepEqual(tenAdmission?.peers, pubs.slice(0, 8), "resolver answers beyond 8 are capped, first 8 kept");
  } finally {
    echo.close();
  }
});

test("real proxy denials persist through the durable spool with the new fields and read back", { timeout: 5000 }, async () => {
  const f = fixture();
  try {
    const writer = new FileEgressAuditWriter(f.logDir, f.identity);
    await drive({ resolve: async () => ["10.0.0.1"] }, (port) => sendConnect(port, "priv.test:443"), { writer });
    const rows = await f.disk.read("sb", 0);
    assert.deepEqual(
      rows.map((r) => [r.phase, r.outcome, r.denyReason]),
      [
        ["admission", "denied", "private"],
        ["outcome", "denied", "private"],
      ],
    );
    assert.ok(isIso(rows[0]?.admittedAt));
    assert.equal(rows[1]?.admittedAt, rows[0]?.admittedAt);
  } finally {
    f.clean();
  }
});

// Writer/reader validation. Both share validateRecord; the writer refuses any row the reader would reject.

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-egress-audit-fields-")));
  const identity = { sandbox: "sb", agent: "worker", host: "host", generation: 2 };
  const dirs = prepareEgressSpool(root, "sb", { allow: [], relay: [], hostAddresses: [], identity });
  return { root, identity, ...dirs, disk: new DiskEgressAudit({ root }), clean: () => rmSync(root, { recursive: true, force: true }) };
}

// Hand-written spool line, used where the writer itself must not be the producer (rejection cases and legacy rows).
function writeRow(f: { logDir: string; identity: EgressAuditIdentity }, sequence: number, fields: Record<string, unknown>): void {
  const path = join(f.logDir, "events.jsonl");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
  const previous = lines.length ? (JSON.parse(lines[lines.length - 1]!) as { chain: string }).chain : auditChainGenesis(f.identity.sandbox);
  const row = { kind: "egress", eventId: `sb:${sequence}`, sequence, at: Date.now(), ...f.identity, ...fields };
  appendFileSync(path, `${JSON.stringify({ ...row, chain: auditChainNext(previous, row as never) })}\n`);
}

const admitted = {
  connection: "c",
  phase: "admission",
  transport: "connect",
  authority: "example.test:443",
  outcome: "allowed",
  peer: "8.8.8.8",
} as EgressAuditEvent;

test("legacy rows without any new field still validate on write and read", async () => {
  const f = fixture();
  try {
    new FileEgressAuditWriter(f.logDir, f.identity).append(admitted);
    writeRow(f, 2, { ...admitted, phase: "outcome", outcome: "complete" });
    const rows = await f.disk.read("sb", 0);
    assert.deepEqual(
      rows.map((r) => r.sequence),
      [1, 2],
    );
    assert.ok(
      rows.every(
        (r) =>
          r.denyReason === undefined &&
          r.limitKind === undefined &&
          r.errorClass === undefined &&
          r.trafficClass === undefined &&
          r.admittedAt === undefined &&
          r.peers === undefined,
      ),
    );
  } finally {
    f.clean();
  }
});

test("every valid new field value is accepted by the writer and returned by the reader", async () => {
  const f = fixture();
  const admittedAt = new Date().toISOString();
  const valid = [
    { outcome: "denied", denyReason: "dns" },
    { outcome: "denied", denyReason: "not-allowlisted" },
    { outcome: "denied", denyReason: "resolver-limit" },
    { outcome: "limit", limitKind: "connections" },
    { outcome: "limit", limitKind: "bytes", trafficClass: "relay" },
    { outcome: "limit", limitKind: "idle", trafficClass: "public" },
    { outcome: "error", errorClass: "internal" },
    { admittedAt, peers: ["8.8.8.8", "1.1.1.1"] },
    { outcome: "denied", denyReason: "dns", repeats: 7, firstAt: 1, lastAt: 2 },
    { outcome: "denied", denyReason: "dns", repeats: 1, firstAt: 5, lastAt: 5 },
  ] as Array<Partial<EgressAuditEvent>>;
  try {
    const writer = new FileEgressAuditWriter(f.logDir, f.identity);
    for (const fields of valid) writer.append({ ...admitted, ...fields });
    const rows = await f.disk.read("sb", 0);
    assert.equal(rows.length, valid.length);
    valid.forEach((fields, i) => {
      for (const [key, value] of Object.entries(fields)) assert.deepEqual(rows[i]?.[key as keyof EgressAuditEvent], value, key);
    });
  } finally {
    f.clean();
  }
});

test("unknown enum values and misplaced or malformed new fields are refused by both writer and reader", async () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["unknown denyReason", { outcome: "denied", denyReason: "bogus" }],
    ["unknown limitKind", { outcome: "limit", limitKind: "bogus" }],
    ["unknown errorClass", { outcome: "error", errorClass: "bogus" }],
    ["denyReason on an allowed row", { outcome: "allowed", denyReason: "dns" }],
    ["limitKind on a complete row", { outcome: "complete", limitKind: "idle" }],
    ["errorClass on a denied row", { outcome: "denied", errorClass: "dial" }],
    ["unknown trafficClass", { outcome: "limit", limitKind: "idle", trafficClass: "bogus" }],
    ["trafficClass on a complete row", { outcome: "complete", trafficClass: "relay" }],
    ["non-ISO admittedAt", { admittedAt: "yesterday" }],
    ["peers over eight entries", { peers: Array<string>(9).fill("8.8.8.8") }],
    ["non-string peers entry", { peers: ["8.8.8.8", 1] }],
    ["repeats without firstAt and lastAt", { outcome: "denied", denyReason: "dns", repeats: 2 }],
    ["firstAt and lastAt without repeats", { outcome: "denied", denyReason: "dns", firstAt: 1, lastAt: 2 }],
    ["repeats and firstAt without lastAt", { outcome: "denied", denyReason: "dns", repeats: 2, firstAt: 1 }],
    ["summary fields on a non-denied row", { outcome: "allowed", repeats: 2, firstAt: 1, lastAt: 2 }],
    ["repeats 0", { outcome: "denied", denyReason: "dns", repeats: 0, firstAt: 1, lastAt: 2 }],
    ["fractional repeats", { outcome: "denied", denyReason: "dns", repeats: 1.5, firstAt: 1, lastAt: 2 }],
    ["firstAt after lastAt", { outcome: "denied", denyReason: "dns", repeats: 2, firstAt: 3, lastAt: 2 }],
    ["negative firstAt", { outcome: "denied", denyReason: "dns", repeats: 2, firstAt: -1, lastAt: 2 }],
  ];
  for (const [label, fields] of invalid) {
    const f = fixture();
    try {
      const row = { ...admitted, ...fields } as EgressAuditEvent;
      assert.throws(() => new FileEgressAuditWriter(f.logDir, f.identity).append(row), Error, `writer: ${label}`);
      writeRow(f, 1, { ...admitted, ...fields });
      await assert.rejects(f.disk.read("sb", 0), Error, `reader: ${label}`);
    } finally {
      f.clean();
    }
  }
});

test("the reader refuses a summary whose lastAt is after the row's own at (the writer raises at to lastAt instead)", async () => {
  const f = fixture();
  try {
    new FileEgressAuditWriter(f.logDir, f.identity).append(admitted); // creates the spool file with its private mode
    writeRow(f, 2, { ...admitted, outcome: "denied", denyReason: "dns", repeats: 2, firstAt: 1, lastAt: Date.now() + 3_600_000 });
    await assert.rejects(f.disk.read("sb", 0), /repeat summary/);
  } finally {
    f.clean();
  }
});

// Admission without outcome: documented behaviour. A reader sees the flow as incomplete by the absence of an outcome-phase row.
test("a flow with no outcome row is distinguishable from a completed one when rows are grouped by connection", async () => {
  const f = fixture();
  try {
    const writer = new FileEgressAuditWriter(f.logDir, f.identity);
    writer.append({ ...admitted, connection: "incomplete" });
    writer.append({ ...admitted, connection: "done" });
    writer.append({ ...admitted, connection: "done", phase: "outcome", outcome: "complete" });
    const byConnection = new Map<string, EgressAuditEvent[]>();
    for (const row of await f.disk.read("sb", 0)) byConnection.set(row.connection, [...(byConnection.get(row.connection) ?? []), row]);
    const incomplete = byConnection.get("incomplete") ?? [];
    const done = byConnection.get("done") ?? [];
    assert.deepEqual(
      incomplete.map((r) => [r.phase, r.outcome]),
      [["admission", "allowed"]],
    );
    assert.equal(
      incomplete.some((r) => r.phase === "outcome"),
      false,
    );
    assert.equal(
      done.some((r) => r.phase === "outcome"),
      true,
    );
  } finally {
    f.clean();
  }
});
