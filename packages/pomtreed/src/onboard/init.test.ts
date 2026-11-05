import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeProbeRunner } from "@pomtree/testing";
import { type InitEnv, type InitIo, type LStat, NEXT_STEP_LABELS, fillCommand, runInit } from "./init.ts";
import type { ProbeRunner } from "./probes.ts";
import { onboardingSteps, stepById } from "./steps.ts";
import { checkTemplateFiles } from "./template-check.ts";

// Contract-drift: the structural fake is assignable to pomtreed's ProbeRunner.
const _runner: ProbeRunner = new FakeProbeRunner({});
void _runner;

const unit = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "deploy", "pomtreed.service"), "utf8");
const facts = { nodeRange: ">=24", pnpmVersion: "10.19.0", minGit: "2.38.0", defaultImage: "pomtree/agent:dev" };
const KEY = "/keys/model.key";
const SECRET_IN_KEY = "sk-live-never-read";

// An in-memory filesystem that records writes and fails if the key file is ever read.
function memory(initial: Record<string, string> = {}, stats: Record<string, Partial<LStat>> = {}, opts: { failWrite?: string; swapped?: string } = {}) {
  const files = new Map(Object.entries(initial));
  const modes = new Map<string, number>();
  const dirs = new Set<string>(["/"]);
  const st = new Map(Object.entries(stats));
  const log: string[] = [];
  const reads: string[] = [];
  const inos = new Map<string, number>();
  const io: InitIo = {
    readText: (p) => {
      reads.push(p);
      assert.notEqual(p, KEY, "the key file must never be read");
      // a path swapped for a symlink between the lstat and the open: the real adapter's O_NOFOLLOW open fails like this
      if (p === opts.swapped) throw new Error(`ELOOP: too many symbolic links encountered, open '${p}'`);
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT: no such file, open '${p}'`);
      return c;
    },
    lstat: (p) => {
      const o = st.get(p);
      if (o === undefined && !files.has(p)) return null;
      return {
        mode: 0o100000 | (modes.get(p) ?? 0o600),
        uid: 1000,
        isDirectory: false,
        isSymlink: false,
        isFile: true,
        dev: 1,
        ino: inos.get(p) ?? inos.set(p, inos.size + 1).get(p),
        ...o,
      } as LStat;
    },
    mkdirp: (d) => {
      dirs.add(d);
      log.push(`mkdir ${d}`);
    },
    writeText: (p, c, m) => {
      assert.notEqual(p, KEY, "the key file must never be overwritten");
      assert.ok(dirs.has(dirname(p)), `parent directory of ${p} was never created`);
      if (p === opts.failWrite) throw new Error("ENOSPC: no space left on device");
      files.set(p, c);
      modes.set(p, m);
      log.push(`write ${p}`);
    },
    createEmpty: (p, m) => {
      assert.ok(!files.has(p) && !st.has(p), "createEmpty only for an absent file");
      files.set(p, "");
      modes.set(p, m);
      log.push(`create ${p}`);
    },
  };
  return { io, files, modes, log, reads };
}

const env = (io: InitIo, over: Partial<InitEnv> = {}): InitEnv => ({
  io,
  defaultOut: "/cfg/pomtreed",
  defaultStateDir: "/state",
  checkout: "/co",
  isGitRepo: (d) => d === "/repo" || d.startsWith("/repo-"),
  node: "/usr/bin/node",
  uid: 1000,
  readAnswers: () => {
    throw new Error("no answers file");
  },
  readServiceTemplate: () => unit,
  facts,
  realpath: (p) => p,
  checkTemplates: checkTemplateFiles,
  ...over,
});

const config = {
  "model.baseUrl": "https://api.example.com/v1",
  "pi.provider": "openrouter",
  "agent.egressProxyImage": `sha256:${"a".repeat(64)}`,
  "agent.untemplatedEgress": "none",
  "extensions.approval": "all",
  "repo.dir": "/repo",
};
const answers = (over: Record<string, unknown> = {}) => JSON.stringify({ config, keyFile: KEY, ...over });
const run = (argv: string[], a: string, io: InitIo, over: Partial<InitEnv> = {}) => runInit(argv, env(io, { readAnswers: () => a, ...over }));
const text = (r: { lines: string[] }) => r.lines.join("\n");

test("--questions --json prints the derived interview; without --json, text", async () => {
  const m = memory();
  const json = await runInit(["--questions", "--json"], env(m.io));
  assert.equal(json.code, 0);
  assert.ok((JSON.parse(json.lines[0] as string) as { id: string }[]).some((q) => q.id === "model.baseUrl"));
  assert.match(text(await runInit(["--questions"], env(m.io))), /model\.baseUrl/);
});

test("usage errors exit 2: neither flag, unknown flag, --force without --write, --json with --answers", async () => {
  const m = memory();
  for (const argv of [[], ["--bogus"], ["--answers", "a", "--force"], ["--answers", "a", "--json"], ["--questions", "--write"]]) {
    const r = await runInit(argv, env(m.io));
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(text(r), /usage: pomtreed init/);
  }
});

test("a missing required or safety answer is refused, naming each, and nothing is written", async () => {
  const m = memory();
  const r = await run(["--answers", "a", "--write"], JSON.stringify({ config: { "pi.provider": "x" } }), m.io);
  assert.equal(r.code, 2);
  for (const id of ["model.baseUrl", "model.upstreamKey", "agent.egressProxyImage", "agent.untemplatedEgress", "extensions.approval"])
    assert.match(text(r), new RegExp(`missing answer for ${id.replace(".", "\\.")}`));
  assert.equal(m.log.length, 0);
});

test("the resolver's refusals are printed and nothing is written", async () => {
  const m = memory();
  const bad = JSON.stringify({ config: { ...config, "agent.untemplatedEgress": "everything" }, keyFile: KEY });
  const r = await run(["--answers", "a", "--write"], bad, m.io);
  assert.equal(r.code, 2);
  assert.match(text(r), /agent\.untemplatedEgress/);
  assert.match(text(r), /nothing was written/);
  assert.equal(m.log.length, 0);
});

test("an unknown key and a sensitive key under config are refused with the action", async () => {
  const m = memory();
  const unknown = await run(["--answers", "a"], answers({ config: { ...config, "agent.nope": 1 } }), m.io);
  assert.equal(unknown.code, 2);
  assert.match(text(unknown), /unknown key agent\.nope/);
  const sensitive = await run(["--answers", "a"], answers({ config: { ...config, "model.upstreamKey": SECRET_IN_KEY } }), m.io);
  assert.equal(sensitive.code, 2);
  assert.match(text(sensitive), /keyFile/);
  assert.ok(!text(sensitive).includes(SECRET_IN_KEY));
});

test("a refused answers file (bad JSON, unreadable) exits 2 naming the action", async () => {
  const m = memory();
  assert.equal((await run(["--answers", "a"], "{", m.io)).code, 2);
  const r = await runInit(["--answers", "/nope.json"], env(m.io));
  assert.equal(r.code, 2);
  assert.match(text(r), /cannot read answers file \/nope\.json/);
});

test("dry run is the default: it prints new files and writes nothing", async () => {
  const m = memory();
  const r = await run(["--answers", "a"], answers(), m.io);
  assert.equal(r.code, 0);
  assert.match(text(r), /new \/cfg\/pomtreed\/pomtreed\.env/);
  assert.match(text(r), /key file \/keys\/model\.key: new/);
  assert.match(text(r), /dry run: pass --write to apply/);
  assert.equal(m.log.length, 0);
});

test("dry run of a differing file exits 0 but says --write would refuse it without --force", async () => {
  const m = memory({ "/cfg/pomtreed/pomtreed.env": "POMTREED_PI_PROVIDER=other\n" });
  const r = await run(["--answers", "a"], answers(), m.io);
  assert.equal(r.code, 0);
  assert.match(text(r), /--write would refuse to overwrite \/cfg\/pomtreed\/pomtreed\.env.*--force/);
  assert.equal(m.log.length, 0);
  const fresh = await run(["--answers", "a"], answers(), memory().io);
  assert.doesNotMatch(text(fresh), /would refuse/, "negative: new files draw no warning");
});

test("--write creates the env file (key as a _FILE path, never a value) and an empty 0600 key file; the second run is a no-op", async () => {
  const m = memory();
  const first = await run(["--answers", "a", "--write"], answers(), m.io);
  assert.equal(first.code, 0, text(first));
  const envText = m.files.get("/cfg/pomtreed/pomtreed.env") as string;
  assert.match(envText, /^POMTREED_MODEL_BASE_URL=https:\/\/api\.example\.com\/v1$/m);
  assert.match(envText, /^POMTREED_MODEL_UPSTREAM_KEY_FILE=\/keys\/model\.key$/m);
  assert.ok(!/POMTREED_MODEL_UPSTREAM_KEY=/.test(envText));
  assert.equal(m.files.get(KEY), "");
  assert.equal(m.modes.get(KEY), 0o600);
  assert.equal(m.modes.get("/cfg/pomtreed/pomtreed.env"), 0o600);
  assert.match(text(first), /set -a; \. \/cfg\/pomtreed\/pomtreed\.env; set \+a/);
  assert.match(text(first), /config show/);
  const writes = m.log.filter((l) => l.startsWith("write") || l.startsWith("create")).length;
  const second = await run(["--answers", "a", "--write"], answers(), m.io);
  assert.equal(second.code, 0);
  assert.match(text(second), /unchanged \/cfg\/pomtreed\/pomtreed\.env/);
  assert.equal(m.log.filter((l) => l.startsWith("write") || l.startsWith("create")).length, writes);
});

test("a differing existing file is refused without --force (diff shown, nothing written) and replaced with it", async () => {
  const m = memory({ "/cfg/pomtreed/pomtreed.env": "POMTREED_PI_PROVIDER=other\n" });
  const refused = await run(["--answers", "a", "--write"], answers(), m.io);
  assert.equal(refused.code, 2);
  assert.match(text(refused), /^ {2}-POMTREED_PI_PROVIDER=other$/m);
  assert.match(text(refused), /refusing to overwrite \/cfg\/pomtreed\/pomtreed\.env/);
  assert.equal(m.files.get("/cfg/pomtreed/pomtreed.env"), "POMTREED_PI_PROVIDER=other\n");
  assert.equal(m.log.filter((l) => l.startsWith("write") || l.startsWith("create")).length, 0);
  const forced = await run(["--answers", "a", "--write", "--force"], answers(), m.io);
  assert.equal(forced.code, 0);
  assert.match(m.files.get("/cfg/pomtreed/pomtreed.env") as string, /POMTREED_MODEL_BASE_URL/);
});

test("an existing key file is never read, opened or overwritten, even with --force; only its mode and owner are reported", async () => {
  const m = memory({ [KEY]: SECRET_IN_KEY });
  const r = await run(["--answers", "a", "--write", "--force"], answers(), m.io);
  assert.equal(r.code, 0, text(r));
  assert.equal(m.files.get(KEY), SECRET_IN_KEY);
  assert.match(text(r), /exists, left untouched \(mode 600, ok\)/);
  assert.ok(!text(r).includes(SECRET_IN_KEY));
  const loose = memory({ [KEY]: SECRET_IN_KEY }, { [KEY]: { mode: 0o100644 } });
  assert.match(text(await run(["--answers", "a"], answers(), loose.io)), /WARNING.*chmod 600/);
  const dir = memory({}, { [KEY]: { mode: 0o40700, isDirectory: true, isFile: false } });
  assert.equal((await run(["--answers", "a"], answers(), dir.io)).code, 2);
});

test('output "json" writes a nested pomtreed.json without secrets and an env file holding only the config and key lines', async () => {
  const m = memory();
  const r = await run(["--answers", "a", "--write"], answers({ output: "json" }), m.io);
  assert.equal(r.code, 0, text(r));
  const json = JSON.parse(m.files.get("/cfg/pomtreed/pomtreed.json") as string);
  assert.equal(json.model.baseUrl, "https://api.example.com/v1");
  assert.equal(json.model.upstreamKey, undefined);
  assert.equal(m.files.get("/cfg/pomtreed/pomtreed.env"), "POMTREED_CONFIG=/cfg/pomtreed/pomtreed.json\nPOMTREED_MODEL_UPSTREAM_KEY_FILE=/keys/model.key\n");
});

test('service "systemd" renders the unit from deploy/pomtreed.service and prints root-only commands for the user; a template without an expected line is refused', async () => {
  const m = memory();
  const r = await run(["--answers", "a", "--write"], answers({ service: "systemd" }), m.io);
  assert.equal(r.code, 0, text(r));
  const svc = m.files.get("/cfg/pomtreed/pomtreed.service") as string;
  assert.ok(svc.includes("ExecStart=/usr/bin/node /co/packages/pomtreed/src/main.ts"));
  assert.ok(svc.includes("EnvironmentFile=/cfg/pomtreed/pomtreed.env"));
  assert.ok(svc.includes("Environment=POMTREED_STATE_DIR=/state"));
  assert.match(text(r), /sudo systemctl enable --now pomtreed/);
  const broken = memory();
  const refused = await run(["--answers", "a", "--write"], answers({ service: "systemd" }), broken.io, {
    readServiceTemplate: () => unit.replace(/^ReadWritePaths=.*$/m, ""),
  });
  assert.equal(refused.code, 2);
  assert.match(text(refused), /no ReadWritePaths= line/);
  assert.equal(broken.log.length, 0);
});

// ---- Part B -----------------------------------------------------------------------------------------------------------------------
const repo = {
  templates: [
    { id: "review", systemPrompt: "Review the diff.", egress: "registry", provider: "openrouter", model: "m", budgetMicros: 500000, disposition: "hold" },
  ],
  schedules: [{ id: "nightly", cron: "0 3 * * *", task: "it's review", tz: "UTC" }],
};

test("templates are written as canonical JSON under <out>/templates, templates.dir is set, schedules are printed shell-quoted, notes carry the gap tags", async () => {
  const m = memory();
  const r = await run(["--answers", "a", "--write"], answers({ repo }), m.io);
  assert.equal(r.code, 0, text(r));
  assert.equal(
    m.files.get("/cfg/pomtreed/templates/review.json"),
    `${JSON.stringify({ systemPrompt: "Review the diff.", egress: { kind: "registry" }, provider: "openrouter", model: "m", budgetMicros: 500000, disposition: { mode: "hold" } }, null, 2)}\n`,
  );
  assert.match(m.files.get("/cfg/pomtreed/pomtreed.env") as string, /^POMTREED_TEMPLATES_DIR=\/cfg\/pomtreed\/templates$/m);
  assert.match(text(r), /pomtree sched add 'nightly' '0 3 \* \* \*' 'it'\\''s review' --tz 'UTC'/);
  assert.match(text(r), /onboard-repo-toolchain/);
  assert.match(text(r), /onboard-repo-secrets/);
});

test("a second run with templates is a no-op", async () => {
  const m = memory();
  await run(["--answers", "a", "--write"], answers({ repo }), m.io);
  const writes = m.log.filter((l) => l.startsWith("write") || l.startsWith("create")).length;
  const again = await run(["--answers", "a", "--write"], answers({ repo }), m.io);
  assert.equal(again.code, 0);
  assert.match(text(again), /unchanged \/cfg\/pomtreed\/templates\/review\.json/);
  assert.equal(m.log.filter((l) => l.startsWith("write") || l.startsWith("create")).length, writes);
});

test("a template the store refuses (provider without model) exits 2 naming the template and writes nothing", async () => {
  const m = memory();
  const bad = { templates: [{ id: "bad", egress: "none", provider: "openrouter" }] };
  const r = await run(["--answers", "a", "--write"], answers({ repo: bad }), m.io);
  assert.equal(r.code, 2);
  assert.match(text(r), /bad: provider requires model/);
  assert.equal(m.log.length, 0);
});

test("a templates dir inside the repo dir is refused", async () => {
  const m = memory();
  const r = await run(["--answers", "a", "--write"], answers({ repo, config: { ...config, "templates.dir": "/repo/.pomtreed/templates" } }), m.io);
  assert.equal(r.code, 2);
  assert.match(text(r), /templates\.dir .* inside the repo dir \/repo/);
  assert.equal(m.log.length, 0);
  const viaOut = await run(["--answers", "a", "--out", "/repo/cfg"], answers({ repo }), memory().io);
  assert.equal(viaOut.code, 2);
});

test("repo answers are checked: a schedule missing a field, an unknown template field, audited-public egress and a bad id are refused", async () => {
  const m = memory();
  const cases: [unknown, RegExp][] = [
    [{ schedules: [{ id: "s", cron: "* * * * *" }] }, /schedules\[0\]\.task is required/],
    [{ templates: [{ id: "t", egress: "none", image: "x" }] }, /unknown field image/],
    [{ templates: [{ id: "t", egress: { kind: "audited-public" } }] }, /browser workers only/],
    [{ templates: [{ id: "../x", egress: "none" }] }, /templates\[0\]\.id/],
    [{ templates: [{ id: "t" }] }, /egress is required/],
  ];
  for (const [bad, re] of cases) {
    const r = await run(["--answers", "a", "--write"], answers({ repo: bad }), m.io);
    assert.equal(r.code, 2);
    assert.match(text(r), re);
  }
  assert.equal(m.log.length, 0);
});

// ---- fix round ----------------------------------------------------------------------------------------------------------------------
test("--write creates the parent directory of every planned file (templates dir) before writing it", async () => {
  const m = memory();
  const r = await run(["--answers", "a", "--write"], answers({ repo }), m.io);
  assert.equal(r.code, 0, text(r));
  assert.ok(m.log.includes("mkdir /cfg/pomtreed/templates"));
});

test("a write error reports what was written and what failed, exit 2, never a raw throw", async () => {
  const m = memory({}, {}, { failWrite: "/cfg/pomtreed/templates/review.json" });
  const r = await run(["--answers", "a", "--write"], answers({ repo }), m.io);
  assert.equal(r.code, 2);
  assert.match(text(r), /wrote .*pomtreed\.env.*; failed \/cfg\/pomtreed\/templates\/review\.json: ENOSPC/);
});

test("a keyFile that is a file init writes (or realpaths to one) is refused, even with --force; the key is never printed", async () => {
  for (const keyFile of ["/cfg/pomtreed/pomtreed.env", "/cfg/pomtreed/templates/review.json", "/alias/pomtreed.env"]) {
    const m = memory({ [keyFile]: SECRET_IN_KEY });
    const real = (p: string) => (p.startsWith("/alias/") ? p.replace("/alias/", "/cfg/pomtreed/") : p);
    const r = await run(["--answers", "a", "--write", "--force"], answers({ keyFile, repo }), m.io, { realpath: real });
    assert.equal(r.code, 2, keyFile);
    assert.match(text(r), /is the same file as/);
    assert.ok(!text(r).includes(SECRET_IN_KEY));
    assert.equal(m.files.get(keyFile), SECRET_IN_KEY);
  }
});

test("a key file that is a symlink (dangling or not) or not a regular file is refused before any write", async () => {
  const m = memory({}, { [KEY]: { isSymlink: true, isFile: false } });
  const r = await run(["--answers", "a", "--write"], answers(), m.io);
  assert.equal(r.code, 2);
  assert.match(text(r), /symlink/);
  assert.equal(m.log.length, 0);
});

test("a key file hardlinked to a planned file is refused before any read or write, naming both paths and never printing content", async () => {
  const m = memory(
    { "/cfg/pomtreed/pomtreed.env": SECRET_IN_KEY, [KEY]: SECRET_IN_KEY },
    { "/cfg/pomtreed/pomtreed.env": { dev: 7, ino: 42 }, [KEY]: { dev: 7, ino: 42 } },
  );
  for (const argv of [
    ["--answers", "a"],
    ["--answers", "a", "--write", "--force"],
  ]) {
    const r = await run(argv, answers(), m.io);
    assert.equal(r.code, 2);
    assert.match(text(r), new RegExp(`keyFile ${KEY} is a hardlink of /cfg/pomtreed/pomtreed\\.env`));
    assert.ok(!text(r).includes(SECRET_IN_KEY));
  }
  assert.equal(m.reads.includes("/cfg/pomtreed/pomtreed.env"), false, "the planned path is never read");
  assert.equal(m.log.length, 0);
  // negative control: same ino on a different device is a different file
  const other = memory({ "/cfg/pomtreed/pomtreed.env": "x", [KEY]: "" }, { "/cfg/pomtreed/pomtreed.env": { dev: 8, ino: 42 }, [KEY]: { dev: 7, ino: 42 } });
  assert.equal((await run(["--answers", "a"], answers(), other.io)).code, 0);
});

test("a planned file that is a symlink is refused before any write", async () => {
  const m = memory({ "/cfg/pomtreed/pomtreed.env": "x" }, { "/cfg/pomtreed/pomtreed.env": { isSymlink: true, isFile: false } });
  const r = await run(["--answers", "a", "--write", "--force"], answers(), m.io);
  assert.equal(r.code, 2);
  assert.match(text(r), /pomtreed\.env is a symlink/);
  assert.equal(m.log.length, 0);
});

test("a secret in an existing planned env or JSON file never reaches dry-run, --write refusal or --json output; a non-sensitive value still shows", async () => {
  const INLINE = "sk-live-INLINE-0123456789abcdef";
  const IN_JSON = "sk-json-0123456789abcdef";
  const OTHER = "sk-other-0123456789abcdef"; // a credential under a name the registry does not own
  const existing = {
    "/cfg/pomtreed/pomtreed.env": `POMTREED_MODEL_UPSTREAM_KEY=${INLINE}\nexport OPENROUTER_API_KEY='${OTHER}'\nPOMTREED_PI_PROVIDER=other\n`,
    "/cfg/pomtreed/pomtreed.json": `{"model":{"upstreamKey":"${IN_JSON}","baseUrl":"https://old.example.com"}}\n`,
  };
  for (const output of ["env", "json"]) {
    for (const argv of [
      ["--answers", "a"],
      ["--answers", "a", "--write"],
      ["--answers", "a", "--json"],
    ]) {
      const r = await run(argv, answers({ output }), memory(existing).io);
      const t = text(r);
      for (const s of [INLINE, IN_JSON, OTHER]) assert.ok(!t.includes(s), `${output} ${argv.join(" ")} printed a secret`);
    }
    const dry = text(await run(["--answers", "a"], answers({ output }), memory(existing).io));
    assert.match(dry, /^ {2}-POMTREED_MODEL_UPSTREAM_KEY=<redacted>$/m, "the changed sensitive line is shown by name");
    // negative control: a non-sensitive key keeps its value in the diff
    assert.match(dry, /^ {2}-POMTREED_PI_PROVIDER=other$/m);
    if (output === "json") {
      assert.match(dry, /"upstreamKey":"<redacted>"/);
      assert.match(dry, /old\.example\.com/);
    }
  }
});

test("a file differing only in a sensitive value says so without showing it", async () => {
  const r = await run(["--answers", "a"], answers(), memory({ "/cfg/pomtreed/pomtreed.env": "POMTREED_MODEL_UPSTREAM_KEY=sk-a-0123456789abcdef\n" }).io);
  assert.ok(!text(r).includes("sk-a-0123456789abcdef"));
  const same = await run(
    ["--answers", "a"],
    answers({ output: "json" }),
    memory({ "/cfg/pomtreed/pomtreed.json": `{\n  "model": {\n    "upstreamKey": "sk-b-0123456789abcdef"\n  }\n}\n` }).io,
  );
  assert.ok(!text(same).includes("sk-b-0123456789abcdef"));
});

test("an unchanged file with a loose mode is reported with the chmod to run", async () => {
  const first = memory();
  await run(["--answers", "a", "--write"], answers(), first.io);
  const m = memory(
    { "/cfg/pomtreed/pomtreed.env": first.files.get("/cfg/pomtreed/pomtreed.env") as string, [KEY]: "" },
    { "/cfg/pomtreed/pomtreed.env": { mode: 0o100644 } },
  );
  assert.match(
    text(await run(["--answers", "a"], answers(), m.io)),
    /unchanged \/cfg\/pomtreed\/pomtreed\.env \(mode 644: run chmod 600 \/cfg\/pomtreed\/pomtreed\.env\)/,
  );
});

test("a keyFile inside the repo dir or an agent-writable state path is refused", async () => {
  for (const keyFile of ["/repo/secrets/model.key", "/state/agents/model.key", "/state/sessions/k"]) {
    const r = await run(["--answers", "a"], answers({ keyFile }), memory().io);
    assert.equal(r.code, 2, keyFile);
    assert.match(text(r), /keyFile .* is inside/);
  }
});

test("printed commands quote a path with a space", async () => {
  const m = memory();
  const r = await run(["--answers", "a", "--write", "--out", "/my cfg/pomtreed"], answers({ service: "systemd" }), m.io, { checkout: "/my co" });
  assert.equal(r.code, 2, "the unit cannot carry a space in a path, so this plan is refused");
  const plain = await run(["--answers", "a", "--write", "--out", "/my cfg/pomtreed"], answers(), memory().io, { checkout: "/my co" });
  assert.equal(plain.code, 0, text(plain));
  assert.match(text(plain), /set -a; \. '\/my cfg\/pomtreed\/pomtreed\.env'; set \+a/);
  assert.match(text(plain), /node '\/my co\/packages\/pomtreed\/src\/main\.ts' config show/);
  assert.match(
    text(await run(["--answers", "a"], answers({ keyFile: "/my keys/k" }), memory({ "/my keys/k": "" }, { "/my keys/k": { mode: 0o100644 } }).io)),
    /chmod 600 '\/my keys\/k'/,
  );
});

// ---- review round 2 -----------------------------------------------------------------------------------------------------------------
const { "repo.dir": _repoDir, ...configNoRepo } = config;
void _repoDir;

test("repo.dir has no default: unanswered and without --repo it is refused; --repo fills it; a conflicting answer is refused", async () => {
  const none = await run(["--answers", "a"], answers({ config: configNoRepo }), memory().io);
  assert.equal(none.code, 2);
  assert.match(text(none), /missing answer for repo\.dir/);
  const filled = memory();
  const viaFlag = await run(["--answers", "a", "--repo", "/repo", "--write"], answers({ config: configNoRepo }), filled.io);
  assert.equal(viaFlag.code, 0, text(viaFlag));
  assert.match(filled.files.get("/cfg/pomtreed/pomtreed.env") as string, /^POMTREED_REPO_DIR=\/repo$/m);
  const conflict = await run(["--answers", "a", "--repo", "/repo-b"], answers(), memory().io);
  assert.equal(conflict.code, 2);
  assert.match(text(conflict), /repo\.dir: the answers file says "\/repo" but --repo says "\/repo-b"/);
  // negative control: the same value twice is no conflict
  assert.equal((await run(["--answers", "a", "--repo", "/repo"], answers(), memory().io)).code, 0);
  assert.equal((await run(["--answers", "a", "--repo", "rel"], answers(), memory().io)).code, 2);
});

test("--questions: repo.dir is required with no default unless --repo gives one; never the working directory", async () => {
  const q = (argv: string[]) => runInit(["--questions", "--json", ...argv], env(memory().io));
  const plain = JSON.parse((await q([])).lines[0] as string) as { id: string; kind: string; default: string | null }[];
  const repoQ = plain.find((x) => x.id === "repo.dir");
  assert.equal(repoQ?.kind, "required");
  assert.equal(repoQ?.default, null);
  const given = JSON.parse((await q(["--repo", "/target"])).lines[0] as string) as { id: string; default: string | null }[];
  assert.equal(given.find((x) => x.id === "repo.dir")?.default, "/target");
});

test("repo.dir that is the checkout, inside it, contains it, or is not a git repository is refused before anything is written", async () => {
  for (const [dir, re] of [
    ["/co", /pomtree checkout/],
    ["/co/sub", /pomtree checkout/],
    ["/", /checkout \/co is inside \//],
    ["/elsewhere", /not a git repository/],
  ] as const) {
    const m = memory();
    const r = await run(["--answers", "a", "--write"], answers({ config: { ...config, "repo.dir": dir } }), m.io, { isGitRepo: () => dir !== "/elsewhere" });
    assert.equal(r.code, 2, dir);
    assert.match(text(r), re);
    assert.equal(m.log.length, 0);
  }
  // realpath identity: a link to the checkout is the checkout
  const linked = await run(["--answers", "a"], answers({ config: { ...config, "repo.dir": "/link" } }), memory().io, {
    realpath: (p) => (p === "/link" ? "/co" : p),
    isGitRepo: () => true,
  });
  assert.equal(linked.code, 2);
});

test("the next-step commands are the step source's, filled in: key-file and every start-daemon command, systemd's root ones included", async () => {
  const steps = onboardingSteps(facts);
  const values = { out: "/cfg/pomtreed", checkout: "/co", "key-file": KEY };
  const r = await run(["--answers", "a", "--write"], answers({ service: "systemd" }), memory().io);
  assert.equal(r.code, 0, text(r));
  const printed = text(r);
  const expected = [stepById(steps, "key-file"), stepById(steps, "start-daemon")].flatMap((s) => s.commands.map((c) => fillCommand(c.run, values)));
  for (const c of expected) assert.ok(printed.includes(c), `next steps lack the step command: ${c}`);
  assert.match(printed, /sudo systemctl daemon-reload/);
  assert.equal(stepById(steps, "start-daemon").commands.filter((c) => c.needsRoot !== true).length, NEXT_STEP_LABELS.length);
  // negative control: a command missing from the step source is not printed
  assert.ok(!printed.includes("sudo cp "));
});

test("fillCommand quotes each placeholder word as one shell word and keeps unknown placeholders", () => {
  assert.equal(fillCommand("set -a; . <out>/pomtreed.env; set +a", { out: "/my cfg" }), "set -a; . '/my cfg/pomtreed.env'; set +a");
  assert.equal(fillCommand("node <checkout>/main.ts", { checkout: "/co" }), "node /co/main.ts");
  assert.equal(fillCommand("git -C <repo> log", {}), "git -C <repo> log");
});

test("a planned file swapped for a symlink between the check and the read is refused, nothing is written and nothing is printed from it", async () => {
  const m = memory({ "/cfg/pomtreed/pomtreed.env": "POMTREED_PI_PROVIDER=other\n" }, {}, { swapped: "/cfg/pomtreed/pomtreed.env" });
  const r = await run(["--answers", "a", "--write", "--force"], answers(), m.io);
  assert.equal(r.code, 2);
  assert.match(text(r), /pomtreed\.env changed while init was checking it \(ELOOP/);
  assert.match(text(r), /nothing was written/);
  assert.ok(!text(r).includes("POMTREED_PI_PROVIDER=other"));
  assert.equal(m.log.length, 0);
});

test("a symlinked directory below --out (such as <out>/templates) is refused before any read or write; --out itself may be a link", async () => {
  const m = memory({ "/cfg/pomtreed/templates/review.json": "{}\n" }, { "/cfg/pomtreed/templates": { isSymlink: true, isFile: false } });
  const r = await run(["--answers", "a", "--write", "--force"], answers({ repo }), m.io);
  assert.equal(r.code, 2);
  assert.match(text(r), /\/cfg\/pomtreed\/templates is a symlink/);
  assert.equal(m.reads.length, 0);
  assert.equal(m.log.length, 0);
  const outLink = memory({}, { "/cfg/pomtreed": { isSymlink: true, isFile: false } });
  assert.equal((await run(["--answers", "a", "--write"], answers({ repo }), outLink.io)).code, 0, "negative control: --out is the user's choice");
});
