import { tmpDir } from "@pomtree/testing";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import {
  HEADERS_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  acquireStateLock,
  ctxs,
  extractError,
  formatErrorDetail,
  isAbortError,
  listen,
  logRequestError,
  makeServer,
  socketRequestContext,
} from "./server.ts";
import { op, setup } from "./test-setup.ts";
import { sockRequest } from "./test-http.ts";

const sock = () => join(tmpDir("pomtreed-"), "s.sock");

const get = (sockPath: string, path: string) => sockRequest(sockPath, path);

// Send raw bytes over a unix socket and collect whatever the server answers, so we can exercise
// malformed request lines / bodies that node's http client would refuse to produce.
function raw(sockPath: string, payload: string | ((s: Socket) => void)): Promise<{ status: number | null; body: string }> {
  return new Promise((resolve) => {
    const s = connect(sockPath);
    let buf = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      s.destroy();
      const m = /^HTTP\/1\.1 (\d+)/m.exec(buf);
      resolve({ status: m ? Number(m[1]) : null, body: buf });
    };
    s.on("connect", () => {
      if (typeof payload === "string") s.write(payload);
      else payload(s);
    });
    s.on("data", (d) => {
      buf += d.toString();
      clearTimeout(timer);
      timer = setTimeout(done, 40); // responses here are tiny; settle after the last chunk
    });
    s.on("error", () => {});
    s.on("close", done);
  });
}

test("makeServer sets explicit request/header timeouts and honors overrides", () => {
  const t = setup(async () => {});
  const dflt = makeServer(t.daemon, false);
  assert.equal(dflt.requestTimeout, REQUEST_TIMEOUT_MS);
  assert.equal(dflt.headersTimeout, HEADERS_TIMEOUT_MS);
  const over = makeServer(t.daemon, false, { requestTimeoutMs: 1234, headersTimeoutMs: 5678 });
  assert.equal(over.requestTimeout, 1234);
  assert.equal(over.headersTimeout, 5678);
});

test("a malformed URL (GET //[) answers 400 instead of crashing the process", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    const res = await raw(path, "GET //[ HTTP/1.1\r\nhost: x\r\n\r\n");
    assert.equal(res.status, 400);
    // The server survives and keeps serving.
    assert.equal((await get(path, "/ui")).status, 200);
  } finally {
    server.close();
  }
});

test("a malformed percent-encoding in a path answers 400", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    // An extension route decodeURIComponent's its :id segment; %zz throws URIError there.
    const res = await raw(path, `GET /v1/agents/%zz/reports HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${op}\r\n\r\n`);
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("an aborted body read does not crash the server", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    await new Promise<void>((resolve) => {
      const s = connect(path);
      s.on("connect", () => {
        s.write('POST /v1/agents HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"name":"a"');
      });
      s.on("error", () => resolve());
      s.on("close", () => resolve());
      setTimeout(() => {
        s.destroy();
        resolve();
      }, 50);
    });
    assert.equal((await get(path, "/ui")).status, 200);
  } finally {
    server.close();
  }
});

test("a garbage request line gets a clientError 400 and the server survives", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    const res = await raw(path, "BOGUS\r\n\r\n");
    assert.equal(res.status, 400);
    assert.match(res.body, /malformed request/);
    assert.equal((await get(path, "/ui")).status, 200);
  } finally {
    server.close();
  }
});

test("the operator socket is created 0600", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    server.close();
  }
});

test("listen refuses to steal a live socket", async () => {
  const t = setup(async () => {});
  const path = sock();
  const first = await listen(t.daemon, path);
  try {
    await assert.rejects(listen(t.daemon, path), /already listening/);
  } finally {
    first.close();
  }
});

test("acquireStateLock takes an exclusive lock and refuses a live second holder", () => {
  const dir = tmpDir("pomtreed-lock-");
  const release = acquireStateLock(dir);
  try {
    assert.throws(() => acquireStateLock(dir), /locked by another pomtreed/);
  } finally {
    release();
  }
  // Released lock can be re-acquired.
  const again = acquireStateLock(dir);
  again();
});

test("acquireStateLock publishes the pid atomically and leaves no temp files", () => {
  const dir = tmpDir("pomtreed-lock-");
  const release = acquireStateLock(dir);
  assert.equal(readFileSync(join(dir, "pomtreed.lock"), "utf8").split("\n")[0], String(process.pid));
  assert.deepEqual(readdirSync(dir), ["pomtreed.lock"]);
  release();
});

test("acquireStateLock takes over a stale lock from a dead pid", () => {
  const dir = tmpDir("pomtreed-lock-");
  writeFileSync(join(dir, "pomtreed.lock"), "99999999\n", { mode: 0o600 });
  const release = acquireStateLock(dir);
  release();
});

test("acquireStateLock takes over a lock whose live pid has a different start time or boot", () => {
  for (const extra of ["start=Thu Jan  1 00:00:00 1970\n", "boot=not-this-boot\n"]) {
    const dir = tmpDir("pomtreed-lock-");
    // Our own pid is alive, so only the identity fields can mark this lock stale.
    writeFileSync(join(dir, "pomtreed.lock"), `${process.pid}\n${extra}`, { mode: 0o600 });
    const release = acquireStateLock(dir);
    assert.match(readFileSync(join(dir, "pomtreed.lock"), "utf8"), new RegExp(`^${process.pid}\\n`));
    release();
  }
});

test("acquireStateLock treats a pid-only lock (no start or boot identity) with a live pid as held", () => {
  const dir = tmpDir("pomtreed-lock-");
  writeFileSync(join(dir, "pomtreed.lock"), `${process.pid}\n`, { mode: 0o600 });
  assert.throws(() => acquireStateLock(dir), /locked by another pomtreed \(pid \d+, lock .*pomtreed\.lock\)/);
});

test("acquireStateLock takeover never deletes a live lock a racing starter installed", () => {
  const dir = tmpDir("pomtreed-lock-");
  const lockPath = join(dir, "pomtreed.lock");
  writeFileSync(lockPath, "99999999\n", { mode: 0o600 });
  let winnerRelease: (() => void) | undefined;
  let fired = false;
  // Starter B judged the dead-pid lock stale; before it takes over, starter A replaces it with a live lock.
  assert.throws(
    () =>
      acquireStateLock(dir, {
        afterJudgedStale: () => {
          if (fired) return;
          fired = true;
          unlinkSync(lockPath);
          winnerRelease = acquireStateLock(dir);
        },
      }),
    /locked by another pomtreed/,
  );
  assert.ok(winnerRelease);
  assert.equal(readFileSync(lockPath, "utf8").split("\n")[0], String(process.pid));
  winnerRelease();
});

test("acquireStateLock release does not unlink a successor's lock", () => {
  const dir = tmpDir("pomtreed-lock-");
  const first = acquireStateLock(dir);
  // Simulate a takeover that replaced the file with a different pid: our release must leave it alone.
  writeFileSync(join(dir, "pomtreed.lock"), "1\n", { mode: 0o600 });
  first();
  const raw = readFileSync(join(dir, "pomtreed.lock"), "utf8");
  assert.equal(raw.trim(), "1");
});

test("isAbortError classifies abort and network disconnect errors", () => {
  assert.equal(isAbortError("aborted"), true);
  assert.equal(isAbortError(new Error("aborted")), true);
  assert.equal(isAbortError(new Error("Premature close")), true);
  assert.equal(isAbortError(Object.assign(new Error("socket closed"), { code: "ECONNRESET" })), true);
  assert.equal(isAbortError(Object.assign(new Error("socket closed"), { code: "ERR_STREAM_PREMATURE_CLOSE" })), true);
  assert.equal(isAbortError(new DOMException("aborted", "AbortError")), true);
  assert.equal(isAbortError(new Error("wrapper", { cause: Object.assign(new Error("c"), { code: "ECONNRESET" }) })), true);

  assert.equal(isAbortError(new Error("internal db error")), false);
  assert.equal(isAbortError(new TypeError("undefined is not a function")), false);
  assert.equal(isAbortError(null), false);
});

test("logRequestError formats aborted request with diagnostic context and suppresses stack", () => {
  const logged: string[] = [];
  const origErr = console.error;
  console.error = (msg: unknown) => logged.push(String(msg));
  try {
    const req = { method: "POST", url: "/v1/agents?secret=key123" } as any;
    const res = {} as any;
    ctxs.set(res, {
      listener: "unix",
      startTime: Date.now() - 42,
      principal: { scope: "operator" },
      hadCredential: true,
    });
    const err = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    logRequestError(false, err, req, res);

    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /^pomtreed: operator request aborted \(unix POST \/v1\/agents \d+ms operator\): aborted \[code=ECONNRESET\]$/);
    assert.ok(!logged[0]!.includes("key123"));
    assert.ok(!logged[0]!.includes("Error: aborted\n")); // no stack trace
  } finally {
    console.error = origErr;
  }
});

test("logRequestError logs stack trace for non-abort errors", () => {
  const logged: string[] = [];
  const origErr = console.error;
  console.error = (msg: unknown) => logged.push(String(msg));
  try {
    const req = { method: "GET", url: "/v1/agents" } as any;
    const res = {} as any;
    ctxs.set(res, {
      listener: "unix",
      startTime: Date.now() - 10,
      principal: { scope: "operator" },
      hadCredential: true,
    });
    const err = new TypeError("cannot read property");
    logRequestError(false, err, req, res);

    assert.equal(logged.length, 1);
    assert.match(
      logged[0]!,
      /^pomtreed: operator request failed \(unix GET \/v1\/agents \d+ms operator\): TypeError: cannot read property\n  TypeError: cannot read property/,
    );
  } finally {
    console.error = origErr;
  }
});

test("logRequestError deduplicates logging on the same request", () => {
  const logged: string[] = [];
  const origErr = console.error;
  console.error = (msg: unknown) => logged.push(String(msg));
  try {
    const req = { method: "POST", url: "/v1/agents" } as any;
    const res = {} as any;
    ctxs.set(res, {
      listener: "unix",
      startTime: Date.now() - 15,
      principal: { scope: "operator" },
      hadCredential: true,
    });
    const err = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    logRequestError(false, err, req, res);
    logRequestError(false, err, req, res);

    assert.equal(logged.length, 1);
  } finally {
    console.error = origErr;
  }
});

test("logRequestError suppresses alarming logs for SSE client disconnects", () => {
  const logged: string[] = [];
  const origErr = console.error;
  console.error = (msg: unknown) => logged.push(String(msg));
  try {
    const req = { method: "GET", url: "/live/events" } as any;
    const res = {} as any;
    ctxs.set(res, {
      listener: "unix",
      startTime: Date.now() - 500,
      principal: { scope: "operator" },
      hadCredential: true,
      sse: true,
    });
    const err = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    logRequestError(false, err, req, res);

    assert.equal(logged.length, 0); // quiet on SSE disconnect
  } finally {
    console.error = origErr;
  }
});

test("server logs diagnostic context on aborted request without duplicates or stack dump", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  const logged: string[] = [];
  const origErr = console.error;
  console.error = (msg: unknown) => logged.push(String(msg));
  try {
    await new Promise<void>((resolve) => {
      const s = connect(path);
      s.on("connect", () => {
        s.write(
          `POST /v1/agents?secret=LEAK HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${op}\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n{"partial": 1`,
        );
        setTimeout(() => {
          s.destroy();
          setTimeout(resolve, 50);
        }, 50);
      });
      s.on("error", () => resolve());
      s.on("close", () => resolve());
    });

    assert.equal(logged.length, 1, `expected exactly 1 log line, got: ${JSON.stringify(logged)}`);
    assert.match(logged[0]!, /pomtreed: operator request aborted \(unix POST \/v1\/agents \d+ms operator\):/);
    assert.ok(!logged[0]!.includes("secret=LEAK"));
    assert.ok(!logged[0]!.includes("\n")); // no stack trace
  } finally {
    console.error = origErr;
    server.close();
  }
});

test("server suppresses alarming error log on SSE client disconnect", async () => {
  const t = setup(async () => {});
  const server = makeServer(t.daemon, false, { heartbeatMs: 20 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const logged: string[] = [];
  const origErr = console.error;
  console.error = (msg: unknown) => logged.push(String(msg));
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/live/events", headers: { authorization: `Bearer ${op}` } }, (res) => {
        res.on("data", () => {
          req.destroy();
          setTimeout(resolve, 50);
        });
      });
      req.on("error", () => {});
      setTimeout(() => reject(new Error("timeout")), 1500);
      req.end();
    });

    // Verify no alarming log for SSE client disconnect
    const errorLogs = logged.filter((l) => l.includes("pomtreed:"));
    assert.equal(errorLogs.length, 0, `expected no error logs on SSE disconnect, got: ${JSON.stringify(errorLogs)}`);
  } finally {
    console.error = origErr;
    server.close();
    server.closeAllConnections();
  }
});

const captureErr = (fn: () => void): string[] => {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (msg: unknown) => logged.push(String(msg));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return logged;
};

test("isAbortError terminates on a cyclic cause chain", () => {
  const a: Error & { cause?: unknown } = new Error("a");
  a.cause = a;
  assert.equal(isAbortError(a), false);
});

test("formatErrorDetail renders name, code and cause on one line, escaping newlines", () => {
  const cause = Object.assign(new Error("inner\nboom"), { code: "ENOENT" });
  const d = formatErrorDetail(extractError(Object.assign(new TypeError("bad\r\nINJECT pomtreed: fake"), { code: "E_X", cause })));
  assert.equal(d, "TypeError: bad\\r\\nINJECT pomtreed: fake [code=E_X] (cause: inner\\nboom [code=ENOENT])");
  assert.ok(!d.includes("\n"));
});

test("extractError tolerates unprintable throwables", () => {
  assert.equal(extractError(Object.create(null)).message, "(unprintable)");
  assert.equal(extractError("plain").message, "plain");
});

test("logRequestError redacts the path and escapes newlines in message and stack", () => {
  const req = { method: "GET", url: `/ui?token=${op}#frag\nforged` } as any;
  const res = {} as any;
  ctxs.set(res, { listener: "ui", startTime: Date.now(), principal: null, hadCredential: false });
  const logged = captureErr(() => logRequestError(false, new Error("x\npomtreed: forged line"), req, res));
  assert.equal(logged.length, 1);
  assert.ok(!logged[0]!.includes(op));
  assert.ok(!logged[0]!.includes("token="));
  assert.ok(!logged[0]!.includes("forged\n"));
  for (const line of logged[0]!.split("\n").slice(1)) assert.ok(line.startsWith("  "), line);
  assert.ok(logged[0]!.split("\n")[0]!.includes("x\\npomtreed: forged line"));
});

test("logRequestError works with no request context and never throws", () => {
  const logged = captureErr(() => logRequestError(true, new Error("bare")));
  assert.match(logged[0]!, /^pomtreed: agent request failed: bare\n/);
  const hostile = {
    get method(): string {
      throw new Error("boom");
    },
    url: "/x",
  } as any;
  assert.doesNotThrow(() => captureErr(() => logRequestError(false, new Error("e"), hostile, {} as any)));
});

test("logRequestError records detail for the access line and honors ctx keyed by request", () => {
  const req = { method: "GET", url: "/v1/agents" } as any;
  const c = { listener: "unix" as const, startTime: Date.now(), principal: null, hadCredential: false };
  ctxs.set(req, c);
  captureErr(() => logRequestError(false, new Error("why"), req));
  assert.equal((c as { detail?: string }).detail, "why");
});

test("socketRequestContext tolerates missing or hostile private fields", () => {
  assert.deepEqual(socketRequestContext(null), {});
  assert.deepEqual(socketRequestContext({}), {});
  assert.deepEqual(socketRequestContext({ parser: { incoming: "nope" }, _httpMessage: 3 }), {});
  const hostile = {
    get parser(): never {
      throw new Error("boom");
    },
  };
  assert.deepEqual(socketRequestContext(hostile), {});
  const req = {};
  assert.equal(socketRequestContext({ parser: { incoming: req } }).req, req);
});

test("/readyz carries the egress audit status next to the reasons, and omits it without a collector", async () => {
  const t = setup(async () => {});
  const withAudit = sock();
  const a = await listen(t.daemon, withAudit, {
    egressAuditStatus: () => ({ quarantined: ["sb-q"], retention: { spools: 5, max: 16, closed: 3, open: ["sb-q", "sb-o"] } }),
  });
  const without = sock();
  const b = await listen(t.daemon, without);
  const broken = sock();
  const c = await listen(t.daemon, broken, {
    egressAuditStatus: () => {
      throw new Error("/secret/path unreadable");
    },
  });
  try {
    const body = JSON.parse((await get(withAudit, "/readyz")).body);
    assert.deepEqual(body, {
      status: "ready",
      reasons: [],
      egressAudit: { quarantined: 1, retention: { spools: 5, max: 16, closed: 3, open: 2 }, nearCap: false },
    });
    assert.deepEqual(JSON.parse((await get(without, "/readyz")).body), { status: "ready", reasons: [] });
    const r = await get(broken, "/readyz");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { status: "ready", reasons: [] });
    assert.ok(!r.body.includes("secret"));
  } finally {
    for (const x of [a, b, c]) await new Promise((res) => x.close(res));
  }
});

test("/healthz and /readyz are served unauthenticated on the unix socket only", async () => {
  const t = setup(async () => {});
  const s = sock();
  const server = await listen(t.daemon, s);
  const agent = makeServer(t.daemon, true);
  try {
    const h = await get(s, "/healthz");
    assert.equal(h.status, 200);
    const r = await get(s, "/readyz");
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { status: "ready", reasons: [] });
    // Not served on agent/ui-style listeners: the agent listener demands credentials.
    await new Promise<void>((res) => agent.listen(0, "127.0.0.1", res));
    const port = (agent.address() as { port: number }).port;
    const status = await new Promise<number>((res, rej) => {
      request({ host: "127.0.0.1", port, path: "/readyz" }, (rs) => {
        rs.resume();
        res(rs.statusCode!);
      })
        .on("error", rej)
        .end();
    });
    assert.equal(status, 401);
  } finally {
    await new Promise((res) => server.close(res));
    await new Promise((res) => agent.close(res));
  }
});
