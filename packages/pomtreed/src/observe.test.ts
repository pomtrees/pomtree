import { tmpDir } from "@pomtree/testing";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FetchLike } from "@pomtree/observe";
import { listen } from "./server.ts";
import { issueToken } from "./auth.ts";
import { op, SECRET, setup, until } from "./test-setup.ts";

const sock = () => join(tmpDir("pomtreed-"), "s.sock");

test("the OTLP exporter is wired to the journal and posts to the injected fetch", async () => {
  const urls: string[] = [];
  const bodies: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    bodies.push(init.body);
    return { ok: true, status: 200 };
  };
  const t = setup(
    async (c) => {
      c.emit({ kind: "tool_call", tool: "bash", callId: "1", input: {} });
      c.emit({ kind: "tool_result", callId: "1", ok: true, output: "x" });
      await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
    },
    {},
    { otlp: { endpoint: "http://collector:4318/", fetch, batchSize: 1 } },
  );
  await t.extensions.startAll(); // the observe builtin's start() runs the exporter
  await t.spawn();
  await t.orchestrator.idle();
  await until(() => urls.length > 0);
  assert.ok(urls.every((u) => u === "http://collector:4318/v1/traces"));
  // At least one batch carried spans.
  const spans = bodies.flatMap((b) => JSON.parse(b).resourceSpans[0].scopeSpans[0].spans);
  assert.ok(spans.length > 0);
});

test("no OTLP endpoint means no exporter is started", async () => {
  let called = false;
  const fetch: FetchLike = async () => {
    called = true;
    return { ok: true, status: 200 };
  };
  const t = setup(async () => {}, {}, { otlp: { endpoint: "", fetch } });
  await t.extensions.startAll();
  assert.equal(called, false);
});

test("stopAll closes the OTLP run", async () => {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    return { ok: true, status: 200 };
  };
  const t = setup(async () => {}, {}, { otlp: { endpoint: "http://collector:4318", fetch, batchSize: 1 } });
  await t.extensions.startAll();
  await t.spawn();
  await t.orchestrator.idle();
  await until(() => urls.length > 0);
  await t.extensions.stopAll();
  const before = urls.length; // any final flush during stop is already accounted for
  // More journal activity after stop must not export (the subscription is closed).
  await t.spawn("k2");
  await t.orchestrator.idle();
  assert.equal(urls.length, before);
});

test("GET /live serves the inline page", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    const html = await new Promise<string>((resolve, reject) => {
      const req = request({ socketPath: path, path: "/live" }, (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => resolve(s));
      });
      req.on("error", reject);
      req.end();
    });
    assert.match(html, /<title>pomtree live<\/title>/);
    assert.ok(html.includes('K.stream("/live/events"'));
    assert.ok(!html.includes("src="));
  } finally {
    server.close();
  }
});

test("GET /reports serves the reports page", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    const html = await new Promise<string>((resolve, reject) => {
      const req = request({ socketPath: path, path: "/reports" }, (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => resolve(s));
      });
      req.on("error", reject);
      req.end();
    });
    assert.match(html, /<title>pomtree reports<\/title>/);
  } finally {
    server.close();
  }
});

test("GET /live and GET /reports send the CSP, nosniff and no-store headers", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    for (const route of ["/live", "/reports"]) {
      const headers = await new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
        const req = request({ socketPath: path, path: route }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.headers));
        });
        req.on("error", reject);
        req.end();
      });
      const csp = String(headers["content-security-policy"]);
      assert.match(csp, /default-src 'none'/, route);
      assert.match(csp, /connect-src 'self'/, route);
      assert.match(csp, /frame-ancestors 'none'/, route);
      assert.equal(headers["x-content-type-options"], "nosniff", route);
      assert.equal(headers["cache-control"], "no-store", route);
    }
  } finally {
    server.close();
  }
});

test("the observe builtin registers the /live, /live/events, /v1/tree, and /reports routes", async () => {
  const t = setup(async () => {});
  const routes = t.extensions.routes().map((r) => `${r.method} ${r.path}`);
  assert.ok(routes.includes("GET /live"));
  assert.ok(routes.includes("GET /reports"));
  assert.ok(routes.includes("GET /v1/tree"));
  assert.ok(routes.includes("POST /v1/ui/command"));
  assert.deepEqual(
    t.extensions.streams().map((s) => `${s.method} ${s.path}`),
    ["GET /live/events", "GET /live/messages", "GET /live/ui"],
  );
});

test("GET /v1/tree serves the pre-formatted operator tree rows", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await t.spawn();
  await until(async () => (await t.fakes.registry.get(a.id))?.state === "running");
  const res = await t.operator("GET", "/v1/tree");
  assert.equal(res.status, 200);
  const rows = res.body as { id: string; state: string; name: string }[];
  const child = rows.find((r) => r.id === a.id.slice(0, 8));
  assert.ok(child, "spawned child present in the tree");
  assert.equal(child.state, "running");
  assert.equal(child.name, "w");
});

test("GET /live/events streams a rows frame on connect and after each accepted entry", async () => {
  const t = setup(async (c) => {
    c.emit({ kind: "message", role: "assistant", text: "on it" });
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  const path = sock();
  const server = await listen(t.daemon, path);
  let frames = 0;
  let req!: ClientRequest;
  try {
    await new Promise<void>((resolve, reject) => {
      req = request({ socketPath: path, path: "/live/events", headers: { accept: "text/event-stream", authorization: `Bearer ${op}` } }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers["content-type"], "text/event-stream");
        let buf = "";
        res.on("data", (d) => {
          buf += d.toString();
          while (buf.includes("event: rows")) {
            buf = buf.slice(buf.indexOf("event: rows") + "event: rows".length);
            frames++;
          }
        });
        res.on("error", reject);
        resolve();
      });
      req.on("error", reject);
      req.end();
    });
    await until(() => frames >= 1); // the initial snapshot written on connect
    assert.equal(frames, 1);
    await t.spawn();
    await t.orchestrator.idle();
    await until(() => frames >= 2); // entries from the spawned agent broadcast more frames
    assert.ok(frames >= 2);
  } finally {
    req.destroy();
    server.close();
  }
});

test("GET /live/events is operator-scoped and refuses unauthenticated clients", async () => {
  const t = setup(async () => {});
  const path = sock();
  const server = await listen(t.daemon, path);
  try {
    const denied = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ socketPath: path, path: "/live/events", headers: { accept: "text/event-stream" } }, (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => resolve({ status: res.statusCode!, body: s }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(denied.status, 401);
    assert.match(denied.body, /missing or invalid token/);
  } finally {
    server.close();
  }
});

test("a file-loaded extension stream route streams SSE frames and enforces its scope", async () => {
  const t = setup(async () => {});
  const dir = tmpDir("pomtreed-ext-");
  const sub = join(dir, "tick");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "manifest.json"), JSON.stringify({ apiVersion: 2, name: "tick", entry: "entry.mjs", capabilities: { routes: true }, deps: [] }));
  writeFileSync(
    join(sub, "entry.mjs"),
    `
export default {
  manifest: { name: "tick", entry: "entry.mjs", capabilities: {}, deps: [] },
  init(host) {
    host.stream({
      method: "GET",
      path: "/v1/ext/tick/stream",
      scope: { kind: "ext" },
      handler: (req, conn) => {
        conn.write(": connected\\n\\n");
        conn.write("event: tick\\ndata: one\\n\\n");
        conn.end();
      },
    });
  },
};
`,
  );
  await t.extensions.load(dir);
  const path = sock();
  const server = await listen(t.daemon, path);
  const ext = issueToken(SECRET, { scope: "ext", name: "tick" });
  const get = (token?: string) =>
    new Promise<{ status: number; contentType?: string; cacheControl?: string; body: string }>((resolve, reject) => {
      const req = request(
        {
          socketPath: path,
          path: "/v1/ext/tick/stream",
          headers: token ? { authorization: `Bearer ${token}` } : {},
        },
        (res) => {
          let s = "";
          res.on("data", (d) => (s += d));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              contentType: res.headers["content-type"],
              cacheControl: res.headers["cache-control"],
              body: s,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    // Scope is checked before SSE headers: an unauthenticated call gets JSON, not a stream.
    const denied = await get();
    assert.equal(denied.status, 401);
    assert.match(denied.body, /missing or invalid token/);

    const ok = await get(ext);
    assert.equal(ok.status, 200);
    assert.equal(ok.contentType, "text/event-stream");
    assert.equal(ok.cacheControl, "no-cache");
    assert.match(ok.body, /: connected/);
    assert.match(ok.body, /event: tick/);
    assert.match(ok.body, /data: one/);
  } finally {
    server.close();
  }
});
