import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SEEN_MAX, validateContentInput } from "./content-contract.mts";
import { INPUT, setup, until } from "./content-harness.mts";
import { exitCodeOf, recordSeenAfterRun } from "./content-live-run.mts";
import type { StateStore } from "../../packages/core/src/index.ts";
import { openStateStore } from "../../packages/store-sqlite/src/index.ts";
import { openSeenState, resolveStateDir } from "./content-live.mts";
import {
  createStoreSeen,
  exportSeenFile,
  importSeenFile,
  mergeSeen,
  parseSeenFile,
  prepareSeenExport,
  recordSeen,
  SEEN_KEY,
  SEEN_OWNER,
  SEEN_SAVE_ATTEMPTS,
  type SeenStore,
  SeenFileError,
  serializeSeenFile,
} from "./content-seen.mts";

const file = (over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, seen: [1, 5, 9], updatedAt: "2026-10-20T00:00:00.000Z", ...over });

describe("parseSeenFile", () => {
  it("accepts a well-formed file, including an empty list", () => {
    assert.deepEqual(parseSeenFile(file()), { ok: true, ids: [1, 5, 9] });
    assert.deepEqual(parseSeenFile(file({ seen: [] })), { ok: true, ids: [] });
  });
  it("rejects corrupt, wrong-version, extra-key, missing-key and badly typed files", () => {
    for (const bad of [
      "{not json",
      "[]",
      "null",
      file({ version: 2 }),
      file({ version: "1" }),
      file({ extra: true }),
      file({ updatedAt: "yesterday" }),
      file({ updatedAt: 5 }),
      file({ seen: [1, 1] }),
      file({ seen: [5, 1] }),
      file({ seen: [0] }),
      file({ seen: [1.5] }),
      file({ seen: ["1"] }),
      file({ seen: 3 }),
      JSON.stringify({ version: 1, seen: [] }),
    ])
      assert.equal(parseSeenFile(bad).ok, false, bad);
  });
  it("bounds the id count at SEEN_MAX", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    assert.equal(parseSeenFile(file({ seen: ids(SEEN_MAX) })).ok, true);
    assert.equal(parseSeenFile(file({ seen: ids(SEEN_MAX + 1) })).ok, false);
  });
  it("round-trips serializeSeenFile and keeps the newest ids when over the bound", () => {
    const text = serializeSeenFile([9, 3, 3, 1], new Date("2026-10-20T01:02:03.000Z"));
    assert.deepEqual(JSON.parse(text), { version: 1, seen: [1, 3, 9], updatedAt: "2026-10-20T01:02:03.000Z" });
    assert.deepEqual(parseSeenFile(text), { ok: true, ids: [1, 3, 9] });
    const merged = mergeSeen(
      [1, 2],
      Array.from({ length: SEEN_MAX }, (_, i) => i + 10),
    );
    assert.equal(merged.length, SEEN_MAX);
    assert.equal(merged[0], 10);
  });
});

describe("launch input seen bound", () => {
  const input = (seen: unknown) => ({ ...INPUT, seen });
  it("is optional and accepts a bounded id list", () => {
    assert.equal(validateContentInput(INPUT).ok, true);
    const r = validateContentInput(input([1, 2, 3]));
    assert.ok(r.ok && r.value.seen?.join() === "1,2,3");
  });
  it("rejects non-arrays, bad ids and too many ids", () => {
    for (const bad of ["1", [0], [-1], [1.5], ["1"], [null], Array.from({ length: SEEN_MAX + 1 }, (_, i) => i + 1)])
      assert.equal(validateContentInput(input(bad)).ok, false, JSON.stringify(bad).slice(0, 40));
    assert.equal(validateContentInput({ ...INPUT, nope: 1 }).ok, false, "unknown keys still refused");
  });
});

const CLOCK = new Date("2026-10-20T01:02:03.000Z");

describe("store-backed SeenStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "hn-seen-")));
  });
  afterEach(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  const open = () => openStateStore(join(dir, "state.sqlite"));

  it("treats an absent doc as empty, creates it only for ids, and merges later saves", async () => {
    const db = open();
    const s = createStoreSeen(db.state, () => CLOCK);
    assert.deepEqual(await s.load(), []);
    assert.deepEqual(await recordSeen(s, "published", []), { written: false, total: 0 });
    assert.equal(await db.state.get(SEEN_OWNER, SEEN_KEY), null);
    assert.equal((await recordSeen(s, "published", [3, 1])).written, true);
    await s.save([3, 7]);
    assert.deepEqual(await s.load(), [1, 3, 7]);
    const doc = await db.state.get(SEEN_OWNER, SEEN_KEY);
    assert.deepEqual(doc?.value, { ids: [1, 3, 7], updatedAt: CLOCK.toISOString() });
    assert.equal(doc?.rev, 2);
    assert.deepEqual(doc?.writer, { operator: true });
    db.close();
  });

  it("a save that adds nothing is not rewritten", async () => {
    const db = open();
    const s = createStoreSeen(db.state);
    await s.save([1, 2]);
    const rev = (await db.state.get(SEEN_OWNER, SEEN_KEY))?.rev;
    await s.save([2, 1]);
    assert.equal((await db.state.get(SEEN_OWNER, SEEN_KEY))?.rev, rev);
    db.close();
  });

  it("a non-published outcome never writes", async () => {
    const db = open();
    const s = createStoreSeen(db.state);
    for (const outcome of ["denied", "cancelled", "failed"]) assert.equal((await recordSeen(s, outcome, [100])).written, false);
    assert.equal(await db.state.get(SEEN_OWNER, SEEN_KEY), null);
    db.close();
  });

  it("retries a CAS conflict with a fresh key and loses neither writer's ids", async () => {
    const db = open();
    const rival = createStoreSeen(db.state);
    const keys: string[] = [];
    let raced = false;
    const racing: StateStore = {
      ...db.state,
      get: (o, k) => db.state.get(o, k),
      put: async (req, key) => {
        keys.push(key);
        if (!raced) {
          raced = true;
          await rival.save([50]);
        }
        return db.state.put(req, key);
      },
    };
    await createStoreSeen(racing).save([1, 2]);
    assert.deepEqual(await rival.load(), [1, 2, 50]);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    db.close();
  });

  it("gives up after the attempt bound and says so", async () => {
    const db = open();
    let puts = 0;
    const always: StateStore = {
      ...db.state,
      put: async () => {
        puts++;
        return { ok: false, reason: "conflict", currentRev: 9 };
      },
    };
    await assert.rejects(createStoreSeen(always).save([1]), (e) => e instanceof SeenFileError && /concurrently/.test(e.message));
    assert.equal(puts, SEEN_SAVE_ATTEMPTS);
    db.close();
  });

  it("trims to SEEN_MAX, keeping the newest ids", async () => {
    const db = open();
    const s = createStoreSeen(db.state);
    await s.save(Array.from({ length: SEEN_MAX }, (_, i) => i + 1));
    await s.save([SEEN_MAX + 1, SEEN_MAX + 2]);
    const ids = await s.load();
    assert.equal(ids.length, SEEN_MAX);
    assert.equal(ids[0], 3);
    assert.equal(ids.at(-1), SEEN_MAX + 2);
    db.close();
  });

  it("refuses a corrupt stored value, pointing at the pomtree state verbs, and never overwrites it", async () => {
    const db = open();
    for (const value of [{ ids: [5, 1], updatedAt: CLOCK.toISOString() }, { ids: "x", updatedAt: CLOCK.toISOString() }, { ids: [1] }, [], 7])
      await db.state.put({ owner: SEEN_OWNER, key: SEEN_KEY, value: value as never, writer: { operator: true } }, `bad-${JSON.stringify(value)}`);
    const s = createStoreSeen(db.state);
    const bad = (e: unknown) =>
      e instanceof SeenFileError && /pomtree state show hn-digest seen\/hn/.test(e.message) && /pomtree state rm hn-digest seen\/hn/.test(e.message);
    await assert.rejects(s.load(), bad);
    await assert.rejects(s.save([9]), bad);
    assert.deepEqual((await db.state.get(SEEN_OWNER, SEEN_KEY))?.value, 7);
    db.close();
  });

  it("two stores on one db file merge without losing ids", async () => {
    const a = open();
    const b = open();
    const sa = createStoreSeen(a.state);
    const sb = createStoreSeen(b.state);
    await Promise.all([sa.save([1, 2]), sb.save([3]), sa.save([4]), sb.save([5, 1])]);
    assert.deepEqual(await sa.load(), [1, 2, 3, 4, 5]);
    assert.deepEqual(await sb.load(), [1, 2, 3, 4, 5]);
    a.close();
    b.close();
  });
});

describe("openSeenState and resolveStateDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "hn-seen-state-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves --state-dir, then POMTREED_STATE_DIR, then ~/.pomtreed (injected env and home)", () => {
    const home = join(dir, "home");
    assert.equal(resolveStateDir({ flag: join(dir, "f"), env: { POMTREED_STATE_DIR: join(dir, "e") }, home }), join(dir, "f"));
    assert.equal(resolveStateDir({ env: { POMTREED_STATE_DIR: join(dir, "e") }, home }), join(dir, "e"));
    assert.equal(resolveStateDir({ env: {}, home }), join(home, ".pomtreed"));
  });

  it("refuses a missing state dir or a file, and never creates the directory", async () => {
    const gone = join(dir, "typo");
    await assert.rejects(openSeenState({ stateDir: gone }), (e) => e instanceof SeenFileError && /never created/.test(e.message));
    assert.equal(existsSync(gone), false);
    writeFileSync(join(dir, "afile"), "x");
    await assert.rejects(openSeenState({ stateDir: join(dir, "afile") }), SeenFileError);
  });

  it("opens state.sqlite beside, and never creates or opens, pomtreed.sqlite", async () => {
    const s = await openSeenState({ stateDir: dir });
    await s.store.save([1]);
    s.close();
    assert.equal(existsSync(join(dir, "state.sqlite")), true);
    assert.equal(existsSync(join(dir, "pomtreed.sqlite")), false);
    assert.ok(readdirSync(dir).every((f) => f.startsWith("state.sqlite")));
  });

  it("refuses a database newer than this code", async () => {
    const file = join(dir, "state.sqlite");
    openStateStore(file).close();
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    await assert.rejects(openSeenState({ stateDir: dir }), (e) => e instanceof SeenFileError && /newer than this binary supports/.test(e.message));
  });

  it("refuses a corrupt stored value before the run", async () => {
    const db = openStateStore(join(dir, "state.sqlite"));
    await db.state.put({ owner: SEEN_OWNER, key: SEEN_KEY, value: { ids: [2, 1], updatedAt: CLOCK.toISOString() }, writer: { operator: true } }, "bad");
    db.close();
    await assert.rejects(openSeenState({ stateDir: dir }), (e) => e instanceof SeenFileError && /invalid/.test(e.message));
  });
});

describe("--seen-import / --seen-export", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "hn-seen-io-")));
  });
  afterEach(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  it("import then export reproduces the original bytes (fixed clock), and a re-import is idempotent", async () => {
    const original = serializeSeenFile([4, 8, 15], CLOCK);
    const src = join(dir, "in.json");
    writeFileSync(src, original);
    const s = await openSeenState({ stateDir: dir, now: () => CLOCK });
    await s.store.save(importSeenFile(src));
    const rev = async () => {
      const db = openStateStore(join(dir, "state.sqlite"));
      const r = (await db.state.get(SEEN_OWNER, SEEN_KEY))?.rev;
      db.close();
      return r;
    };
    const first = await rev();
    await s.store.save(importSeenFile(src));
    assert.equal(await rev(), first);
    const out = prepareSeenExport(join(dir, "out.json"));
    exportSeenFile(out, await s.store.load(), CLOCK);
    assert.equal(readFileSync(out, "utf8"), original);
    assert.deepEqual(
      readdirSync(dir)
        .filter((f) => !f.startsWith("state.sqlite"))
        .sort(),
      ["in.json", "out.json"],
      "no temp or lock left behind",
    );
    s.close();
  });

  it("import refuses a missing, corrupt, wrong-version or non-file path", () => {
    const p = join(dir, "x.json");
    assert.throws(() => importSeenFile(p), /does not exist/);
    writeFileSync(p, "{oops");
    assert.throws(
      () => importSeenFile(p),
      (e) => e instanceof SeenFileError && e.message.includes(p),
    );
    writeFileSync(p, file({ version: 2 }));
    assert.throws(() => importSeenFile(p), /unsupported version/);
    mkdirSync(join(dir, "d"));
    assert.throws(() => importSeenFile(join(dir, "d")), /not a regular file/);
  });

  it("export refuses a missing directory, a held lock and a directory in place of the file", () => {
    assert.throws(() => prepareSeenExport(join(dir, "nope", "o.json")), /does not exist/);
    writeFileSync(join(dir, "o.json.lock"), "999\n");
    assert.throws(
      () => prepareSeenExport(join(dir, "o.json")),
      (e) => e instanceof SeenFileError && /delete that file/.test(e.message),
    );
    assert.equal(existsSync(join(dir, "o.json.lock")), true, "never removed");
    mkdirSync(join(dir, "d"));
    assert.throws(() => prepareSeenExport(join(dir, "d")), /not a regular file/);
  });

  it("a failed export leaves the old file and no lock", { skip: process.getuid?.() === 0 }, () => {
    const p = join(dir, "o.json");
    writeFileSync(p, file());
    chmodSync(dir, 0o555);
    assert.throws(
      () => exportSeenFile(p, [100], CLOCK),
      (e) => e instanceof SeenFileError && e.message.includes(dir),
    );
    chmodSync(dir, 0o755);
    assert.deepEqual(parseSeenFile(readFileSync(p, "utf8")), { ok: true, ids: [1, 5, 9] });
    assert.deepEqual(readdirSync(dir), ["o.json"]);
  });
});

// Offline end-to-end: real workflow runs against the scripted harness and fake feed, with the seen state carried between them in a real
// state.sqlite under os.tmpdir().
describe("seen state across runs (offline workflow)", () => {
  type Decision = "approve" | "deny";
  async function run(stateDir: string, options: Parameters<typeof setup>[0], decision: Decision) {
    const seen = await openSeenState({ stateDir });
    try {
      const e = await setup({ ...options, seen: await seen.store.load() });
      try {
        e.releaseCapture.resolve();
        e.releaseComment.resolve();
        const approval = await until(
          async () => (await e.rt.stores.approvals.list({ state: "pending" })).find((a) => a.action.kind === "publish"),
          "publish gate",
        );
        await e.rt.daemon.decideApproval(approval.id, decision, "operator", "seen fixture", `seen-${decision}`);
        const done = await until(async () => {
          const r = await e.rt.daemon.get(e.id);
          return r && ["exited", "reaped"].includes(r.state) && r;
        }, "terminal");
        const result = done.result as { entryIds: number[]; stories: { story: { id: number } }[]; report?: unknown } | null;
        const outcome = decision === "deny" ? "denied" : done.exit === "succeeded" && result?.report ? "published" : "failed";
        const recorded = await recordSeen(seen.store, outcome, result?.entryIds ?? []);
        return { outcome, recorded, stories: result?.stories?.map((s) => s.story.id) ?? [], entryIds: result?.entryIds ?? [] };
      } finally {
        await e.cleanup();
      }
    } finally {
      seen.close();
    }
  }
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "hn-seen-e2e-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const stored = async () => {
    const s = await openSeenState({ stateDir: dir });
    try {
      return await s.store.load();
    } finally {
      s.close();
    }
  };

  it("run 2 selects only the new stories and the stored set becomes the union", { timeout: 60000 }, async () => {
    const first = await run(dir, { stories: 3 }, "approve");
    assert.deepEqual(first.stories, [101, 102, 103]);
    assert.deepEqual(await stored(), [101, 102, 103]);
    const second = await run(dir, { stories: 3, feed: [101, 102, 103, 104, 105] }, "approve");
    assert.deepEqual(second.stories, [104, 105]);
    assert.deepEqual(await stored(), [101, 102, 103, 104, 105]);
  });

  it("a denied approval leaves the stored set unchanged", { timeout: 60000 }, async () => {
    const s = await openSeenState({ stateDir: dir });
    await s.store.save([101]);
    s.close();
    const r = await run(dir, { stories: 3 }, "deny");
    assert.equal(r.outcome, "denied");
    assert.deepEqual(await stored(), [101]);
  });

  it("a published run with zero analysed stories writes nothing", { timeout: 60000 }, async () => {
    const r = await run(dir, { stories: 1, invalidAnalysis: [101] }, "approve");
    assert.deepEqual(r.entryIds, []);
    assert.equal(r.recorded.written, false);
    assert.deepEqual(await stored(), []);
  });
});

// The entry depends only on SeenStore: an in-memory store stands in for the database.
describe("SeenStore seam (in-memory)", () => {
  const memory = (initial: number[] = [], failWith?: Error): SeenStore & { saves: number[][] } => {
    let ids = initial;
    const saves: number[][] = [];
    return {
      saves,
      load: async () => ids,
      async save(add) {
        saves.push([...add]);
        if (failWith) throw failWith;
        ids = mergeSeen(ids, add);
      },
    };
  };
  const quiet = async (fn: () => Promise<number>): Promise<number> => {
    const orig = console.error;
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.error = orig;
    }
  };
  const capture = async (fn: () => Promise<number>): Promise<{ code: number; lines: string[] }> => {
    const orig = console.error;
    const lines: string[] = [];
    console.error = (m: string) => void lines.push(m);
    try {
      return { code: await fn(), lines };
    } finally {
      console.error = orig;
    }
  };

  it("recordSeen saves only for a published run with ids", async () => {
    const s = memory([5]);
    assert.deepEqual(await recordSeen(s, "denied", [9]), { written: false, total: 1 });
    assert.deepEqual(await recordSeen(s, "published", []), { written: false, total: 1 });
    assert.deepEqual(await recordSeen(s, "published", [9]), { written: true, total: 2 });
    assert.deepEqual(s.saves, [[9]]);
    assert.deepEqual(await s.load(), [5, 9]);
  });

  it("a successful save leaves the exit code alone", async () => {
    const s = memory();
    assert.equal(await quiet(() => recordSeenAfterRun(s, "mem", "published", [1], 0)), 0);
    assert.deepEqual(await s.load(), [1]);
  });

  it("a failing save maps 0 to 5 and keeps 3 and 4, naming the ids to add by hand", async () => {
    const s = memory([], new Error("disk full"));
    const r = await capture(() => recordSeenAfterRun(s, "mem", "published", [1, 2], 0));
    assert.equal(r.code, 5);
    assert.match(r.lines.join("\n"), /PUBLISHED, but the seen state was NOT updated: Error: disk full\. Story ids to add by hand: \[1,2\]/);
    assert.equal(await quiet(() => recordSeenAfterRun(s, "mem", "published", [1], 4)), 4);
    assert.equal(await quiet(() => recordSeenAfterRun(s, "mem", "published", [1], 3)), 3);
  });

  it("a real store that fails (closed database) maps to exit 5", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "hn-seen-fail-")));
    try {
      const db = openStateStore(join(dir, "state.sqlite"));
      const s = createStoreSeen(db.state);
      db.close();
      assert.equal(await quiet(() => recordSeenAfterRun(s, "db", "published", [1], 0)), 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an export failure after a good save is exit 5 and says the stored state was updated", async () => {
    const s = memory();
    const r = await capture(() =>
      recordSeenAfterRun(s, "mem", "published", [7], 0, () => {
        throw new SeenFileError("lock held");
      }),
    );
    assert.equal(r.code, 5);
    assert.deepEqual(await s.load(), [7]);
    assert.match(r.lines.join("\n"), /export failed: lock held \(the stored seen state WAS updated\)\. Story ids to add by hand: \[7\]/);
  });

  it("the export gets the full stored set, and only after a published run that added ids", async () => {
    const s = memory([1]);
    const got: number[][] = [];
    await quiet(() => recordSeenAfterRun(s, "mem", "denied", [9], 3, (ids) => void got.push([...ids])));
    await quiet(() => recordSeenAfterRun(s, "mem", "published", [], 0, (ids) => void got.push([...ids])));
    assert.equal(got.length, 0);
    await quiet(() => recordSeenAfterRun(s, "mem", "published", [9], 0, (ids) => void got.push([...ids])));
    assert.deepEqual(got, [[1, 9]]);
  });

  it("exit 3 and seen marking agree: a run that exits 3 marks nothing, whatever it published", async () => {
    const verdict = (failing: string[]) => ({
      ok: failing.length === 0,
      checks: ["analysed-stories", "usable-article", "seen-set"].map((name) => ({ name, ok: !failing.includes(name) })),
    });
    // [label, failing checks, ids the root would mark, expected exit, ids saved]
    const rows: [string, string[], number[], number, number[][]][] = [
      ["every URL-bearing article failed, a URL-less story analysed", ["usable-article"], [102], 3, []],
      ["mixed: one article usable, one failed, a URL-less story analysed", [], [101, 102], 0, [[101, 102]]],
      ["all fine", [], [101, 102], 0, [[101, 102]]],
      ["another assertion failed (4) still marks the published ids", ["seen-set"], [101], 4, [[101]]],
    ];
    for (const [label, failing, ids, exit, saved] of rows) {
      const s = memory();
      const code = exitCodeOf("published", verdict(failing));
      assert.equal(await quiet(() => recordSeenAfterRun(s, "mem", "published", ids, code)), exit, label);
      assert.deepEqual(s.saves, saved, label);
    }
  });

  it("a non-published outcome never calls save, even if save would fail", async () => {
    const s = memory([], new Error("boom"));
    assert.equal(await quiet(() => recordSeenAfterRun(s, "mem", "denied", [1], 3)), 3);
    assert.deepEqual(s.saves, []);
  });
});
