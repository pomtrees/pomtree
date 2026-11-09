import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ExtensionGateway, ExtensionResult, ExtensionSpec } from "@pomtree/core";
import { EXIT, run, socketTransport } from "@pomtree/pomtree";
import type { ModelCatalog } from "@pomtree/pomtreed";
import { createExtensionRegistry, handle, listen, issueToken } from "@pomtree/pomtreed";
import { DirReportStore } from "@pomtree/report-dir";
import type { StateDb } from "@pomtree/store-sqlite";
import { openStateStore } from "@pomtree/store-sqlite";
import { FakeOrigin, tmpDir } from "@pomtree/testing";
import { CAPTURE_EXIT } from "../../pomtree/src/capture.ts";
import { createCronExtension } from "../../pomtreed/src/builtin/cron.ts";
import { createObserveExtension } from "../../pomtreed/src/builtin/observe.ts";
import { createReportsExtension } from "../../pomtreed/src/builtin/reports.ts";
import { wireCaptureBroker } from "../../pomtreed/src/capture-wiring.ts";
import { StatePolicy } from "../../pomtreed/src/state-policy.ts";
import { testFetchSeam } from "../../pomtreed/src/test-fetch.ts";
import { DirTemplateStore } from "../../template-dir/src/index.ts";
import type { Rig } from "./harness.ts";
import { rig, SECRET, until } from "./harness.ts";

// CLI smoke test: runs EVERY `pomtree` command in the USAGE text once through the real `run()` against a
// real in-process daemon (real store-sqlite, real HTTP server on a unix socket; fake sandbox/harness,
// stub extension gateway and model catalog; offline, Docker-free). Catches crashes that only appear on real,
// ragged data (e.g. a table() TypeError in `pomtree peers`). The command list is parsed out of USAGE, so a new
// command without a smoke case fails `coverage` ("add smoke case for <cmd>").

type Scope = "operator" | "agent";
interface Ids {
  root: string;
  worker: string;
  peer: string;
  finisher: string;
  resulter: string;
  canceler: string;
  killer: string;
  abandoner: string;
  yielder: string;
  reaper: string;
  esc: string;
  report: string;
  rep: string;
  tpl: string;
  sched: string;
  file: string;
  jfile: string;
  xfile: string;
  out: string;
  cap: string; // a stored capture (seeded through POST /v1/capture)
  job: string; // a capture job that stays running (its origin never answers)
}
type JsonType = "string" | "number" | "boolean" | "object" | "array" | "null";
type Shape = Record<string, JsonType>; // keys stdout's JSON must carry, with their JSON types
interface Case {
  name: string;
  covers?: string[]; // USAGE keys ("spawn", "sched add", ...) this case exercises
  scope: Scope;
  argv: (c: Ids) => string[];
  exit?: number; // the one expected exit code (default 0); the smoke daemon is deterministic, so no case accepts a set
  // stdout must be valid JSON; a Shape names keys it must carry (with types); `each` applies one to every element of an array,
  // which has exactly `len` elements when given
  json?: true | Shape | { each: Shape; len?: number };
  out?: RegExp; // stdout+stderr must match
  fail?: boolean; // wrong-scope/usage case: must exit non-zero with a clean `pomtree: ...` stderr line
  as?: string; // agent to authenticate as (default: ids.worker); "root" = the root agent
  env?: Record<string, string | undefined>;
  after?: (c: Ids, o: Res) => void;
}

const HARD_TIMEOUT_MS = 15_000;
const never = () => new Promise<void>(() => {});
const TYPES = ["TypeError", "ReferenceError", "RangeError", "[object Object]", "undefined", "NaN"];
const STACK = /^\s+at\s.+(:\d+:\d+\)?|<anonymous>\))/m;

// ---- USAGE parsing ----
async function usageKeys(): Promise<{ keys: string[]; flags: Set<string> }> {
  const out: string[] = [];
  await run(["--help"], {
    call: async () => {
      throw new Error("no call");
    },
    out: (s) => out.push(s),
    err: () => {},
    version: "0",
  });
  const text = out.join("\n");
  const keys: string[] = [];
  const flags = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.startsWith("usage") || line.startsWith("global")) continue;
    const m = /^ {2}([a-z][a-z-]*)(?: ([a-z][a-z-]*(?:\|[a-z][a-z-]*)*))?(?= |$)/.exec(line);
    if (m) {
      const subs = m[2] ? m[2].split("|") : [undefined];
      for (const s of subs) keys.push(s ? `${m[1]} ${s}` : m[1]!);
    }
    for (const f of line.matchAll(/(?<![\w-])(--[a-z][a-z-]*|-f)\b/g)) flags.add(f[1]!);
  }
  return { keys, flags };
}

// ---- world ----
interface World {
  r: Rig;
  stateDb: StateDb;
  server: Server;
  sock: string;
  ids: Ids;
  tok: (who: string) => string;
  extCalls: string[];
  origin: FakeOrigin;
}

const SPECS: ExtensionSpec[] = [
  { name: "web_search", description: "search the web", inputSchema: { type: "object" }, streaming: false },
  { name: "web_fetch", description: "fetch a URL", inputSchema: { type: "object" }, streaming: false },
  { name: "echo", description: "echo the input", inputSchema: {}, streaming: false },
];
function stubGateway(calls: string[]): ExtensionGateway {
  return {
    list: async () => structuredClone(SPECS),
    call: async (_a, ext, input): Promise<ExtensionResult> => {
      calls.push(ext);
      if (ext === "web_fetch") return { ok: false, denied: true, reason: "network egress denied (offline stub)" };
      if (ext === "web_search") return { ok: true, result: { items: [{ title: "T", url: "https://example.invalid/", snippet: "S" }] } };
      return { ok: true, result: { echoed: input } };
    },
  };
}

const DIGEST = `img@sha256:${"ab".repeat(32)}`;

// A seeding failure must not leak the listening server and held agents: the test process would never exit.
async function makeWorld(seeded: boolean): Promise<World> {
  let w: World | undefined;
  try {
    return await buildWorld(seeded, (x) => {
      w = x;
    });
  } catch (e) {
    if (w) await close(w).catch(() => {});
    throw e;
  }
}

async function buildWorld(seeded: boolean, publish: (w: World) => void): Promise<World> {
  const templates = tmpDir("pomtree-smoke-tpl-");
  if (seeded)
    writeFileSync(
      join(templates, "researcher.json"),
      JSON.stringify({ image: DIGEST, model: "m1", provider: "test", extensions: ["web_search", "web_fetch"], budgetMicros: 500 }),
    );
  const models: ModelCatalog = {
    list: async () =>
      seeded
        ? {
            models: [
              { provider: "test", id: "m1", default: true },
              { provider: "test", id: "m2" },
            ],
            source: "pi" as const,
          }
        : { models: [], source: "pi" as const },
  };
  const extCalls: string[] = [];
  const r = rig({
    play: (_a, prompt) => (prompt.includes("finish") ? { result: { status: "succeeded", result: { done: true } } } : { hold: never() }),
    resume: () => ({ hold: never() }),
    maxSessions: 40,
    deps: {
      messagingChannels: ["discord"],
      escalationChannels: ["discord"],
      templates: new DirTemplateStore({ root: templates }),
      models,
      extensions: stubGateway(extCalls),
    },
  });
  const ext = createExtensionRegistry({
    hostId: "h1",
    now: () => r.daemon.now(),
    registry: r.daemon.deps.registry,
    journal: r.daemon.deps.journal,
    mailbox: r.daemon.deps.mailbox,
    root: () => r.daemon.root(),
  });
  ext.registerBuiltin(
    createReportsExtension({ store: new DirReportStore({ root: join(r.stateDir, "reports2"), registry: r.store.registry }), reportMaxBytes: 1 << 20 }),
  );
  ext.registerBuiltin(
    createCronExtension({
      schedules: r.store.schedules,
      cronTickMs: r.daemon.limits.cronTickMs,
      rootId: async () => (await r.daemon.root()).id,
      spawnRootChild: async (i, k) => r.daemon.spawn((await r.daemon.root()).id, { name: i.name, task: i.task, idempotencyKey: k }),
      steerAgent: (agent, body, key) => r.daemon.messageAgent(agent, body, key, "queue"),
      wakeAgent: (agent, body, key) => r.daemon.resumeAgent(agent, body, {}, key),
      pendingSignals: (agent) => r.daemon.deps.mailbox.peek(agent),
    }),
  );
  ext.registerBuiltin(createObserveExtension({ waits: () => r.daemon.liveWaits() }));
  r.daemon.deps.extensionHost = ext;
  // Durable workflow store: the real store-sqlite state store; the researcher template may read owner "smoke" under memo/ (agents are default-deny).
  const stateDb = openStateStore(join(r.stateDir, "state.sqlite"), { generationOf: r.store.generationOf });
  r.daemon.deps.state = stateDb.state;
  r.daemon.deps.stateGrants = new StatePolicy(JSON.stringify({ researcher: [{ owner: "smoke", prefix: "memo/", mode: "r" }] }));
  // The capture broker as main.ts composes it (capture-wiring.ts over the real store, report store and process parser), its origin a
  // FakeOrigin behind the test fetch seam: docs.example.org answers, /hang never does (a job that stays running), /private is
  // disallowed by robots.txt, and the Wayback hosts are mapped too so no request leaves the machine.
  const origin = await FakeOrigin.start();
  origin
    .route("docs.example.org", "/page", { status: 200, headers: { "content-type": "text/html" }, body: "<h1>smoke</h1>" })
    .route("docs.example.org", "/hang", { hang: true })
    .robots("docs.example.org", "User-agent: *\nDisallow: /private\n")
    .waybackAvailability(null);
  const capture = wireCaptureBroker({
    stores: r.store,
    quota: r.store.quotaCounters(),
    reports: new DirReportStore({ root: join(r.stateDir, "capture-reports"), registry: r.store.registry }),
    daemon: { root: () => r.daemon.root(), captureRecord: (agent, payload, key) => r.daemon.captureRecord(agent, payload, key) },
    hostId: "h1",
    userAgent: "pomtree-smoke smoke@example.invalid",
    log: () => {},
    ...testFetchSeam(origin.hostsMap("docs.example.org", "archive.org", "web.archive.org"), {
      resolveDns: async (h) => Promise.reject(new Error(`no DNS in the smoke test (${h})`)),
    }),
    config: { timeoutMs: 120_000 },
  });
  r.daemon.deps.capture = capture;
  const sock = join(r.stateDir, "pomtreed.sock");
  const server = await listen(r.daemon, sock);
  const root = await r.daemon.root();
  const tok = (who: string) => (who === "operator" ? issueToken(SECRET, { scope: "operator" }) : r.daemon.agentToken(who === "root" ? root.id : who, 0));
  const ids: Ids = {
    root: root.id,
    worker: "",
    peer: "",
    finisher: "",
    resulter: "",
    canceler: "",
    killer: "",
    abandoner: "",
    yielder: "",
    reaper: "",
    esc: "",
    report: "",
    rep: "",
    tpl: "researcher",
    sched: "seed",
    file: "",
    jfile: join(r.stateDir, "state-put.json"),
    xfile: join(r.stateDir, "state-export.json"),
    out: join(r.stateDir, "report-out.txt"),
    cap: "",
    job: "",
  };
  const w: World = { r, stateDb, server, sock, ids, tok, extCalls, origin };
  publish(w);
  if (!seeded) return w;

  const kid = async (name: string, template?: string, task = "hold", budgetMicros?: number) => {
    const a = await r.daemon.spawn(root.id, {
      name,
      task,
      idempotencyKey: `seed-${name}`,
      ...(template && { template }),
      ...(budgetMicros !== undefined && { budgetMicros }),
    });
    await until(async () => (await r.daemon.get(a.id))?.state === "running", `${name} running`);
    return a.id;
  };
  ids.worker = await kid("worker", "researcher");
  ids.peer = await kid("peer");
  ids.resulter = await kid("resulter");
  ids.canceler = await kid("canceler");
  ids.killer = await kid("killer");
  ids.abandoner = await kid("abandoner", undefined, "hold", 1); // tiny budget: later spawn cases need the root's remainder
  ids.yielder = await kid("yielder");
  for (const [k, n] of [
    ["reaper", "reaper"],
    ["finisher", "finisher"],
  ] as const) {
    const a = await r.daemon.spawn(root.id, { name: n, task: "finish", idempotencyKey: `seed-${n}` });
    await until(async () => {
      const st = (await r.daemon.get(a.id))?.state;
      return st === "exited" || st === "reaped";
    }, `${n} exited`);
    ids[k] = a.id;
  }
  ids.file = join(r.stateDir, "report.md");
  writeFileSync(ids.file, "# smoke report\nhello\n");
  writeFileSync(ids.jfile, JSON.stringify({ from: "file" }));
  process.env.POMTREE_AGENT_GENERATION = "0";

  // seed: an open escalation, a report, a schedule (through the real CLI / API)
  const ask = await cli(w, "agent", ["ask", "seed question?", "--options", "yes,no", "--key", "seed-ask"]);
  assert.equal(ask.code, 0, ask.err);
  ids.esc = ask.out.trim();
  const pub = await cli(w, "agent", ["report", "publish", ids.file, "--name", "seed", "--key", "seed-pub"]);
  assert.equal(pub.code, 0, pub.err);
  ids.rep = pub.out.trim().split(" ").at(-1)!;
  ids.report = ids.worker;
  const put = await handle(r.daemon, {
    method: "PUT",
    url: `/v1/schedules/${ids.sched}`,
    token: tok("operator"),
    body: { cron: "0 3 * * *", task: "nightly", missed: "skip", overlap: "skip", jitterMs: 0, idempotencyKey: "seed-sched" },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  // seed: a stored capture and a capture job that stays running
  const seedCapture = async (url: string, key: string, waitMs: number) =>
    (
      await handle(r.daemon, {
        method: "POST",
        url: `/v1/capture?waitMs=${waitMs}`,
        token: tok("operator"),
        body: { request: { url, purpose: "smoke seed" }, idempotencyKey: key },
      })
    ).body as { outcome: { state: string; capture?: { id: string }; job?: string } };
  const got = await seedCapture("https://docs.example.org/page", "seed-cap", 10_000);
  assert.equal(got.outcome.state, "ok", JSON.stringify(got));
  ids.cap = got.outcome.capture?.id ?? "";
  const held = await seedCapture("https://docs.example.org/hang", "seed-job", 0);
  assert.equal(held.outcome.state, "pending", JSON.stringify(held));
  ids.job = held.outcome.job ?? "";
  return w;
}

// Quiesce before closing the store: stop admitting, then let in-flight drive/resume/settle runs finish (held
// agents never do, so the wait is bounded) so none of them touches a closed db ("database is not open").
async function close(w: World) {
  await w.r.daemon.shutdown(0);
  let t: NodeJS.Timeout | undefined;
  await Promise.race([
    w.r.orchestrator.idle(),
    new Promise((res) => {
      t = setTimeout(res, 500);
    }),
  ]);
  clearTimeout(t);
  w.server.close();
  w.server.closeAllConnections?.();
  await w.r.daemon.deps.capture?.close();
  await w.origin.close();
  w.stateDb.close();
  w.r.store.close();
}

interface Res {
  requests: Array<{ method: string; path: string; body?: unknown }>;
  code: number;
  out: string;
  err: string;
  crashed?: string;
}
// `pomtree push`/`pull` run git in a clone; the smoke runs them in an empty non-repo dir so they can never touch a real repo.
const NON_REPO_CWD = mkdtempSync(join(tmpdir(), "pomtree-e2e-smoke-cwd-"));
after(() => rmSync(NON_REPO_CWD, { recursive: true, force: true }));

async function cli(
  w: World,
  scope: Scope | "root",
  argv: string[],
  o: { as?: string; env?: Record<string, string | undefined>; isTTY?: boolean } = {},
): Promise<Res> {
  const who = scope === "operator" ? "operator" : (o.as ?? (scope === "root" ? "root" : w.ids.worker));
  const out: string[] = [];
  const err: string[] = [];
  const requests: Res["requests"] = [];
  const transport = socketTransport(w.sock, w.tok(who));
  const saved: Record<string, string | undefined> = {};
  // A real operator shell has no agent generation; only agent-scope runs inherit the seeded POMTREE_AGENT_GENERATION.
  const env = scope === "operator" ? { POMTREE_AGENT_GENERATION: undefined, ...o.env } : (o.env ?? {});
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const code = await Promise.race([
      run(argv, {
        call: (request) => {
          requests.push(request);
          return transport(request);
        },
        out: (s) => out.push(s),
        err: (s) => err.push(s),
        isTTY: o.isTTY ?? false,
        version: "0.0.0",
        cwd: NON_REPO_CWD,
      }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`hung > ${HARD_TIMEOUT_MS}ms: pomtree ${argv.join(" ")}`)), HARD_TIMEOUT_MS);
      }),
    ]);
    return { code, out: out.join("\n"), err: err.join("\n"), requests };
  } catch (e) {
    if ((e as Error).message.startsWith("hung")) throw e;
    return { requests, code: -1, out: out.join("\n"), err: err.join("\n"), crashed: (e as Error).stack ?? String(e) };
  } finally {
    clearTimeout(timer);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function invariants(argv: string[], res: Res) {
  const label = `pomtree ${argv.join(" ")}`;
  assert.equal(res.crashed, undefined, `${label} threw out of run():\n${res.crashed}`);
  // The shared codes, plus `pomtree capture`'s command-specific ones above them (USAGE: "pomtree capture adds 15-18").
  const documented: number[] = [...Object.values(EXIT), ...(argv.includes("capture") ? Object.values(CAPTURE_EXIT) : [])];
  assert.ok(documented.includes(res.code as number), `${label}: exit ${res.code} is not a documented EXIT code`);
  const all = `${res.out}\n${res.err}`;
  for (const bad of TYPES) assert.ok(!all.includes(bad), `${label}: output contains ${JSON.stringify(bad)}:\n${all}`);
  assert.ok(!STACK.test(all), `${label}: output contains a stack frame:\n${all}`);
}

function check(c: Case, argv: string[], res: Res) {
  const label = `pomtree ${argv.join(" ")} [${c.scope}]`;
  invariants(argv, res);
  assert.equal(res.code, c.exit ?? 0, `${label}: exit ${res.code}, expected ${c.exit ?? 0}\nstdout: ${res.out}\nstderr: ${res.err}`);
  if (c.fail) {
    assert.notEqual(res.code, 0, `${label}: expected a failure`);
    const text = argv.includes("--json") ? res.out : res.err;
    assert.ok(
      argv.includes("--json") ? /"error"/.test(text) : /^pomtree: \S/.test(text),
      `${label}: expected a clean 'pomtree: ...' error, got:\nstdout: ${res.out}\nstderr: ${res.err}`,
    );
  } else if (res.code === 0) {
    assert.ok(res.out.trim().length > 0, `${label}: exit 0 with empty stdout`);
  }
  if (c.json) {
    let doc: unknown;
    assert.doesNotThrow(() => {
      doc = JSON.parse(res.out);
    }, `${label}: stdout is not valid JSON: ${res.out}`);
    if (c.json !== true) assertJsonShape(label, doc, c.json);
  }
  // stdout then stderr, joined only when both are non-empty, so `$` anchors at the last line either way.
  if (c.out) assert.match([res.out, res.err].filter((t) => t !== "").join("\n"), c.out, `${label}: output mismatch\nstdout: ${res.out}\nstderr: ${res.err}`);
}

const jsonType = (v: unknown): string => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
function assertKeys(label: string, doc: unknown, shape: Shape) {
  assert.equal(jsonType(doc), "object", `${label}: expected a JSON object, got ${JSON.stringify(doc)}`);
  for (const [k, t] of Object.entries(shape))
    assert.equal(jsonType((doc as Record<string, unknown>)[k]), t, `${label}: JSON key ${k} should be ${t} in ${JSON.stringify(doc)}`);
}
function assertJsonShape(label: string, doc: unknown, spec: Shape | { each: Shape; len?: number }) {
  if (!("each" in spec)) return assertKeys(label, doc, spec as Shape);
  const list = spec as { each: Shape; len?: number };
  assert.ok(Array.isArray(doc), `${label}: expected a JSON array, got ${JSON.stringify(doc)}`);
  if (list.len !== undefined) assert.equal(doc.length, list.len, `${label}: expected ${list.len} elements`);
  for (const e of doc) assertKeys(label, e, list.each);
}

const AGENT_KEYS: Shape = { id: "string", name: "string", task: "string", state: "string", host: "string", generation: "number", spec: "object" };
const TREE_ROW: Shape = { name: "string", id: "string", fullId: "string", depth: "number", state: "string", tokens: "number", cost: "string" };
const SPEND_KEYS: Shape = { agentsByState: "object", totalSpendMicros: "number", openEscalations: "number", hosts: "object", sessions: "object" };
const DOCTOR_KEYS: Shape = { ok: "boolean", host: "string", agents: "object", sandboxUp: "boolean", degraded: "boolean", reasons: "array" };
const ESCALATION_KEYS: Shape = { id: "string", agent: "string", question: "string", options: "array", state: "string", createdAt: "number" };
const REPORT_KEYS: Shape = { id: "string", agent: "string", name: "string", mediaType: "string", sizeBytes: "number", sha256: "string" };
const SCHEDULE_KEYS: Shape = { id: "string", cron: "string", task: "string", missed: "string", overlap: "string", jitterMs: "number" };
const TEMPLATE_KEYS: Shape = { id: "string", image: "string", extensions: "array", provider: "string", model: "string", budgetMicros: "number" };
const PEER_KEYS: Shape = { id: "string", name: "string", state: "string" };
const EXT_CALL_KEYS: Shape = { callId: "string", ok: "boolean", result: "object" };
// The fake sandbox is always up and nothing is degraded, so doctor is healthy (exit 0) on every host, Docker or not.
const doctorHealthy = (_c: Ids, res: Res) => {
  const d = JSON.parse(res.out) as { ok: boolean; reasons: unknown[] };
  assert.equal(d.ok, true, res.out);
  assert.deepEqual(d.reasons, []);
};

const dummy: Ids = Object.fromEntries(
  [
    "root",
    "worker",
    "peer",
    "finisher",
    "resulter",
    "canceler",
    "killer",
    "abandoner",
    "yielder",
    "reaper",
    "esc",
    "report",
    "rep",
    "tpl",
    "sched",
    "file",
    "jfile",
    "xfile",
    "out",
    "cap",
    "job",
  ].map((k) => [k, "X"]),
) as unknown as Ids;

// ---- blank world: empty / ragged-data variants ----
// The smoke daemon has no /live/ui tab, so the daemon records each ui command and the CLI exits 3; a connected tab (exit 0) is covered in ui-drive.test.ts.
const NO_UI_TAB = /ui command \d+ was recorded but no UI tab is connected/;
const BLANK: Case[] = [
  { name: "ps (empty)", covers: ["ps"], scope: "operator", argv: () => ["ps"], out: /^\S+\s+root\s+running\s/m },
  { name: "ps --json (empty)", scope: "operator", argv: () => ["--json", "ps"], json: { each: AGENT_KEYS, len: 1 } },
  { name: "ps --state running --parent", scope: "operator", argv: (c) => ["ps", "--state", "running", "--parent", c.root], out: /^no agents$/m },
  { name: "tree (empty)", covers: ["tree"], scope: "operator", argv: () => ["tree"], out: /^root\s+\S+\s+running\s/m },
  { name: "tree --json (empty)", scope: "operator", argv: () => ["tree", "--json"], json: { each: TREE_ROW, len: 1 } },
  { name: "top --once (empty)", covers: ["top"], scope: "operator", argv: () => ["top", "--once"], out: /^root\s+\S+\s+running\s/m },
  { name: "top (non-tty renders once)", scope: "operator", argv: () => ["top", "--interval", "5"], out: /^root\s+\S+\s+running\s/m },
  { name: "sched ls (empty)", covers: ["sched ls"], scope: "operator", argv: () => ["sched", "ls"], out: /^no schedules$/ },
  { name: "capture ls (empty)", covers: ["capture ls"], scope: "operator", argv: () => ["capture", "ls"], out: /^no captures$/m },
  { name: "sched ls --json (empty)", scope: "operator", argv: () => ["sched", "ls", "--json"], json: { each: SCHEDULE_KEYS, len: 0 } },
  { name: "report list (empty)", covers: ["report list"], scope: "operator", argv: () => ["report", "list"], out: /no reports/ },
  { name: "report list AGENT (empty)", scope: "operator", argv: (c) => ["report", "list", c.root], out: /no reports/ },
  { name: "report list --json (empty)", scope: "operator", argv: () => ["report", "list", "--json"], json: { each: REPORT_KEYS, len: 0 } },
  { name: "template ls (empty)", covers: ["template ls"], scope: "operator", argv: () => ["template", "ls"], out: /no templates/ },
  { name: "template ls --json (empty)", scope: "operator", argv: () => ["template", "ls", "--json"], json: { each: TEMPLATE_KEYS, len: 0 } },
  { name: "escalations ls (empty)", covers: ["escalations ls"], scope: "operator", argv: () => ["escalations", "ls"], out: /no escalations/ },
  {
    name: "escalations ls --state open --json (empty)",
    scope: "operator",
    argv: () => ["escalations", "ls", "--state", "open", "--json"],
    json: { each: ESCALATION_KEYS, len: 0 },
  },
  { name: "models (empty catalog)", covers: ["models"], scope: "operator", argv: () => ["models"], out: /no models/ },
  { name: "models --json (empty catalog)", scope: "operator", argv: () => ["--json", "models"], json: { models: "array", source: "string" } },
  {
    name: "spend (empty)",
    covers: ["spend"],
    scope: "operator",
    argv: () => ["spend"],
    out: /^agents: 1 running \| spend: \$0\.0000 \| escalations: 0 open$/m,
  },
  { name: "spend --json (empty)", scope: "operator", argv: () => ["spend", "--json"], json: SPEND_KEYS },
  { name: "doctor (blank)", covers: ["doctor"], scope: "operator", argv: () => ["doctor"], out: /^ok\n\s+host:\s+h1$/m },
  {
    name: "ui open (no tab connected)",
    covers: ["ui open"],
    scope: "operator",
    argv: () => ["ui", "open", "terminal", "a1"],
    exit: EXIT.notFound,
    out: NO_UI_TAB,
  },
  {
    name: "ui focus (no tab connected)",
    covers: ["ui focus"],
    scope: "operator",
    argv: () => ["ui", "focus", "terminal", "a1"],
    exit: EXIT.notFound,
    out: NO_UI_TAB,
  },
  {
    name: "ui focus --dir (no tab connected)",
    scope: "operator",
    argv: () => ["ui", "focus", "--dir", "left"],
    exit: EXIT.notFound,
    out: NO_UI_TAB,
  },
  {
    name: "ui close (no tab connected)",
    covers: ["ui close"],
    scope: "operator",
    argv: () => ["ui", "close", "terminal", "a1"],
    exit: EXIT.notFound,
    out: NO_UI_TAB,
  },
  {
    name: "ui close --others (no tab connected)",
    scope: "operator",
    argv: () => ["ui", "close", "terminal", "a1", "--others"],
    exit: EXIT.notFound,
    out: NO_UI_TAB,
  },
  {
    name: "ui close --left (no tab connected)",
    scope: "operator",
    argv: () => ["ui", "close", "terminal", "a1", "--left"],
    exit: EXIT.notFound,
    out: NO_UI_TAB,
  },
  {
    name: "ui close --right (no tab connected)",
    scope: "operator",
    argv: () => ["ui", "close", "terminal", "a1", "--right"],
    exit: EXIT.notFound,
    out: NO_UI_TAB,
  },
  {
    name: "ui close --all (no tab connected)",
    scope: "operator",
    argv: () => ["ui", "close", "--all"],
    exit: EXIT.notFound,
    out: NO_UI_TAB,
  },
  {
    name: "ui maximize (no tab connected)",
    covers: ["ui maximize"],
    scope: "operator",
    argv: () => ["ui", "maximize", "terminal", "a1"],
    exit: EXIT.notFound,
    out: NO_UI_TAB,
  },
  {
    name: "ui minimize (no tab connected)",
    covers: ["ui minimize"],
    scope: "operator",
    argv: () => ["ui", "minimize", "terminal", "a1"],
    exit: EXIT.notFound,
    out: NO_UI_TAB,
  },
  {
    name: "ui restore VIEW (no tab connected)",
    covers: ["ui restore"],
    scope: "operator",
    argv: () => ["ui", "restore", "terminal", "a1"],
    exit: EXIT.notFound,
    out: NO_UI_TAB,
  },
  {
    name: "ui restore (no ref, no tab connected)",
    scope: "operator",
    argv: () => ["ui", "restore"],
    exit: EXIT.notFound,
    out: NO_UI_TAB,
  },
  {
    name: "ui follow --views --of (no tab connected)",
    covers: ["ui follow"],
    scope: "operator",
    argv: () => ["ui", "follow", "on", "--views", "terminal,browser", "--of", "a1"],
    exit: EXIT.notFound,
    out: NO_UI_TAB,
  },
  { name: "doctor --json (blank)", scope: "operator", argv: () => ["doctor", "--json"], json: DOCTOR_KEYS, after: doctorHealthy },
  { name: "peers (no peers)", covers: ["peers"], scope: "agent", as: "root", argv: () => ["peers"], out: /^\S+\s+root\s+running$/m },
  { name: "peers --json (no peers)", scope: "agent", as: "root", argv: () => ["peers", "--json"], json: { each: PEER_KEYS, len: 1 } },
  { name: "inbox --peek (empty)", covers: ["inbox"], scope: "agent", as: "root", argv: () => ["inbox", "--peek"], out: /no signals/ },
  { name: "budget (root)", covers: ["budget"], scope: "agent", as: "root", argv: () => ["budget"], out: /^budget: \$0\.01 \(10000 µ\$\)\nremaining: \$0\.01/m },
  { name: "whoami (root)", covers: ["whoami"], scope: "agent", as: "root", argv: () => ["whoami"], out: /^\S+ root running gen 0 host h1$/ },
  { name: "ext list (no extensions enabled)", covers: ["ext list"], scope: "agent", as: "root", argv: () => ["ext", "list"], out: /^no extensions$/ },
  { name: "ext list --json (no extensions)", scope: "agent", as: "root", argv: () => ["ext", "list", "--json"], json: { extensions: "array" } },
  // No human message is unanswered in the blank world, so the daemon refuses the declaration with a clean conflict.
  {
    name: "await-user (no human message)",
    covers: ["await-user"],
    scope: "agent",
    as: "root",
    argv: () => ["await-user"],
    exit: EXIT.conflict,
    out: /Valid exits are: keep working, `pomtree result`, or `pomtree yield`/,
    fail: true,
  },
];

// ---- usage handling (no daemon state needed) ----
const USAGE_ERRORS: Case[] = [
  ["spawn"],
  ["wait"],
  ["reap"],
  ["send"],
  ["send", "X"],
  ["ask"],
  ["yield"],
  ["yield", "--until", "bogus"],
  ["show"],
  ["logs"],
  ["cancel"],
  ["kill"],
  ["decide"],
  ["decide", "X"],
  ["decide", "X", "maybe"],
  ["decide", "X", "approve", "--grant", "nope"],
  ["answer"],
  ["answer", "X"],
  ["pass"],
  ["extend"],
  ["extend", "X", "--deadline", "0"],
  ["extend", "X", "--deadline", "bogus"],
  ["resume"],
  ["escalations"],
  ["escalations", "answer"],
  ["sched"],
  ["sched", "add", "x"],
  ["sched", "add", "x", "not a cron", "t"],
  ["sched", "rm"],
  ["sched", "pause"],
  ["template"],
  ["template", "show"],
  ["ext"],
  ["ext", "call"],
  ["ext", "call", "echo", "--input", "{bad"],
  ["ext", "search"],
  ["ext", "fetch"],
  ["workflow"],
  ["workflow", "launch"],
  ["workflow", "launch", "hn/digest", "--input", "{bad"],
  ["workflow", "launch", "Bad"],
  ["workflow", "launch", "hn/digest", "--budget", "nope"],
  ["workflow", "launch", "hn/digest", "--deadline", "bogus"],
  ["workflow", "bogus"],
  ["report"],
  ["report", "publish"],
  ["report", "show", "X"],
  ["report", "rm", "X"],
  ["bogus-command"],
  ["ui"],
  ["ui", "open"],
  ["ui", "focus"],
  ["ui", "close"],
  ["ui", "follow"],
  ["ui", "maximize"],
  ["ui", "minimize"],
  ["ui", "close", "terminal", "--others", "--left"],
  ["ui", "close", "--all", "terminal"],
  ["ui", "maximize", "terminal", "--others"],
  ["ui", "restore", "terminal", "a1", "r1", "x"],
  ["spawn", "--task"],
  ["spawn", "--task", "t", "--disposition", "keep"],
  ["spawn", "--task", "t", "--disposition", "reap-on-exit", "--ttl", "1h"],
  ["wait", "X", "--timeout", "-1"],
  ["top", "--interval", "abc"],
  ["result", "{notjson"],
  ["result", "--status", "maybe"],
].map((argv) => ({ name: `usage error: ${argv.join(" ")}`, scope: "operator" as const, argv: () => argv, exit: EXIT.usage, fail: true }));

// ---- seeded world, ordered: reads, then mutations, drain last ----
const SEEDED: Case[] = [
  // The capture broker through pomtree and pomtreed end to end (FakeOrigin behind the test fetch seam; the seeded capture and job).
  {
    name: "capture request --render --max-age --purpose (served from the cache)",
    covers: ["capture request"],
    scope: "operator",
    argv: () => [
      "capture",
      "request",
      "https://docs.example.org/page",
      "--purpose",
      "smoke",
      "--render",
      "static",
      "--max-age",
      "600000",
      "--key",
      "smoke-cap",
    ],
    out: /cap-[0-9a-f]{64}/,
  },
  {
    name: "capture request --json (robots.txt disallow: blocked, exit 16)",
    scope: "operator",
    argv: () => ["capture", "request", "https://docs.example.org/private", "--purpose", "smoke", "--key", "smoke-robots", "--json"],
    exit: CAPTURE_EXIT.unavailableSource,
    json: { outcome: "object", message: "string" },
  },
  {
    name: "capture request --wait 0 (still running: exit 7)",
    scope: "operator",
    argv: () => ["capture", "request", "https://docs.example.org/hang", "--purpose", "smoke", "--wait", "0", "--key", "smoke-hang"],
    exit: EXIT.timeout,
    out: /pomtree capture wait cj-[0-9a-f]{64}/,
  },
  {
    name: "capture request (an invalid URL: exit 2)",
    scope: "operator",
    argv: () => ["capture", "request", "ftp://docs.example.org/x", "--purpose", "smoke", "--key", "smoke-ftp"],
    exit: EXIT.usage,
  },
  {
    name: "capture wait JOB --wait 0 (still running)",
    covers: ["capture wait"],
    scope: "operator",
    argv: (c) => ["capture", "wait", c.job, "--wait", "0"],
    exit: EXIT.timeout,
  },
  { name: "capture show CAPTURE", covers: ["capture show"], scope: "operator", argv: (c) => ["capture", "show", c.cap], out: /docs\.example\.org/ },
  { name: "capture show --json", scope: "operator", argv: (c) => ["capture", "show", c.cap, "--json"], json: { capture: "object" } },
  { name: "capture ls --limit", scope: "operator", argv: () => ["capture", "ls", "--limit", "5"], out: /cap-[0-9a-f]{12}/ },
  { name: "capture ls --json", scope: "operator", argv: () => ["capture", "ls", "--json"], json: { captures: "array" } },
  {
    name: "capture request as an agent (its own credential; registry egress: no scope)",
    scope: "agent",
    argv: () => ["capture", "request", "https://docs.example.org/page", "--purpose", "smoke", "--key", "smoke-agent"],
    exit: CAPTURE_EXIT.unavailableSource,
    out: /egress policy blocks this host/,
  },
  // reads (operator)
  { name: "ps", scope: "operator", argv: () => ["ps"], out: /worker/ },
  { name: "ps --state running", scope: "operator", argv: () => ["ps", "--state", "running"], out: /^\S+\s+worker\s+running\s/m },
  { name: "ps --parent", scope: "operator", argv: (c) => ["ps", "--parent", c.root], out: /^\S+\s+worker\s+running\s/m },
  { name: "ps --json", scope: "operator", argv: () => ["ps", "--json"], json: { each: AGENT_KEYS } },
  { name: "tree", scope: "operator", argv: () => ["tree"], out: /worker/ },
  { name: "tree --json", scope: "operator", argv: () => ["--json", "tree"], json: { each: TREE_ROW } },
  { name: "top --once", scope: "operator", argv: () => ["top", "--once"], out: /^\s*worker\s+\S+\s+running\s/m },
  { name: "top --once --json", scope: "operator", argv: () => ["top", "--once", "--json"], json: { each: TREE_ROW } },
  { name: "spend", scope: "operator", argv: () => ["spend"], out: /^agents: \d+ running, 2 reaped \| spend: \$0\.0000 \| escalations: 1 open$/m },
  { name: "spend --json", scope: "operator", argv: () => ["spend", "--json"], json: SPEND_KEYS },
  { name: "escalations ls", scope: "operator", argv: () => ["escalations", "ls"], out: /seed question/ },
  {
    name: "escalations ls --state open --agent",
    scope: "operator",
    argv: (c) => ["escalations", "ls", "--state", "open", "--agent", c.worker],
    out: /\sopen\s.*seed question/,
  },
  { name: "escalations ls --json", scope: "operator", argv: () => ["escalations", "ls", "--json"], json: { each: ESCALATION_KEYS, len: 1 } },
  { name: "show", covers: ["show"], scope: "operator", argv: (c) => ["show", c.worker], out: /^name:\s+worker\n.*\nstate:\s+running$/m },
  { name: "show (exited)", scope: "operator", argv: (c) => ["show", c.reaper], out: /^state:\s+reaped \(succeeded\)$/m },
  {
    name: "show --json",
    scope: "operator",
    argv: (c) => ["show", c.worker, "--json"],
    json: { agent: "object", events: "array", checkpoint: "null", deadline: "object" },
  },
  { name: "logs", covers: ["logs"], scope: "operator", argv: (c) => ["logs", c.worker], out: /^\s+\d+\s+\S+\s+spawned$/m },
  // NDJSON: one journal entry per line.
  { name: "logs --json", scope: "operator", argv: (c) => ["logs", c.worker, "--json"], out: /^\{"seq":\d+,"ts":\d+,.*"payload":\{"kind":"spawned"/m },
  { name: "logs -f (exited agent ends)", scope: "operator", argv: (c) => ["logs", c.reaper, "-f"], out: /^\s+\d+\s+\S+\s+spawned$/m },
  // The fake harness checkpoints no session, so a running worker has no transcript: a clean not-found.
  {
    name: "logs --transcript --limit --raw",
    scope: "operator",
    argv: (c) => ["logs", c.worker, "--transcript", "--limit", "5", "--raw"],
    exit: EXIT.notFound,
    out: /no checkpointed session transcript/,
    fail: true,
  },
  {
    name: "logs --transcript --json",
    scope: "operator",
    argv: (c) => ["logs", c.worker, "--transcript", "--json"],
    exit: EXIT.notFound,
    json: { error: "string" },
    out: /no checkpointed session transcript/,
    fail: true,
  },
  { name: "trace", covers: ["trace"], scope: "operator", argv: (c) => ["trace", c.worker], out: /^# Trace: .*redacted: 0 values/s },
  { name: "trace --children --short", scope: "operator", argv: (c) => ["trace", c.root, "--children", "--short"], out: /# Trace:/ },
  {
    name: "trace --raw --json",
    scope: "operator",
    argv: (c) => ["trace", c.worker, "--raw", "--json"],
    json: { agent: "string", markdown: "string", bytes: "number", redacted: "number", raw: "boolean" },
  },
  { name: "trace --out", scope: "operator", argv: (c) => ["trace", c.worker, "--out", c.out], out: /^wrote \d+ bytes to .*report-out\.txt$/ },
  { name: "wait (exited agent)", covers: ["wait"], scope: "operator", argv: (c) => ["wait", c.reaper], out: /^\S+ reaped succeeded\nhandoff:/ },
  {
    name: "wait --timeout (running agent times out)",
    scope: "operator",
    argv: (c) => ["wait", c.worker, "--timeout", "40"],
    exit: EXIT.timeout,
    out: /^\S+ still running$/,
  },
  {
    name: "wait --json timeout",
    scope: "operator",
    argv: (c) => ["wait", c.worker, "--timeout", "40", "--json"],
    exit: EXIT.timeout,
    json: { done: "boolean", record: "object" },
  },
  { name: "wait unknown agent", scope: "operator", argv: () => ["wait", "no-such-agent", "--timeout", "40"], exit: EXIT.notFound, fail: true },
  // The smoke daemon wires no workflow host (no launchWorkflow callback), so the launch is refused as "not configured"
  // (503 -> exit 1). A truthful refusal, never a fake success; it does not exercise the approval gate.
  {
    name: "workflow launch (no workflow host configured) is refused",
    covers: ["workflow launch"],
    scope: "operator",
    argv: () => ["workflow", "launch", "hn/digest", "--input", '{"n":1}', "--budget", "$1", "--deadline", "0", "--key", "smoke-wf"],
    exit: EXIT.error,
    out: /workflow launch is not configured/,
    fail: true,
  },
  { name: "show unknown agent", scope: "operator", argv: () => ["show", "no-such-agent"], exit: EXIT.notFound, out: /no such agent/, fail: true },
  { name: "models", scope: "operator", argv: () => ["models"], out: /test\/m1/ },
  { name: "models --json", scope: "operator", argv: () => ["models", "--json"], json: { models: "array", source: "string" } },
  { name: "doctor", scope: "operator", argv: () => ["doctor"], out: /^ok\n\s+host:\s+h1$/m },
  { name: "doctor --json", scope: "operator", argv: () => ["doctor", "--json"], json: DOCTOR_KEYS, after: doctorHealthy },
  { name: "template ls", scope: "operator", argv: () => ["template", "ls"], out: /researcher/ },
  { name: "template ls --json", scope: "operator", argv: () => ["template", "ls", "--json"], json: { each: TEMPLATE_KEYS, len: 1 } },
  { name: "template show", covers: ["template show"], scope: "operator", argv: (c) => ["template", "show", c.tpl], out: /researcher/ },
  { name: "template show --json", scope: "operator", argv: (c) => ["template", "show", c.tpl, "--json"], json: TEMPLATE_KEYS },
  {
    name: "template show missing",
    scope: "operator",
    argv: () => ["template", "show", "nope"],
    exit: EXIT.notFound,
    out: /no such template: nope/,
    fail: true,
  },
  { name: "sched ls", scope: "operator", argv: () => ["sched", "ls"], out: /seed/ },
  { name: "sched ls --json", scope: "operator", argv: () => ["sched", "ls", "--json"], json: { each: SCHEDULE_KEYS, len: 1 } },
  { name: "report list", scope: "operator", argv: () => ["report", "list"], out: /seed/ },
  { name: "report list AGENT", scope: "operator", argv: (c) => ["report", "list", c.report], out: /\sseed\s+text\/plain\s/ },
  { name: "report list --json", scope: "operator", argv: () => ["report", "list", "--json"], json: { each: REPORT_KEYS, len: 1 } },
  { name: "report show", covers: ["report show"], scope: "operator", argv: (c) => ["report", "show", c.report, c.rep], out: /smoke report/ },
  { name: "report show --json", scope: "operator", argv: (c) => ["report", "show", c.report, c.rep, "--json"], json: REPORT_KEYS },
  { name: "report show --out", scope: "operator", argv: (c) => ["report", "show", c.report, c.rep, "--out", c.out], out: /^name:\s+seed$/m },
  { name: "report show missing", scope: "operator", argv: (c) => ["report", "show", c.report, "nope"], exit: EXIT.notFound, out: /no such report/, fail: true },
  // reads (agent)
  { name: "peers", scope: "agent", argv: () => ["peers"], out: /root/ },
  { name: "peers --json", scope: "agent", argv: () => ["peers", "--json"], json: { each: PEER_KEYS, len: 2 } },
  { name: "inbox --peek", scope: "agent", argv: () => ["inbox", "--peek"], out: /^no signals$/ },
  { name: "inbox --wait (nothing arrives)", scope: "agent", argv: () => ["inbox", "--wait", "40"], out: /^no signals$/ },
  { name: "inbox --json", scope: "agent", argv: () => ["inbox", "--peek", "--json"], json: { each: { kind: "string" }, len: 0 } },
  { name: "budget", scope: "agent", argv: () => ["budget"], out: /^budget: \$0\.00 \(500 µ\$\)\nremaining: \$0\.00 \(500 µ\$\)$/ },
  { name: "budget --json", scope: "agent", argv: () => ["budget", "--json"], json: { budgetMicros: "number", remainingMicros: "number" } },
  { name: "whoami", scope: "agent", argv: () => ["whoami"], out: /^\S+ worker running gen 0 host h1$/ },
  { name: "whoami --json", scope: "agent", argv: () => ["whoami", "--json"], json: AGENT_KEYS },
  { name: "ext list", scope: "agent", argv: () => ["ext", "list"], out: /web_search/ },
  { name: "ext list --json", scope: "agent", argv: () => ["ext", "list", "--json"], json: { extensions: "array" } },
  // mutations
  {
    name: "spawn",
    covers: ["spawn"],
    scope: "operator",
    argv: () => ["spawn", "--task", "smoke child", "--name", "smoke-a", "--budget", "100", "--key", "smoke-spawn-a"],
    out: /^ag-[0-9a-f]+\n.*budget \$0\.00 is small/,
  },
  {
    name: "spawn --deadline 0 (unlimited, operator)",
    scope: "operator",
    argv: () => ["spawn", "--task", "t", "--name", "smoke-f", "--deadline", "0", "--key", "smoke-spawn-f"],
    out: /^ag-[0-9a-f]+$/,
  },
  {
    name: "spawn --wrapup",
    scope: "operator",
    argv: () => ["spawn", "--task", "wrap up", "--wrapup", "45s", "--key", "smoke-wrapup", "--json"],
    json: AGENT_KEYS,
    after: (_c, res) => {
      const request = res.requests.find((r) => r.method === "POST" && r.path === "/v1/agents")!;
      assert.equal((request.body as { wrapupMs: number }).wrapupMs, 45_000);
      assert.equal((JSON.parse(res.out) as { spec: { wrapupMs: number } }).spec.wrapupMs, 45_000);
    },
  },
  {
    name: "spawn --disposition hold --ttl",
    scope: "operator",
    argv: () => ["spawn", "--task", "t", "--disposition", "hold", "--ttl", "1h", "--budget", "1", "--key", "smoke-disp-hold", "--json"],
    json: AGENT_KEYS,
    after: (_c, res) => {
      const request = res.requests.find(
        (r) => r.method === "POST" && r.path === "/v1/agents" && (r.body as { idempotencyKey?: string }).idempotencyKey === "smoke-disp-hold",
      )!;
      assert.deepEqual((request.body as { disposition: unknown }).disposition, { mode: "hold", ttlMs: 3_600_000 });
    },
  },
  {
    name: "spawn --disposition reap-on-exit",
    scope: "operator",
    argv: () => ["spawn", "--task", "t", "--disposition", "reap-on-exit", "--budget", "1", "--key", "smoke-disp-reap", "--json"],
    json: AGENT_KEYS,
    after: (_c, res) => {
      const request = res.requests.find(
        (r) => r.method === "POST" && r.path === "/v1/agents" && (r.body as { idempotencyKey?: string }).idempotencyKey === "smoke-disp-reap",
      )!;
      assert.deepEqual((request.body as { disposition: unknown }).disposition, { mode: "reap-on-exit" });
    },
  },
  {
    name: "spawn --json",
    scope: "operator",
    argv: () => ["spawn", "--task", "smoke json", "--name", "smoke-b", "--key", "smoke-spawn-b", "--json"],
    json: AGENT_KEYS,
  },
  {
    name: "spawn --template --model",
    scope: "operator",
    argv: (c) => ["spawn", "--task", "t", "--name", "smoke-c", "--template", c.tpl, "--model", "test/m2", "--key", "smoke-spawn-c"],
    out: /^ag-[0-9a-f]+$/,
  },
  {
    name: "spawn --model unknown",
    scope: "operator",
    argv: () => ["spawn", "--task", "t", "--model", "x/y", "--key", "smoke-spawn-d"],
    exit: EXIT.usage,
    out: /unknown model: x\/y; run `pomtree models`/,
    fail: true,
  },
  // The fake harness has no sessions, so the named session is a clean not-found (the flags still reach the daemon).
  {
    name: "spawn --fork --from-commit --session",
    scope: "operator",
    argv: () => ["spawn", "--task", "t", "--name", "smoke-e", "--fork", "--from-commit", "HEAD", "--session", "none", "--key", "smoke-spawn-e"],
    exit: EXIT.notFound,
    out: /no such session: none/,
    fail: true,
  },
  { name: "send", covers: ["send"], scope: "agent", argv: (c) => ["send", c.root, "hello", "root", "--key", "smoke-send"], out: /^sent to \S+$/ },
  {
    name: "agent send to root is relayed to the user",
    scope: "agent",
    argv: (c) => ["send", c.root, "hi", "--key", "smoke-send-root"],
    out: /^sent to \S+$/,
  },
  {
    name: "agent send --interrupt is denied",
    scope: "agent",
    argv: (c) => ["send", c.peer, "now", "--interrupt", "--key", "smoke-int-agent"],
    exit: EXIT.denied,
    out: /only the operator may interrupt an agent/,
    fail: true,
  },
  { name: "operator send", scope: "operator", argv: (c) => ["send", c.peer, "hi", "--key", "smoke-op-send"], out: /^sent to \S+ \(queued\)$/ },
  {
    name: "operator send --interrupt",
    scope: "operator",
    argv: (c) => ["send", c.peer, "now", "--interrupt", "--key", "smoke-op-int"],
    out: /^sent to \S+ \(interrupting\)$/,
  },
  {
    name: "send --json",
    scope: "agent",
    argv: (c) => ["send", c.root, "again", "--key", "smoke-send2", "--json"],
    json: { kind: "string", from: "string", body: "string" },
  },
  { name: "peers after send", scope: "agent", argv: () => ["peers"], out: /^\S+\s+worker\s+running$/m },
  { name: "inbox as recipient (peer)", scope: "agent", as: "peer", argv: () => ["inbox"], out: /hi|message/ },
  {
    name: "ask",
    covers: ["ask"],
    scope: "agent",
    argv: () => ["ask", "second question?", "--options", "a,b", "--key", "smoke-ask"],
    out: /^es-[0-9a-f]+$/,
  },
  { name: "ask --json", scope: "agent", argv: () => ["ask", "third question?", "--key", "smoke-ask3", "--json"], json: ESCALATION_KEYS },
  {
    name: "ask --wait (unanswered -> timeout)",
    scope: "agent",
    argv: () => ["ask", "waiting question?", "--wait", "60", "--key", "smoke-ask-wait"],
    exit: EXIT.timeout,
    out: /^es-[0-9a-f]+ still open$/m,
  },
  {
    name: "escalations answer",
    covers: ["escalations answer"],
    scope: "operator",
    argv: (c) => ["escalations", "answer", c.esc, "yes", "--key", "smoke-answer"],
    out: /^answered es-[0-9a-f]+$/,
  },
  // Same key: the stored answer is replayed (not a conflict).
  {
    name: "escalations answer --json (replay)",
    scope: "operator",
    argv: (c) => ["escalations", "answer", c.esc, "yes", "--key", "smoke-answer", "--json"],
    json: { ...ESCALATION_KEYS, answer: "string", answeredBy: "object", answeredAt: "number" },
  },
  { name: "escalations ls --state answered", scope: "operator", argv: () => ["escalations", "ls", "--state", "answered"], out: /answered/ },
  // decide/answer/pass: the seed has no approval, and c.esc is already answered above, so these exercise routing, scope and typed errors.
  // The rig configures no approval gate, so every decide is "approvals are not configured" (exit 1) before any lookup.
  {
    name: "decide approve (unknown approval)",
    covers: ["decide"],
    scope: "operator",
    argv: () => ["decide", "no-such-approval", "approve", "--grant", "$1", "--why", "smoke", "--key", "smoke-decide"],
    exit: EXIT.error,
    out: /approvals are not configured/,
    fail: true,
  },
  {
    name: "decide deny as agent (unknown approval)",
    scope: "agent",
    as: "root",
    argv: () => ["decide", "no-such-approval", "deny", "--key", "smoke-decide-deny"],
    exit: EXIT.error,
    out: /approvals are not configured/,
    fail: true,
  },
  {
    name: "decide pass --json (unknown approval)",
    scope: "operator",
    argv: () => ["decide", "no-such-approval", "pass", "--json"],
    exit: EXIT.error,
    json: { error: "string" },
    out: /approvals are not configured/,
    fail: true,
  },
  {
    name: "answer (already answered)",
    covers: ["answer"],
    scope: "agent",
    as: "root",
    argv: (c) => ["answer", c.esc, "yes", "--key", "smoke-answer-agent"],
    exit: EXIT.conflict, // a late answer to an answered ask is a 409: refused, not applied
    out: /escalation es-[0-9a-f]+ was already answered; your answer was not applied/,
    fail: true,
  },
  {
    name: "pass (already answered)",
    covers: ["pass"],
    scope: "agent",
    as: "root",
    argv: (c) => ["pass", c.esc, "--key", "smoke-pass-agent"],
    out: /^passed es-[0-9a-f]+$/, // pomtreed currently lets a pass of an answered escalation succeed
  },
  { name: "inbox consumes (no signals)", scope: "agent", as: "root", argv: () => ["inbox", "--key", "smoke-inbox-ack"], out: /^no signals$/ },
  // No POMTREE_BASE_COMMIT and a non-repo cwd: push is refused up front (usage); pull cannot fetch into a non-clone. Both must fail cleanly.
  {
    name: "push (no base commit) is a clean usage error",
    covers: ["push"],
    scope: "agent",
    argv: () => ["push", "--branch", "agent/x", "--key", "smoke-push"],
    exit: EXIT.usage,
    out: /POMTREE_BASE_COMMIT is not set/,
    fail: true,
  },
  {
    name: "pull outside a clone fails cleanly",
    covers: ["pull"],
    scope: "agent",
    argv: (c) => ["pull", "--from", c.worker],
    exit: EXIT.error,
    out: /git fetch failed: .*not a git repository/,
    fail: true,
  },
  // The smoke daemon has no merge engine, so merge is refused cleanly as not configured (exit 1).
  {
    name: "merge is refused cleanly",
    covers: ["merge"],
    scope: "agent",
    argv: (c) => ["merge", c.peer, "--key", "smoke-merge"],
    exit: EXIT.error,
    out: /merging is not configured/,
    fail: true,
  },
  {
    name: "merge --into",
    scope: "agent",
    argv: (c) => ["merge", c.peer, "--into", "feature", "--key", "smoke-merge2"],
    exit: EXIT.error,
    out: /merging is not configured/,
    fail: true,
  },
  {
    name: "ext call",
    covers: ["ext call"],
    scope: "agent",
    argv: () => ["ext", "call", "web_search", "--input", '{"query":"x"}', "--key", "smoke-ext-call"],
    json: { items: "array" },
  },
  {
    name: "ext call --json (positional input)",
    scope: "agent",
    argv: () => ["ext", "call", "web_search", '{"query":"y"}', "--key", "smoke-ext-call2", "--json"],
    json: EXT_CALL_KEYS,
  },
  {
    name: "ext search",
    covers: ["ext search"],
    scope: "agent",
    argv: () => ["ext", "search", "--query", "pomtree", "--key", "smoke-ext-search"],
    out: /^1\. T\n\s+https:\/\/example\.invalid\/\n\s+S$/,
  },
  {
    name: "ext search --json",
    scope: "agent",
    argv: () => ["ext", "search", "--query", "pomtree", "--key", "smoke-ext-search2", "--json"],
    json: EXT_CALL_KEYS,
  },
  {
    name: "ext fetch (denied offline)",
    covers: ["ext fetch"],
    scope: "agent",
    argv: () => ["ext", "fetch", "https://example.invalid/", "--key", "smoke-ext-fetch"],
    out: /^network egress denied \(offline stub\)$/,
  },
  {
    name: "ext fetch --json (denied offline)",
    scope: "agent",
    argv: () => ["ext", "fetch", "https://example.invalid/", "--key", "smoke-ext-fetch2", "--json"],
    json: { callId: "string", ok: "boolean", denied: "boolean", reason: "string" },
  },
  {
    name: "ext call not enabled",
    scope: "agent",
    as: "peer",
    argv: () => ["ext", "call", "echo", "--input", "{}", "--key", "smoke-ext-no"],
    exit: EXIT.denied,
    out: /extension echo is not enabled for this agent/,
    fail: true,
  },
  {
    name: "report publish",
    covers: ["report publish"],
    scope: "agent",
    argv: (c) => ["report", "publish", c.file, "--name", "smoke2", "--media-type", "text/markdown", "--key", "smoke-pub"],
    out: /^published [0-9a-f]{64}$/,
  },
  {
    name: "report publish --json (replay)",
    scope: "agent",
    argv: (c) => ["report", "publish", c.file, "--name", "smoke2", "--key", "smoke-pub", "--json"],
    json: REPORT_KEYS,
  },
  {
    name: "report publish missing file",
    scope: "agent",
    argv: () => ["report", "publish", "/nonexistent/file.md"],
    exit: EXIT.usage,
    out: /cannot read \/nonexistent\/file\.md/,
    fail: true,
  },
  { name: "report rm", covers: ["report rm"], scope: "operator", argv: (c) => ["report", "rm", c.report, c.rep, "--key", "smoke-rm"], out: /removed/ },
  {
    name: "report rm missing",
    scope: "operator",
    argv: (c) => ["report", "rm", c.report, c.rep, "--key", "smoke-rm2"],
    exit: EXIT.notFound,
    out: /no such report/,
    fail: true,
  },
  // pomtree state: real CLI -> real daemon -> real store-sqlite; order matters (put, read, export, import, rm).
  {
    name: "state put",
    covers: ["state put"],
    scope: "operator",
    argv: () => ["state", "put", "smoke", "memo/a", '{"n":1}', "--expect-rev", "none", "--key", "smoke-state-put"],
    out: /wrote smoke\/memo\/a rev 1/,
  },
  {
    name: "state put --file",
    scope: "operator",
    argv: (c) => ["state", "put", "smoke", "memo/b", "--file", c.jfile, "--key", "smoke-state-put-file"],
    out: /wrote smoke\/memo\/b/,
  },
  { name: "state ls (owners)", covers: ["state ls"], scope: "operator", argv: () => ["state", "ls", "--owner", "smoke", "--prefix", "memo/"], out: /memo\/a/ },
  { name: "state ls --json", scope: "operator", argv: () => ["state", "ls", "--owner", "smoke", "--json"], json: { docs: "array" } },
  {
    name: "state ls --after --limit",
    scope: "operator",
    argv: () => ["state", "ls", "--owner", "smoke", "--prefix", "memo/", "--after", "memo/a", "--limit", "10"],
    out: /memo\/b/,
  },
  { name: "state show", covers: ["state show"], scope: "operator", argv: () => ["state", "show", "smoke", "memo/a"], out: /rev 1/ },
  {
    name: "state show --json",
    scope: "operator",
    argv: () => ["state", "show", "smoke", "memo/a", "--json"],
    json: { owner: "string", key: "string", rev: "number", bytes: "number", writer: "object", value: "object" },
  },
  {
    name: "state show missing",
    scope: "operator",
    argv: () => ["state", "show", "smoke", "memo/none"],
    exit: EXIT.notFound,
    out: /no such state document/,
    fail: true,
  },
  {
    name: "state export",
    covers: ["state export"],
    scope: "operator",
    argv: (c) => ["state", "export", "smoke", "--prefix", "memo/", "--out", c.xfile],
    out: /exported 2 documents/,
  },
  {
    name: "state import",
    covers: ["state import"],
    scope: "operator",
    argv: (c) => ["state", "import", "smoke", c.xfile, "--key", "smoke-state-import"],
    out: /imported 2 documents/,
  },
  {
    name: "state rm KEY",
    covers: ["state rm"],
    scope: "operator",
    argv: () => ["state", "rm", "smoke", "memo/b", "--yes", "--key", "smoke-state-rm"],
    out: /removed 1 document/,
  },
  {
    name: "state rm --prefix --older-than",
    scope: "operator",
    argv: () => ["state", "rm", "smoke", "--prefix", "memo/", "--older-than", "30d", "--yes", "--key", "smoke-state-rm-old"],
    out: /removed 0 documents/,
  },
  {
    name: "sched add",
    covers: ["sched add"],
    scope: "operator",
    argv: () => ["sched", "add", "smoke-s", "*/5 * * * *", "do the thing", "--tz", "UTC", "--missed", "run-one", "--overlap", "queue", "--jitter", "10"],
    out: /added/,
  },
  {
    name: "sched add --json (replace)",
    scope: "operator",
    argv: () => ["sched", "add", "smoke-s", "0 * * * *", "do it hourly", "--json"],
    json: SCHEDULE_KEYS,
  },
  { name: "sched pause", covers: ["sched pause"], scope: "operator", argv: () => ["sched", "pause", "smoke-s", "--key", "smoke-pause"], out: /paused/ },
  { name: "sched ls (paused)", scope: "operator", argv: () => ["sched", "ls"], out: /smoke-s/ },
  { name: "sched resume", covers: ["sched resume"], scope: "operator", argv: () => ["sched", "resume", "smoke-s", "--json"], json: SCHEDULE_KEYS },
  { name: "sched rm", covers: ["sched rm"], scope: "operator", argv: () => ["sched", "rm", "smoke-s", "--key", "smoke-schedrm"], out: /removed/ },
  { name: "sched rm --json", scope: "operator", argv: (c) => ["sched", "rm", c.sched, "--json"], json: { removed: "boolean" } },
  // Delete is idempotent: removing a schedule that does not exist succeeds (TODO(rule6) covers its missing idempotency key).
  { name: "sched rm missing", scope: "operator", argv: () => ["sched", "rm", "nope"], out: /^removed nope$/ },
  {
    name: "result --save-uncommitted rejects a stale approval",
    scope: "agent",
    as: "resulter",
    argv: () => ["result", "--summary", "save it", "--save-uncommitted", "stale-snapshot", "--key", "smoke-save-stale"],
    exit: EXIT.conflict,
    out: /workspace changed since approval/,
    after: (_c, res) => {
      const request = res.requests.find((r) => r.method === "POST" && r.path === "/v1/agents/self/result")!;
      assert.deepEqual(request.body, {
        status: "succeeded",
        result: { summary: "save it" },
        saveUncommitted: "stale-snapshot",
        idempotencyKey: "smoke-save-stale",
      });
    },
  },
  {
    name: "result (finisher)",
    covers: ["result"],
    scope: "agent",
    as: "resulter",
    argv: () => ["result", "--status", "succeeded", "--summary", "smoke handoff", "--key", "smoke-result", '{"ok":true}'],
    out: /recorded/,
  },
  // Same key, different body: refused as a conflicting replay, never recorded twice.
  {
    name: "result --summary-file",
    covers: ["result"],
    scope: "agent",
    as: "resulter",
    argv: (c) => ["result", "--summary-file", c.file, "--key", "smoke-result"],
    exit: EXIT.conflict,
    out: /a different result was already reported under idempotency key smoke-result/,
    fail: true,
  },
  // A running agent with no result yet (killer, killed later), so the refusal is the missing summary and not "already has a result".
  {
    name: "result without a summary is refused",
    scope: "agent",
    as: "killer",
    argv: () => ["result", "--key", "smoke-result-nosum"],
    exit: EXIT.usage,
    out: /A handoff is required: pass --summary/,
    fail: true,
  },
  {
    name: "reap",
    covers: ["reap"],
    scope: "operator",
    argv: (c) => ["reap", c.finisher, "--key", "smoke-reap"],
    out: /^reaped \S+ \(\$0\.00 \(\d+ µ\$\) returned\)\nhandoff:/,
  },
  {
    name: "reap --json (replay)",
    scope: "operator",
    argv: (c) => ["reap", c.finisher, "--key", "smoke-reap", "--json"],
    json: { record: "object", unusedMicros: "number" },
  },
  {
    name: "reap running agent refused",
    scope: "operator",
    argv: (c) => ["reap", c.worker],
    exit: EXIT.conflict,
    out: /agent is running, not exited/,
    fail: true,
  },
  {
    name: "cancel",
    covers: ["cancel"],
    scope: "operator",
    argv: (c) => ["cancel", c.canceler, "--grace", "50", "--key", "smoke-cancel"],
    out: /cancel requested/,
  },
  { name: "kill", covers: ["kill"], scope: "operator", argv: (c) => ["kill", c.killer, "--key", "smoke-kill", "--json"], json: { accepted: "boolean" } },
  // The seeded agent holds a sandbox on the selected backend, so the abandon kills it there, ends the run and reports it.
  {
    name: "abandon",
    covers: ["abandon"],
    scope: "operator",
    argv: (c) => ["abandon", c.abandoner, "--reason", "smoke", "--key", "smoke-abandon"],
    out: /abandoned; sandbox \S+ killed on \S+/,
  },
  {
    name: "abandon --json (replay finds it abandoned)",
    scope: "operator",
    argv: (c) => ["abandon", c.abandoner, "--key", "smoke-abandon-2", "--json"],
    json: { agent: "string", outcome: "string", message: "string" },
  },
  {
    name: "abandon unknown agent",
    scope: "operator",
    argv: () => ["abandon", "no-such-agent", "--key", "smoke-abandon-3"],
    exit: EXIT.notFound,
    out: /no such agent/,
    fail: true,
  },
  // The seeded worker runs with no session deadline, so there is nothing to extend: a clean conflict naming why.
  {
    name: "extend",
    covers: ["extend"],
    scope: "operator",
    argv: (c) => ["extend", c.worker, "--deadline", "30m", "--key", "smoke-extend"],
    exit: EXIT.conflict,
    out: /no session deadline \(unlimited\); nothing to extend/,
    fail: true,
  },
  {
    name: "yield (yielder)",
    covers: ["yield"],
    scope: "agent",
    as: "yielder",
    argv: () => ["yield", "--until", "message", "--key", "smoke-yield"],
    out: /^yielded \S+$/,
  },
  { name: "resume", covers: ["resume"], scope: "operator", argv: (c) => ["resume", c.yielder, "--key", "smoke-resume"], out: /^resumed \S+$/ },
  { name: "resume --force", scope: "operator", argv: (c) => ["resume", c.yielder, "--force", "--key", "smoke-resume-f"], out: /^resumed \S+$/ },
  {
    name: "resume non-yielded agent",
    scope: "operator",
    argv: (c) => ["resume", c.peer],
    exit: EXIT.conflict,
    out: /no checkpoint for /,
    fail: true,
  },
  { name: "ps after mutations", scope: "operator", argv: () => ["ps"], out: /worker/ },
  { name: "tree after mutations", scope: "operator", argv: () => ["tree"], out: /worker/ },
  // run last, from the suite epilogue
  {
    name: "drain",
    covers: ["drain"],
    scope: "operator",
    argv: () => ["drain", "--deadline", "100", "--key", "smoke-drain"],
    out: /^draining \(deadline in 100ms\)$/,
  },
];

// ---- wrong scope: agent running operator commands, operator running agent-only commands ----
// Each is refused with one code: 4 (denied) when the daemon's scope check refuses it, 2 (usage) when pomtree refuses locally because
// the operator has no agent credential for `self`.
const OPERATOR_ONLY = /operator scope required \(this command is for the host operator/;
const NEEDS_AGENT = /'self' needs an agent credential/;
const WRONG_RAW: Case[] = [
  { name: "agent: spend", scope: "agent", argv: () => ["spend"], out: OPERATOR_ONLY },
  { name: "agent: escalations ls", scope: "agent", argv: () => ["escalations", "ls"], out: OPERATOR_ONLY },
  { name: "agent: escalations answer", scope: "agent", argv: (c) => ["escalations", "answer", c.esc, "x"], out: /does not hold escalation/ },
  { name: "agent: template ls", scope: "agent", argv: () => ["template", "ls"], out: OPERATOR_ONLY },
  { name: "agent: template show", scope: "agent", argv: (c) => ["template", "show", c.tpl], out: OPERATOR_ONLY },
  { name: "agent: models", scope: "agent", argv: () => ["models"], out: OPERATOR_ONLY },
  { name: "agent: doctor", scope: "agent", argv: () => ["doctor"], out: OPERATOR_ONLY },
  { name: "agent: drain", scope: "agent", argv: () => ["drain"], out: OPERATOR_ONLY },
  { name: "agent: resume --force", scope: "agent", argv: (c) => ["resume", c.yielder, "--force"], out: /--force is operator-only/ },
  { name: "agent: report rm", scope: "agent", argv: (c) => ["report", "rm", c.root, "X"], out: /forbidden/ },
  // Strict: the agent is refused by the daemon's operator-scope check (403 -> exit 4), not a CLI-local usage error.
  {
    name: "agent: workflow launch",
    scope: "agent",
    argv: () => ["workflow", "launch", "hn/digest", "--key", "smoke-wf-agent"],
    out: OPERATOR_ONLY,
  },
  // Agents may add/rm/ls their own (self-targeted) schedules; they may not target another agent or pause/resume.
  {
    name: "agent: sched add --agent other",
    scope: "agent",
    argv: (c) => ["sched", "add", "w", "*/10 * * * *", "t", "--agent", c.peer],
    out: /an agent may schedule only itself/,
  },
  { name: "agent: sched pause", scope: "agent", argv: (c) => ["sched", "pause", c.sched], out: /forbidden/ },
  { name: "agent: sched rm operator's", scope: "agent", argv: (c) => ["sched", "rm", c.sched], out: /an agent may remove only its own schedules/ },
  { name: "agent: trace", scope: "agent", argv: (c) => ["trace", c.worker], out: OPERATOR_ONLY },
  { name: "agent: kill unrelated", scope: "agent", argv: (c) => ["kill", c.root], out: /agents may only address themselves/ },
  { name: "agent: extend", scope: "agent", argv: (c) => ["extend", c.worker, "--deadline", "30m"], out: OPERATOR_ONLY },
  { name: "operator: result", scope: "operator", argv: () => ["result", "{}"], exit: EXIT.usage, out: NEEDS_AGENT },
  { name: "operator: inbox", scope: "operator", argv: () => ["inbox", "--peek"], exit: EXIT.usage, out: NEEDS_AGENT },
  { name: "operator: peers", scope: "operator", argv: () => ["peers"], out: /agent scope required/ },
  // An operator shell has no POMTREE_AGENT_GENERATION, which pomtree checks before the call.
  { name: "operator: ask", scope: "operator", argv: () => ["ask", "q?"], exit: EXIT.usage, out: /POMTREE_AGENT_GENERATION must be a non-negative integer/ },
  { name: "operator: budget", scope: "operator", argv: () => ["budget"], exit: EXIT.usage, out: NEEDS_AGENT },
  { name: "operator: yield", scope: "operator", argv: () => ["yield", "--until", "message"], exit: EXIT.usage, out: NEEDS_AGENT },
  { name: "operator: whoami", scope: "operator", argv: () => ["whoami"], exit: EXIT.usage, out: NEEDS_AGENT },
  { name: "operator: report publish", scope: "operator", argv: (c) => ["report", "publish", c.file], out: /forbidden/ },
  { name: "operator: ext list", scope: "operator", argv: () => ["ext", "list"], out: /agent scope required/ },
  { name: "operator: ext call", scope: "operator", argv: () => ["ext", "call", "echo", "--input", "{}"], out: /agent scope required/ },
  { name: "operator: ext search", scope: "operator", argv: () => ["ext", "search", "--query", "q"], out: /agent scope required/ },
  { name: "operator: ext fetch", scope: "operator", argv: () => ["ext", "fetch", "https://example.invalid/"], out: /agent scope required/ },
];
const WRONG_SCOPE: Case[] = WRONG_RAW.map((c) => ({ ...c, fail: true, exit: c.exit ?? EXIT.denied }));

// ---- tests ----
describe("pomtree CLI smoke: coverage of USAGE", () => {
  test("every command and flag in USAGE has a smoke case", async () => {
    const { keys, flags } = await usageKeys();
    assert.ok(keys.length >= 30, `parsed only ${keys.length} USAGE commands`);
    const covered = new Set([...BLANK, ...SEEDED].flatMap((c) => c.covers ?? []));
    const missing = keys.filter((k) => !covered.has(k));
    assert.deepEqual(missing, [], missing.map((k) => `add smoke case for '${k}'`).join("; "));
    const stale = [...covered].filter((k) => !keys.includes(k));
    assert.deepEqual(stale, [], `smoke cases cover commands no longer in USAGE: ${stale}`);
    const used = new Set([...BLANK, ...SEEDED, ...WRONG_SCOPE, ...USAGE_ERRORS].flatMap((c) => c.argv(dummy)).filter((a) => a.startsWith("-")));
    const untested = [...flags].filter((f) => !used.has(f) && !["--help", "--no-color"].includes(f));
    assert.deepEqual(untested, [], untested.map((f) => `add smoke case using flag ${f}`).join("; "));
  });
  test("matrix size", () => {
    const tables = [BLANK, SEEDED, WRONG_SCOPE, USAGE_ERRORS];
    const n = tables.reduce((sum, t) => sum + t.length, 0);
    assert.ok(n > 0, "smoke matrix has no cases");
    assert.ok(
      tables.every((t) => t.length > 0),
      "a smoke case table is empty: add cases or delete the table",
    );
    console.log(
      `# cli-smoke matrix: ${n} cases (${BLANK.length} blank, ${SEEDED.length} seeded, ${WRONG_SCOPE.length} wrong-scope, ${USAGE_ERRORS.length} usage)`,
    );
  });
});

function suite(title: string, seeded: boolean, cases: Case[], extra?: (w: () => World) => void) {
  describe(title, () => {
    let w!: World;
    before(
      async () => {
        w = await makeWorld(seeded);
      },
      { timeout: 30_000 },
    );
    after(async () => {
      if (w) await close(w);
    });
    for (const c of cases) {
      test(c.name, { timeout: HARD_TIMEOUT_MS + 5_000 }, async () => {
        const argv = c.argv(w.ids);
        const res = await cli(w, c.scope, argv, {
          as: c.as ? (c.as === "root" ? "root" : ((w.ids as unknown as Record<string, string>)[c.as] ?? c.as)) : undefined,
          env: c.env,
        });
        check(c, argv, res);
        c.after?.(w.ids, res);
      });
    }
    extra?.(() => w);
  });
}

suite("pomtree CLI smoke: blank daemon", false, [...BLANK, ...USAGE_ERRORS]);

suite("pomtree CLI smoke: seeded daemon", true, SEEDED, (w) => {
  test("idempotent ask: same --key returns the same escalation", async () => {
    const a = await cli(w(), "agent", ["ask", "idem?", "--key", "smoke-idem"]);
    const b = await cli(w(), "agent", ["ask", "idem?", "--key", "smoke-idem"]);
    invariants(["ask"], a);
    invariants(["ask"], b);
    assert.equal(a.code, 0, a.err);
    assert.equal(b.out, a.out);
  });
  test("state: agents are default-deny; a read grant allows show/ls but not put", async () => {
    const show = ["state", "show", "smoke", "memo/a"];
    const denied = await cli(w(), "agent", show, { as: w().ids.peer });
    invariants(show, denied);
    assert.equal(denied.code, EXIT.denied, denied.err);
    assert.match(denied.err, /no read grant/);
    const ok = await cli(w(), "agent", show);
    invariants(show, ok);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /rev \d+/);
    const ls = await cli(w(), "agent", ["state", "ls"]);
    invariants(["state", "ls"], ls);
    assert.equal(ls.code, 0, ls.err);
    assert.match(ls.out, /smoke/);
    const put = ["state", "put", "smoke", "memo/z", "{}", "--key", "smoke-agent-put"];
    const w2 = await cli(w(), "agent", put);
    invariants(put, w2);
    assert.equal(w2.code, EXIT.denied, w2.err);
    assert.match(w2.err, /no write grant/);
  });
  test("state put: same --key replays the same revision; a stale --expect-rev is exit 5 naming the current rev", async () => {
    const a = ["state", "put", "smoke", "memo/c", '{"v":1}', "--expect-rev", "none", "--key", "smoke-idem-put"];
    const first = await cli(w(), "operator", a);
    const replay = await cli(w(), "operator", a);
    invariants(a, first);
    invariants(a, replay);
    assert.equal(first.code, 0, first.err);
    assert.equal(replay.code, 0, replay.err);
    assert.equal(replay.out, first.out);
    const c = ["state", "put", "smoke", "memo/c", '{"v":2}', "--expect-rev", "none", "--key", "smoke-conflict-put"];
    const conflict = await cli(w(), "operator", c);
    invariants(c, conflict);
    assert.equal(conflict.code, EXIT.conflict, conflict.err);
    assert.match(conflict.err, /current rev is 1/);
  });
  test("state import above the daemon's 1 MiB body limit succeeds in batches and round-trips through export", async () => {
    const file = join(w().r.stateDir, "state-big.json");
    const docs = Array.from({ length: 12 }, (_, i) => ({ key: `big/k${String(i).padStart(2, "0")}`, value: { pad: "x".repeat(120 * 1024), i } }));
    writeFileSync(file, JSON.stringify({ docs }));
    const imp = ["state", "import", "bulk", file, "--key", "smoke-big-import"];
    const r1 = await cli(w(), "operator", imp);
    invariants(imp, r1);
    assert.equal(r1.code, 0, r1.err);
    assert.match(r1.out, /imported 12 documents/);
    const out = join(w().r.stateDir, "state-big-export.json");
    const exp = ["state", "export", "bulk", "--out", out];
    const r2 = await cli(w(), "operator", exp);
    invariants(exp, r2);
    assert.equal(r2.code, 0, r2.err);
    assert.match(r2.out, /exported 12 documents/);
    assert.ok(statSync(out).size > 1 << 20, "the export is itself over 1 MiB");
    const again = ["state", "import", "bulk2", out, "--key", "smoke-big-reimport"];
    const r3 = await cli(w(), "operator", again);
    invariants(again, r3);
    assert.equal(r3.code, 0, r3.err);
    assert.match(r3.out, /imported 12 documents/);
  });
  test("agent commands without POMTREE_AGENT_GENERATION are a clean usage error", async () => {
    for (const argv of [
      ["ask", "q?"],
      ["report", "publish", w().ids.file],
    ]) {
      const res = await cli(w(), "agent", argv, { env: { POMTREE_AGENT_GENERATION: undefined } });
      invariants(argv, res);
      assert.equal(res.code, EXIT.usage, `${argv.join(" ")}: ${res.err}`);
      assert.match(res.err, /^pomtree: /);
    }
  });
  test("unreachable daemon is exit 6 with a hint, not a crash", async () => {
    const res = await cli({ ...w(), sock: join(w().r.stateDir, "nope.sock") }, "operator", ["ps"]);
    invariants(["ps"], res);
    assert.equal(res.code, EXIT.unreachable);
    assert.match(res.err, /^pomtree: /);
  });
  test("bad token is denied (exit 4)", async () => {
    const res = await cli({ ...w(), tok: () => "bogus" }, "operator", ["ps"]);
    invariants(["ps"], res);
    assert.equal(res.code, EXIT.denied);
    assert.match(res.err, /^pomtree: /);
  });
});

suite("pomtree CLI smoke: wrong scope", true, WRONG_SCOPE);
