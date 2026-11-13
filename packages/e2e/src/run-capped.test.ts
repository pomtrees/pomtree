// Behavior of scripts/run-capped.sh, the memory and time cap around test runs. Each case drives the real script over a
// real child. The cap cases need a systemd user scope and skip with a printed reason without one; the negative controls
// (the same allocation under a roomy cap, a short sleep under a long limit) show the kills come from the cap, not from the
// child or the harness. The whole file is bounded by per-run timeouts and a test timeout, and the child allocating beyond
// its cap stays inside a 64M cgroup, so it cannot hurt the host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../../../scripts/run-capped.sh", import.meta.url).pathname;
const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), `${prefix}-`));
const OPTS = { timeout: 60_000 } as const;

// Ambient POMTREE_RUN_* settings (set by the root test scripts or an outer shell) must not leak into a case.
const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("POMTREE_RUN_")));

const run = (args: string[], env: Record<string, string> = {}) => {
  const started = Date.now();
  const r = spawnSync(SCRIPT, args, { encoding: "utf8", env: { ...cleanEnv(), ...env }, ...OPTS });
  return { rc: r.status, err: r.stderr, out: r.stdout, ms: Date.now() - started };
};

const scope = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "-p", "MemoryMax=64M", "true"], { encoding: "utf8" });
const noScope = scope.status === 0 ? false : `no systemd user scope (${(scope.stderr || String(scope.error)).trim()}); cap cases cannot run here`;

const ALLOC = "const a=[];for(let i=0;i<512;i++)a.push(Buffer.alloc(1024*1024,1));console.log('allocated '+a.length)";

test("the command's exit code passes through exactly", OPTS, () => {
  assert.equal(run(["--", "bash", "-c", "exit 7"]).rc, 7);
  assert.equal(run(["--", "bash", "-c", "exit 0"]).rc, 0);
  const ok = run(["--", "bash", "-c", "echo hi; echo err >&2"]);
  assert.equal(ok.out, "hi\n");
  assert.match(ok.err, /(^|\n)err\n/, "the command stderr passes through, after any notice");
});

test("a sleeping command hits the timeout, is killed with its group, and the cause and action are printed", OPTS, () => {
  const pidfile = join(tmp("capped"), "pid");
  const r = run(["--timeout", "2s", "--", "bash", "-c", `sleep 60 & echo $! > ${pidfile}; wait`]);
  assert.equal(r.rc, 124);
  assert.match(r.err, /TIMEOUT after 2s.*raise --timeout/);
  assert.ok(r.ms < 20_000, `took ${r.ms}ms`);
  const grandchild = readFileSync(pidfile, "utf8").trim();
  assert.equal(spawnSync("ps", ["-p", grandchild], { encoding: "utf8" }).status, 1, "the backgrounded sleep must be dead");
});

test("negative control: a short sleep under a long limit finishes without the timeout message", OPTS, () => {
  const r = run(["--timeout", "30s", "--", "sleep", "1"]);
  assert.equal(r.rc, 0);
  assert.doesNotMatch(r.err, /TIMEOUT/);
});

test("a child allocating 512 MB under --mem 64M is killed with a memory-cap message", { ...OPTS, skip: noScope }, () => {
  const r = run(["--mem", "64M", "--", process.execPath, "-e", ALLOC]);
  assert.equal(r.rc, 137);
  assert.match(r.err, /memory cap \(MemoryMax=64M cgroup\).*raise --mem/);
  assert.doesNotMatch(r.out, /allocated/);
});

test("negative control: the same allocation under a roomy cap succeeds", { ...OPTS, skip: noScope }, () => {
  const r = run(["--mem", "2G", "--", process.execPath, "-e", ALLOC]);
  assert.equal(r.rc, 0);
  assert.match(r.out, /allocated 512/);
  assert.doesNotMatch(r.err, /memory cap/);
});

test("POMTREE_RUN_MEM and POMTREE_RUN_TIMEOUT set the defaults", { ...OPTS, skip: noScope }, () => {
  const r = run(["--", process.execPath, "-e", ALLOC], { POMTREE_RUN_MEM: "64M" });
  assert.equal(r.rc, 137);
  assert.equal(run(["--", "sleep", "30"], { POMTREE_RUN_TIMEOUT: "1s" }).rc, 124);
});

test("a nested run still applies its own cap: a tight inner cap inside a roomy outer one kills", { ...OPTS, skip: noScope }, () => {
  const r = run(["--mem", "2G", "--", SCRIPT, "--mem", "64M", "--", process.execPath, "-e", ALLOC]);
  assert.equal(r.rc, 137);
  assert.match(r.err, /MemoryMax=64M cgroup/);
  assert.doesNotMatch(r.err, /enclosing cgroup/, "a roomy outer cap must not stand in for the tighter inner one");
});

// A nested systemd scope would escape the outer cgroup, so the inner run must stay inside a tighter outer cap.
test("a nested run under a tighter outer cap stays inside it and is killed by it", { ...OPTS, skip: noScope }, () => {
  const r = run(["--mem", "64M", "--", SCRIPT, "--mem", "2G", "--", process.execPath, "-e", ALLOC]);
  assert.equal(r.rc, 137);
  assert.match(r.err, /enclosing cgroup already limits memory to 64M/);
});

test("an inherited POMTREE_RUN_CAPPED=1 does not disable the cap", { ...OPTS, skip: noScope }, () => {
  const r = run(["--mem", "64M", "--", process.execPath, "-e", ALLOC], { POMTREE_RUN_CAPPED: "1" });
  assert.equal(r.rc, 137);
});

// systemd stops a scope with SIGTERM after a kernel OOM kill; `timeout` then exits 124 before reaping the SIGKILLed child.
test("a SIGTERM sent to timeout before the time limit is a cap kill (137), not a timeout (124)", OPTS, () => {
  const r = run(["--timeout", "30s", "--", "sh", "-c", "kill -TERM $PPID; sleep 5"]);
  assert.equal(r.rc, 137);
  assert.doesNotMatch(r.err, /TIMEOUT/);
  assert.ok(r.ms < 10_000, `took ${r.ms}ms`);
});

// A fake cgroup hierarchy and /proc/self/cgroup, fed to the script through POMTREE_CGROUP_ROOT and POMTREE_CGROUP_PROC. Each entry of
// `limits` is a path under the root and the content of its limit file; `proc` is the content of the fake /proc/self/cgroup.
const UNLIMITED_V1 = "9223372036854771712";
const fakeCgroup = (limits: Record<string, string>, proc: string): Record<string, string> => {
  const root = tmp("cgroup");
  for (const [path, content] of Object.entries(limits)) {
    mkdirSync(join(root, path.slice(0, path.lastIndexOf("/"))), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const procFile = join(tmp("cgroup-proc"), "cgroup");
  writeFileSync(procFile, proc);
  return { POMTREE_CGROUP_ROOT: root, POMTREE_CGROUP_PROC: procFile };
};
const ENCLOSING = /enclosing cgroup already limits memory to (\d+)M/;

test("cgroup v1: the memory limit along the path is inherited, so no new scope is made", OPTS, () => {
  const env = fakeCgroup(
    { "memory/a/memory.limit_in_bytes": "67108864\n", "memory/a/b/memory.limit_in_bytes": `${UNLIMITED_V1}\n` },
    "4:cpu,cpuacct:/x\n3:memory:/a/b\n",
  );
  const r = run(["--mem", "2G", "--", "true"], env);
  assert.equal(r.rc, 0);
  assert.equal(r.err.match(ENCLOSING)?.[1], "64", "the tighter ancestor limit wins over the unlimited leaf");
});

test("cgroup v1: a controller list that includes memory is read, and the minimum along the path is taken", OPTS, () => {
  const env = fakeCgroup({ "memory/a/memory.limit_in_bytes": "134217728\n", "memory/a/b/memory.limit_in_bytes": "33554432\n" }, "2:cpu,memory,pids:/a/b\n");
  assert.equal(run(["--mem", "2G", "--", "true"], env).err.match(ENCLOSING)?.[1], "32");
});

test("cgroup v1 negative controls: no inherited limit when unlimited, above the requested cap, or on another controller", OPTS, () => {
  const unlimited = fakeCgroup({ "memory/a/memory.limit_in_bytes": `${UNLIMITED_V1}\n` }, "3:memory:/a\n");
  assert.doesNotMatch(run(["--mem", "2G", "--", "true"], unlimited).err, /enclosing cgroup/);
  const roomy = fakeCgroup({ "memory/a/memory.limit_in_bytes": "4294967296\n" }, "3:memory:/a\n");
  assert.doesNotMatch(run(["--mem", "2G", "--", "true"], roomy).err, /enclosing cgroup/, "a 4G outer limit does not stand in for a 2G request");
  const other = fakeCgroup({ "memory/a/memory.limit_in_bytes": "67108864\n" }, "3:cpu:/a\n");
  assert.doesNotMatch(run(["--mem", "2G", "--", "true"], other).err, /enclosing cgroup/, "only the memory controller line counts");
});

test("cgroup v2 via the fake hierarchy still wins when both are present", OPTS, () => {
  const env = fakeCgroup({ "u/memory.max": "67108864\n", "memory/a/memory.limit_in_bytes": "134217728\n" }, "3:memory:/a\n0::/u\n");
  assert.equal(run(["--mem", "2G", "--", "true"], env).err.match(ENCLOSING)?.[1], "64");
});

test("a missing /proc/self/cgroup (macOS) is no inherited limit and prints no error", OPTS, () => {
  const env = { POMTREE_CGROUP_ROOT: tmp("cgroup"), POMTREE_CGROUP_PROC: join(tmp("cgroup-proc"), "absent") };
  const r = run(["--mem", "2G", "--", "true"], env);
  assert.equal(r.rc, 0);
  assert.doesNotMatch(r.err, /No such file|enclosing cgroup/);
});

test("POMTREE_RUN_UNCAPPED=1 runs the command and prints a notice", OPTS, () => {
  const r = run(["--timeout", "1s", "--", "bash", "-c", "sleep 2; exit 3"], { POMTREE_RUN_UNCAPPED: "1" });
  assert.equal(r.rc, 3, "no time limit applies");
  assert.match(r.err, /NOTICE POMTREE_RUN_UNCAPPED=1/);
});

test("bad input is refused with a cause and an action, never run uncapped", OPTS, () => {
  const marker = join(tmp("capped"), "ran");
  for (const args of [["--mem", "lots", "--", "touch", marker], ["--timeout", "0s", "--", "touch", marker], ["touch", marker], ["--"]]) {
    const r = run(args);
    assert.equal(r.rc, 2, args.join(" "));
    assert.match(r.err, /run-capped: /);
  }
  assert.equal(spawnSync("test", ["-e", marker]).status, 1, "the command must not have run");
});
