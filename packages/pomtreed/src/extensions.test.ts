import { EXTENSION_ACTIONS, EXTENSION_API_VERSION, isExtensionAction } from "@pomtree/core";
import type { ExtensionCapabilities, ExtensionDepName, ExtensionDeps, ExtensionHost, ExtensionManifest } from "@pomtree/core";
import { tmpDir } from "@pomtree/testing";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { issueToken, verifyToken } from "./auth.ts";
import { listen } from "./server.ts";
import { SECRET, op, setup, until } from "./test-setup.ts";
import { parseManifest } from "./extension-manifest.ts";
import { createExtensionRegistry } from "./extensions.ts";
import { EXPIRED, raceUntil } from "./workflows.ts";
import { bearer, sockRequest } from "./test-http.ts";

// Everything declared: the default for fixtures that are not about capability enforcement (those pass their own blocks).
const ALL_CAPS: ExtensionCapabilities = { routes: true, verbs: true, journalKinds: true, hooks: { journal: true, spawn: true } };
// TODO(seam-exhaustive): make seam checks fail when the surface grows. Current behavior: ALL_DEPS, CAP_OPS, DEP_OPS are manual.
// No check ties them to ExtensionCapabilities or ExtensionDepName, so a new flag or dep with no probe is not caught.
const ALL_DEPS: ExtensionDepName[] = ["registry", "journal", "record", "deliver", "authorize", "credentials", "store"];

function writeExt(dir: string, name: string, manifest: unknown, entrySource?: string) {
  const sub = join(dir, name);
  mkdirSync(sub, { recursive: true });
  // apiVersion defaults to the host's; a test passes `apiVersion: undefined` (omitted) or another value to exercise the refusal.
  writeFileSync(
    join(sub, "manifest.json"),
    JSON.stringify({ apiVersion: EXTENSION_API_VERSION, capabilities: ALL_CAPS, deps: ALL_DEPS, ...(manifest as object) }),
  );
  if (entrySource !== undefined) writeFileSync(join(sub, "entry.mjs"), entrySource);
}

// A valid extension: an `ext`-scoped route, a namespaced verb, a journal kind, and an onJournal hook.
const demoEntry = `
export default {
  manifest: { name: "demo", entry: "entry.mjs", capabilities: {}, deps: [] },
  init(host) {
    host.route({
      method: "GET",
      path: "/v1/ext/demo/ping",
      scope: { kind: "ext" },
      handler: (req) => ({ status: 200, body: { ok: true, name: "demo" } }),
    });
    host.route({
      method: "POST",
      path: "/v1/ext/demo/record",
      scope: { kind: "ext" },
      handler: async (req) => {
        const b = (req.body && typeof req.body === "object") ? req.body : {};
        const entry = await host.deps.record(b.agent ?? null, b.kind, b.data, b.key ?? "test-key");
        return { status: 200, body: entry };
      },
    });
    host.verb({ extension: "demo", verb: "ping", usage: "demo ping", audience: "operator", endpoint: { method: "GET", path: "/v1/ext/demo/ping" } });
    host.journalKind({ kind: "visited", validate: (d) => (d !== null && typeof d === "object" && !Array.isArray(d)) ? true : "visited data must be an object" });
    host.onJournal(async (e) => {
      if (e.payload.kind === "started") {
        await host.deps.record(e.agent, "visited", { seq: e.seq }, "demo-visited:" + e.seq);
      }
    });
  },
};
`;

// A throwing onJournal hook: exercises the per-hook circuit breaker.
const boomEntry = `
export default {
  manifest: { name: "boom", entry: "entry.mjs", capabilities: {}, deps: [] },
  init(host) {
    host.journalKind({ kind: "attempt", validate: () => true });
    host.onJournal(async (e) => {
      if (e.payload.kind === "started") {
        await host.deps.record(e.agent, "attempt", { seq: e.seq }, "boom-attempt:" + e.seq);
        throw new Error("boom");
      }
    });
  },
};
`;

test("extension stops: strict mode reports failed names after stopping others; default callers stay best-effort; raw errors are never logged", async () => {
  for (const mode of ["all", "shutdown", "legacy"] as const) {
    const t = setup(async () => {});
    const logs: string[] = [];
    const stops: string[] = [];
    const registry = createExtensionRegistry({
      hostId: "h1",
      now: Date.now,
      registry: t.fakes.registry,
      journal: t.fakes.journal,
      mailbox: t.fakes.mailbox,
      root: () => t.daemon.root(),
      log: (line) => logs.push(line),
    });
    registry.registerBuiltin({
      manifest: { name: "bad", entry: "builtin", capabilities: ALL_CAPS, deps: ALL_DEPS },
      stop: () => {
        stops.push("bad");
        throw new Error("SECRET-STOP-DIAGNOSTIC");
      },
    });
    registry.registerBuiltin({
      manifest: { name: "good", entry: "builtin", capabilities: ALL_CAPS, deps: ALL_DEPS },
      stop: () => {
        stops.push("good");
      },
    });
    registry.registerBuiltin({
      manifest: { name: "keep", entry: "builtin", capabilities: ALL_CAPS, deps: ALL_DEPS },
      stop: () => {
        stops.push("keep");
      },
    });
    if (mode === "all") await assert.rejects(registry.stopAll({ throwOnStopFailure: true }), /^Error: extensions failed to stop: bad$/);
    else if (mode === "shutdown")
      await assert.rejects(registry.stopForShutdown(["keep"], { throwOnStopFailure: true }), /^Error: extensions failed to stop: bad$/);
    else assert.deepEqual(await registry.stopForShutdown([]), { stopped: ["bad", "good", "keep"], retained: [] });
    assert.deepEqual(stops, mode === "shutdown" ? ["bad", "good"] : ["bad", "good", "keep"]);
    assert.ok(logs.some((line) => line === "extension bad failed to stop"));
    assert.doesNotMatch(logs.join("\n"), /SECRET-STOP-DIAGNOSTIC/);
    await registry.finishShutdown();
  }
});

test("strict extension stops invoke stop before joining a journal callback that stop itself releases", async () => {
  for (const mode of ["all", "shutdown"] as const) {
    const t = setup(async () => {});
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const order: string[] = [];
    const registry = createExtensionRegistry({
      hostId: "h1",
      now: Date.now,
      registry: t.fakes.registry,
      journal: t.fakes.journal,
      mailbox: t.fakes.mailbox,
      root: () => t.daemon.root(),
    });
    registry.registerBuiltin({
      manifest: { name: "hook", entry: "builtin", capabilities: ALL_CAPS, deps: ALL_DEPS },
      init: (host) => {
        host.onJournal(async () => {
          order.push("hook-start");
          entered();
          await gate;
          order.push("hook-finished");
        });
      },
      stop: () => {
        order.push("stop");
        release();
      },
    });
    await registry.startAll();
    const root = await t.daemon.root();
    await t.fakes.journal.append({
      agent: root.id,
      host: root.host,
      generation: root.generation,
      payload: { kind: "started" },
      idempotencyKey: `release-by-stop-${mode}`,
    });
    await started;
    const deadlineAt = Date.now() + 500;
    const stopping =
      mode === "all" ? registry.stopAll({ throwOnStopFailure: true, deadlineAt }) : registry.stopForShutdown([], { throwOnStopFailure: true, deadlineAt });
    try {
      assert.notEqual(
        await raceUntil(
          stopping.then(() => true),
          deadlineAt,
        ),
        EXPIRED,
        "stop must release its own callback without an external release",
      );
      assert.deepEqual(order, ["hook-start", "stop", "hook-finished"]);
    } finally {
      release();
      await stopping;
      await registry.finishShutdown();
    }
  }
});

test("standalone strict stopAll bounds a journal callback that does not cooperate with stop", async () => {
  const t = setup(async () => {});
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let stopped = false;
  const registry = createExtensionRegistry({
    hostId: "h1",
    now: Date.now,
    registry: t.fakes.registry,
    journal: t.fakes.journal,
    mailbox: t.fakes.mailbox,
    root: () => t.daemon.root(),
  });
  registry.registerBuiltin({
    manifest: { name: "hook", entry: "builtin", capabilities: ALL_CAPS, deps: ALL_DEPS },
    init: (host) => {
      host.onJournal(async () => {
        entered();
        await gate;
      });
    },
    stop: () => {
      stopped = true;
    },
  });
  await registry.startAll();
  const root = await t.daemon.root();
  await t.fakes.journal.append({
    agent: root.id,
    host: root.host,
    generation: root.generation,
    payload: { kind: "started" },
    idempotencyKey: "uncooperative-hook",
  });
  await started;
  try {
    await assert.rejects(registry.stopAll({ throwOnStopFailure: true, deadlineAt: Date.now() + 20 }), /journal dispatch did not settle before deadline/);
    assert.equal(stopped, true, "stop was attempted before the bounded callback join");
  } finally {
    release();
    await registry.finishShutdown();
  }
});

test("finishShutdown is an observable join for an already-running journal hook", async () => {
  const t = setup(async () => {});
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const registry = createExtensionRegistry({
    hostId: "h1",
    now: Date.now,
    registry: t.fakes.registry,
    journal: t.fakes.journal,
    mailbox: t.fakes.mailbox,
    root: () => t.daemon.root(),
  });
  registry.registerBuiltin({
    manifest: { name: "hook", entry: "builtin", capabilities: ALL_CAPS, deps: ALL_DEPS },
    init: (host) => {
      host.onJournal(async () => {
        entered();
        await gate;
      });
    },
  });
  await registry.startAll();
  await t.daemon.root();
  const root = await t.daemon.root();
  await t.fakes.journal.append({ agent: root.id, host: root.host, generation: root.generation, payload: { kind: "started" }, idempotencyKey: "hook-start" });
  await started;
  let joined = false;
  const finished = registry.finishShutdown().then(() => {
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  release();
  await finished;
  await registry.stopAll({ throwOnStopFailure: true });
});

test("ext tokens round-trip and reject unsafe names", () => {
  assert.deepEqual(verifyToken(SECRET, issueToken(SECRET, { scope: "ext", name: "my-ext" })), { scope: "ext", name: "my-ext" });
  assert.deepEqual(verifyToken(SECRET, issueToken(SECRET, { scope: "ext", name: "a1_b-c" })), { scope: "ext", name: "a1_b-c" });
  for (const bad of ["A", "a.b", "a/b", "a\\b", "..", "a b", "", "-a", "_a", "a..b", "a\nb"]) {
    assert.throws(() => issueToken(SECRET, { scope: "ext", name: bad }), /invalid extension name/);
  }
  assert.equal(verifyToken(SECRET, "ext.a/b.xyz"), null);
  assert.equal(verifyToken(SECRET, "ext.a.b.xyz"), null); // four parts: not an ext token shape
});

test("daemon-owned extension names (egress, pomtreed) are refused by manifest load and builtin registration", async () => {
  const t = setup(async () => {});
  const dir = tmpDir("pomtreed-ext-reserved-");
  for (const name of ["egress", "pomtreed"])
    writeExt(dir, `x-${name}`, { name, entry: "entry.mjs" }, `export default { manifest: { name: ${JSON.stringify(name)}, entry: "entry.mjs" } };`);
  writeExt(
    dir,
    "pomtreed-ok",
    { name: "pomtreed-ok", entry: "entry.mjs" },
    'export default { manifest: { name: "pomtreed-ok", entry: "entry.mjs", capabilities: {}, deps: [] } };',
  );
  const loaded = await t.extensions.load(dir);
  for (const name of ["egress", "pomtreed"]) {
    const l = loaded.find((x) => x.manifest.name === `x-${name}`);
    assert.equal(l?.status, "failed");
    assert.match(l?.error ?? "", /reserved for the daemon/);
    assert.throws(() => t.extensions.registerBuiltin({ manifest: { name, entry: "builtin", capabilities: {}, deps: [] } }), /reserved for the daemon/);
  }
  assert.equal(loaded.find((x) => x.manifest.name === "pomtreed-ok")?.status, "ok");
});

test("a file manifest must declare apiVersion equal to EXTENSION_API_VERSION: missing, other numbers and non-numbers are refused at load, naming the extension", async () => {
  const t = setup(async () => {});
  const dir = tmpDir("pomtreed-ext-apiversion-");
  const entry = 'export default { manifest: { name: "x", entry: "entry.mjs", capabilities: {}, deps: [] } };';
  writeExt(dir, "good", { name: "good", entry: "entry.mjs" }, entry);
  writeExt(dir, "missing", { name: "missing", entry: "entry.mjs", apiVersion: undefined }, entry);
  writeExt(dir, "future", { name: "future", entry: "entry.mjs", apiVersion: EXTENSION_API_VERSION + 1 }, entry);
  writeExt(dir, "zero", { name: "zero", entry: "entry.mjs", apiVersion: 0 }, entry);
  writeExt(dir, "str", { name: "str", entry: "entry.mjs", apiVersion: "1" }, entry);
  writeExt(dir, "nul", { name: "nul", entry: "entry.mjs", apiVersion: null }, entry);
  const loaded = await t.extensions.load(dir);
  const by = (n: string) => loaded.find((l) => l.manifest.name === n);
  assert.equal(by("good")?.status, "ok");
  assert.match(by("missing")?.error ?? "", /^extension missing: manifest\.json has no "apiVersion"; this host speaks extension API 1$/);
  assert.match(by("future")?.error ?? "", /^extension future: manifest apiVersion 2 is not supported; this host speaks extension API 1$/);
  assert.match(by("zero")?.error ?? "", /^extension zero: manifest apiVersion 0 is not supported/);
  assert.match(by("str")?.error ?? "", /^extension str: manifest apiVersion "1" is not supported/);
  assert.match(by("nul")?.error ?? "", /^extension nul: manifest apiVersion null is not supported/);
  for (const n of ["missing", "future", "zero", "str", "nul"]) assert.equal(by(n)?.status, "failed");
  // A refused extension exposes nothing and its entry never ran (no routes, verbs or state owner).
  assert.deepEqual(
    t.extensions.names().filter((n) => n !== "good" && !["observe", "reports", "cron"].includes(n)),
    [],
  );
});

test("a compiled-in extension may omit apiVersion (the build's) but a present different one is refused", () => {
  const t = setup(async () => {});
  t.extensions.registerBuiltin({ manifest: { name: "bi-ok", entry: "builtin", capabilities: ALL_CAPS, deps: ALL_DEPS } });
  t.extensions.registerBuiltin({ manifest: { name: "bi-same", entry: "builtin", capabilities: ALL_CAPS, deps: ALL_DEPS, apiVersion: EXTENSION_API_VERSION } });
  assert.throws(
    () =>
      t.extensions.registerBuiltin({
        manifest: { name: "bi-bad", entry: "builtin", capabilities: ALL_CAPS, deps: ALL_DEPS, apiVersion: 2 as unknown as typeof EXTENSION_API_VERSION },
      }),
    /^Error: extension bi-bad: manifest apiVersion 2 is not supported/,
  );
  assert.ok(!t.extensions.names().includes("bi-bad"));
});

test("load validates manifests and registers routes/verbs/hooks", async () => {
  const t = setup(async () => {});
  const dir = tmpDir("pomtreed-ext-");
  writeExt(dir, "demo", { name: "demo", entry: "entry.mjs" }, demoEntry);
  writeExt(dir, "boom", { name: "boom", entry: "entry.mjs" }, boomEntry);
  writeExt(dir, "badname", { name: "Bad.Name", entry: "entry.mjs" }, "export default {};");
  writeExt(dir, "badescape", { name: "escape", entry: "../outside.mjs" });

  const loaded = await t.extensions.load(dir);
  assert.ok(loaded.some((l) => l.manifest.name === "demo" && l.status === "ok"));
  assert.ok(loaded.some((l) => l.manifest.name === "boom" && l.status === "ok"));
  const failed = loaded.filter((l) => l.status === "failed");
  assert.equal(failed.length, 2);
  assert.ok(failed.some((l) => l.manifest.name === "badname")); // invalid manifest name (parse fails -> placeholder name = dir name)
  assert.ok(failed.some((l) => l.manifest.name === "escape")); // entry escapes the extension dir

  // Builtin routes (e.g. the observe extension's /live, /reports) are registered separately from
  // file-loaded extensions; this assertion scopes to the /v1/ext/ prefix the demo registers under.
  assert.deepEqual(
    t.extensions
      .routes()
      .filter((r) => r.path.startsWith("/v1/ext/"))
      .map((r) => `${r.method} ${r.path}`),
    ["GET /v1/ext/demo/ping", "POST /v1/ext/demo/record"],
  );
  const verbs = t.extensions.verbs();
  assert.equal(verbs.length, 1);
  assert.equal(verbs[0]!.verb, "ping");
  assert.equal(verbs[0]!.extension, "demo");
});

test("extension routes are mounted and enforce their scope", async () => {
  const t = setup(async () => {});
  const dir = tmpDir("pomtreed-ext-");
  writeExt(dir, "demo", { name: "demo", entry: "entry.mjs" }, demoEntry);
  await t.extensions.load(dir);

  const sock = join(tmpDir("pomtreed-"), "s.sock");
  const server = await listen(t.daemon, sock);
  const ext = issueToken(SECRET, { scope: "ext", name: "demo" });
  const agent = issueToken(SECRET, { scope: "agent", agent: "a1", generation: 0, expiry: Date.now() + 60_000 });
  const get = async (path: string, token?: string) => {
    const r = await sockRequest(sock, path, { headers: bearer(token) });
    return { status: r.status, body: JSON.parse(r.body) };
  };
  try {
    assert.equal((await get("/v1/ext/demo/ping", ext)).status, 200);
    assert.equal((await get("/v1/ext/demo/ping", op)).status, 403); // operator is not an ext principal
    assert.equal((await get("/v1/ext/demo/ping", agent)).status, 403); // agent is not an ext principal
    assert.equal((await get("/v1/ext/demo/ping")).status, 401); // no token
    const cmds = await get("/v1/ext/commands", op);
    assert.equal(cmds.status, 200);
    assert.deepEqual(
      cmds.body.map((v: any) => v.verb),
      ["ping"],
    );
    assert.equal((await get("/v1/ext/commands", ext)).status, 403); // verb table is operator-only
  } finally {
    server.close();
  }
});

test("record namespaces and validates journal kinds", async () => {
  const t = setup(async () => {});
  const dir = tmpDir("pomtreed-ext-");
  writeExt(dir, "demo", { name: "demo", entry: "entry.mjs" }, demoEntry);
  await t.extensions.load(dir);
  const root = await t.daemon.root();

  const sock = join(tmpDir("pomtreed-"), "s.sock");
  const server = await listen(t.daemon, sock);
  const ext = issueToken(SECRET, { scope: "ext", name: "demo" });
  const post = (body: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = request(
        {
          socketPath: sock,
          path: "/v1/ext/demo/record",
          method: "POST",
          headers: { authorization: `Bearer ${ext}`, "content-type": "application/json", "content-length": Buffer.byteLength(data) },
        },
        (res) => {
          let s = "";
          res.on("data", (d) => (s += d));
          res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(s) }));
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  try {
    const ok = await post({ kind: "visited", data: { page: "/x" }, key: "k1", idempotencyKey: "k1" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.payload.kind, "ext.demo.visited"); // namespaced
    assert.equal(ok.body.agent, root.id); // null agent resolves to the root supervisor
    assert.equal((await post({ kind: "nope", data: {}, key: "k2", idempotencyKey: "k2" })).status, 500); // undeclared kind
    assert.equal((await post({ kind: "visited", data: "not-an-object", key: "k3", idempotencyKey: "k3" })).status, 500); // failed validation
  } finally {
    server.close();
  }
});

test("onJournal hooks fire and a throwing hook is disabled", async () => {
  const t = setup(async () => {});
  const dir = tmpDir("pomtreed-ext-");
  writeExt(dir, "demo", { name: "demo", entry: "entry.mjs" }, demoEntry);
  writeExt(dir, "boom", { name: "boom", entry: "entry.mjs" }, boomEntry);
  await t.extensions.load(dir);
  await t.extensions.startAll();

  await t.daemon.root(); // "started" (root) -> hooks fire
  await t.spawn(); // "started" (child)
  await t.orchestrator.idle();

  await until(
    async () =>
      t.journal.entries.filter((e) => e.payload.kind === "ext.demo.visited").length === 2 &&
      t.journal.entries.filter((e) => e.payload.kind === "ext.boom.attempt").length === 1,
  );
  assert.equal(t.journal.entries.filter((e) => e.payload.kind === "ext.demo.visited").length, 2);
  assert.equal(t.journal.entries.filter((e) => e.payload.kind === "ext.boom.attempt").length, 1);
});

test("manifest store: only {name: state} is admitted", async () => {
  const t = setup(async () => {});
  const dir = tmpDir("pomtreed-ext-");
  writeExt(dir, "stateful", { name: "stateful", entry: "entry.mjs", store: { name: "state" } }, "export default {};");
  writeExt(dir, "othername", { name: "othername", entry: "entry.mjs", store: { name: "sql" } }, "export default {};");
  writeExt(dir, "extrakeys", { name: "extrakeys", entry: "entry.mjs", store: { name: "state", extra: 1 } }, "export default {};");
  const loaded = await t.extensions.load(dir);
  const status = (n: string) => loaded.find((l) => l.manifest.name === n)?.status;
  assert.equal(status("stateful"), "ok");
  assert.equal(status("othername"), "failed");
  assert.equal(status("extrakeys"), "failed");
  assert.ok(t.extensions.names().includes("stateful"));
  assert.ok(!t.extensions.names().includes("othername"));
});

// --- Capability and dep enforcement: undeclared is denied by the one facade. ---

function capRegistry() {
  const t = setup(async () => {});
  const registry = createExtensionRegistry({
    hostId: "h1",
    now: Date.now,
    registry: t.fakes.registry,
    journal: t.fakes.journal,
    mailbox: t.fakes.mailbox,
    root: () => t.daemon.root(),
  });
  return { t, registry };
}

// Registers a builtin whose init runs `op(host)`; returns the init error message, or "" when it did not throw.
function initError(caps: ExtensionCapabilities, op: (host: ExtensionHost) => void): string {
  const { registry } = capRegistry();
  try {
    registry.registerBuiltin({ manifest: { name: "capx", entry: "builtin", capabilities: caps, deps: [] }, init: (host) => op(host) });
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const noop = () => {};
const CAP_OPS: { op: string; flag: string; caps: ExtensionCapabilities; run: (h: ExtensionHost) => void }[] = [
  {
    op: "host.route",
    flag: "routes",
    caps: { routes: true },
    run: (h) => h.route({ method: "GET", path: "/x", scope: { kind: "public" }, handler: () => ({ status: 200, body: {} }) }),
  },
  { op: "host.stream", flag: "routes", caps: { routes: true }, run: (h) => h.stream({ method: "GET", path: "/x", scope: { kind: "public" }, handler: noop }) },
  {
    op: "host.verb",
    flag: "verbs",
    caps: { verbs: true },
    run: (h) => h.verb({ extension: "capx", verb: "v", usage: "v", audience: "operator", endpoint: { method: "GET", path: "/v" } }),
  },
  { op: "host.journalKind", flag: "journalKinds", caps: { journalKinds: true }, run: (h) => h.journalKind({ kind: "k", validate: () => true }) },
  { op: "host.onJournal", flag: "hooks.journal", caps: { hooks: { journal: true } }, run: (h) => void h.onJournal(noop) },
  { op: "host.onSpawn", flag: "hooks.spawn", caps: { hooks: { spawn: true } }, run: (h) => void h.onSpawn(noop) },
  { op: "host.spawnSpec", flag: "hooks.spawn", caps: { hooks: { spawn: true } }, run: (h) => h.spawnSpec((s) => s) },
];

test("each capability-gated host operation is refused when undeclared (closed message) and allowed when declared; flags are independent", () => {
  for (const c of CAP_OPS) {
    assert.equal(initError({}, c.run), `extension capx: ${c.op} requires capabilities.${c.flag}`, c.op);
    assert.equal(
      initError({ routes: false, verbs: false, journalKinds: false, hooks: { journal: false, spawn: false } }, c.run),
      `extension capx: ${c.op} requires capabilities.${c.flag}`,
      `${c.op} explicit false`,
    );
    assert.equal(initError(c.caps, c.run), "", `${c.op} declared`);
    // Every other flag, all declared, does not grant this one.
    const others = CAP_OPS.filter((o) => o.flag !== c.flag).reduce<ExtensionCapabilities>(
      (acc, o) => ({ ...acc, ...o.caps, hooks: { ...acc.hooks, ...o.caps.hooks } }),
      {},
    );
    assert.match(initError(others, c.run), /requires capabilities\./, `${c.op} not granted by other flags`);
  }
});

test("host.workflow has no capability flag: it is gated by workflow admission, not the manifest", () => {
  const def = { name: "w", validate: (i: unknown) => ({ ok: true as const, value: i as never }), run: async () => {} };
  assert.equal(
    initError({}, (h) => h.workflow(def as never)),
    "",
  );
});

type DepProbe = { dep: ExtensionDepName; op: string; run: (d: ExtensionDeps) => unknown };
const DEP_OPS: DepProbe[] = [
  { dep: "registry", op: "deps.getAgent", run: (d) => d.getAgent("nobody") },
  { dep: "registry", op: "deps.listAgents", run: (d) => d.listAgents() },
  { dep: "journal", op: "deps.journal.read", run: (d) => d.journal.read({}) },
  { dep: "journal", op: "deps.journal.subscribe", run: (d) => d.journal.subscribe({}).close() },
  { dep: "record", op: "deps.record", run: (d) => d.record(null, "k", {}, "key") },
  { dep: "deliver", op: "deps.deliver", run: (d) => d.deliver("nobody", { kind: "message", from: "x", body: "b" } as never, "key") },
  { dep: "authorize", op: "deps.authorize", run: (d) => d.authorize("anything") },
  { dep: "credentials", op: "deps.credential", run: (d) => d.credential("tok") },
];

function depsOf(manifest: Pick<ExtensionManifest, "capabilities" | "deps"> & Partial<ExtensionManifest>, init?: (h: ExtensionHost) => void): ExtensionDeps {
  const { registry } = capRegistry();
  let captured: ExtensionDeps | undefined;
  registry.registerBuiltin({
    manifest: { name: "capx", entry: "builtin", ...manifest },
    init: (h) => {
      init?.(h);
      captured = h.deps;
    },
  });
  return captured as ExtensionDeps;
}

async function depOutcome(deps: ExtensionDepName[], run: (d: ExtensionDeps) => unknown): Promise<string> {
  const d = depsOf({ capabilities: {}, deps, credentials: ["tok"] });
  try {
    await run(d);
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

test("each deps-gated operation is refused when its dep is undeclared (closed message); declared, it is not refused by the gate", async () => {
  for (const p of DEP_OPS) {
    assert.equal(await depOutcome([], p.run), `extension capx: ${p.op} requires deps "${p.dep}"`, p.op);
    const others = (["registry", "journal", "record", "deliver", "authorize", "credentials", "store"] as const).filter((d) => d !== p.dep);
    assert.equal(await depOutcome([...others], p.run), `extension capx: ${p.op} requires deps "${p.dep}"`, `${p.op} not granted by other deps`);
    assert.doesNotMatch(await depOutcome([p.dep], p.run), /requires deps/, `${p.op} declared`);
  }
});

test("deps with no gate stay available with nothing declared: hostId, now, log", async () => {
  const d = depsOf({ capabilities: {}, deps: [] });
  assert.equal(d.hostId, "h1");
  assert.equal(typeof d.now(), "number");
  assert.doesNotThrow(() => d.log("line"));
});

test("deps.authorize is deny-all over a closed action set: false for every action, declared or not in any set", async () => {
  assert.deepEqual(EXTENSION_ACTIONS, []);
  const d = depsOf({ capabilities: {}, deps: ["authorize"] });
  for (const action of ["spawn", "ext.capx.anything", "", "__proto__", "toString"]) assert.equal(await d.authorize(action), false, JSON.stringify(action));
  assert.equal(isExtensionAction("spawn"), false);
});

test("a deps-declared journal read works end to end, and record still requires a declared journal kind", async () => {
  const d = depsOf({ capabilities: { journalKinds: true }, deps: ["journal", "record"] }, (h) => h.journalKind({ kind: "k", validate: () => true }));
  assert.ok(Array.isArray(await d.journal.read({})));
  const entry = await d.record(null, "k", { n: 1 }, "capx-k-1");
  assert.equal((entry.payload as { kind: string }).kind, "ext.capx.k");
});

test("a manifest missing capabilities or deps, or with an invalid block, refuses that extension's load naming it and the field; others load", async () => {
  const { registry } = capRegistry();
  const dir = tmpDir("pomtreed-ext-blocks-");
  const entry = "export default { init() {} };";
  const bad = (name: string, over: Record<string, unknown>) => writeExt(dir, name, { name, entry: "entry.mjs", ...over }, entry);
  writeExt(dir, "good", { name: "good", entry: "entry.mjs", capabilities: {}, deps: [] }, entry);
  bad("nocaps", { capabilities: undefined });
  bad("nodeps", { deps: undefined });
  bad("capsnull", { capabilities: null });
  bad("capsarr", { capabilities: [] });
  bad("capskey", { capabilities: { routez: true } });
  bad("capsbool", { capabilities: { routes: "yes" } });
  bad("hookskey", { capabilities: { hooks: { journals: true } } });
  bad("hooksbool", { capabilities: { hooks: { spawn: 1 } } });
  bad("hooksarr", { capabilities: { hooks: [] } });
  bad("depsobj", { deps: {} });
  bad("depsunknown", { deps: ["registry", "teleport"] });
  bad("depsdup", { deps: ["registry", "registry"] });
  const loaded = await registry.load(dir);
  const by = (n: string) => loaded.find((l) => l.manifest.name === n);
  assert.equal(by("good")?.status, "ok");
  const expect: Record<string, RegExp> = {
    nocaps: /^extension nocaps: manifest has no "capabilities" block/,
    nodeps: /^extension nodeps: manifest has no "deps" block/,
    capsnull: /^extension capsnull: manifest "capabilities" block must be an object/,
    capsarr: /^extension capsarr: manifest "capabilities" block must be an object/,
    capskey: /^extension capskey: manifest "capabilities" block has unknown key "routez"/,
    capsbool: /^extension capsbool: manifest "capabilities" routes must be a boolean/,
    hookskey: /^extension hookskey: manifest "capabilities" hooks has unknown key "journals"/,
    hooksbool: /^extension hooksbool: manifest "capabilities" hooks\.spawn must be a boolean/,
    hooksarr: /^extension hooksarr: manifest "capabilities" hooks must be an object/,
    depsobj: /^extension depsobj: deps must be an array of strings/,
    depsunknown: /^extension depsunknown: unknown dep "teleport"/,
    depsdup: /^extension depsdup: deps must be distinct/,
  };
  for (const [n, re] of Object.entries(expect)) {
    assert.equal(by(n)?.status, "failed", n);
    assert.match(by(n)?.error ?? "", re, n);
  }
  assert.deepEqual(registry.names(), ["good"]);
});

test("a file extension that registers an undeclared route fails its load with the closed message and exposes nothing", async () => {
  const { registry } = capRegistry();
  const dir = tmpDir("pomtreed-ext-undeclared-");
  const src = `export default { init(host) { host.route({ method: "GET", path: "/v1/ext/noroute/x", scope: { kind: "ext" }, handler: () => ({ status: 200, body: {} }) }); } };`;
  writeExt(dir, "noroute", { name: "noroute", entry: "entry.mjs", capabilities: {}, deps: [] }, src);
  writeExt(dir, "route", { name: "route", entry: "entry.mjs", capabilities: { routes: true }, deps: [] }, src.replaceAll("noroute", "route"));
  const loaded = await registry.load(dir);
  const by = (n: string) => loaded.find((l) => l.manifest.name === n);
  assert.equal(by("noroute")?.status, "failed");
  assert.equal(by("noroute")?.error, "extension noroute: host.route requires capabilities.routes");
  assert.equal(by("route")?.status, "ok");
  assert.deepEqual(
    registry.routes().map((r) => r.path),
    ["/v1/ext/route/x"],
  );
});

test("a compiled-in extension without capabilities or deps is refused at registration, like a file one", () => {
  const { registry } = capRegistry();
  const bare = { name: "bare", entry: "builtin" } as unknown as ExtensionManifest;
  assert.throws(() => registry.registerBuiltin({ manifest: bare }), /^Error: extension bare: manifest has no "capabilities" block/);
  assert.throws(() => registry.registerBuiltin({ manifest: { ...bare, capabilities: {} } }), /^Error: extension bare: manifest has no "deps" block/);
  assert.throws(() => registry.registerBuiltin({ manifest: { ...bare, capabilities: { nope: true } as never, deps: [] } }), /unknown key "nope"/);
  assert.ok(!registry.names().includes("bare"));
});

test("the daemon's builtins (observe, reports, cron) declare capabilities and deps and register through the same facade", () => {
  const t = setup(async () => {});
  assert.ok(
    ["observe", "reports", "cron"].every((n) => t.extensions.names().includes(n)),
    "builtins registered",
  );
});

test("parseManifest returns the declared blocks and keeps an empty block distinct from a missing one", () => {
  const base = { apiVersion: EXTENSION_API_VERSION, name: "a", entry: "e" };
  const m = parseManifest(JSON.stringify({ ...base, capabilities: { routes: true, hooks: { journal: true } }, deps: ["registry", "journal"] }));
  assert.deepEqual(m.capabilities, { routes: true, hooks: { journal: true } });
  assert.deepEqual(m.deps, ["registry", "journal"]);
  const empty = parseManifest(JSON.stringify({ ...base, capabilities: {}, deps: [] }));
  assert.deepEqual([empty.capabilities, empty.deps], [{}, []]);
  assert.throws(() => parseManifest(JSON.stringify({ ...base, deps: [] })), /^Error: extension a: manifest has no "capabilities" block/);
  assert.throws(() => parseManifest(JSON.stringify({ ...base, capabilities: {} })), /^Error: extension a: manifest has no "deps" block/);
});
