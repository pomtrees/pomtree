// Boot refusals (S0, no Docker, no network): items INS-9, EGR-8 (refusal half), SAF-2 (refusal half), the SAF-3
// session-bound case, MIG-2 and SAF-4, run against the real pomtreed binary (packages/pomtreed/src/main.ts) in a subprocess.
// Run: node --test packages/e2e/src/boot-refusals.test.ts
//
// Each child gets a clean env built from scratch (HOME, PATH and the variables under test only; the operator's own POMTREED_*/POMTREE_* settings
// never leak in, same rule as cli-scenarios-harness.ts), a hard timeout with SIGKILL (a case that wrongly boots fails fast instead of hanging),
// and the same pass rule: exit nonzero, before "pomtreed listening", with a message that names the variable and the cause.
//
// Controls. A control that boots needs Docker, so none boots. `pomtreed config show --origin` runs loadDaemonConfig, the same registry
// validation as a start (main.ts: the load happens before the `config-show` branch), so it is the control for every registry-validated
// refusal (INS-9, EGR-8, session bounds): the corrected value passes `config show`. It is NOT a control for SAF-2: the sender allowlist is
// read from the env and checked in main.ts after the `config-show` exit, so `config show` accepts a missing or malformed
// POMTREED_MESSAGING_SENDERS. The pure check has its own unit tests (pomtreed channels tests); no control is written here for it.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "@pomtree/store-sqlite";
import { detectBridgeGateway, planAgentListen } from "../../pomtreed/src/agent-net.ts";
import { isLoopbackHost } from "../../pomtreed/src/config.ts";
import { realpathLoose, safetyBootErrors } from "../../pomtreed/src/safety-boot.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pomtreedMain = join(ROOT, "packages/pomtreed/src/main.ts");

interface Run {
  code: number | null;
  timedOut: boolean;
  out: string;
  err: string;
  all: string;
}

// How long a refusal may take before the run counts as a hang or a boot. A refusal does no Docker work, but node startup plus
// type-stripping pomtreed's main.ts took over 10 s on the 2-vCPU hosted runner under parallel test files; a wrong boot still never exits, so it
// is still caught (timedOut), only later.
const POMTREED_TIMEOUT_MS = 30_000;

// `env` entries with an undefined value are left out. Only HOME, PATH and `env` reach the child; cwd is the scratch dir.
function pomtreed(scratch: string, env: Record<string, string | undefined>, args: string[] = [], timeoutMs = POMTREED_TIMEOUT_MS): Promise<Run> {
  const clean: Record<string, string> = { HOME: join(scratch, "home"), PATH: process.env.PATH ?? "" };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [pomtreedMain, ...args], { cwd: scratch, env: clean, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    p.stdout.on("data", (c: Buffer) => (out += c.toString()));
    p.stderr.on("data", (c: Buffer) => (err += c.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill("SIGKILL");
    }, timeoutMs);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, out, err, all: out + err });
    });
  });
}

interface Scratch {
  dir: string;
  stateDir: string; // not created: a refused start must not create it
  keyFile: string; // mode 0600, random bytes
  key: string;
  base: Record<string, string>; // a model env that passes validation
}

async function withScratch(fn: (s: Scratch) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-e2e-boot-"));
  try {
    mkdirSync(join(dir, "home"));
    const key = randomBytes(24).toString("hex");
    const keyFile = join(dir, "upstream.key");
    writeFileSync(keyFile, key, { mode: 0o600 });
    const stateDir = join(dir, "state");
    await fn({
      dir,
      stateDir,
      keyFile,
      key,
      base: {
        POMTREED_STATE_DIR: stateDir,
        POMTREED_MODEL_BASE_URL: "http://127.0.0.1:9",
        POMTREED_PI_PROVIDER: "deepseek",
        POMTREED_MODEL_UPSTREAM_KEY_FILE: keyFile,
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

// The refusal rule: nonzero exit, not killed by the timeout, never reached the listening line, and every `names` fragment is in the output.
function assertRefused(r: Run, o: { code?: number; names: (string | RegExp)[] }): void {
  assert.equal(r.timedOut, false, `the start must refuse, not hang or boot (killed after the timeout):\n${r.all}`);
  assert.notEqual(r.code, 0, `exit code must be nonzero:\n${r.all}`);
  if (o.code !== undefined) assert.equal(r.code, o.code, `exit code:\n${r.all}`);
  assert.doesNotMatch(r.all, /pomtreed listening/, "a refusal exits before the daemon listens");
  for (const n of o.names) {
    if (typeof n === "string") assert.ok(r.all.includes(n), `output must name ${JSON.stringify(n)}:\n${r.all}`);
    else assert.match(r.all, n, `output must match ${n}:\n${r.all}`);
  }
}

const CONFIG_EXIT = 2;

// The socket sits outside the state dir so "no socket created" is its own check, not implied by "no state dir".
const socketEnv = (s: Scratch): Record<string, string> => ({ POMTREED_SOCKET_PATH: join(s.dir, "p.sock") });
const assertNothingCreated = (s: Scratch): void => {
  assert.equal(existsSync(s.stateDir), false, "a refused start must not create the state dir");
  assert.equal(existsSync(join(s.dir, "p.sock")), false, "a refused start must not create the socket");
};

// The three settings that have no default and the agent listener, set so the safety refusals (safety-boot.ts) pass: a case that tests another
// refusal overlays this, and a SAF-4 case breaks exactly one of them. `agent.listen` off keeps a safe boot from asking Docker for the gateway.
const SAFE_ENV: Record<string, string> = {
  POMTREED_AGENT_EGRESS_PROXY_IMAGE: `sha256:${"0".repeat(64)}`,
  POMTREED_AGENT_UNTEMPLATED_EGRESS: "none",
  POMTREED_EXTENSIONS_APPROVAL: "none",
  POMTREED_AGENT_LISTEN: "off",
};

// The same exec main.ts hands detectBridgeGateway (5 s timeout).
const dockerExec = (cmd: string, args: string[]) =>
  new Promise<string>((res, rej) => execFile(cmd, args, { timeout: 5000 }, (e, out) => (e ? rej(e) : res(out))));

// ---- INS-9: no model upstream, or an unsafe key file ----

test("INS-9a: no model env exits 2 naming the base URL, the provider and the key file, and creates no state dir", async () => {
  await withScratch(async (s) => {
    const r = await pomtreed(s.dir, { POMTREED_STATE_DIR: s.stateDir });
    assertRefused(r, {
      code: CONFIG_EXIT,
      names: ["model.baseUrl", "POMTREED_MODEL_BASE_URL", "pi.provider", "POMTREED_PI_PROVIDER", "POMTREED_MODEL_UPSTREAM_KEY_FILE"],
    });
    assert.equal(existsSync(s.stateDir), false, "a refused start must not create the state dir");
    assert.equal(existsSync(join(s.dir, "home", ".pomtreed")), false, "nor the default state dir");
  });
});

test("INS-9b: a group/other-readable (0644) key file exits 2 with the chmod action; the key bytes are not printed", async () => {
  await withScratch(async (s) => {
    chmodSync(s.keyFile, 0o644);
    const r = await pomtreed(s.dir, s.base);
    assertRefused(r, { code: CONFIG_EXIT, names: ["POMTREED_MODEL_UPSTREAM_KEY_FILE", s.keyFile, "is readable by group/other", `chmod 600 ${s.keyFile}`] });
    assert.equal(countOf(r.all, s.key), 0, "the key bytes must never appear in the output");
    assert.equal(existsSync(s.stateDir), false, "a refused start must not create the state dir");
  });
});

test("INS-9c: a relative key-file path exits 2 saying an absolute path is expected", async () => {
  await withScratch(async (s) => {
    const r = await pomtreed(s.dir, { ...s.base, POMTREED_MODEL_UPSTREAM_KEY_FILE: "upstream.key" }); // relative to the child's cwd, where the file exists
    assertRefused(r, { code: CONFIG_EXIT, names: ["POMTREED_MODEL_UPSTREAM_KEY_FILE", "expected an absolute path"] });
    assert.equal(countOf(r.all, s.key), 0, "the key bytes must never appear in the output");
    assert.equal(existsSync(s.stateDir), false, "a refused start must not create the state dir");
  });
});

test("INS-9 control: the valid set passes `config show --origin` (exit 0) and the key appears only masked", async () => {
  await withScratch(async (s) => {
    const r = await pomtreed(s.dir, s.base, ["config", "show", "--origin"]);
    assert.equal(r.timedOut, false, r.all);
    assert.equal(r.code, 0, `config show must exit 0 for the valid set:\n${r.all}`);
    assert.match(r.out, /model\.upstreamKey.*<redacted>/, "the secret key is shown masked");
    assert.equal(countOf(r.all, s.key), 0, "the key bytes must not appear anywhere in the output");
    assert.equal(existsSync(s.stateDir), false, "config show must not create the state dir");
  });
});

// ---- Config and sender refusals: INS-9d, SAF-2a/2b, EGR-8 and the former pomtreed main.smoke refusals, one table ----
// Every row boots the real binary and pins its exit code (2 = a config error, 1 = the channel/sender refusal in main.ts) and the rule above:
// the output names the cause, is one line per error with no stack trace, never echoes the key, and creates neither the state dir nor the socket.
interface Refusal {
  title: string;
  env: Record<string, string | undefined>;
  code: number;
  names: (string | RegExp)[];
  override?: boolean; // the POMTREED_LISTEN_ALLOW_NONLOOPBACK override must pass `config show` with the same env
}
const NONLOOPBACK = "POMTREED_LISTEN_ALLOW_NONLOOPBACK";
const BAD_CONFIG = "pomtreed refuses bad config before binding anything: exit 2, one line per error, naming the cause";
const NO_SENDERS = "pomtreed refuses to start a chat channel without POMTREED_MESSAGING_SENDERS (fail closed)";
const MALFORMED = "pomtreed refuses malformed channel names and sender entries in one line, naming the value";
const REFUSALS: Refusal[] = [
  {
    title: "INS-9d: POMTREED_PI_PROVIDER unset exits 2 naming the variable",
    env: { POMTREED_PI_PROVIDER: undefined },
    code: CONFIG_EXIT,
    names: ["pi.provider", "POMTREED_PI_PROVIDER"],
  },
  {
    title: "pomtreed refuses to start without POMTREED_PI_PROVIDER: exit 2, one line naming the variable (set to an empty string)",
    env: { POMTREED_PI_PROVIDER: "" },
    code: CONFIG_EXIT,
    names: [/pi\.provider is required: set POMTREED_PI_PROVIDER/],
  },
  {
    title: "SAF-2a: POMTREED_MESSAGING_CHANNELS=discord with no senders exits 1 naming POMTREED_MESSAGING_SENDERS",
    env: { POMTREED_MESSAGING_CHANNELS: "discord" },
    code: 1,
    names: ["refusing to start", "POMTREED_MESSAGING_SENDERS", "unset or empty", "discord"],
  },
  ...[{ POMTREED_ESCALATION_CHANNELS: "discord" }, { POMTREED_ESCALATION_CHANNELS: "ui,discord", POMTREED_MESSAGING_SENDERS: "" }].map((env) => ({
    title: `${NO_SENDERS} (${JSON.stringify(env)})`,
    env,
    code: 1,
    names: [/pomtreed: refusing to start: .*POMTREED_MESSAGING_SENDERS/, /discord/],
  })),
  {
    title: "SAF-2b: a malformed POMTREED_MESSAGING_SENDERS exits 1 naming the variable and the channel:sender form",
    env: { POMTREED_MESSAGING_CHANNELS: "discord", POMTREED_MESSAGING_SENDERS: "garbage" },
    code: 1,
    names: ["POMTREED_MESSAGING_SENDERS", '"garbage"', "must be of the form channel:sender"],
  },
  ...(
    [
      [{ POMTREED_MESSAGING_CHANNELS: "Operator", POMTREED_MESSAGING_SENDERS: "x:y" }, /refusing to start: .*"Operator"/],
      [{ POMTREED_MESSAGING_CHANNELS: "a:b", POMTREED_MESSAGING_SENDERS: "a:b:c" }, /refusing to start: .*"a:b"/],
      [{ POMTREED_MESSAGING_CHANNELS: "discord", POMTREED_MESSAGING_SENDERS: "nocolon" }, /refusing to start: .*"nocolon".*channel:sender/],
    ] as const
  ).map(([env, re]) => ({ title: `${MALFORMED} (${JSON.stringify(env)})`, env, code: 1, names: [re] })),
  ...(["POMTREED_UI_LISTEN=0.0.0.0:8787", "POMTREED_HOST_LISTEN=0.0.0.0:8788"] as const).map((kv) => {
    const [key, value] = kv.split("=") as [string, string];
    return {
      title: `EGR-8: ${key}=${value} exits 2 naming the variable, plain HTTP and the override; the override passes config show`,
      env: { [key]: value },
      code: CONFIG_EXIT,
      names: [key, "plain HTTP", NONLOOPBACK],
      override: true,
    };
  }),
  ...(
    [
      [{ POMTREED_CAPACITY_MAX_CONTAINERS: "abc" }, /POMTREED_CAPACITY_MAX_CONTAINERS/],
      [{ POMTREED_BUDGET_ROOT_MICROS: "-5" }, /budget\.rootMicros="-5" \(env:POMTREED_BUDGET_ROOT_MICROS\)/],
      [{ POMTREED_HOST_LISTEN: "nope" }, /POMTREED_HOST_LISTEN/],
      [
        { POMTREED_MAX_CONTAINERS: "4" },
        /^pomtreed: config: unknown env POMTREED_MAX_CONTAINERS; remove it, or use a name listed in docs\/configuration\.md$/m,
      ],
      [{ POMTREED_MODEL_KEY: "k" }, /unknown env POMTREED_MODEL_KEY; remove it, or use a name listed in docs\/configuration\.md/],
    ] as const
  ).map(([env, re]) => ({ title: `${BAD_CONFIG} (${JSON.stringify(env)})`, env, code: CONFIG_EXIT, names: [re] })),
];

for (const c of REFUSALS) {
  test(c.title, async () => {
    await withScratch(async (s) => {
      const r = await pomtreed(s.dir, { ...s.base, ...socketEnv(s), ...c.env });
      assertRefused(r, { code: c.code, names: c.names });
      assert.doesNotMatch(r.all, /\n\s+at /, "one line per error, no stack trace");
      assert.equal(countOf(r.all, s.key), 0, "the key bytes must never appear in the output");
      assertNothingCreated(s);
      if (c.override) {
        const ok = await pomtreed(s.dir, { ...s.base, ...c.env, [NONLOOPBACK]: "1" }, ["config", "show"]);
        assert.equal(ok.code, 0, `with ${NONLOOPBACK}=1 config show must pass:\n${ok.all}`);
      }
    });
  });
}

// ---- SAF-3 sub-case: session bounds ----

test("SAF-3: POMTREED_SESSION_DEFAULT_MS=0 exits 2 naming the variable and its minimum; 1 passes config show", async () => {
  await withScratch(async (s) => {
    const r = await pomtreed(s.dir, { ...s.base, POMTREED_SESSION_DEFAULT_MS: "0" });
    assertRefused(r, { code: CONFIG_EXIT, names: ["POMTREED_SESSION_DEFAULT_MS", "below its minimum 1"] });
    const ok = await pomtreed(s.dir, { ...s.base, POMTREED_SESSION_DEFAULT_MS: "1" }, ["config", "show"]);
    assert.equal(ok.code, 0, `the corrected value must pass config show:\n${ok.all}`);
  });
});

// ---- MIG-2: a database newer than the binary, from a pre-release build, or foreign ----
// Startup order (main.ts): config, channels, the safety refusals (safety-boot.ts), state-dir mkdir and lock, then openDaemonStore on
// pomtreed.sqlite, before the git mirror, the sandbox, any listener or any Docker call, so the refusal needs no Docker. These cases pass the
// safety refusals first (SAFE_ENV), so the database refusal is the only one that can fire.

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

// Starts pomtreed on a state dir holding `dbPath`'s hand-built database and asserts the refusal, the exit code, and that the file is byte-identical.
async function assertDbRefused(s: Scratch, dbPath: string, names: string[]): Promise<void> {
  const before = sha256(dbPath);
  const r = await pomtreed(s.dir, { ...s.base, ...SAFE_ENV });
  assertRefused(r, { code: 1, names: ["pomtreed.sqlite", "refusing to open", ...names] });
  assert.equal(sha256(dbPath), before, "the refused database must be byte-identical");
  assert.deepEqual(
    readdirSync(s.stateDir).filter((f) => f.startsWith("pomtreed.sqlite") && f !== "pomtreed.sqlite"),
    [],
    "no backup, WAL or SHM sidecar may be left beside the refused database",
  );
}

test("MIG-2a: a pomtreed.sqlite with user_version raised by 1 exits 1 saying it is newer than the binary, and the file is untouched", async () => {
  await withScratch(async (s) => {
    mkdirSync(s.stateDir, { mode: 0o700 });
    const dbPath = join(s.stateDir, "pomtreed.sqlite");
    openStore(dbPath).close(); // creates the real schema and stamps the application id
    const raw = new DatabaseSync(dbPath);
    const v = (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    raw.exec(`PRAGMA user_version=${v + 1}`);
    raw.close();
    await assertDbRefused(s, dbPath, [`has schema version ${v + 1}`, "newer than this binary supports", "upgrade pomtreed or restore a backup"]);
  });
});

test("MIG-2b: a pomtreed.sqlite with tables and no pomtree id exits 1 as created by a pre-release build, and the file is untouched", async () => {
  await withScratch(async (s) => {
    mkdirSync(s.stateDir, { mode: 0o700 });
    const dbPath = join(s.stateDir, "pomtreed.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE legacy (id TEXT)");
    raw.close();
    await assertDbRefused(s, dbPath, ["was created by a pre-release build (no pomtree schema id)", "move it aside and restart to re-initialize"]);
  });
});

test("MIG-2c: a pomtreed.sqlite with a foreign nonzero application_id exits 1 as not a pomtree database, and the file is untouched", async () => {
  await withScratch(async (s) => {
    mkdirSync(s.stateDir, { mode: 0o700 });
    const dbPath = join(s.stateDir, "pomtreed.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE other (id TEXT)");
    raw.exec("PRAGMA application_id=1234567");
    raw.close();
    await assertDbRefused(s, dbPath, [
      "is not a pomtree",
      "(application_id 1234567, expected ",
      "check the path, or move it aside and restart to re-initialize",
    ]);
  });
});

// ---- SAF-4: each unsafe default refuses to start ----
// main.ts runs safetyBootErrors after the registry load and the sender check and before it creates any state or touches Docker, with one
// exception: on Linux a non-loopback explicit agent.listen first asks Docker for the bridge gateway (`docker network inspect`, failure
// = not detected), so the gateway is detected here the same way and fed to safetyBootErrors; the child and the test agree whether Docker
// is present or not. Every case is therefore lite. The expected text is built by calling safetyBootErrors, so it cannot drift from the code.
// Not expressible as a boot, so not tested here: the untemplated spawn itself (a spawn-time effect that needs a running daemon).
// `agent.listen` unset on Linux (bridge gateway plus loopback) is covered by the gateway-detection tests in pomtreed; SAFE_ENV sets it to
// `off` so a safe case never reaches Docker.

type Violation = "egress" | "untemplated" | "approval" | "listen" | "merge" | "loadDirOverlap";
// A function of the state dir: the overlap case places templates.dir inside the default session dir, so its path depends on the scratch dir.
const VIOLATIONS: Record<Violation, (stateDir: string) => Record<string, string>> = {
  egress: () => ({ POMTREED_AGENT_EGRESS_PROXY_IMAGE: "" }),
  untemplated: () => ({ POMTREED_AGENT_UNTEMPLATED_EGRESS: "" }),
  approval: () => ({ POMTREED_EXTENSIONS_APPROVAL: "" }),
  listen: () => ({ POMTREED_AGENT_LISTEN: "0.0.0.0:0" }),
  merge: () => ({ POMTREED_MERGE_CHECK: "true" }),
  loadDirOverlap: (stateDir) => ({ POMTREED_TEMPLATES_DIR: join(stateDir, "sessions", "templates") }),
};
const ORDER = Object.keys(VIOLATIONS) as Violation[];
// A literal fragment per violation, pinned beside the safetyBootErrors comparison so rewording a message in safety-boot.ts fails here too.
const FRAGMENT: Record<Violation, string> = {
  egress: "agent.egressProxyImage is not set",
  untemplated: "agent.untemplatedEgress is not set",
  approval: "extensions.approval is not set",
  listen: "agent.listen binds",
  merge: "merge.check is set",
  loadDirOverlap: "templates.dir (",
};
const SAF4_TIMEOUT_MS = POMTREED_TIMEOUT_MS + 10_000; // also covers the docker network inspect timeout (5 s) of the listen case

// The exact lines the daemon prints for `env` (SAFE_ENV overlaid with it), built by safetyBootErrors itself.
// The load-directory and agent-writable facts mirror main.ts's safetyBootErrors call for the default layout under `stateDir`.
async function expectedRefusals(env: Record<string, string>, stateDir: string): Promise<string[]> {
  const e = { ...SAFE_ENV, ...env };
  const listen = e.POMTREED_AGENT_LISTEN === "" ? undefined : e.POMTREED_AGENT_LISTEN;
  const explicit = planAgentListen({ listen, platform: process.platform, gateway: undefined });
  const gateway =
    process.platform === "linux" && explicit.mode === "explicit" && !isLoopbackHost(explicit.host.replace(/^\[(.*)\]$/, "$1"))
      ? await detectBridgeGateway(dockerExec, true)
      : undefined;
  return safetyBootErrors(
    {
      "agent.egressProxyImage": e.POMTREED_AGENT_EGRESS_PROXY_IMAGE ?? "",
      "agent.untemplatedEgress": (e.POMTREED_AGENT_UNTEMPLATED_EGRESS ?? "") as "",
      "extensions.approval": e.POMTREED_EXTENSIONS_APPROVAL ?? "",
      "merge.check": e.POMTREED_MERGE_CHECK ?? "",
      "listen.allowNonloopback": false,
    },
    {
      checkRunnerWired: false,
      agentListen: planAgentListen({ listen, platform: process.platform, gateway }),
      bridgeGateway: gateway,
      loadDirs: {
        templates: realpathLoose(e.POMTREED_TEMPLATES_DIR || join(stateDir, "templates")),
        extensions: realpathLoose(join(stateDir, "extensions")),
      },
      agentWritable: [
        { key: "state.dir", path: realpathLoose(join(stateDir, "workspaces")) },
        { key: "state.dir", path: realpathLoose(join(stateDir, "agents")) },
        { key: "session.dir", path: realpathLoose(e.POMTREED_SESSION_DIR || join(stateDir, "sessions")) },
        { key: "envCache.dir", path: realpathLoose(join(stateDir, "env-cache")) },
        { key: "socket.path", path: realpathLoose(e.POMTREED_SOCKET_PATH || join(stateDir, "pomtreed.sock")) },
      ],
    },
  );
}

const refusalLines = (text: string): string[] => text.split("\n").filter((l) => l.startsWith("pomtreed: refusing to start: "));

for (const v of ORDER) {
  test(`SAF-4 ${v}: alone it exits 1 with exactly its safetyBootErrors message, before any state dir`, async () => {
    await withScratch(async (s) => {
      const env = { ...VIOLATIONS[v](s.stateDir), ...socketEnv(s) };
      const expected = await expectedRefusals(env, s.stateDir);
      assert.equal(expected.length, 1, "the violation under test must be the only one");
      const r = await pomtreed(s.dir, { ...s.base, ...SAFE_ENV, ...env }, [], SAF4_TIMEOUT_MS);
      assertRefused(r, { code: 1, names: [FRAGMENT[v]] });
      assert.deepEqual(refusalLines(r.all), expected);
      assertNothingCreated(s);
    });
  });
}

// loadDirOverlap above uses the default session dir; the same refusal must hold when POMTREED_SESSION_DIR is set explicitly (outside the state dir).
test("SAF-4 loadDirOverlap: a templates.dir inside an explicit session.dir exits 1 with exactly its safetyBootErrors message, before any state dir", async () => {
  await withScratch(async (s) => {
    const env = { POMTREED_SESSION_DIR: join(s.dir, "sess"), POMTREED_TEMPLATES_DIR: join(s.dir, "sess", "t"), ...socketEnv(s) };
    const expected = await expectedRefusals(env, s.stateDir);
    assert.equal(expected.length, 1, "the violation under test must be the only one");
    const r = await pomtreed(s.dir, { ...s.base, ...SAFE_ENV, ...env }, [], SAF4_TIMEOUT_MS);
    assertRefused(r, { code: 1, names: [FRAGMENT.loadDirOverlap] });
    assert.deepEqual(refusalLines(r.all), expected);
    assertNothingCreated(s);
  });
});

test("SAF-4: every violation together lists every message at once, in the fixed order, exit 1", async () => {
  await withScratch(async (s) => {
    const all = Object.assign({}, socketEnv(s), ...ORDER.map((v) => VIOLATIONS[v](s.stateDir))) as Record<string, string>;
    const expected = await expectedRefusals(all, s.stateDir);
    assert.equal(expected.length, ORDER.length);
    const r = await pomtreed(s.dir, { ...s.base, ...SAFE_ENV, ...all }, [], SAF4_TIMEOUT_MS);
    assertRefused(r, { code: 1, names: ORDER.map((v) => FRAGMENT[v]) });
    assert.deepEqual(refusalLines(r.all), expected);
    assertNothingCreated(s);
  });
});

// The second row is the other set of safe values (an extension approval mode and a registry-only untemplated egress), as the pomtreed boot smoke used.
for (const [label, safe] of [
  ["", {}],
  [" (extensions.approval=all, agent.untemplatedEgress=registry)", { POMTREED_EXTENSIONS_APPROVAL: "all", POMTREED_AGENT_UNTEMPLATED_EGRESS: "registry" }],
] as const) {
  test(`SAF-4 control${label}: a safe config prints no safety refusal and gets as far as creating the state dir`, async () => {
    await withScratch(async (s) => {
      // Lite: a full boot needs Docker, so prove the gate was passed instead. The state dir is created right after the last boot
      // refusal (main.ts), before any Docker use; wait for that (or an earlier exit), then SIGKILL.
      const p = spawn(process.execPath, [pomtreedMain], {
        cwd: s.dir,
        env: { HOME: join(s.dir, "home"), PATH: process.env.PATH ?? "", ...s.base, ...SAFE_ENV, ...safe, POMTREED_REPO_DIR: s.dir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let all = "";
      p.stdout.on("data", (c: Buffer) => (all += c.toString()));
      p.stderr.on("data", (c: Buffer) => (all += c.toString()));
      let exited = false;
      const closed = new Promise<void>((res) =>
        p.on("close", () => {
          exited = true;
          res();
        }),
      );
      const end = Date.now() + SAF4_TIMEOUT_MS;
      while (!exited && !existsSync(s.stateDir) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      const reachedState = existsSync(s.stateDir);
      p.kill("SIGKILL");
      await closed;
      assert.deepEqual(refusalLines(all), [], `a safe config must not hit a safety refusal:\n${all}`);
      assert.ok(reachedState, `the boot must get past every refusal to the state dir:\n${all}`);
    });
  });
}
