import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_DEFAULTS, DEFAULT_DENIED_PATHS } from "@pomtree/core";
import { DEFAULT_WATCHDOG } from "@pomtree/sched";
import { AGENT_TOKEN_TTL_MS } from "./auth.ts";
import { DEFAULT_BUDGET_RAISE_MS, DEFAULT_BUDGET_RAISE_PCT } from "./budget-raise.ts";
import { DEFAULT_MAX_SESSION_MS, DEFAULT_SESSION_MS } from "./daemon.ts";
import type { ManifestScan } from "./extension-manifest.ts";
import { fetchIdentityLine, formatConfigShow, loadDaemonConfig, parseDaemonArgv, type DaemonConfigInput } from "./daemon-config.ts";
import { DEFAULT_CONTAINER_MEMORY_BYTES } from "./host-guards.ts";
import { DEFAULT_LIMITS } from "./lifecycle.ts";
import { DEFAULT_MAX_REQUEST_MICROS, DEFAULT_PROXY_TOKEN_TTL_MS } from "./model-proxy-options.ts";
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "./model-proxy/service.ts";

const SECRET = "sk-test-sentinel-91c2";

// A temp dir holding the upstream key file; the minimal env every load needs (the model proxy is the only model path).
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pomtreed-config-"));
  const keyFile = join(dir, "upstream.key");
  writeFileSync(keyFile, `${SECRET}\n`, { mode: 0o600 });
  const base = { POMTREED_MODEL_BASE_URL: "http://127.0.0.1:1", POMTREED_MODEL_UPSTREAM_KEY_FILE: keyFile, POMTREED_PI_PROVIDER: "x" };
  const load = (o: { env?: Record<string, string>; set?: string[]; file?: unknown; configFile?: string; scan?: ManifestScan } = {}) => {
    let configFile = o.configFile;
    if (o.file !== undefined) {
      configFile = join(dir, "pomtreed.json");
      writeFileSync(configFile, JSON.stringify(o.file));
    }
    const input: DaemonConfigInput = {
      env: { ...base, ...o.env },
      args: { set: o.set ?? [], ...(configFile !== undefined && { configFile }) },
      readFile: (p) => readFileSync(p, "utf8"),
      fileMode: (p) => statSync(p).mode,
      defaultStateDir: join(dir, "state"),
      scanExtensions: () => o.scan ?? { extensions: [], errors: [] },
    };
    return loadDaemonConfig(input);
  };
  const errors = (o: Parameters<typeof load>[0]) => {
    const r = load(o);
    assert.equal(r.ok, false, "expected a refusal");
    return (r as { errors: string[] }).errors;
  };
  return { dir, keyFile, load, errors, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("loadDaemonConfig layers default < file < env < --set, with origins", () => {
  const f = fixture();
  try {
    const r = f.load({
      file: { agent: { maxDepth: 2, maxChildren: 3 }, drain: { timeoutMs: 1234 }, merge: { deny: [] } },
      env: { POMTREED_AGENT_MAX_DEPTH: "3", POMTREED_AGENT_MAX_CHILDREN: "5" },
      set: ["agent.maxDepth=6", "agent.maxDepth=7"],
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.config["agent.maxDepth"], 7, "--set wins, the last one");
    assert.equal(r.config["agent.maxChildren"], 5, "env beats the file");
    assert.equal(r.config["drain.timeoutMs"], 1234, "the file beats the default");
    assert.deepEqual(r.config["merge.deny"], [], "an empty list from the file means no denylist");
    assert.equal(r.config["model.upstreamKey"], SECRET, "the secret is read from its file, trailing newline stripped");
    assert.deepEqual(
      [r.resolved.origins["agent.maxDepth"], r.resolved.origins["agent.maxChildren"], r.resolved.origins["drain.timeoutMs"], r.resolved.origins["cron.tickMs"]],
      ["set", "env:POMTREED_AGENT_MAX_CHILDREN", "file", "default"],
    );
    assert.equal(r.journal, null, "journal pruning stays off by default");
    assert.equal(r.uiSpec, null);
    assert.equal(r.hostSpec, null);
    // POMTREED_CONFIG names the file when --config is absent; --config wins over it.
    const viaEnv = f.load({ env: { POMTREED_CONFIG: join(f.dir, "pomtreed.json") } });
    assert.ok(viaEnv.ok);
    assert.equal(viaEnv.config["drain.timeoutMs"], 1234);
  } finally {
    f.cleanup();
  }
});

test("each rejection class surfaces with its exact message", () => {
  const f = fixture();
  try {
    const ACTION = "; remove it, or use a name listed in docs/configuration.md";
    assert.deepEqual(f.errors({ env: { POMTREED_AGENT_MAX_DEPHT: "1" } }), [
      `unknown env POMTREED_AGENT_MAX_DEPHT (did you mean POMTREED_AGENT_MAX_DEPTH?)${ACTION}`,
    ]);
    assert.deepEqual(f.errors({ env: { POMTREED_MAX_DEPTH: "1" } }), [`unknown env POMTREED_MAX_DEPTH${ACTION}`]);
    assert.deepEqual(f.errors({ env: { POMTREED_ROOT_BUDGET_MICROS: "1" } }), [`unknown env POMTREED_ROOT_BUDGET_MICROS${ACTION}`]);
    assert.deepEqual(f.errors({ env: { POMTREED_MODEL_KEY: SECRET } }), [`unknown env POMTREED_MODEL_KEY${ACTION}`]);
    assert.ok(
      f
        .errors({ env: { POMTREED_BUDGET_ROOT_MICROS: "1000" } })
        .includes("budget.topLevelMicros=5000000 (default) exceeds its ceiling budget.rootMicros=1000 (env:POMTREED_BUDGET_ROOT_MICROS); refused, not clamped"),
    );
    assert.deepEqual(f.errors({ set: ["session.maxMs=999999999"] }), ["session.maxMs=999999999 (set) must be <= agent.tokenTtlMs=86400000 (default)"]);
    assert.deepEqual(f.errors({ file: { agent: { maxDepht: 1 } } }), ["config file: unknown key agent.maxDepht (did you mean agent.maxDepth?)"]);
    assert.deepEqual(f.errors({ configFile: join(f.dir, "absent.json") }).length, 1);
    assert.match(f.errors({ configFile: join(f.dir, "absent.json") })[0] as string, /^config file .*absent\.json: cannot read: /);
    writeFileSync(join(f.dir, "bad.json"), `{"secret": "${SECRET}"`);
    assert.deepEqual(f.errors({ configFile: join(f.dir, "bad.json") }), [`config file ${join(f.dir, "bad.json")}: not valid JSON`]);
    assert.deepEqual(f.errors({ env: { POMTREED_JOURNAL_KEEP_PER_AGENT: "5" } }), [
      "journal.keepPerAgent (env:POMTREED_JOURNAL_KEEP_PER_AGENT) requires journal.retentionMs > 0 (POMTREED_JOURNAL_RETENTION_MS)",
    ]);
    assert.match(
      f.errors({ env: { POMTREED_UI_LISTEN: "0.0.0.0:8787" } })[0] as string,
      /POMTREED_UI_LISTEN binds non-loopback 0\.0\.0\.0.*POMTREED_LISTEN_ALLOW_NONLOOPBACK=1/,
    );
    assert.match(f.errors({ env: { POMTREED_HOST_LISTEN: "nope" } })[0] as string, /^invalid POMTREED_HOST_LISTEN="nope"/);
    assert.match(f.errors({ env: { POMTREED_AGENT_LISTEN: "nope" } })[0] as string, /^invalid POMTREED_AGENT_LISTEN="nope"/);
    assert.match(f.errors({ env: { POMTREED_STATE_GRANTS: '{"x/y":[{"owner":"x","mode":"w"}]}' } })[0] as string, /POMTREED_STATE_GRANTS: mode for x\/y/);
    assert.match(f.errors({ env: { POMTREED_WORKFLOW_REVIEWED_EXTENSIONS: "Bad Name" } })[0] as string, /invalid POMTREED_WORKFLOW_REVIEWED_EXTENSIONS/);
    assert.deepEqual(f.errors({ env: { POMTREED_MODEL_BASE_URL: "" } }), [
      "model.baseUrl is required: the model proxy is the only model path (set POMTREED_MODEL_BASE_URL)",
    ]);
    // A malformed base URL is refused at resolve, naming the variable and never echoing a query, fragment or credentials.
    const baseExpect = "expected http(s)://host[/basePath] with no query, fragment or credentials, e.g. https://openrouter.ai/api/v1";
    assert.deepEqual(f.errors({ env: { POMTREED_MODEL_BASE_URL: "https://openrouter.ai/api?key=sk-q" } }), [
      `invalid POMTREED_MODEL_BASE_URL: it has a query string (https://openrouter.ai/api); ${baseExpect}`,
    ]);
    assert.deepEqual(f.errors({ env: { POMTREED_MODEL_BASE_URL: "openrouter.ai/api" } }), [
      `invalid POMTREED_MODEL_BASE_URL: not a parseable URL; ${baseExpect}`,
    ]);
    assert.deepEqual(f.errors({ env: { POMTREED_MODEL_BASE_URL: "https://u:pw@openrouter.ai/api" } }), [
      `invalid POMTREED_MODEL_BASE_URL: it carries credentials (user:password@); ${baseExpect}`,
    ]);
    assert.equal(f.load({ env: { POMTREED_MODEL_BASE_URL: "https://openrouter.ai/api/v1" } }).ok, true);
    assert.deepEqual(f.errors({ env: { POMTREED_MODEL_UPSTREAM_KEY_FILE: undefined as unknown as string } }), [
      "model.upstreamKey is required: set POMTREED_MODEL_UPSTREAM_KEY_FILE to a file holding the upstream API key",
    ]);
    assert.deepEqual(f.errors({ env: { POMTREED_PI_PROVIDER: "" } }), [
      "pi.provider is required: set POMTREED_PI_PROVIDER to the provider the model proxy serves (e.g. openrouter)",
    ]);
    // The registry's tightened bounds: no fractions, NaN, signs, 0 where a positive value is required, or loose switches.
    assert.deepEqual(f.errors({ env: { POMTREED_CAPACITY_MEMORY_FRACTION: "1.5" } }), [
      'capacity.memoryFraction="1.5" (env:POMTREED_CAPACITY_MEMORY_FRACTION): expected a number in 0..1',
    ]);
    assert.deepEqual(f.errors({ env: { POMTREED_CAPACITY_MEMORY_FRACTION: "0" } }), [
      'capacity.memoryFraction="0" (env:POMTREED_CAPACITY_MEMORY_FRACTION): is below its minimum 0.01',
    ]);
    assert.deepEqual(f.errors({ env: { POMTREED_APPROVAL_TIMEOUT_MS: "1.5" } }), [
      'approval.timeoutMs="1.5" (env:POMTREED_APPROVAL_TIMEOUT_MS): expected a non-negative integer of milliseconds',
    ]);
    assert.deepEqual(f.errors({ env: { POMTREED_AGENT_ZOMBIE_MS: "0" } }), ['agent.zombieMs="0" (env:POMTREED_AGENT_ZOMBIE_MS): is below its minimum 1']);
    assert.deepEqual(f.errors({ env: { POMTREED_MODEL_PROXY_MAX_REQUEST_MICROS: "0" } }), [
      'model.proxy.maxRequestMicros="0" (env:POMTREED_MODEL_PROXY_MAX_REQUEST_MICROS): is below its minimum 1',
    ]);
    assert.deepEqual(f.errors({ env: { POMTREED_WEBFETCH_ENABLED: "no" } }), [
      'webfetch.enabled="no" (env:POMTREED_WEBFETCH_ENABLED): expected true, false, 1 or 0',
    ]);
    assert.deepEqual(f.errors({ env: { POMTREED_CAPACITY_MAX_SESSIONS: " auto" } }), [
      'capacity.maxSessions=" auto" (env:POMTREED_CAPACITY_MAX_SESSIONS): expected "auto" or a positive integer',
    ]);
    assert.deepEqual(f.errors({ env: { POMTREED_STATE_DIR: "relative/dir" } }), [
      'state.dir="relative/dir" (env:POMTREED_STATE_DIR): expected an absolute path',
    ]);
    // Every error is reported, not just the first.
    assert.equal(f.errors({ env: { POMTREED_MAX_DEPTH: "1", POMTREED_IMAGE: "x" } }).length, 2);
  } finally {
    f.cleanup();
  }
});

test("a sensitive key never reaches an error or `config show`", () => {
  const f = fixture();
  try {
    for (const errs of [
      f.errors({ env: { POMTREED_MODEL_UPSTREAM_KEY: SECRET } }),
      f.errors({ set: [`model.upstreamKey=${SECRET}`] }),
      f.errors({ file: { model: { upstreamKey: SECRET } } }),
      f.errors({ env: { POMTREED_SEARCH_KEY: SECRET } }),
    ]) {
      assert.equal(errs.length, 1, JSON.stringify(errs));
      assert.doesNotMatch(errs.join("\n"), new RegExp(SECRET));
      assert.match(errs[0] as string, /_FILE to a file holding it/);
    }
    const r = f.load({ env: { POMTREED_SEARCH_KEY_FILE: f.keyFile, POMTREED_AGENT_MAX_DEPTH: "2", UNRELATED_SECRET: SECRET } });
    assert.ok(r.ok);
    for (const out of [formatConfigShow(r), formatConfigShow(r, { origin: true }), formatConfigShow(r, { json: true })]) {
      assert.doesNotMatch(out, new RegExp(SECRET));
      assert.doesNotMatch(out, /UNRELATED_SECRET/);
    }
    const lines = formatConfigShow(r, { origin: true }).split("\n");
    assert.ok(lines.includes('model.upstreamKey="<redacted>"  origin=file-secret:POMTREED_MODEL_UPSTREAM_KEY_FILE default=""'));
    assert.ok(lines.includes('search.key="<redacted>"  origin=file-secret:POMTREED_SEARCH_KEY_FILE default=""'));
    assert.ok(lines.includes("agent.maxDepth=2  origin=env:POMTREED_AGENT_MAX_DEPTH default=4"));
    assert.ok(formatConfigShow(r).split("\n").includes("agent.maxDepth=2"));
    const rows = JSON.parse(formatConfigShow(r, { json: true })) as { path: string; value: unknown; origin: string }[];
    assert.deepEqual(
      rows.find((x) => x.path === "model.upstreamKey"),
      { ...rows.find((x) => x.path === "model.upstreamKey"), value: "<redacted>", origin: "file-secret:POMTREED_MODEL_UPSTREAM_KEY_FILE" },
    );
    assert.equal(rows.length, lines.length, "one row per registry key");
  } finally {
    f.cleanup();
  }
});

test("parseDaemonArgv: --config, repeatable --set, config show flags, help, and refusals", () => {
  assert.deepEqual(parseDaemonArgv([]), { ok: true, args: { command: "run", set: [], origin: false, json: false } });
  assert.deepEqual(parseDaemonArgv(["--config", "/c.json", "--set", "a.b=1", "--set=c.d=2"]), {
    ok: true,
    args: { command: "run", configFile: "/c.json", set: ["a.b=1", "c.d=2"], origin: false, json: false },
  });
  assert.deepEqual(parseDaemonArgv(["config", "show", "--origin", "--json", "--config=/c.json"]), {
    ok: true,
    args: { command: "config-show", configFile: "/c.json", set: [], origin: true, json: true },
  });
  assert.deepEqual(parseDaemonArgv(["-h"]), { ok: true, args: { command: "help", set: [], origin: false, json: false } });
  assert.deepEqual(parseDaemonArgv(["--help"]), { ok: true, args: { command: "help", set: [], origin: false, json: false } });
  for (const flag of ["--version", "-V"])
    assert.deepEqual(parseDaemonArgv([flag]), { ok: true, args: { command: "version", set: [], origin: false, json: false } });
  // --help wins over --version in either order; --version wins over `config show`.
  assert.equal((parseDaemonArgv(["--version", "--help"]) as { args: { command: string } }).args.command, "help");
  assert.equal((parseDaemonArgv(["--help", "--version"]) as { args: { command: string } }).args.command, "help");
  assert.equal((parseDaemonArgv(["config", "show", "--version"]) as { args: { command: string } }).args.command, "version");
  assert.deepEqual(parseDaemonArgv(["--set"]), { ok: false, errors: ["--set needs a value"] });
  assert.deepEqual(parseDaemonArgv(["--bogus"]), { ok: false, errors: ["unknown option --bogus"] });
  assert.deepEqual(parseDaemonArgv(["start"]), { ok: false, errors: ["unknown command start (expected: config show)"] });
  assert.deepEqual(parseDaemonArgv(["--origin"]), { ok: false, errors: ["--origin applies only to `pomtreed config show`"] });
});

test("delivered container keys: the loader returns the subset, and a violated relation refuses the start with one line per error", () => {
  const f = fixture();
  try {
    const r = f.load({ env: { POMTREED_BROWSER_CAPTURE_TEXT_MAX_BYTES: "4096" } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.containerConfig["browser.capture.textMaxBytes"], 4096);
    assert.ok(Object.isFrozen(r.containerConfig));
    assert.equal("report.maxBytes" in r.containerConfig, false, "only delivered keys");
    // deadlineMinMs < deadlineMaxMs, and textMaxBytes <= report.maxBytes (8 MiB by default).
    const errs = f.errors({ env: { POMTREED_BROWSER_CAPTURE_DEADLINE_MIN_MS: "200000", POMTREED_BROWSER_CAPTURE_TEXT_MAX_BYTES: "16777216" } });
    assert.ok(errs.length >= 2, JSON.stringify(errs));
    assert.ok(errs.some((e) => e.includes("browser.capture.deadlineMinMs")));
    assert.ok(errs.some((e) => e.includes("browser.capture.textMaxBytes")));
    for (const e of errs) assert.doesNotMatch(e, /\n/, "one line per error");
  } finally {
    f.cleanup();
  }
});

// Behavior parity: with no env, no file and no --set, the resolved values equal the effective defaults pomtreed used before the
// registry (the exported constants that still hold them, and the literals main.ts and ext-gateway.ts used to inline).
test("parity: an empty config resolves to the previous effective defaults", () => {
  const f = fixture();
  try {
    const r = f.load();
    assert.ok(r.ok);
    const c = r.config;
    const OLD: ReadonlyArray<readonly [keyof typeof c, unknown]> = [
      ["session.defaultMs", DEFAULT_SESSION_MS],
      ["session.maxMs", DEFAULT_MAX_SESSION_MS],
      ["agent.tokenTtlMs", AGENT_TOKEN_TTL_MS],
      ["agent.maxDepth", DEFAULT_LIMITS.maxDepth],
      ["agent.maxChildren", DEFAULT_LIMITS.maxChildren],
      ["agent.zombieMs", DEFAULT_LIMITS.zombieMs],
      ["agent.zombieSweepMs", DEFAULT_LIMITS.zombieSweepMs],
      ["agent.reconcileSweepMs", 30_000],
      ["watchdog.sweepMs", DEFAULT_LIMITS.watchdogSweepMs],
      ["watchdog.blockedMs", DEFAULT_LIMITS.watchdogBlockedMs],
      ["watchdog.intensityWindowMs", DEFAULT_LIMITS.watchdogIntensityWindowMs],
      ["watchdog.stableMs", DEFAULT_LIMITS.watchdogStableMs],
      ["watchdog.stallMs", DEFAULT_WATCHDOG.stallMs],
      ["cron.tickMs", DEFAULT_LIMITS.cronTickMs],
      ["cleanup.sweepMs", DEFAULT_LIMITS.cleanupSweepMs],
      ["capacity.containerMemoryBytes", 2 * 1024 ** 3],
      ["capacity.containerMemoryBytes", DEFAULT_CONTAINER_MEMORY_BYTES],
      ["budget.raiseMs", DEFAULT_BUDGET_RAISE_MS],
      ["budget.raisePct", DEFAULT_BUDGET_RAISE_PCT],
      ["model.upstreamTimeoutMs", DEFAULT_UPSTREAM_TIMEOUT_MS],
      ["model.proxy.ttlMs", DEFAULT_PROXY_TOKEN_TTL_MS],
      ["model.proxy.maxRequestMicros", DEFAULT_MAX_REQUEST_MICROS],
      ["merge.deny", [...DEFAULT_DENIED_PATHS]],
      ["publish.deny", [...DEFAULT_DENIED_PATHS]],
      // The literals main.ts inlined before the registry.
      ["push.maxBytes", 256 * 1024 * 1024],
      // The pre-registry constants pomtreed no longer reads (report-limits.ts, core WAIT_YIELD_MS_DEFAULT), as literals.
      ["report.maxBytes", 8 << 20],
      ["report.workflowMaxBytes", 256 * 1024],
      ["wait.yieldMs", 20_000],
      ["budget.rootMicros", 10_000_000],
      ["budget.topLevelMicros", 5_000_000],
      ["budget.defaultMicros", 1_000_000],
      ["folder.retentionMs", 7 * 24 * 3600 * 1000],
      ["folder.reapedGraceMs", 0],
      ["folder.minFreeBytes", 0],
      ["idempotency.retentionMs", 30 * 24 * 3_600_000],
      ["drain.timeoutMs", 10_000],
      ["capacity.maxContainers", 32],
      ["capacity.minDiskFreeBytes", 1 << 30],
      ["capacity.memoryFraction", 0.9],
      ["capacity.maxSessions", "auto"],
      ["model.proxy.port", 18080],
      ["agent.image", "pomtree/agent:dev"],
      ["sandbox.socket", "/run/pomtreed.sock"],
      ["ui.listen", "off"],
      ["host.listen", "off"],
      ["escalation.channels", ["ui"]],
      ["messaging.channels", []],
      ["publish.targets", []],
      ["publish.scan", true],
      ["webfetch.enabled", true],
      ["harness.steerExt", true],
      ["harness.jobsExt", false],
      ["agent.probe", true],
      ["agent.adoptOrphans", false],
      ["listen.allowNonloopback", false],
      ["readyz.allowSandboxDown", false],
      ["journal.retentionMs", 0],
      // The daemon's in-code fallbacks for options main.ts now always passes (escalation.ts, lifecycle.ts).
      ["approval.timeoutMs", 300_000],
      ["ask.timeoutMs", 24 * 3_600_000],
      ["escalation.agentRungMs", 600_000],
      ["agent.interruptGraceMs", 5000],
      // The ext-gateway web_fetch caps (formerly unexported literals there; now read from CONFIG_DEFAULTS).
      ["webfetch.maxCalls", 60],
      ["webfetch.windowMs", 60_000],
      ["webfetch.maxTotalBytes", 32 * 1024 * 1024],
    ];
    for (const [path, value] of OLD) assert.deepEqual(c[path], value, path);
    for (const [path, value] of Object.entries(CONFIG_DEFAULTS)) {
      if (path === "model.baseUrl" || path === "model.upstreamKey" || path === "pi.provider") continue; // the fixture's required values
      assert.deepEqual((c as Record<string, unknown>)[path], value, `${path} resolves to its registry default`);
    }
  } finally {
    f.cleanup();
  }
});

test("loadDaemonConfig refuses a group/other-readable upstream key file", () => {
  const f = fixture();
  try {
    assert.ok(f.load().ok, "0600 is accepted");
    chmodSync(f.keyFile, 0o644);
    assert.deepEqual(f.errors({}), [`POMTREED_MODEL_UPSTREAM_KEY_FILE: ${f.keyFile} is readable by group/other; run chmod 600 ${f.keyFile}`]);
  } finally {
    f.cleanup();
  }
});

test("test.fetchHosts is off by default and refused outside test mode; test mode admits it", () => {
  const f = fixture();
  try {
    const def = f.load();
    assert.ok(def.ok, JSON.stringify(def));
    assert.equal(def.testMode, false, "test mode is off by default");
    assert.equal(def.testFetchHosts, null, "the fetch seam is off by default");

    const hosts = JSON.stringify({ "data.sec.gov": 18443 });
    for (const o of [
      { env: { POMTREED_TEST_FETCH_HOSTS: hosts } },
      { set: [`test.fetchHosts=${hosts}`] },
      { file: { test: { fetchHosts: { "data.sec.gov": 18443 } } } },
    ]) {
      const errs = f.errors(o);
      assert.ok(
        errs.some((e) => e.includes("test.fetchHosts is a test-only seam") && e.includes("POMTREED_TEST_MODE=true")),
        `refused without test mode: ${JSON.stringify(errs)}`,
      );
      assert.equal(f.errors({ ...o, set: [...(o.set ?? []), "test.mode=false"] }).length > 0, true, "an explicit test.mode=false is still refused");
    }

    const on = f.load({ env: { POMTREED_TEST_MODE: "true", POMTREED_TEST_FETCH_HOSTS: hosts } });
    assert.ok(on.ok, JSON.stringify(on));
    assert.equal(on.testMode, true);
    assert.deepEqual([...(on.testFetchHosts ?? [])], [["data.sec.gov", 18443]]);

    const modeOnly = f.load({ env: { POMTREED_TEST_MODE: "true" } });
    assert.ok(modeOnly.ok);
    assert.equal(modeOnly.testFetchHosts, null, "test mode alone turns no seam on");

    for (const bad of [{ "https://data.sec.gov": 1 }, { "data.sec.gov": "127.0.0.1:1" }, { "data.sec.gov": 0 }, { "127.0.0.1": 80 }, ["data.sec.gov"]])
      assert.ok(
        f.errors({ env: { POMTREED_TEST_MODE: "true", POMTREED_TEST_FETCH_HOSTS: JSON.stringify(bad) } }).length > 0,
        `${JSON.stringify(bad)} is refused`,
      );
  } finally {
    f.cleanup();
  }
});

test("fetchIdentityLine: names the effective User-Agent, the key and its env, and recommends a contact; formats what it is given", () => {
  assert.equal(
    fetchIdentityLine("pomtree"),
    'pomtreed: fetch identity: User-Agent "pomtree" (workflow.fetch.userAgent, env POMTREED_WORKFLOW_FETCH_USER_AGENT); naming a contact in it is recommended, e.g. "pomtree (+https://example.org/contact)"',
  );
  assert.match(
    fetchIdentityLine("acme-bot ops@example.org"),
    /User-Agent "acme-bot ops@example\.org" \(workflow\.fetch\.userAgent, env POMTREED_WORKFLOW_FETCH_USER_AGENT\)/,
  );
});

test("parseDaemonArgv: preflight and init hand their remaining arguments to the onboarding commands; the daemon's own flags still apply elsewhere", () => {
  assert.deepEqual(parseDaemonArgv(["preflight", "--json", "--repo", "/r"]), {
    ok: true,
    args: { command: "preflight", set: [], origin: false, json: false, rest: ["--json", "--repo", "/r"] },
  });
  assert.deepEqual(parseDaemonArgv(["init", "--questions"]), {
    ok: true,
    args: { command: "init", set: [], origin: false, json: false, rest: ["--questions"] },
  });
  // negative control: `preflight` after other arguments is not the subcommand
  assert.deepEqual(parseDaemonArgv(["--set", "a.b=1", "preflight"]), { ok: false, errors: ["unknown command preflight (expected: config show)"] });
});
