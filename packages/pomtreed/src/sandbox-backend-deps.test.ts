import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ProcessRunner, SandboxRequester } from "@pomtree/core";
import { SECRET_FILE_MAX_BYTES, createSandboxBackendDeps, readSecretFileByDescriptor } from "./sandbox-backend-deps.ts";
import type { SandboxBackendDepsOptions, SecretFileRead } from "./sandbox-backend-deps.ts";

const UA = "pomtree-test-agent/9";
// The daemon's own secret variable; spelled in two parts so no source line carries the whole name.
const DAEMON_TOKEN_VAR = ["POMTREE", "API", "TOKEN"].join("_");

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

interface Recorded {
  fetches: { input: unknown; headers: Headers }[];
  requests: { url: string; headers: Record<string, string> | undefined }[];
  sockets: { url: string; headers: Record<string, string> | undefined }[];
  reads: string[];
}
function build(over: Partial<SandboxBackendDepsOptions> = {}, files: Record<string, SecretFileRead> = {}) {
  const rec: Recorded = { fetches: [], requests: [], sockets: [], reads: [] };
  const request = Object.assign(
    async (url: string, init: { headers?: Record<string, string> }) => {
      rec.requests.push({ url, headers: init.headers });
      return { status: 200, headers: {}, body: new Uint8Array() };
    },
    {
      openWebSocket: (url: string, init?: { headers?: Record<string, string> }) => {
        rec.sockets.push({ url, headers: init?.headers });
        return {} as WebSocket;
      },
    },
  ) as unknown as SandboxRequester;
  const opts: SandboxBackendDepsOptions = {
    id: "toybox",
    credentials: ["apiKey"],
    config: { baseUrl: "http://127.0.0.1:1" },
    userAgent: UA,
    fetch: (async (input: unknown, init?: RequestInit) => {
      rec.fetches.push({ input, headers: new Headers(init?.headers) });
      return new Response("ok");
    }) as typeof fetch,
    request,
    env: { POMTREED_SANDBOX_TOYBOX_APIKEY_FILE: "/secrets/toybox-api-key" },
    readSecretFile: (p) => {
      rec.reads.push(p);
      const f = files[p];
      if (f === undefined) throw new Error("ENOENT: no such file");
      return f;
    },
    log: () => {},
    now: () => 42,
    declaresRun: false,
    ...over,
  };
  return { deps: createSandboxBackendDeps(opts), rec, opts };
}

describe("credential reader", () => {
  const ok = { "/secrets/toybox-api-key": { mode: 0o100600, content: "s3cret-value\n" } };

  test("returns the declared credential's contents, newline trimmed, from the derived _FILE variable", async () => {
    const { deps, rec } = build({}, ok);
    assert.equal(await deps.credential("apiKey"), "s3cret-value");
    assert.deepEqual(rec.reads, ["/secrets/toybox-api-key"]);
  });

  test("re-reads on every call (rotation is picked up)", async () => {
    const files = { "/secrets/toybox-api-key": { mode: 0o600, content: "one" } };
    const { deps } = build({}, files);
    assert.equal(await deps.credential("apiKey"), "one");
    files["/secrets/toybox-api-key"] = { mode: 0o600, content: "two" };
    assert.equal(await deps.credential("apiKey"), "two");
  });

  test("a file readable by group or other (0644, 0640, 0604) is refused through the shared check without exposing its contents", async () => {
    for (const mode of [0o644, 0o640, 0o604]) {
      const { deps } = build({}, { "/secrets/toybox-api-key": { mode, content: "s3cret-value" } });
      await assert.rejects(deps.credential("apiKey"), (e: Error) => {
        assert.match(e.message, /POMTREED_SANDBOX_TOYBOX_APIKEY_FILE: \/secrets\/toybox-api-key is readable by group\/other; run chmod 600/);
        assert.ok(!e.message.includes("s3cret-value"));
        return true;
      });
    }
  });

  test("an undeclared name is refused before any variable or file is touched", async () => {
    const { deps, rec } = build({ env: { POMTREED_SANDBOX_TOYBOX_OTHER_FILE: "/secrets/other" } }, ok);
    await assert.rejects(deps.credential("other"), /did not declare \(declared: apiKey\).*add it to provides\[\]\.credentials/);
    assert.deepEqual(rec.reads, []);
  });

  test("another backend's credential, an extension credential and the daemon token are unreachable", async () => {
    const env = {
      POMTREED_SANDBOX_OTHERBOX_API_KEY_FILE: "/secrets/other-box",
      POMTREED_EXT_TOYBOX_APIKEY_FILE: "/secrets/ext",
      [DAEMON_TOKEN_VAR]: "daemon-token-value",
      [`${DAEMON_TOKEN_VAR}_FILE`]: "/secrets/daemon",
    };
    const files = {
      "/secrets/other-box": { mode: 0o600, content: "other" },
      "/secrets/ext": { mode: 0o600, content: "ext" },
      "/secrets/daemon": { mode: 0o600, content: "daemon" },
    };
    const { deps, rec } = build({ env }, files);
    for (const name of ["OTHERBOX_API_KEY", DAEMON_TOKEN_VAR, "../daemon", "toybox.apiKey"]) {
      await assert.rejects(deps.credential(name), /did not declare/);
    }
    // The declared name resolves only from its own variable, which is unset here.
    await assert.rejects(deps.credential("apiKey"), /set POMTREED_SANDBOX_TOYBOX_APIKEY_FILE to the absolute path/);
    assert.deepEqual(rec.reads, []);
  });

  test("an unset variable names the variable to set; a relative path and an empty or unreadable file are refused", async () => {
    await assert.rejects(build({ env: {} }, ok).deps.credential("apiKey"), /needs credential apiKey; set POMTREED_SANDBOX_TOYBOX_APIKEY_FILE/);
    await assert.rejects(build({ env: { POMTREED_SANDBOX_TOYBOX_APIKEY_FILE: "rel/key" } }, ok).deps.credential("apiKey"), /must be an absolute path/);
    await assert.rejects(build({}, { "/secrets/toybox-api-key": { mode: 0o600, content: "\n" } }).deps.credential("apiKey"), /is empty; write the credential/);
    await assert.rejects(build({}, {}).deps.credential("apiKey"), /cannot read \/secrets\/toybox-api-key: ENOENT.*check the path/);
  });

  test("the real descriptor reader: 0600 is read, 0644 is refused (the same files, one mode apart)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pomtree-g3-cred-"));
    roots.push(dir);
    const file = join(dir, "key");
    writeFileSync(file, "real-secret\n");
    chmodSync(file, 0o600);
    const mk = () => build({ env: { POMTREED_SANDBOX_TOYBOX_APIKEY_FILE: file }, readSecretFile: readSecretFileByDescriptor }).deps;
    assert.equal(await mk().credential("apiKey"), "real-secret");
    chmodSync(file, 0o644);
    await assert.rejects(mk().credential("apiKey"), (e: Error) => {
      assert.match(e.message, /readable by group\/other/);
      assert.ok(!e.message.includes("real-secret"));
      return true;
    });
  });
});

describe("credential file shape", () => {
  const mkdir = () => {
    const dir = mkdtempSync(join(tmpdir(), "pomtree-g3-cred-"));
    roots.push(dir);
    return dir;
  };
  const deps = (file: string) => build({ env: { POMTREED_SANDBOX_TOYBOX_APIKEY_FILE: file }, readSecretFile: readSecretFileByDescriptor }).deps;

  test("an oversize file is refused without reading it", async () => {
    const file = join(mkdir(), "big");
    writeFileSync(file, "x".repeat(SECRET_FILE_MAX_BYTES + 1), { mode: 0o600 });
    await assert.rejects(deps(file).credential("apiKey"), /over the 65536-byte limit for a credential/);
    writeFileSync(file, "x".repeat(SECRET_FILE_MAX_BYTES), { mode: 0o600 }); // the boundary reads
    assert.equal((await deps(file).credential("apiKey")).length, SECRET_FILE_MAX_BYTES);
  });

  test("a FIFO at the path is refused promptly instead of hanging the daemon", async (t) => {
    const file = join(mkdir(), "pipe");
    try {
      execFileSync("mkfifo", [file]);
    } catch (e) {
      t.skip(`mkfifo is unavailable here (${e instanceof Error ? e.message : String(e)}); the FIFO case was not exercised`);
      return;
    }
    chmodSync(file, 0o600);
    // A blocking open() of a FIFO stalls the whole event loop, so no in-process timeout could fire: the read runs in a child with a
    // hard timeout, and a missing O_NONBLOCK fails here in seconds (execFileSync throws ETIMEDOUT) instead of hanging the suite.
    const mod = new URL("./sandbox-backend-deps.ts", import.meta.url).href;
    const script = `import { readSecretFileByDescriptor as r } from ${JSON.stringify(mod)}; try { r(process.argv[1]); console.log("read"); } catch (e) { console.log(e.message); }`;
    const scale = Number(process.env.POMTREE_TEST_TIMEOUT_SCALE ?? "1") || 1;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, file], { timeout: 5000 * scale, encoding: "utf8" });
    assert.match(out, /is not a regular file; point the variable at a plain file/);
  });
});

describe("frozen facade", () => {
  test("a provider cannot replace the facade's members or mutate the shared config", () => {
    const shared = { nested: { a: 1 } };
    const { deps } = build({ config: shared });
    assert.throws(() => {
      (deps as { fetch: unknown }).fetch = () => 1;
    }, TypeError);
    assert.throws(() => {
      (deps as { credential: unknown }).credential = async () => "x";
    }, TypeError);
    assert.throws(() => {
      (deps.request as { openWebSocket: unknown }).openWebSocket = () => 1;
    }, TypeError);
    assert.throws(() => {
      (deps.config as { nested: { a: number } }).nested.a = 2;
    }, TypeError);
    assert.throws(() => {
      (deps.config as Record<string, unknown>).extra = 1;
    }, TypeError);
    assert.equal(shared.nested.a, 1);
    deps.config; // a copy: mutating the daemon's own object later does not reach the provider
    shared.nested.a = 9;
    assert.equal((deps.config as { nested: { a: number } }).nested.a, 1);
  });
});

describe("User-Agent stamping", () => {
  test("negative control: the underlying transports carry no User-Agent until the facade stamps one", async () => {
    const { opts } = build();
    const h = new Headers();
    await opts.fetch("http://x", { headers: h });
    assert.equal(h.get("user-agent"), null);
  });

  test("fetch stamps the configured User-Agent (string, URL and Request inputs)", async () => {
    const { deps, rec } = build();
    await deps.fetch("http://x/a");
    await deps.fetch(new URL("http://x/b"), { headers: { Authorization: "Bearer t" } });
    await deps.fetch(new Request("http://x/c", { headers: { "x-keep": "1" } }));
    assert.equal(rec.fetches.length, 3);
    for (const f of rec.fetches) assert.equal(f.headers.get("user-agent"), UA);
    assert.equal(rec.fetches[1]?.headers.get("authorization"), "Bearer t");
    assert.equal(rec.fetches[2]?.headers.get("x-keep"), "1");
  });

  test("request and openWebSocket stamp the configured User-Agent and keep the caller's other headers", async () => {
    const { deps, rec } = build();
    await deps.request("https://x/a", { method: "GET" });
    await deps.request("https://x/b", { method: "POST", headers: { "X-Api": "1" } });
    deps.request.openWebSocket("wss://x/c");
    deps.request.openWebSocket("wss://x/d", { headers: { "X-Api": "1" }, protocols: "p" });
    for (const r of [...rec.requests, ...rec.sockets]) assert.equal(r.headers?.["User-Agent"], UA);
    assert.equal(rec.requests[1]?.headers?.["X-Api"], "1");
    assert.equal(rec.sockets[1]?.headers?.["X-Api"], "1");
  });

  test("a call that sets its own User-Agent throws a TypeError naming the rule, on every path, in any case", async () => {
    const { deps, rec } = build();
    const rule = /sandbox backend toybox: User-Agent is set by the daemon from workflow\.fetch\.userAgent; remove the header/;
    assert.throws(() => deps.fetch("http://x", { headers: { "user-agent": "mine" } }), rule);
    assert.throws(() => deps.fetch("http://x", { headers: [["User-Agent", "mine"]] }), rule);
    assert.throws(() => deps.fetch(new Request("http://x", { headers: { "USER-AGENT": "mine" } })), rule);
    assert.throws(() => deps.request("https://x", { method: "GET", headers: { "User-agent": "mine" } }), TypeError);
    assert.throws(() => deps.request.openWebSocket("wss://x", { headers: { "USER-AGENT": "mine" } }), rule);
    assert.deepEqual([rec.fetches.length, rec.requests.length, rec.sockets.length], [0, 0, 0]);
  });
});

describe("headers and redirects", () => {
  test("request and openWebSocket reject a Headers object or a tuple array", () => {
    const { deps, rec } = build();
    const rule = /request headers must be a plain object of name to string/;
    for (const h of [new Headers({ a: "b" }), [["a", "b"]]]) {
      assert.throws(() => deps.request("https://x", { method: "GET", headers: h as never }), rule);
      assert.throws(() => deps.request.openWebSocket("wss://x", { headers: h as never }), rule);
    }
    assert.deepEqual([rec.requests.length, rec.sockets.length], [0, 0]);
  });

  test("fetch never follows a redirect on its own", async () => {
    const seen: (RequestRedirect | undefined)[] = [];
    const { deps } = build({
      fetch: (async (_i: unknown, init?: RequestInit) => {
        seen.push(init?.redirect);
        return new Response("ok");
      }) as typeof fetch,
    });
    await deps.fetch("http://x", { redirect: "follow" });
    await deps.fetch("http://x");
    assert.deepEqual(seen, ["manual", "manual"]);
  });
});

describe("config values", () => {
  test("a binary buffer in config is rejected with a clear message; null headers get the helpful message", () => {
    assert.throws(() => build({ config: { blob: new Uint8Array([1, 2]) } }), /config value config\.blob is a binary buffer, which cannot be frozen/);
    assert.doesNotThrow(() => build({ config: { empty: new Uint8Array(0) } }));
    const { deps } = build();
    assert.throws(() => deps.request("https://x", { method: "GET", headers: null as never }), /request headers must be a plain object/);
  });
});

describe("the rest of the deps", () => {
  test("config, log and now pass through", () => {
    const { deps } = build();
    assert.deepEqual(deps.config, { baseUrl: "http://127.0.0.1:1" });
    assert.equal(deps.now(), 42);
  });

  test("run is present only when the manifest declares it", () => {
    const run: ProcessRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    assert.equal("run" in build({ run, declaresRun: false }).deps, false);
    assert.equal(build({ run, declaresRun: true }).deps.run, run);
  });

  test("a declared run dep with no runner supplied refuses with the action", () => {
    assert.throws(() => build({ declaresRun: true }), /declares the run dep but the daemon supplied no process runner; wire a ProcessRunner/);
  });
});
