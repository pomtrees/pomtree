// CRD-2 (S1, key-leak grep): the upstream model key appears nowhere an agent or an operator could read it: not in
// the agent container's or its egress sidecar's environment, logs or filesystem while the agent runs, and not in pomtreed's log, the raw trace
// or any file under the state directory afterwards. The real pomtreed and agent image with FakeModelUpstream; the stack writes the upstream
// key "stub-upstream-key-not-real" to its 0600 key file, and that string is the pattern. Only counts are reported, never values, and the
// scans stream (nothing is written to disk). Each scan has a negative control that proves it can find the string.
// Docker-gated like cli-scenarios.test.ts (cliScenarioSkip); the scanner's own unit tests run everywhere.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, type Stats, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { describeCall, type ModelScript } from "@pomtree/testing";
import { gateCommand } from "../../sandbox-docker/src/docker-gate.ts";
import { docker, freePort, showAgent } from "./cli-crash.ts";
import { type AgentJson, agentErrorDump, bash, cliScenarioSkip, image, MODEL, PROVIDER, type Stack, startStack } from "./cli-scenarios-harness.ts";

const SKIP = cliScenarioSkip();
const KEY = "stub-upstream-key-not-real"; // written by startStack to <root>/upstream.key, outside the state dir
const BIG = { input: 100, output: 10 };

// Counts non-overlapping occurrences of a needle across chunk boundaries. Holds back needle.length-1 bytes, which cannot contain a whole needle.
class Counter {
  count = 0;
  bytes = 0;
  private tail: Buffer = Buffer.alloc(0);
  private readonly needle: Buffer;
  constructor(needle: Buffer) {
    this.needle = needle;
  }
  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    const buf = Buffer.concat([this.tail, chunk]);
    for (let i = buf.indexOf(this.needle); i !== -1; i = buf.indexOf(this.needle, i + this.needle.length)) this.count++;
    this.tail = buf.subarray(Math.max(0, buf.length - (this.needle.length - 1)));
  }
}
const counter = () => new Counter(Buffer.from(KEY));

interface Scan {
  count: number;
  bytes: number;
}

// Runs `cmd args`, feeding its stdout (and stderr when `both`) to a Counter; fails on a nonzero exit so a failed command is not a clean scan.
function scanCommand(args: string[], both = false): Promise<Scan> {
  return new Promise((resolve, reject) => {
    const c = counter();
    const g = gateCommand(args, { stdio: ["ignore", "pipe", both ? "pipe" : "ignore"] as ("ignore" | "pipe")[] });
    const p = spawn(g.file, g.args, g.options);
    p.stdout?.on("data", (b: Buffer) => c.push(b));
    if (both) p.stderr?.on("data", (b: Buffer) => c.push(b));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve({ count: c.count, bytes: c.bytes }) : reject(new Error(`${g.file} ${args[0]} exited ${code}`))));
  });
}

// `docker export <ctr> | tar -xO`, streamed.
function scanExport(container: string): Promise<Scan> {
  return new Promise((resolve, reject) => {
    const c = counter();
    const g = gateCommand(["export", container], { stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] });
    const exp = spawn(g.file, g.args, g.options);
    const tar = spawn("tar", ["-xO"], { stdio: ["pipe", "pipe", "ignore"] });
    exp.stdout.pipe(tar.stdin);
    tar.stdin.on("error", () => {}); // tar may close early on a corrupt member; the exit codes decide
    tar.stdout.on("data", (b: Buffer) => c.push(b));
    exp.on("error", reject);
    tar.on("error", reject);
    let expCode: number | null = null;
    exp.on("close", (code) => {
      expCode = code;
    });
    tar.on("close", () =>
      expCode === 0 || expCode === null ? resolve({ count: c.count, bytes: c.bytes }) : reject(new Error(`${g.file} export exited ${expCode}`)),
    );
  });
}

const scanInspect = (container: string) => scanCommand(["inspect", container, "--format", "{{json .Config.Env}}"]);
const scanLogs = (container: string) => scanCommand(["logs", container], true);

async function scanFile(path: string): Promise<Scan> {
  const c = counter();
  for await (const chunk of createReadStream(path)) c.push(chunk as Buffer);
  return { count: c.count, bytes: c.bytes };
}

type TreeOps = { readdir: (d: string) => string[]; lstat: (p: string) => Stats; scan: (p: string) => Promise<Scan> };
const realOps: TreeOps = { readdir: (d) => readdirSync(d), lstat: (p) => lstatSync(p), scan: scanFile };
const vanished = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";

// Every regular file under `dir` (sockets and other special files cannot be read), nothing excluded. `files` counts files with a match.
// The walk is over a live tree the daemon may still be changing (workspace folders are evicted or rewritten), so an entry can legitimately
// disappear between being listed and being read. Such an entry is skipped: a vanished file no longer holds anything at rest. Every other
// error, and a missing `dir` itself, still throws. The walk is not a snapshot: content written after its directory was listed (for example a file renamed into place mid-walk) is not seen, a limit the walk had before this change too.
// Skipped entries are reported as a diagnostic (reportVanished); the EACCES cases below keep the other errors throwing.
// Suspected writer (code reading, not yet observed): the daemon evicts a reaped agent's workspace on the next cleanup tick, because the harness keeps the defaults folder.reapedGraceMs = 0 and cleanup.sweepMs = 60 s.
// Proposed fix: set a large folder.reapedGraceMs in the harness stack so the workspace stays until teardown, then assert nothing vanished and keep this tolerance only as a backstop. See issue #531.
async function scanTree(dir: string, ops: TreeOps = realOps): Promise<Scan & { files: number; withMatch: string[]; vanished: string[] }> {
  let count = 0;
  let bytes = 0;
  let files = 0;
  const withMatch: string[] = [];
  const vanishedPaths: string[] = [];
  const walk = async (d: string, root: boolean): Promise<void> => {
    let names: string[];
    try {
      names = ops.readdir(d);
    } catch (e) {
      if (root || !vanished(e)) throw e;
      vanishedPaths.push(d.slice(dir.length));
      return;
    }
    for (const e of names) {
      const p = join(d, e);
      let st: Stats;
      try {
        st = ops.lstat(p);
      } catch (err) {
        if (!vanished(err)) throw err;
        vanishedPaths.push(p.slice(dir.length));
        continue;
      }
      if (st.isDirectory()) await walk(p, false);
      else if (st.isFile()) {
        let r: Scan;
        try {
          r = await ops.scan(p);
        } catch (err) {
          if (!vanished(err)) throw err;
          vanishedPaths.push(p.slice(dir.length));
          continue;
        }
        files++;
        count += r.count;
        bytes += r.bytes;
        if (r.count > 0) withMatch.push(p.slice(dir.length));
      }
    }
  };
  await walk(dir, true);
  return { count, bytes, files, withMatch, vanished: vanishedPaths };
}

test("credentials scanner: counts across chunk boundaries, finds nothing in clean data", () => {
  const c = counter();
  c.push(Buffer.from(`xx ${KEY.slice(0, 10)}`));
  c.push(Buffer.from(`${KEY.slice(10)} yy ${KEY}`));
  assert.equal(c.count, 2);
  const clean = counter();
  clean.push(Buffer.from(KEY.slice(0, -1)));
  clean.push(Buffer.from("x"));
  assert.equal(clean.count, 0);
  assert.equal(clean.bytes, KEY.length);
});

// A skipped entry is not a failure, but it is surfaced so a scan that skipped a lot is visible in the run output.
function reportVanished(t: TestContext, vanishedPaths: string[]): void {
  if (vanishedPaths.length > 0) t.diagnostic(`state-dir scan skipped ${vanishedPaths.length} entries that vanished mid-walk: ${vanishedPaths.join(", ")}`);
}

test("credentials scanner: a tree walk tolerates entries that vanish mid-walk but still throws on other errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "crd2-walk-"));
  try {
    mkdirSync(join(root, "gone-dir"));
    writeFileSync(join(root, "gone-dir", "x"), "x");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "keep.txt"), `${KEY}\n`);
    writeFileSync(join(root, "gone-lstat"), "x");
    writeFileSync(join(root, "gone-read"), "x");
    writeFileSync(join(root, "plain.txt"), "clean");
    const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, ${p}`), { code: "ENOENT" });
    // Each doomed entry is listed, then removed before it is read.
    const racing: TreeOps = {
      readdir: (d) => {
        const names = readdirSync(d);
        if (d === root) {
          rmSync(join(root, "gone-lstat"));
          rmSync(join(root, "gone-dir"), { recursive: true });
        }
        return names;
      },
      lstat: lstatSync,
      scan: async (p) => {
        if (p.endsWith("gone-read")) rmSync(p);
        return scanFile(p);
      },
    };
    const t = await scanTree(root, racing);
    assert.deepEqual(t.withMatch, ["/sub/keep.txt"], "the planted key in a surviving file is still found");
    assert.equal(t.count, 1);
    assert.equal(t.files, 2, "only plain.txt and sub/keep.txt remain");
    assert.deepEqual([...t.vanished].sort(), ["/gone-dir", "/gone-lstat", "/gone-read"], "every skipped entry is reported");
    // Non-ENOENT errors are real failures, wherever they occur.
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    await assert.rejects(
      scanTree(root, {
        ...realOps,
        lstat: () => {
          throw eacces;
        },
      }),
      /EACCES/,
    );
    await assert.rejects(
      scanTree(root, {
        ...realOps,
        scan: async () => {
          throw eacces;
        },
      }),
      /EACCES/,
    );
    await assert.rejects(
      scanTree(root, {
        ...realOps,
        readdir: (d) => {
          if (d !== root) throw eacces;
          return readdirSync(d);
        },
      }),
      /EACCES/,
    );
    // The root itself must exist, and a subdirectory listing that fails with ENOENT is skipped.
    await assert.rejects(scanTree(join(root, "absent")), /ENOENT/);
    const t2 = await scanTree(root, {
      ...realOps,
      readdir: (d) => {
        if (d === join(root, "sub")) throw enoent(d);
        return readdirSync(d);
      },
    });
    assert.deepEqual(t2.withMatch, []);
    assert.deepEqual(t2.vanished, ["/sub"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function withStack(o: Parameters<typeof startStack>[0], fn: (s: Stack) => Promise<void>): Promise<void> {
  const s = await startStack({ ...o, set: { "model.proxy.port": String(await freePort()), ...o.set } });
  try {
    await fn(s);
  } catch (e) {
    const calls = s.stub.calls.map(describeCall);
    const errors = await agentErrorDump(s);
    throw new Error(
      `${(e as Error).message}\n--- agent errors\n${errors}\n--- fake model calls\n${calls.join("\n")}\n--- pomtreed log tail\n${s.pomtreedLog().slice(-4000)}`,
      { cause: e },
    );
  } finally {
    await s.close();
  }
}

// Negative controls for the Docker scans: a throwaway container that carries the string in its env, its output and its filesystem.
// It is not labelled as a framework container. Runs the agent image the suite is gated on, with --pull never (this test never pulls).
async function dockerControl(): Promise<{ inspect: Scan; logs: Scan; exp: Scan }> {
  const name = `crd2-control-${process.pid}-${Date.now()}`;

  try {
    await docker([
      "run",
      "-d",
      "--pull",
      "never",
      "--name",
      name,
      "-e",
      `CANARY=${KEY}`,
      "--entrypoint",
      "sh",
      image!,
      "-c",
      'echo "$CANARY"; echo "$CANARY" > /tmp/canary; sleep 30',
    ]);
    for (let i = 0; i < 20; i++) {
      if ((await docker(["exec", name, "test", "-f", "/tmp/canary"]).catch(() => "no")) !== "no") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return { inspect: await scanInspect(name), logs: await scanLogs(name), exp: await scanExport(name) };
  } finally {
    await docker(["rm", "-f", name]).catch(() => {});
  }
}

test("cli credentials CRD-2: no upstream key bytes in the agent or sidecar container, pomtreed log, trace or state dir; every scan can find the string", {
  skip: SKIP,
  timeout: 280_000,
}, async (t) => {
  // The agent holds until the test releases it (touch /tmp/go), so every container scan happens while it runs.
  const script: ModelScript = {
    name: "crd2",
    rules: [
      {
        id: "hold",
        when: { toolResults: 0 },
        reply: { kind: "tool_calls", calls: [bash("i=0; while [ ! -f /tmp/go ] && [ $i -lt 200 ]; do sleep 1; i=$((i+1)); done; echo released")], usage: BIG },
      },
      { id: "result", when: { toolResults: 1 }, reply: { kind: "tool_calls", calls: [bash("pomtree result --summary 'no key here'")], usage: BIG } },
      { id: "done", when: { toolResults: 2 }, reply: { kind: "text", text: "STUB-DONE", usage: BIG } },
    ],
  };
  await withStack({ script }, async (s) => {
    const r = await s.pomtree(["spawn", "--task", "[[scn:crd2]] hold", "--name", "holder", "--budget", "500000", "--model", `${PROVIDER}/${MODEL}`]);
    assert.equal(r.code, 0, `spawn: exit ${r.code}: ${r.err} stdout: ${r.out}`);
    const a = r.json<AgentJson>();
    await s.until(
      "the agent running with a settled call",
      async () => {
        const cur = await showAgent(s, a.id);
        return cur.state === "running" && !!cur.sandbox && (await s.settlements(a.id)).length >= 1;
      },
      150_000,
    );
    // The settled call proves the proxy reached the stub; every call it recorded must have carried the upstream key (never recorded itself).
    assert.ok(s.stub.calls.length >= 1, "the stub recorded no call");
    assert.deepEqual(
      s.stub.calls.map((c) => c.keyMatched),
      s.stub.calls.map(() => true),
      "every upstream call must carry the upstream key: the proxy must present it (startStack passes it as expectKey)",
    );
    const sandbox = (await showAgent(s, a.id)).sandbox!;
    const containers = { agent: `pomtree-${sandbox}`, sidecar: `pomtree-egress-proxy-${sandbox}` };
    const keyFile = readFileSync(join(s.stateDir, "..", "upstream.key"), "utf8").trim();
    assert.equal(keyFile, KEY, "the scan pattern must be the key the stack really uses (cli-scenarios-harness.ts startStack)");
    assert.equal(
      readdirSync(s.stateDir).includes("upstream.key"),
      false,
      "the key file must live outside the state dir, or the tree scan would find the file itself",
    );

    // Negative controls first: each scan finds the string where it is known to be.
    const ctl = await dockerControl();
    assert.ok(ctl.inspect.count >= 1, "control: the inspect scan must find the string in a container's env");
    assert.ok(ctl.logs.count >= 1, "control: the logs scan must find the string in a container's output");
    assert.ok(ctl.exp.count >= 1, "control: the export scan must find the string in a container's filesystem");
    const scratch = mkdtempSync(join(tmpdir(), "crd2-scratch-"));
    try {
      const planted = join(s.stateDir, "crd2-planted.txt");
      writeFileSync(planted, `${KEY}\n`);
      const withPlant = await scanTree(s.stateDir);
      reportVanished(t, withPlant.vanished);
      rmSync(planted);
      assert.deepEqual(withPlant.withMatch, ["/crd2-planted.txt"], "control: the state-dir scan must find a planted file and only that one");
      const clean = await scanTree(s.stateDir);
      reportVanished(t, clean.vanished);
      assert.ok(clean.withMatch.length === 0, "the planted file must be gone before the real scan");
      const planted2 = join(scratch, "t.md");
      writeFileSync(planted2, `trace ${KEY}\n`);
      assert.equal((await scanFile(planted2)).count, 1, "control: the file scan must find the string");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    // While the agent runs: its container and its egress sidecar, each three ways. Counts and scanned sizes only.
    const during: Record<string, Scan> = {};
    for (const [who, name] of Object.entries(containers)) {
      during[`${who} env`] = await scanInspect(name);
      during[`${who} logs`] = await scanLogs(name);
      during[`${who} fs`] = await scanExport(name);
    }
    for (const [what, scan] of Object.entries(during)) {
      assert.ok(scan.bytes > 0, `${what}: the scan read no bytes, so it proves nothing`);
      assert.equal(scan.count, 0, `${what}: the upstream key appears ${scan.count} time(s); stop and tell the coordinator without sharing the evidence`);
    }
    assert.ok(during["agent fs"]!.bytes > 1_000_000 && during["sidecar fs"]!.bytes > 1_000_000, "the export scans must have read a real filesystem");

    // Release the agent, let it finish, then the daemon-side artifacts.
    await docker(["exec", containers.agent, "touch", "/tmp/go"]);
    const w = await s.waitExited(a.id, 120_000);
    assert.equal(w.code, 0, `wait: exit ${w.code} ${w.out} ${w.err}`);
    assert.equal(w.json<{ record: AgentJson }>().record.exit, "succeeded");

    const traceDir = mkdtempSync(join(tmpdir(), "crd2-trace-"));
    try {
      const out = join(traceDir, "t.md");
      const tr = await s.pomtree(["trace", a.id, "--raw", "--out", out]);
      assert.equal(tr.code, 0, `trace --raw: exit ${tr.code}: ${tr.err}`);
      const trace = await scanFile(out);
      assert.ok(trace.bytes > 0, "the trace was empty");
      assert.equal(trace.count, 0, `the raw trace contains the upstream key ${trace.count} time(s)`);
    } finally {
      rmSync(traceDir, { recursive: true, force: true });
    }
    const log = counter();
    log.push(Buffer.from(s.pomtreedLog()));
    assert.ok(log.bytes > 0, "the pomtreed log was empty");
    assert.equal(log.count, 0, `pomtreed's log contains the upstream key ${log.count} time(s)`);
    const tree = await scanTree(s.stateDir);
    reportVanished(t, tree.vanished);
    assert.ok(tree.files > 0 && tree.bytes > 0, "the state dir scan read nothing");
    assert.equal(tree.count, 0, `the state dir has the upstream key in ${tree.withMatch.length} file(s) (${tree.count} matches): ${tree.withMatch.join(", ")}`);
    assert.deepEqual(s.stub.unmatched, []);
  });
});
