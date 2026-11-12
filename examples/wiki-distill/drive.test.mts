import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Offline: drive.sh runs against fake-pomtree.sh; nothing real is spawned, fetched or spent.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const DRIVE = process.env.WIKI_DISTILL_DRIVE_SH ?? join(HERE, "drive.sh");
const FAKE = join(HERE, "fake-pomtree.sh");

const READER_MICROS = 400000;
const RUN = "tst1";

type Run = { status: number | null; stdout: string; stderr: string; calls: string[][]; tasks: string };
let dir = "";
let budgets = "";
let seq = 0;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "wiki-distill-drive-"));
  budgets = join(dir, "budgets.env");
  copyFileSync(join(HERE, "budgets.env"), budgets);
});
after(() => rmSync(dir, { recursive: true, force: true }));

function drive(args: string[], env: Record<string, string> = {}): Run {
  const log = join(dir, `calls-${seq++}.log`);
  const tasksFile = `${log}.tasks`;
  writeFileSync(log, "");
  const r = spawnSync("bash", [DRIVE, ...args], {
    encoding: "utf8",
    timeout: 50000,
    env: {
      PATH: process.env.PATH ?? "",
      WIKI_DISTILL_CLI: `bash ${FAKE}`,
      FAKE_LOG: log,
      FAKE_TASKS: tasksFile,
      DRIVE_POLL_S: "0",
      WIKI_DISTILL_BUDGETS: budgets,
      ...env,
    },
  });
  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split(" | "));
  let tasks = "";
  try {
    tasks = readFileSync(tasksFile, "utf8");
  } catch {
    // no spawn happened
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, tasks };
}

const isSpawn = (c: string[]) => c[0] === "spawn";
const isUi = (c: string[], ...words: string[]) => c[0] === "ui" && words.every((w, i) => c[i + 1] === w);
const flagOf = (c: string[], f: string) => c[c.indexOf(f) + 1];

// Pure sequence check over a call log; returns the violated rules (empty = well formed).
function sequenceViolations(calls: string[][]): string[] {
  const bad: string[] = [];
  const spawns = (t: string) => calls.map((c, i) => (isSpawn(c) && c[c.indexOf("--template") + 1] === t ? i : -1)).filter((i) => i >= 0);
  const readers = spawns("wiki-reader");
  const orch = spawns("wiki-orchestrator")[0] ?? -1;
  const first = readers[0] ?? -1;
  const last = readers[readers.length - 1] ?? -1;
  if (!(calls[0] && isUi(calls[0], "reset"))) bad.push("first call is not ui reset");
  const followOn = calls.findIndex((c) => isUi(c, "follow", "on") && c.includes("terminal,browser"));
  if (followOn < 0 || first < 0 || followOn > first) bad.push("follow on terminal,browser must precede the first reader spawn");
  const followOff = calls.findIndex((c, i) => i > last && isUi(c, "follow", "off"));
  const arrange = calls.findIndex((c, i) => i > last && isUi(c, "arrange", "grid"));
  if (followOff < 0 || arrange < 0 || !(last < followOff && followOff < arrange && arrange < orch))
    bad.push("follow off, arrange grid must follow the last reader spawn and precede the orchestrator spawn");
  if (
    !calls.some(
      (c, i) =>
        i > orch && orch >= 0 && isUi(c, "follow", "on") && c.includes("--of") && flagOf(c, "--of") !== undefined && flagOf(c, "--views") === "terminal",
    )
  ) {
    bad.push("follow on --views terminal --of <orchestrator> must follow the orchestrator spawn");
  }
  return bad;
}

describe("drive.sh pipeline", () => {
  let r: Run;
  before(() => {
    r = drive(["--title", "Byzantine Empire", "--yes", "--run-id", RUN]);
  });

  it("exits 0 and prints the report commands", () => {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /pomtree ui open report ag-[0-9a-f]+ [0-9a-f]{64}/);
    assert.match(r.stdout, /pomtree spend/);
    assert.match(r.stdout, /pomtree tree/);
    assert.match(r.stdout, /pomtree report rm ag-/);
  });

  it("probes with ui reset first and follows the choreography order", () => {
    assert.deepEqual(sequenceViolations(r.calls), []);
    assert.ok(isUi(r.calls[0] ?? [], "reset"));
  });

  it("spawns each reader with the template, budget, and distinct run-stamped key and name", () => {
    const spawns = r.calls.filter((c) => isSpawn(c) && flagOf(c, "--template") === "wiki-reader");
    assert.equal(spawns.length, 4);
    for (const c of spawns) assert.equal(flagOf(c, "--budget"), String(READER_MICROS));
    assert.equal(new Set(spawns.map((c) => flagOf(c, "--key"))).size, 4);
    assert.equal(new Set(spawns.map((c) => flagOf(c, "--name"))).size, 4);
    for (const c of spawns) assert.match(flagOf(c, "--key") ?? "", new RegExp(`^wd-${RUN}-reader-[1-4]$`));
  });

  it("gives every ui and spawn call a key derived from the run", () => {
    for (const c of r.calls.filter((c) => c[0] === "ui" || isSpawn(c))) assert.match(flagOf(c, "--key") ?? "", new RegExp(`^wd-${RUN}-[a-z0-9-]+$`));
  });

  it("puts every reader's NOTES block in the orchestrator task in the contract format", () => {
    const orch = /### SPAWN wiki-orchestrator (ag-[0-9a-f]+)\n([\s\S]*?)\n### END SPAWN/.exec(r.tasks);
    assert.ok(orch, "orchestrator task logged");
    const task = orch[2] ?? "";
    assert.match(task, /^RUN: tst1\nARTICLE: Byzantine Empire\nSOURCE_URL: https:\/\/en\.wikipedia\.org\/wiki\/Byzantine_Empire\nBLOCKS: 4\n/);
    for (let i = 1; i <= 4; i++)
      assert.ok(task.includes(`=== BLOCK ${i} ===\n=== NOTES ${i - 1} ===\n`) && task.includes(`=== END BLOCK ${i} ===`), `block ${i}`);
    const orchId = orch[1] ?? "";
    assert.ok(r.calls.some((c) => isUi(c, "follow", "on") && c.includes("--of") && flagOf(c, "--of") === orchId && flagOf(c, "--views") === "terminal"));
    assert.ok(r.calls.some((c) => isUi(c, "focus", "terminal", orchId)));
  });

  it("gives the distiller the briefs, SOURCE_URL and REPORT_KEY, then opens the report", () => {
    const m = /### SPAWN wiki-distiller (ag-[0-9a-f]+)\n([\s\S]*?)\n### END SPAWN/.exec(r.tasks);
    assert.ok(m, "distiller task logged");
    const task = m[2] ?? "";
    assert.match(task, /SOURCE_URL: https:\/\/en\.wikipedia\.org\/wiki\/Byzantine_Empire/);
    assert.match(task, /REPORT_KEY: wd-tst1-distillation/);
    for (let i = 1; i <= 4; i++) assert.ok(task.includes(`=== BRIEF ${i} ===`) && task.includes(`=== END BRIEF ${i} ===`), `brief ${i}`);
    const last = r.calls[r.calls.length - 2] ?? [];
    assert.deepEqual(last.slice(0, 4), ["ui", "open", "report", m[1]]);
    assert.match(last[4] ?? "", /^[0-9a-f]{64}$/);
  });

  it("never logs a token-looking string", () => {
    const text = r.calls.map((c) => c.join(" | ")).join("\n") + r.stdout + r.stderr;
    const stripped = text.replace(/\b[0-9a-f]{64}\b/g, "REPORTID");
    assert.doesNotMatch(stripped, /bearer|operator\.token|POMTREE_TOKEN|sk-[A-Za-z0-9]{8,}|[A-Za-z0-9+/]{40,}={0,2}/i);
  });

  it("prints commands with task text capped at 80 characters", () => {
    const line = r.stdout.split("\n").find((l) => l.startsWith("+ pomtree spawn --template wiki-orchestrator")) ?? "";
    assert.ok(line.includes("--task 'RUN: tst1 ARTICLE: Byzantine Empire SOURCE_URL"));
    assert.ok(!line.includes("BRIEF") && !line.includes("NOTES"));
  });

  it("prints a ceiling of 4*400000+600000+300000", () => {
    assert.ok(r.stdout.includes(`ceiling: ${4 * 400000 + 600000 + 300000} micros`));
    assert.ok(r.stdout.includes("POMTREED_BUDGET_ROOT_MICROS=2600000"));
    assert.ok(r.stdout.includes("POMTREED_BUDGET_TOP_LEVEL_MICROS=2600000"));
  });
});

describe("drive.sh sequence helper", () => {
  it("rejects a log with arrange moved before the reader spawns (negative control)", () => {
    const ok = drive(["--title", "T", "--yes", "--run-id", RUN]).calls;
    assert.deepEqual(sequenceViolations(ok), []);
    const arrange = ok.findIndex((c) => isUi(c, "arrange", "grid"));
    const moved = [...ok];
    const [a] = moved.splice(arrange, 1);
    moved.splice(1, 0, a as string[]);
    assert.notDeepEqual(sequenceViolations(moved), []);
    const noProbe = ok.slice(1);
    assert.notDeepEqual(sequenceViolations(noProbe), []);
  });
});

describe("drive.sh guards and failures", () => {
  it("without --yes prints the plan and exits 2 with no calls", () => {
    const r = drive(["--title", "T", "--run-id", RUN]);
    assert.equal(r.status, 2);
    assert.equal(r.calls.length, 0);
    assert.match(r.stdout, /ceiling: 2500000/);
    assert.match(r.stderr, /--yes/);
  });

  it("FAKE_TABS=0 aborts before any spawn naming the fix", () => {
    const r = drive(["--title", "T", "--yes", "--run-id", RUN], { FAKE_TABS: "0" });
    assert.equal(r.status, 1);
    assert.equal(r.calls.filter(isSpawn).length, 0);
    assert.match(r.stderr, /open \/ui in the browser, then rerun/);
  });

  it("notes several tabs", () => {
    const r = drive(["--title", "T", "--yes", "--run-id", RUN], { FAKE_TABS: "2" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /note: 2 UI tabs are connected/);
  });

  it("one failed reader yields a NOT READ block and the run succeeds", () => {
    const r = drive(["--title", "T", "--yes", "--run-id", RUN], { FAKE_FAIL_READER: "2" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.tasks, /=== BLOCK 2 ===\nNOT READ: reader 1 failed \(failed\)\n=== END BLOCK 2 ===/);
    assert.match(r.tasks, /=== BLOCK 1 ===\n=== NOTES 0 ===/);
  });

  it("all readers failed exits 1 naming cause and action, with no orchestrator", () => {
    const r = drive(["--title", "T", "--yes", "--run-id", RUN], { FAKE_FAIL_ALL_READERS: "1" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /all 4 readers failed/);
    assert.match(r.stderr, /rerun with a new --run-id/);
    assert.match(r.stderr, /pomtree cancel ag-/);
    assert.equal(r.calls.filter((c) => isSpawn(c) && flagOf(c, "--template") === "wiki-orchestrator").length, 0);
  });

  it("--dry-run calls the fake zero times and prints the commands", () => {
    const r = drive(["--title", "T", "--dry-run", "--run-id", RUN]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.length, 0);
    assert.match(r.stdout, /^\+ pomtree ui reset/m);
    assert.match(r.stdout, /^\+ pomtree spawn --template wiki-reader /m);
  });

  it("rejects --readers 7, a slices count mismatch, and a missing title as usage errors", () => {
    for (const args of [
      ["--title", "T", "--yes", "--readers", "7"],
      ["--title", "T", "--yes", "--readers", "1"],
      ["--title", "T", "--yes", "--readers", "3", "--slices", "0,1;2,3"],
      ["--yes"],
    ]) {
      const r = drive(args);
      assert.equal(r.status, 2, args.join(" "));
      assert.equal(r.calls.length, 0);
    }
  });

  it("passes explicit slices into the reader tasks", () => {
    const r = drive(["--title", "T", "--yes", "--readers", "2", "--slices", "0,3;1,4", "--oldid", "123", "--run-id", RUN]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.tasks, /READER: 0 OF 2\nOLDID: 123\nSECTIONS: 0,3\n/);
    assert.match(r.tasks, /READER: 1 OF 2\nOLDID: 123\nSECTIONS: 1,4\n/);
  });

  it("takes the distiller REVISION from the readers' REV line when unpinned, and a pinned --oldid wins", () => {
    const u = drive(["--title", "T", "--yes", "--run-id", RUN]);
    assert.match(u.tasks, /### SPAWN wiki-distiller [\s\S]*?\nREVISION: 1000001\n/);
    const p = drive(["--title", "T", "--yes", "--oldid", "555", "--run-id", RUN]);
    assert.match(p.tasks, /### SPAWN wiki-distiller [\s\S]*?\nREVISION: 555\n/);
    assert.doesNotMatch(p.tasks, /REVISION: 1000001/);
  });

  it("retries on wait exit 7 until the agent is done", () => {
    const r = drive(["--title", "T", "--yes", "--run-id", RUN], { FAKE_WAIT_TIMEOUTS: "2" });
    assert.equal(r.status, 0, r.stderr);
    // 4 readers + orchestrator + distiller, each answered 7 twice then done.
    assert.equal(r.calls.filter((c) => c.includes("wait")).length, 6 * 3);
  });

  it("a reader past READER_TIMEOUT_S exits 1 naming cause and action and prints cancel commands", () => {
    const r = drive(["--title", "T", "--yes", "--readers", "2", "--run-id", RUN], {
      FAKE_WAIT_TIMEOUTS: "1000000",
      READER_TIMEOUT_S: "1",
      WAIT_CHUNK_MS: "10",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /did not finish within 1s/);
    assert.match(r.stderr, /pomtree cancel ag-/);
    assert.match(r.stderr, /raise the matching \*_TIMEOUT_S/);
    assert.equal(r.calls.filter((c) => isSpawn(c) && flagOf(c, "--template") === "wiki-orchestrator").length, 0);
  });

  it("--help exits 0 listing the flags", () => {
    const r = drive(["--help"]);
    assert.equal(r.status, 0);
    for (const f of ["--title", "--readers", "--run-id", "--oldid", "--slices", "--yes", "--dry-run"]) assert.ok(r.stdout.includes(f), f);
    assert.match(r.stdout, /READER_TIMEOUT_S \(720\)/);
  });
});
