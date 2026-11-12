import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// Exercises scripts/pomtree-up offline: a copy of the script runs in a temp "checkout" holding fake pomtreed/pomtree entry points,
// with a PATH of symlinks to the needed system tools plus an optional fake `docker`. No real docker, pomtreed or model.

const realScript = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/pomtree-up");
const realImageSources = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/image-sources.sh");
const SECRET = "sk-TESTSECRET-do-not-print";
const OP_TOKEN = "optok-DUMMY-4f9a1c";
const TOOLS = [
  "bash",
  "node",
  "git",
  "realpath",
  "sha256sum",
  "shasum",
  "cut",
  "stat",
  "tr",
  "find",
  "head",
  "tail",
  "seq",
  "sleep",
  "grep",
  "sed",
  "ps",
  "mkdir",
  "chmod",
  "dirname",
  "cat",
  "rm",
  "tee",
  "env",
  "uname",
  "ls",
];
const cleanup: string[] = [];
after(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

function which(tool: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(dir, tool);
    if (existsSync(p)) return p;
  }
  return undefined;
}

const IMAGE_ID = `sha256:${"ab".repeat(32)}`;
type DockerMode = "none" | "daemon-down" | "ok";
interface Fixture {
  dir: string;
  repo: string;
  state: string;
  key: string;
  root: string;
  // Run git in the fixture checkout (the script's own tree, where the image label is compared); returns trimmed stdout.
  gitc: (...a: string[]) => string;
  // Write a file in the checkout and commit it; returns the new short sha.
  commitFile: (rel: string, body?: string) => string;
  // Set the revision label the fake docker reports for the image.
  setLabel: (label: string) => void;
  run: (args?: string[], env?: Record<string, string>) => { out: string; status: number | null };
}

function fixture(opts: { docker: DockerMode; pomtreedStderr?: string; longState?: boolean; checkoutGit?: boolean; opener?: boolean }): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-up-test-")));
  cleanup.push(dir);
  const root = join(dir, "checkout");
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(realScript, join(root, "scripts/pomtree-up"));
  chmodSync(join(root, "scripts/pomtree-up"), 0o755);
  copyFileSync(realImageSources, join(root, "scripts/image-sources.sh"));
  mkdirSync(join(root, "packages/pomtreed/src"), { recursive: true });
  mkdirSync(join(root, "packages/pomtree/src"), { recursive: true });
  const pomtreedBody = opts.pomtreedStderr
    ? `process.stderr.write(${JSON.stringify(opts.pomtreedStderr)});\nprocess.exit(1);\n`
    : [
        "import { writeFileSync } from 'node:fs';",
        "import { createServer } from 'node:net';",
        "const state = process.env.POMTREED_STATE_DIR;",
        `writeFileSync(state + '/operator.token', ${JSON.stringify(`${OP_TOKEN}\n`)}, { mode: 0o600 });`,
        "writeFileSync(state + '/seen-env.json', JSON.stringify(process.env));",
        "createServer().listen(process.env.POMTREED_SOCKET_PATH ?? state + '/pomtreed.sock', () => setTimeout(() => process.exit(0), 1500));",
        "",
      ].join("\n");
  writeFileSync(join(root, "packages/pomtreed/src/main.ts"), pomtreedBody);
  writeFileSync(
    join(root, "packages/pomtree/src/main.ts"),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.POMTREED_STATE_DIR + '/pomtree-seen-sock', process.env.POMTREE_SOCKET ?? '');\nconsole.log('ok');\n",
  );

  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const t of TOOLS) {
    const p = which(t);
    if (p) symlinkSync(p, join(bin, t));
  }
  if (opts.opener) {
    // Fake `xdg-open`: records its argv (one line per call) so a test can see what the browser would be handed.
    writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\necho "$*" >> ${join(dir, "opened")}\n`, { mode: 0o755 });
  }
  if (opts.docker !== "none") {
    const info = opts.docker === "ok" ? "exit 0" : "exit 1";
    // The revision label comes from <dir>/label (empty when unset), so a test can set it after making commits.
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\ncase "$1" in info) ${info} ;; image) case "$*" in *'{{.Id}}'*) echo ${IMAGE_ID} ;; *'org.opencontainers.image.revision'*) cat ${join(dir, "label")} ;; esac ;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
  }
  writeFileSync(join(dir, "label"), "");

  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@localhost", ...a]);
  git("init", "-q");
  git("commit", "--allow-empty", "-q", "-m", "init");
  const gitc = (...a: string[]) =>
    spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@localhost", ...a], { encoding: "utf8" }).stdout.trim();
  const commitFile = (rel: string, body = "x\n") => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
    gitc("add", rel);
    gitc("commit", "-q", "-m", `change ${rel}`);
    return gitc("rev-parse", "--short", "HEAD");
  };
  if (opts.checkoutGit) {
    gitc("init", "-q");
    gitc("add", "scripts", "packages");
    gitc("commit", "-q", "-m", "base");
  }
  const state = opts.longState ? join(dir, "s".repeat(80), "state") : join(dir, "state");
  const key = join(dir, "key");
  writeFileSync(key, `${SECRET}\n`, { mode: 0o600 });

  return {
    dir,
    repo,
    state,
    key,
    root,
    gitc,
    commitFile,
    setLabel: (label) => writeFileSync(join(dir, "label"), `${label}\n`),
    run: (args = [], env = {}) => {
      const r = spawnSync(
        "bash",
        [join(root, "scripts/pomtree-up"), repo, "--state", state, "--model-base-url", "http://127.0.0.1:1/v1", "--model-key-file", key, ...args],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 60_000,
          env: { PATH: bin, HOME: dir, POMTREED_PI_PROVIDER: "x", ...env },
        },
      );
      return { out: `${r.stdout}${r.stderr}`, status: r.status };
    },
  };
}

test("docker CLI missing: names the CLI, not the daemon", () => {
  const f = fixture({ docker: "none" });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.out, /pomtree-up: docker CLI not found; install Docker/);
  assert.doesNotMatch(r.out, /daemon not reachable/);
});

test("docker daemon down: says daemon, hints Docker Desktop and DOCKER_HOST, never reaches an image build", () => {
  const f = fixture({ docker: "daemon-down" });
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.out, /pomtree-up: docker daemon not reachable.*start Docker Desktop.*DOCKER_HOST/);
  assert.doesNotMatch(r.out, /docker CLI not found|image build failed|building image/);
});

const PROVIDER_STACK = [
  "node:internal/modules/run_main:123",
  "    triggerUncaughtException(",
  "Error: pi.provider is required: set POMTREED_PI_PROVIDER to the provider the model proxy serves",
  "    at resolveProvider (file:///x/pomtreed/src/proxy.ts:10:11)",
  "    at main (file:///x/pomtreed/src/main.ts:5:3)",
  "",
  "Node.js v24.0.0",
  "",
].join("\n");

test("pomtreed dies at startup: prints the cause line, the hint and the log path; the log is 0600 and holds the stack", () => {
  const f = fixture({ docker: "ok", pomtreedStderr: PROVIDER_STACK });
  const r = f.run(["--no-build"]);
  const log = join(f.state, "pomtreed.log");
  assert.equal(r.status, 1);
  assert.match(r.out, /pomtree-up: cause: Error: pi.provider is required: set POMTREED_PI_PROVIDER/);
  assert.match(r.out, /pomtree-up: hint: set POMTREED_PI_PROVIDER=<provider> \(or pass --provider; the provider the model proxy serves, e.g. openrouter\)/);
  assert.match(r.out, new RegExp(`pomtree-up: pomtreed exited during startup; full log: ${log}`));
  assert.ok(r.out.includes("    at resolveProvider"), "stack still reaches the terminal");
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.match(readFileSync(log, "utf8"), /Error: pi.provider is required: set POMTREED_PI_PROVIDER/);
  assert.ok(!r.out.includes(SECRET) && !readFileSync(log, "utf8").includes(SECRET));
});

test("no provider: pomtree-up refuses before starting pomtreed, naming the flag and the variable", () => {
  const f = fixture({ docker: "ok" });
  const r = f.run(["--no-build"], { POMTREED_PI_PROVIDER: "" });
  assert.equal(r.status, 1);
  assert.match(r.out, /pomtree-up: the model provider is required: pass --provider NAME or set POMTREED_PI_PROVIDER/);
  assert.doesNotMatch(r.out, /pomtreed exited during startup/);
});

test("pomtreed dies with an unknown message: cause shown, no hint line", () => {
  const f = fixture({ docker: "ok", pomtreedStderr: "Error: something unrelated broke\n    at x (y:1:1)\n" });
  const r = f.run(["--no-build"]);
  assert.match(r.out, /pomtree-up: cause: Error: something unrelated broke/);
  assert.doesNotMatch(r.out, /pomtree-up: hint:/);
});

test("pomtreed dies with a base-URL message: hint points to the flag and docs/operating.md", () => {
  const f = fixture({ docker: "ok", pomtreedStderr: "Error: POMTREED_MODEL_BASE_URL is not a valid URL\n" });
  assert.match(f.run(["--no-build"]).out, /pomtree-up: hint: pass --model-base-url URL or set POMTREED_MODEL_BASE_URL; see docs\/operating\.md/);
});

test("valid start: banner shown, no error block, log exists", () => {
  const f = fixture({ docker: "ok" });
  const r = f.run(["--no-build"]);
  assert.equal(r.status, 0);
  assert.match(r.out, /== pomtreed is up/);
  assert.doesNotMatch(r.out, /pomtree-up: cause:|pomtree-up: hint:|exited during startup/);
  assert.ok(existsSync(join(f.state, "pomtreed.log")));
});

test("safety settings: defaults to the agent image id, registry egress and all approvals; an operator value wins", () => {
  const seen = (f: Fixture) => JSON.parse(readFileSync(join(f.state, "seen-env.json"), "utf8")) as Record<string, string>;
  const f = fixture({ docker: "ok" });
  assert.equal(f.run(["--no-build"]).status, 0);
  assert.equal(seen(f).POMTREED_AGENT_EGRESS_PROXY_IMAGE, IMAGE_ID);
  assert.equal(seen(f).POMTREED_AGENT_UNTEMPLATED_EGRESS, "registry");
  assert.equal(seen(f).POMTREED_EXTENSIONS_APPROVAL, "all");

  const g = fixture({ docker: "ok" });
  const pinned = `r.example/agent@sha256:${"cd".repeat(32)}`;
  g.run(["--no-build"], { POMTREED_AGENT_EGRESS_PROXY_IMAGE: pinned, POMTREED_AGENT_UNTEMPLATED_EGRESS: "none", POMTREED_EXTENSIONS_APPROVAL: "none" });
  assert.equal(seen(g).POMTREED_AGENT_EGRESS_PROXY_IMAGE, pinned);
  assert.equal(seen(g).POMTREED_AGENT_UNTEMPLATED_EGRESS, "none");
  assert.equal(seen(g).POMTREED_EXTENSIONS_APPROVAL, "none");
});

test("safety settings: an unreadable agent image id is refused with the action, pomtreed never starts", () => {
  const f = fixture({ docker: "ok" });
  writeFileSync(join(f.dir, "bin/docker"), `#!/bin/sh\ncase "$1" in info) exit 0 ;; esac\nexit 0\n`, { mode: 0o755 });
  const r = f.run(["--no-build"]);
  assert.equal(r.status, 1);
  assert.match(r.out, /pomtree-up: could not read the id of image .*set POMTREED_AGENT_EGRESS_PROXY_IMAGE to a digest-pinned image/);
  assert.equal(existsSync(join(f.state, "seen-env.json")), false);
});

test("busy port: a one-line notice says the port moved; a free port prints none", async () => {
  const f = fixture({ docker: "ok" });
  const busy = createServer();
  await new Promise<void>((res) => busy.listen(0, "127.0.0.1", res));
  const p = (busy.address() as { port: number }).port;
  try {
    // A listening socket refuses the script's bind even while this thread blocks in spawnSync.
    const r = f.run(["--no-build", "--port", String(p)]);
    assert.match(r.out, new RegExp(`pomtree-up: port ${p} is busy; using \\d+ instead`));
  } finally {
    busy.close();
  }
  assert.doesNotMatch(fixture({ docker: "ok" }).run(["--no-build", "--port", "38911"]).out, /is busy/);
});

test("key file errors name the path and never the contents: mode 0644, missing, relative", () => {
  const f = fixture({ docker: "ok" });
  chmodSync(f.key, 0o644);
  let r = f.run(["--no-build"]);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes(`upstream key file ${f.key} must be mode 0600`));
  assert.ok(!r.out.includes(SECRET));

  r = f.run(["--no-build", "--model-key-file", join(f.dir, "nope")]);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes(`pomtree-up: upstream key file ${join(f.dir, "nope")} not found; create it (mode 0600`), r.out);
  assert.ok(r.out.includes("or pass --model-key-file FILE"));
  assert.ok(!r.out.includes(SECRET));

  // A relative path is resolved against the cwd (the fixture dir) and reported by its realpath.
  r = f.run(["--no-build", "--model-key-file", "key"]);
  assert.ok(r.out.includes(`upstream key file ${f.key} must be mode 0600`));
  assert.ok(!r.out.includes(SECRET));

  chmodSync(f.key, 0o600);
  r = f.run(["--no-build", "--model-key-file", "key"]);
  assert.doesNotMatch(r.out, /upstream key file|exited during startup/);
});

// fresh-wipe regression: --fresh must never empty a directory that is not pomtreed state, --yes or not.
function populate(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

test("--fresh --yes on a Documents-like dir with arbitrary files refuses, names the path, and touches nothing", () => {
  const f = fixture({ docker: "ok" });
  const docs = join(f.dir, "Documents");
  populate(docs, { "taxes.pdf": "1", "notes.txt": "2" });
  mkdirSync(join(docs, "photos"));
  for (const args of [["--fresh"], ["--fresh", "--yes"]]) {
    const r = f.run(["--no-build", "--state", docs, ...args]);
    assert.equal(r.status, 1);
    assert.ok(r.out.includes(`refusing --fresh on ${docs}: it is not empty and holds no pomtreed state`), r.out);
    assert.match(r.out, /--yes does not override this/);
    assert.ok(existsSync(join(docs, "taxes.pdf")) && existsSync(join(docs, "notes.txt")) && existsSync(join(docs, "photos")));
  }
});

test("--fresh on a real pomtreed state dir: refused without --yes, wiped with --yes", () => {
  const f = fixture({ docker: "ok" });
  populate(f.state, { secret: "s", "pomtreed.sqlite": "db", "old-agent-file": "x" });
  let r = f.run(["--no-build", "--fresh"]);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes(`${f.state} holds pomtreed state (pomtreed.sqlite); --fresh would destroy all agents, data and secrets`), r.out);
  assert.ok(existsSync(join(f.state, "pomtreed.sqlite")));

  r = f.run(["--no-build", "--fresh", "--yes"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /== pomtreed is up/);
  assert.ok(!existsSync(join(f.state, "pomtreed.sqlite")) && !existsSync(join(f.state, "secret")) && !existsSync(join(f.state, "old-agent-file")));
});

test("--fresh --yes on a dir whose only pomtreed-like names are generic (secret, pomtreed.log) refuses and touches nothing", () => {
  const f = fixture({ docker: "ok" });
  const dir = join(f.dir, "keys");
  populate(dir, { secret: "my own key", "pomtreed.log": "not pomtreed's", "notes.txt": "n" });
  const r = f.run(["--no-build", "--state", dir, "--fresh", "--yes"]);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes(`refusing --fresh on ${dir}: it is not empty and holds no pomtreed state (no pomtreed.sqlite database)`), r.out);
  assert.ok(existsSync(join(dir, "secret")) && existsSync(join(dir, "pomtreed.log")) && existsSync(join(dir, "notes.txt")));
});

test("--fresh on an empty dir needs no --yes", () => {
  const f = fixture({ docker: "ok" });
  mkdirSync(f.state);
  const r = f.run(["--no-build", "--fresh"]);
  assert.equal(r.status, 0, r.out);
});

test("--fresh refuses $HOME, a dir holding .git, and a dir that contains the repo, even with --yes", () => {
  const f = fixture({ docker: "ok" });
  // The fixture's HOME is f.dir, which also contains the repo; the HOME check fires first.
  let r = f.run(["--no-build", "--state", f.dir, "--fresh", "--yes"]);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes(`refusing --fresh on ${f.dir}: it is / or your home directory`), r.out);

  const withGit = join(f.dir, "proj");
  populate(join(withGit, ".git"), { HEAD: "ref" });
  writeFileSync(join(withGit, "secret"), "looks like pomtreed");
  r = f.run(["--no-build", "--state", withGit, "--fresh", "--yes"]);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes(`refusing --fresh on ${withGit}: it contains .git`), r.out);
  assert.ok(existsSync(join(withGit, ".git/HEAD")) && existsSync(join(withGit, "secret")));

  r = f.run(["--no-build", "--state", f.dir, "--fresh", "--yes"], { HOME: join(f.dir, "elsewhere") });
  assert.equal(r.status, 1);
  assert.ok(r.out.includes(`refusing --fresh on ${f.dir}: it contains the target repo ${f.repo}`), r.out);
  assert.ok(existsSync(join(f.repo, ".git")));
});

test("long state path: the socket moves under /tmp and the readiness probe's pomtree sees it via POMTREE_SOCKET (pomtree-up-sock)", () => {
  const f = fixture({ docker: "ok", longState: true });
  const r = f.run(["--no-build"]);
  assert.equal(r.status, 0, r.out);
  const seen = readFileSync(join(f.state, "pomtree-seen-sock"), "utf8");
  assert.match(seen, /^\/tmp\/pomtreed-[0-9a-f]{10}\/pomtreed\.sock$/);
  assert.ok(seen.length < f.state.length + 20 && !seen.startsWith(f.state), "relocated, not under the long state dir");
  rmSync(dirname(seen), { recursive: true, force: true });
});

test("short state path: POMTREE_SOCKET stays unset for pomtree (default socket is found from the state dir)", () => {
  const f = fixture({ docker: "ok" });
  assert.equal(f.run(["--no-build"]).status, 0);
  assert.equal(readFileSync(join(f.state, "pomtree-seen-sock"), "utf8"), "");
});

// Image revision label: only a label that is current (HEAD, or an ancestor with no image-source change since) is silent.
const STALE_WARN = /differs from source/;
const BUILDING = /building image .*stale/;

function labelled(): { f: Fixture; base: string } {
  const f = fixture({ docker: "ok", checkoutGit: true });
  const base = f.gitc("rev-parse", "--short", "HEAD");
  f.setLabel(base);
  return { f, base };
}

// A successful run leaves a socket in the state dir, so each run of a case gets its own fixture, built by `setup`.
function eachRun(setup: (f: Fixture, base: string) => void, args: string[][], check: (r: { out: string; status: number | null }, a: string[]) => void): void {
  for (const a of args) {
    const { f, base } = labelled();
    setup(f, base);
    check(f.run(a), a);
  }
}

test("image label equal to HEAD: silent, no build attempt", () => {
  eachRun(
    () => {},
    [["--no-build"], []],
    (r) => {
      assert.equal(r.status, 0, r.out);
      assert.doesNotMatch(r.out, STALE_WARN);
      assert.doesNotMatch(r.out, /building image|image build failed/);
    },
  );
});

test("image label is an ancestor and only a docs file changed since: not stale, no warning, no build", () => {
  eachRun(
    (f) => {
      f.commitFile("docs/note.md");
      f.commitFile("packages/observe/src/x.ts");
    },
    [["--no-build"], []],
    (r) => {
      assert.equal(r.status, 0, r.out);
      assert.doesNotMatch(r.out, STALE_WARN);
      assert.doesNotMatch(r.out, /building image|image build failed/);
    },
  );
});

test("image label is an ancestor but a file under packages/agent-image changed: stale (warns with --no-build, builds without)", () => {
  eachRun(
    (f) => f.commitFile("packages/agent-image/Dockerfile"),
    [["--no-build"], []],
    (r, a) => {
      if (a.length) {
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, STALE_WARN);
        assert.doesNotMatch(r.out, /building image/);
      } else {
        assert.equal(r.status, 1);
        assert.match(r.out, BUILDING);
        assert.match(r.out, /image build failed/);
      }
    },
  );
});

test("image label is not an ancestor of HEAD: stale", () => {
  eachRun(
    (f) => {
      f.gitc("checkout", "-q", "--orphan", "other");
      f.commitFile("docs/other.md");
    },
    [["--no-build"], []],
    (r, a) => assert.match(r.out, a.length ? STALE_WARN : BUILDING),
  );
});

test("image label that names no commit: stale", () => {
  eachRun(
    (f) => f.setLabel("deadbee"),
    [["--no-build"], []],
    (r, a) => assert.match(r.out, a.length ? STALE_WARN : BUILDING),
  );
});

// --open hands the signed-in link (token in the URL fragment) to the opener; --show-token alone controls whether it is printed.
function openRun(args: string[]) {
  const f = fixture({ docker: "ok", opener: true });
  const r = f.run(["--no-build", ...args]);
  const openedFile = join(f.dir, "opened");
  return { r, opened: existsSync(openedFile) ? readFileSync(openedFile, "utf8") : "" };
}

test("--open: the opener gets the #token= link, but the token is not printed", () => {
  const { r, opened } = openRun(["--open"]);
  assert.equal(r.status, 0, r.out);
  assert.match(opened, /^http:\/\/127\.0\.0\.1:\d+\/ui#token=optok-DUMMY-4f9a1c$/m);
  assert.ok(!r.out.includes(OP_TOKEN), "operator token printed without --show-token");
  assert.doesNotMatch(r.out, /#token=/);
  assert.match(r.out, /Token file \(0600, not printed\)/);
});

test("--open --show-token: the opener gets the link and the printed output carries it too", () => {
  const { r, opened } = openRun(["--open", "--show-token"]);
  assert.equal(r.status, 0, r.out);
  assert.ok(opened.includes(`#token=${OP_TOKEN}`));
  assert.ok(r.out.includes(`#token=${OP_TOKEN}`));
});

test("--show-token alone prints the link and does not call the opener; no flags prints no token and opens nothing", () => {
  const a = openRun(["--show-token"]);
  assert.ok(a.r.out.includes(`#token=${OP_TOKEN}`));
  assert.equal(a.opened, "");
  const b = openRun([]);
  assert.ok(!b.r.out.includes(OP_TOKEN));
  assert.equal(b.opened, "");
});

test("--open with neither xdg-open nor open on PATH: warns with the cause and the action, token still unprinted", () => {
  const f = fixture({ docker: "ok" });
  const r = f.run(["--no-build", "--open"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /warning: --open: neither xdg-open nor open was found/);
  assert.match(r.out, /open http:\/\/127\.0\.0\.1:\d+\/ui and paste the operator token from \S+operator\.token/);
  assert.ok(!r.out.includes(OP_TOKEN), "operator token printed without --show-token");
  const ok = openRun(["--open"]);
  assert.doesNotMatch(ok.r.out, /neither xdg-open nor open/);
});

test("negative control: the token-bearing opener link depends on --open (plain URL when the script's link logic is reverted)", () => {
  const f = fixture({ docker: "ok", opener: true });
  const sp = join(f.root, "scripts/pomtree-up");
  const src = readFileSync(sp, "utf8");
  const mutated = src.replace('"$opener" "$openlink"', '"$opener" "$link"');
  assert.notEqual(mutated, src);
  writeFileSync(sp, mutated);
  f.run(["--no-build", "--open"]);
  assert.ok(!readFileSync(join(f.dir, "opened"), "utf8").includes("#token="), "mutant should fail the assertion above");
});
