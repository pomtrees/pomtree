import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { until as untilShared } from "@pomtree/testing";
import * as J from "../ext/pomtree-jobs/jobs.ts";

const WRAP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "pomtree-job-run");
const until = (f: () => boolean, ms = 15000) => untilShared(f, ms, { what: "jobs test condition", intervalMs: 50 });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The wrapper needs util-linux `setsid` and GNU `timeout` (both absent on stock macOS); it runs inside the Linux agent container.
const wrapperSkip: string | false = (() => {
  for (const tool of ["setsid", "timeout"]) {
    try {
      execFileSync(tool, ["--version"], { stdio: "ignore" });
    } catch {
      return `wrapper needs util-linux setsid and GNU timeout (${tool} not on PATH; Linux container only)`;
    }
  }
  return false;
})();

// TODO(jobs-helper-linux-only): the wrapper tests skip without setsid or timeout (stock macOS); current behavior: that skip is unverified on a real Mac and the wrapper itself is unproven there.
function launch(cmdOf: string | ((dir: string) => string), t = 30) {
  const dir = mkdtempSync(join(tmpdir(), "job-"));
  const cmd = typeof cmdOf === "string" ? cmdOf : cmdOf(dir);
  const pid = Number(execFileSync(WRAP, [dir, String(t), cmd], { encoding: "utf8" }).trim());
  return { dir, pid, exit: () => (existsSync(join(dir, "exit")) ? J.parseExit(readFileSync(join(dir, "exit"), "utf8")) : undefined) };
}

test("validateStart: timeout required, capped, live-job limit, name sanitized", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(J.validateStart({ cmd: "x" }, 0, {}, now).ok, false);
  assert.equal(J.validateStart({ cmd: "x", timeout_s: -1 }, 0, {}, now).ok, false);
  assert.equal(J.validateStart({ cmd: "", timeout_s: 5 }, 0, {}, now).ok, false);
  assert.equal(J.validateStart({ cmd: "x", timeout_s: 5 }, 8, {}, now).ok, false);
  assert.deepEqual((J.validateStart({ cmd: "x", timeout_s: 99999 }, 0, {}, now) as any).timeoutS, 14400);
  assert.equal((J.validateStart({ cmd: "x", timeout_s: 99999 }, 0, { POMTREE_AGENT_DEADLINE_AT: "2026-01-01T00:10:00Z" }, now) as any).timeoutS, 600);
  assert.equal(J.sanitizeName("a b/../c", "z"), "a-b----c");
  assert.equal(J.sanitizeName("", "z"), "z");
  assert.equal(J.sanitizeName("x".repeat(80), "z").length, 40);
  assert.match(J.newId(), /^[0-9a-f]{6}$/);
});

test("deriveStatus: running, exited, timeout, killed, lost", () => {
  const m = JSON.stringify({ id: "abc123", name: "n", cmd: "c", startedAt: "t", timeoutS: 5 });
  assert.equal(J.deriveStatus("abc123", { meta: m, pid: "42\n" }, () => true).state, "running");
  assert.equal(J.deriveStatus("abc123", { meta: m, pid: "42" }, () => false).state, "lost");
  assert.equal(J.deriveStatus("abc123", {}, () => false).state, "lost");
  assert.equal(J.deriveStatus("abc123", { pid: "42", exit: "code=0\nsignal=\nendedAt=x\n" }, () => false).state, "exited");
  assert.equal(J.deriveStatus("abc123", { pid: "42", exit: "code=124\nsignal=TIMEOUT\nendedAt=x\n" }, () => false).state, "timeout");
  assert.equal(J.deriveStatus("abc123", { pid: "42", exit: "code=143\nsignal=KILLED\nendedAt=x\n" }, () => true).state, "killed");
  assert.equal(J.deriveStatus("abc123", { pid: "42", exit: "code=" }, () => false).state, "lost"); // garbled exit
  assert.match(J.formatStatus(J.deriveStatus("abc123", { meta: m }, () => false)), /lost \(container restarted/);
});

test("tailText strips ANSI, caps lines and bytes", () => {
  assert.equal(J.tailText("\u001b[31mred\u001b[0m\nb\n", 5), "red\nb");
  assert.equal(J.tailText(Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n"), 9999).split("\n").length, 200);
  assert.ok(Buffer.byteLength(J.tailText("x".repeat(100000), 5)) < 33000);
});

test("startCommand quotes and ignores the job dir in git", () => {
  const c = J.startCommand({ id: "abc123", name: "n", cmd: "echo 'hi'", startedAt: "t", timeoutS: 9 }, "/w/.jobs");
  assert.match(c, /pomtree-job-run '\/w\/\.jobs\/abc123' 9 'echo '\\''hi'\\'''/);
  assert.match(c, /\.gitignore/);
});

test("waitFor: done, timeout, aborted before/during; listener removed", async () => {
  assert.equal(await J.waitFor(() => true, 1000), "done");
  assert.equal(await J.waitFor(() => false, 60), "timeout");
  const ac = new AbortController();
  ac.abort();
  assert.equal(await J.waitFor(() => false, 5000, ac.signal), "interrupted");
  const ac2 = new AbortController();
  let added = 0,
    removed = 0;
  const sig = {
    get aborted() {
      return ac2.signal.aborted;
    },
    addEventListener: (t: "abort", f: () => void, o?: { once: boolean }) => {
      added++;
      ac2.signal.addEventListener(t, f, o);
    },
    removeEventListener: (t: "abort", f: () => void) => {
      removed++;
      ac2.signal.removeEventListener(t, f);
    },
  };
  const t0 = Date.now();
  const p = J.waitFor(() => false, 20000, sig);
  setTimeout(() => ac2.abort(), 50);
  assert.equal(await p, "interrupted");
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual([added, removed], [1, 1]);
  assert.equal(J.clampWaitMs(10 ** 9), J.MAX_WAIT_MS);
});

test("wrapper: success, output capture, exit file", { skip: wrapperSkip }, async () => {
  const j = launch("echo hello; echo err >&2");
  await until(() => !!j.exit());
  assert.deepEqual({ ...j.exit()!, endedAt: "" }, { code: 0, signal: "", endedAt: "" });
  assert.match(readFileSync(join(j.dir, "out.log"), "utf8"), /hello\nerr|err\nhello/);
  assert.equal(existsSync(join(j.dir, "exit.tmp")), false);
  rmSync(j.dir, { recursive: true });
});

test("wrapper: nonzero exit code", { skip: wrapperSkip }, async () => {
  const j = launch("exit 7");
  await until(() => !!j.exit());
  assert.equal(j.exit()!.code, 7);
  rmSync(j.dir, { recursive: true });
});

test("wrapper: timeout kills the whole process group", { skip: wrapperSkip }, async () => {
  const j = launch((d) => `sleep 60 & echo $! > ${d}/child; wait`, 1);
  await until(() => !!j.exit(), 20000);
  assert.equal(j.exit()!.signal, "TIMEOUT");
  assert.equal(j.exit()!.code, 124);
  const child = Number(readFileSync(join(j.dir, "child"), "utf8"));
  await until(() => !alive(child));
  rmSync(j.dir, { recursive: true });
});

test("wrapper: TERM to the job group (job_kill) kills it and records KILLED", { skip: wrapperSkip }, async () => {
  const j = launch((d) => `sleep 60 & echo $! > ${d}/child; wait`);
  await until(() => existsSync(join(j.dir, "child")));
  process.kill(-j.pid, "SIGTERM");
  await until(() => !!j.exit(), 20000);
  assert.equal(j.exit()!.signal, "KILLED");
  await until(() => !alive(Number(readFileSync(join(j.dir, "child"), "utf8"))));
  rmSync(j.dir, { recursive: true });
});

test("wrapper: job survives its launching parent being killed", { skip: wrapperSkip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-"));
  writeFileSync(join(dir, "go.sh"), `#!/bin/sh\n${WRAP} ${dir} 30 'sleep 1; echo done' &\nsleep 30\n`, { mode: 0o755 });
  const parent = spawn(join(dir, "go.sh"), { detached: true, stdio: "ignore" });
  await until(() => existsSync(join(dir, "pid")));
  process.kill(-parent.pid!, "SIGKILL"); // Pi bash-timeout style group kill
  await until(() => existsSync(join(dir, "exit")), 20000);
  assert.equal(J.parseExit(readFileSync(join(dir, "exit"), "utf8"))!.code, 0);
  assert.match(readFileSync(join(dir, "out.log"), "utf8"), /done/);
  rmSync(dir, { recursive: true });
});
