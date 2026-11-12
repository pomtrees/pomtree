import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CONFIG_REGISTRY } from "../../packages/core/src/config/params.ts";
import { resolveConfig } from "../../packages/core/src/config/resolve.ts";

// Offline: rehearse.sh runs with a PATH-shimmed fake docker and its four command seams (REHEARSE_STUB, REHEARSE_POMTREE_UP,
// REHEARSE_DRIVE, REHEARSE_POMTREE_CLI) pointing at fakes. No docker, network, daemon or model is touched, nothing is spent.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT = join(HERE, "rehearse.sh");

const TOKEN_SECRET = "TOKEN-SECRET-d41d8cd9";
const REAL_KEY = "sk-real-upstream-key-0000";

type Run = { status: number | null; stdout: string; stderr: string; events: string[]; pids: Record<string, number>; fx: string };
let dir = "";
let shim = "";
let seq = 0;
const leaked: number[] = [];

// A fake long-running process: logs its call line and PID, prints what the real one prints, then becomes `sleep` (same PID).
const FAKES: Record<string, string> = {
  docker: `#!/usr/bin/env bash
echo "docker $*" >>"$FX/events"
case "$1" in
  images) printf '%b' "\${FAKE_IMAGES-}" ;;
  create) echo cid-1 ;;
  cp) mkdir -p "\${@: -1}" && : >"\${@: -1}/catalog.json" ;;
esac
`,
  stub: `#!/usr/bin/env bash
echo "stub $*" >>"$FX/events"
echo "stub $$" >>"$FX/pids"
[ -z "\${FAKE_STUB_DIES-}" ] || { echo "listen failed" >&2; exit 1; }
echo '{"baseUrl":"http://127.0.0.1:4242/v1","script":"wiki-distill"}'
exec sleep 300
`,
  up: `#!/usr/bin/env bash
if [[ " $* " == *" --print-env "* ]]; then
  mkdir -p "$FX/state"
  echo "export POMTREED_STATE_DIR='$FX/state'"
  echo "alias pomtree='node nowhere'"
  exit 0
fi
echo "up $* | pool=\${POMTREED_BUDGET_ROOT_MICROS-} | toplevel=\${POMTREED_BUDGET_TOP_LEVEL_MICROS-} | catalog=\${POMTREED_PI_CATALOG_DIR-} | image=\${POMTREED_AGENT_IMAGE-} | baseurl=\${POMTREED_MODEL_BASE_URL-} | orkey=\${OPENROUTER_API_KEY-} | templates=$(ls "$FX/state/templates" | tr '\\n' ,)" >>"$FX/events"
echo "up $$" >>"$FX/pids"
all="$*"; key="\${all#*--model-key-file }"; key="\${key%% *}"
echo "keymode=$(stat -c %a "$key")" >>"$FX/facts"
echo "keyfile=$key" >>"$FX/facts"
printf %s "$TOKEN_SECRET" >"$FX/state/operator.token"
echo "== pomtreed is up (repo x) =="
echo "UI:     http://127.0.0.1:8787/ui"
exec sleep 300
`,
  drive: `#!/usr/bin/env bash
echo "drive $* | cli=\${WIKI_DISTILL_CLI-} | state=\${POMTREED_STATE_DIR-}" >>"$FX/events"
exit "\${FAKE_DRIVE_RC:-0}"
`,
  cli: `#!/usr/bin/env bash
echo "cli $*" >>"$FX/events"
echo ok
`,
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "wiki-distill-rehearse-"));
  shim = join(dir, "shim");
  mkdirSync(shim);
  for (const [name, body] of Object.entries(FAKES)) {
    const p = join(name === "docker" ? shim : dir, name === "docker" ? "docker" : `fake-${name}.sh`);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
});
after(() => {
  for (const pid of leaked) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const fake = (n: string) => `bash ${join(dir, `fake-${n}.sh`)}`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function rehearse(args: string[], env: Record<string, string> = {}, opts: { script?: string; input?: string } = {}): Run {
  const fx = join(dir, `fx-${seq++}`);
  mkdirSync(fx);
  const r = spawnSync("bash", [opts.script ?? SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 50000,
    input: opts.input ?? "",
    env: {
      PATH: `${shim}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "",
      TMPDIR: fx,
      FX: fx,
      TOKEN_SECRET,
      FAKE_IMAGES: "pomtree/agent:v1\n",
      REHEARSE_STUB: fake("stub"),
      REHEARSE_POMTREE_UP: fake("up"),
      REHEARSE_DRIVE: fake("drive"),
      REHEARSE_POMTREE_CLI: fake("cli"),
      ...env,
    },
  });
  const read = (f: string) => (existsSync(join(fx, f)) ? readFileSync(join(fx, f), "utf8") : "");
  const events = read("events")
    .split("\n")
    .filter((l) => l !== "");
  const pids: Record<string, number> = {};
  for (const l of read("pids")
    .split("\n")
    .filter((x) => x !== "")) {
    const [who, pid] = l.split(" ");
    pids[who] = Number(pid);
    leaked.push(Number(pid));
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, events, pids, fx };
}
const idx = (events: string[], prefix: string) => events.findIndex((e) => e.startsWith(prefix));
const all = (r: Run) => r.stdout + r.stderr;

describe("rehearse.sh", () => {
  it("--help exits 0 and documents usage, needs, no-spend and cleanup", () => {
    const r = rehearse(["--help"]);
    assert.equal(r.status, 0);
    for (const w of ["Usage:", "--target", "--keep", "Needs:", "never", "no money", "Cleanup:"]) assert.ok(r.stdout.includes(w), `help lacks ${w}`);
    assert.deepEqual(r.events, [], "--help must not start anything");
  });

  it("rejects an unknown option with exit 2", () => {
    assert.equal(rehearse(["--bogus"]).status, 2);
  });

  it("no local image: fails naming cause and action, starts nothing, builds nothing", () => {
    const r = rehearse(["--no-wait"], { FAKE_IMAGES: "" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no local pomtree\/agent:\* image found/);
    assert.match(r.stderr, /POMTREED_AGENT_IMAGE/);
    assert.equal(idx(r.events, "stub"), -1);
    assert.equal(idx(r.events, "up "), -1);
    assert.ok(!r.events.some((e) => e.startsWith("docker build")));
  });

  it("picks the newest pomtree/agent tag, and POMTREED_AGENT_IMAGE wins when set", () => {
    const newest = rehearse(["--no-wait"], { FAKE_IMAGES: "other/x:1\npomtree/agent:v2\npomtree/agent:v1\n" });
    assert.equal(newest.status, 0, all(newest));
    assert.ok(newest.events.includes("docker create pomtree/agent:v2"), newest.events.join("\n"));
    const pinned = rehearse(["--no-wait"], { POMTREED_AGENT_IMAGE: "mine/agent:9" });
    assert.ok(pinned.events.includes("docker create mine/agent:9"));
    assert.ok(!pinned.events.some((e) => e.startsWith("docker images")), "no listing when the image is named");
  });

  it("full run: commands in order with the pool, --no-build, stub URL, and drive --readers 4 --yes", () => {
    const r = rehearse(["--no-wait"]);
    assert.equal(r.status, 0, all(r));
    const create = idx(r.events, "docker create");
    const copy = idx(r.events, "docker cp");
    const stub = idx(r.events, "stub ");
    const up = idx(r.events, "up ");
    const drive = idx(r.events, "drive ");
    assert.ok(create >= 0 && create < copy && copy < stub && stub < up && up < drive, r.events.join("\n"));
    assert.match(r.events[copy], /pi-ai\/dist\/providers\/data /);
    assert.match(r.events[stub], /--script .*stub\/wiki-distill\.json --port 0$/);
    const upLine = r.events[up];
    assert.match(upLine, /--init --no-build --provider openrouter --model-base-url http:\/\/127\.0\.0\.1:4242\/v1 --model-key-file /);
    assert.match(upLine, /pool=2600000 /);
    // pomtreed refuses to start when budget.topLevelMicros (default 5000000) exceeds budget.rootMicros.
    const topLevel = /toplevel=(\d+) /.exec(upLine)?.[1];
    assert.ok(topLevel !== undefined, `POMTREED_BUDGET_TOP_LEVEL_MICROS not set: ${upLine}`);
    assert.ok(Number(topLevel) <= 2600000, `top-level ${topLevel} exceeds the pool: ${upLine}`);
    // The real daemon validation accepts the pair; with only the pool set (the original bug) it refuses.
    const env = { POMTREED_BUDGET_ROOT_MICROS: "2600000", POMTREED_BUDGET_TOP_LEVEL_MICROS: topLevel };
    const ok = resolveConfig(CONFIG_REGISTRY, { env });
    assert.ok(ok.ok, ok.ok ? "" : ok.errors.join("\n"));
    assert.ok(!resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_BUDGET_ROOT_MICROS: "2600000" } }).ok, "negative control: pool alone must be refused");
    assert.match(upLine, /catalog=\S+\/pi-catalog /);
    assert.match(upLine, /image=pomtree\/agent:v1 /);
    assert.match(r.events[drive], /^drive --title anything --readers 4 --yes \| cli=bash .*fake-cli\.sh \| state=.*\/state$/);
    assert.ok(
      r.events.some((e) => e === "cli ui follow off"),
      "ui follow off at cleanup",
    );
    assert.match(r.stdout, /Open the UI in Chrome|UI: +http:\/\/127\.0\.0\.1:8787\/ui/);
  });

  it("copies exactly the stub templates into <state>/templates before the daemon starts", () => {
    const r = rehearse(["--no-wait"]);
    const want = readdirSync(join(HERE, "stub", "templates")).sort();
    assert.ok(want.length >= 3);
    assert.match(r.events[idx(r.events, "up ")], new RegExp(`templates=${want.join(",")},$`));
  });

  it("key file is mode 0600, holds a dummy (not any env key), and is never printed", () => {
    const r = rehearse(["--no-wait", "--keep"], { OPENROUTER_API_KEY: REAL_KEY });
    assert.equal(r.status, 0, all(r));
    const facts = readFileSync(join(r.fx, "facts"), "utf8");
    assert.match(facts, /keymode=600/);
    const keyPath = /keyfile=(.+)/.exec(facts)?.[1] ?? "";
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    const content = readFileSync(keyPath, "utf8");
    assert.match(content, /^stub-\d+$/);
    assert.ok(!content.includes(REAL_KEY));
    assert.ok(!all(r).includes(content), "key content printed");
  });

  it("unsets real-upstream env for the children", () => {
    const r = rehearse(["--no-wait"], { OPENROUTER_API_KEY: REAL_KEY, POMTREED_MODEL_BASE_URL: "https://openrouter.ai/api" });
    const line = r.events[idx(r.events, "up ")];
    assert.match(line, /baseurl= \|/);
    assert.match(line, /orkey= \|/);
    assert.ok(!all(r).includes(REAL_KEY));
  });

  it("prints the token file path but never its contents", () => {
    const r = rehearse(["--no-wait"]);
    assert.match(r.stdout, /token file: +\S+\/state\/operator\.token/);
    assert.ok(!all(r).includes(TOKEN_SECRET), "token contents leaked");
    assert.equal(readFileSync(join(r.fx, "state", "operator.token"), "utf8"), TOKEN_SECRET, "fake wrote the token");
  });

  it("waits for Enter at sign-in and before cleanup unless --no-wait", () => {
    const r = rehearse([], {}, { input: "\n\n" });
    assert.equal(r.status, 0, all(r));
    assert.match(r.stdout, /sign in, then press Enter/);
    assert.match(r.stdout, /Press Enter or Ctrl-C to stop everything/);
    assert.ok(!rehearse(["--no-wait"]).stdout.includes("press Enter."));
  });

  it("--open is passed through to pomtree-up only when requested, and the token never appears", () => {
    const on = rehearse(["--no-wait", "--open"]);
    assert.equal(on.status, 0, all(on));
    const onLine = on.events[idx(on.events, "up ")];
    assert.match(onLine, / --open /);
    assert.ok(!onLine.includes("--show-token"), "must never ask pomtree-up for the token link");
    assert.ok(!all(on).includes(TOKEN_SECRET), "token contents leaked");
    assert.ok(!on.events.join("\n").includes(TOKEN_SECRET), "token reached a child argv");
    const off = rehearse(["--no-wait"]);
    assert.doesNotMatch(off.events[idx(off.events, "up ")], /--open/);
    assert.ok(!off.stdout.includes("browser tab should have opened"));
    assert.match(on.stdout, /browser tab should have opened/);
    // Negative control: a script with the pass-through removed no longer forwards --open, so the assertion above can fail.
    const sandbox = join(dir, "mutant-open", "a", "b");
    mkdirSync(sandbox, { recursive: true });
    symlinkSync(join(HERE, "stub"), join(sandbox, "stub"));
    const mutant = join(sandbox, "rehearse.sh");
    writeFileSync(mutant, readFileSync(SCRIPT, "utf8").replace('[ "$open_ui" = 0 ] || up_args+=(--open)', ":"));
    const m = rehearse(["--no-wait", "--open"], {}, { script: mutant });
    assert.doesNotMatch(m.events[idx(m.events, "up ")], / --open /);
  });

  it("cleanup stops exactly the recorded stub and pomtree-up PIDs and spares an unrelated process", () => {
    const decoy = spawnSync("bash", ["-c", "sleep 301 </dev/null >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
    const decoyPid = Number(decoy.stdout.trim());
    leaked.push(decoyPid);
    try {
      const r = rehearse(["--no-wait"]);
      assert.equal(r.status, 0, all(r));
      assert.ok(r.pids.stub > 0 && r.pids.up > 0 && r.pids.stub !== r.pids.up);
      assert.equal(alive(r.pids.stub), false, "stub still running");
      assert.equal(alive(r.pids.up), false, "pomtree-up still running");
      assert.equal(alive(decoyPid), true, "an unrelated process was killed");
      assert.ok(!existsSync(join(r.fx, readdirSync(r.fx).find((f) => f.startsWith("wiki-rehearse.")) ?? "none")), "scratch dir removed");
    } finally {
      process.kill(decoyPid, "SIGKILL");
    }
  });

  it("negative control: a script without the stop calls leaves the PIDs running (so the check above can fail)", () => {
    const sandbox = join(dir, "mutant", "a", "b");
    mkdirSync(sandbox, { recursive: true });
    symlinkSync(join(HERE, "stub"), join(sandbox, "stub"));
    const mutated = readFileSync(SCRIPT, "utf8")
      .split("\n")
      .filter((l) => !l.includes('stop_pid "$up_pid"') && !l.includes('stop_pid "$stub_pid"'))
      .join("\n");
    const path = join(sandbox, "rehearse.sh");
    writeFileSync(path, mutated);
    const r = rehearse(["--no-wait"], {}, { script: path });
    assert.ok(alive(r.pids.stub) && alive(r.pids.up), "the mutant should leave both processes alive");
  });

  it("stub that dies at startup: fails naming the log, still cleans up pomtree-up never started", () => {
    const r = rehearse(["--no-wait"], { FAKE_STUB_DIES: "1" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /model stub exited during startup; see \S+stub\.log/);
    assert.equal(idx(r.events, "up "), -1);
    assert.equal(idx(r.events, "drive "), -1);
  });

  it("--target must be a git repo, and never the checkout", () => {
    const plain = mkdtempSync(join(dir, "plain-"));
    const bad = rehearse(["--no-wait", "--target", plain]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /is not a git repository/);
    const self = rehearse(["--no-wait", "--target", join(HERE, "..", "..")]);
    assert.notEqual(self.status, 0);
    assert.match(self.stderr, /pomtree checkout itself/);
    assert.equal(idx(self.events, "stub "), -1);
  });

  it("--target and --port are passed through; the target repo is left untouched", () => {
    const repo = mkdtempSync(join(dir, "repo-"));
    spawnSync("git", ["init", "-q", repo]);
    const r = rehearse(["--no-wait", "--target", repo, "--port", "9001"]);
    assert.equal(r.status, 0, all(r));
    assert.match(r.events[idx(r.events, "up ")], new RegExp(`^up ${repo} --init --no-build .* --port 9001 `));
    assert.ok(existsSync(repo), "a given --target is never deleted");
  });

  it("drive failure is reported and becomes the exit code, and cleanup still runs", () => {
    const r = rehearse(["--no-wait"], { FAKE_DRIVE_RC: "3" });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /drive\.sh failed with exit 3/);
    assert.equal(alive(r.pids.up), false);
  });
});
