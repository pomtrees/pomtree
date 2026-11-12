import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId, AgentRecord, NewReport } from "@pomtree/core";
import { StaleGenerationError } from "@pomtree/core";
import { DirReportStore } from "./index.ts";

function reg(agents: Record<AgentId, number>) {
  return {
    async get(id: AgentId): Promise<AgentRecord | null> {
      const generation = agents[id];
      if (generation === undefined) return null;
      return {
        id,
        parent: null,
        name: "n",
        task: "t",
        state: "pending",
        exit: null,
        result: null,
        host: "h",
        generation,
        sandbox: null,
        sandboxBackend: null,
        budgetMicros: 1,
        createdAt: 0,
        updatedAt: 0,
        executor: "container",
        spec: { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "registry" } },
      };
    },
  };
}

// Every temp dir a test makes is removed when the file's tests finish (the package does not depend on @pomtree/testing's tmpDir).
const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function setup(agents: Record<AgentId, number> = { a: 0 }) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "report-dir-"));
  made.push(root);
  const store = new DirReportStore({ root, registry: reg(agents) });
  return { root, store };
}

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const nr = (over: Partial<NewReport> = {}): NewReport => {
  const content = over.content ?? enc("one");
  return {
    id: "deadbeef",
    agent: "a",
    generation: 0,
    host: "h",
    name: "report",
    mediaType: "text/plain",
    sizeBytes: content.byteLength,
    sha256: sha(content),
    content,
    ...over,
  };
};

test("write is idempotent by id; a later write never rewrites", async () => {
  const { store } = setup();
  const first = await store.write(nr(), "k1");
  const second = await store.write(nr({ content: enc("TWO") }), "k2");
  assert.equal(second.createdAt, first.createdAt);
  const got = await store.read("a", first.id);
  assert.equal(new TextDecoder().decode(got!.content), "one");
});

test("a partial write (content without meta.json) reads as absent", async () => {
  const { store, root } = setup();
  const dir = join(root, "a", "deadbeef");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "content"), "ghost");
  assert.equal(await store.read("a", "deadbeef"), null);
  assert.deepEqual(await store.list("a"), []);
  const w = await store.write(nr(), "k");
  assert.equal(w.id, "deadbeef");
  assert.ok(await store.read("a", "deadbeef"));
});

test("stale generation rejected, unknown agent rejected", async () => {
  const stale = setup({ a: 1 });
  await assert.rejects(stale.store.write(nr({ generation: 0 }), "k"), StaleGenerationError);
  const unknown = setup({});
  await assert.rejects(unknown.store.write(nr(), "k"), /unknown agent a/);
});

test("list returns newest first; read of a missing id is null", async () => {
  const { store } = setup();
  await store.write(nr({ id: "r1" }), "k1");
  await new Promise((r) => setTimeout(r, 5));
  await store.write(nr({ id: "r2" }), "k2");
  assert.deepEqual(
    (await store.list("a")).map((x) => x.id),
    ["r2", "r1"],
  );
  assert.equal(await store.read("a", "missing"), null);
});

test("remove reports whether it existed", async () => {
  const { store } = setup();
  assert.equal(await store.remove("a", "nope"), false);
  await store.write(nr(), "k");
  assert.equal(await store.remove("a", "deadbeef"), true);
  assert.equal(await store.remove("a", "deadbeef"), false);
});

test("agent and id are validated against path traversal", async () => {
  const { store } = setup();
  for (const bad of ["", "a/b", "a\\b", "..", "-x", ".x", "a\0b"]) {
    await assert.rejects(store.write(nr({ agent: bad }), "k"), /invalid agent id/);
    await assert.rejects(store.write(nr({ id: bad }), "k"), /invalid report id/);
    await assert.rejects(store.list(bad), /invalid agent id/);
    await assert.rejects(store.read("a", bad), /invalid report id/);
    await assert.rejects(store.remove("a", bad), /invalid report id/);
  }
});

test("corrupt meta.json is skipped by list and read", async () => {
  const { store, root } = setup();
  const bad = join(root, "a", "bad");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "meta.json"), "{not json");
  await store.write(nr({ id: "good" }), "k");
  assert.deepEqual(
    (await store.list("a")).map((x) => x.id),
    ["good"],
  );
  assert.equal(await store.read("a", "bad"), null);
});

test("missing content reads as absent without breaking list", async () => {
  const { store, root } = setup();
  await store.write(nr(), "k");
  rmSync(join(root, "a", "deadbeef", "content"));
  assert.equal(await store.read("a", "deadbeef"), null);
  assert.deepEqual(
    (await store.list("a")).map((x) => x.id),
    ["deadbeef"],
  );
});

test("symlinked meta.json and content are treated as absent", async () => {
  const { store, root } = setup();
  const target = join(root, "..", `leak-${process.pid}`);
  writeFileSync(target, JSON.stringify({ id: "leak" }));

  const metaDir = join(root, "a", "meta-link");
  mkdirSync(metaDir, { recursive: true });
  symlinkSync(target, join(metaDir, "meta.json"));
  assert.equal(await store.read("a", "meta-link"), null);
  assert.deepEqual(await store.list("a"), []);

  await store.write(nr(), "k");
  rmSync(join(root, "a", "deadbeef", "content"));
  symlinkSync(target, join(root, "a", "deadbeef", "content"));
  assert.equal(await store.read("a", "deadbeef"), null);

  rmSync(target, { force: true });
});

test("write refuses a symlinked meta.json rather than writing through it", async () => {
  const { store, root } = setup();
  const target = join(root, "..", `wleak-${process.pid}`);
  writeFileSync(target, "{}");
  const dir = join(root, "a", "deadbeef");
  mkdirSync(dir, { recursive: true });
  symlinkSync(target, join(dir, "meta.json"));
  await assert.rejects(store.write(nr(), "k"), /meta\.json/);
  assert.equal(readFileSync(target, "utf8"), "{}"); // never scribbled through
  rmSync(target, { force: true });
});

test("write rejects content whose size or sha256 does not match", async () => {
  const { store } = setup();
  await assert.rejects(store.write(nr({ sizeBytes: 99 }), "k"), /size/i);
  await assert.rejects(store.write(nr({ sha256: "deadbeef" }), "k"), /sha256/i);
  assert.deepEqual(await store.list("a"), []);
});

test("meta.json whose identity mismatches its directory is ignored", async () => {
  const { store, root } = setup();
  const r = await store.write(nr({ id: "good" }), "k");
  const d = join(root, "a", "other");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "meta.json"), JSON.stringify(r));
  writeFileSync(join(d, "content"), "x");
  assert.deepEqual(
    (await store.list("a")).map((x) => x.id),
    ["good"],
  );
  assert.equal(await store.read("a", "other"), null);
});

test("a planted symlink at the report path is not followed, even over a sibling's report", async () => {
  const { store, root } = setup({ a: 0, b: 0 });
  await store.write(nr({ agent: "b", name: "secret" }), "k");
  const content = join(root, "a", "deadbeef", "content");
  await store.write(nr(), "k");
  rmSync(content);
  symlinkSync(join(root, "b", "deadbeef", "content"), content);
  assert.equal(await store.read("a", "deadbeef"), null);
});

test("a FIFO at the report path does not hang the read", async () => {
  const { store, root } = setup();
  await store.write(nr(), "k");
  const content = join(root, "a", "deadbeef", "content");
  rmSync(content);
  execFileSync("mkfifo", [content]);
  assert.equal(await store.read("a", "deadbeef"), null);
  rmSync(join(root, "a", "deadbeef", "meta.json"));
  execFileSync("mkfifo", [join(root, "a", "deadbeef", "meta.json")]);
  assert.deepEqual(await store.list("a"), []);
});

test("content or meta.json grown past its bound is refused; a normal file still reads", async () => {
  const { store, root } = setup();
  const r = await store.write(nr(), "k");
  assert.deepEqual((await store.read("a", "deadbeef"))?.report, r);
  writeFileSync(join(root, "a", "deadbeef", "content"), Buffer.alloc(r.sizeBytes + 1));
  assert.equal(await store.read("a", "deadbeef"), null);
  writeFileSync(join(root, "a", "deadbeef", "meta.json"), Buffer.alloc(1024 * 1024 + 1));
  assert.deepEqual(await store.list("a"), []);
});

test("meta.json with a missing, negative or non-integer sizeBytes is invalid, so the content read is never unbounded", async () => {
  for (const bad of [undefined, -1, 1.5, "3", null]) {
    const { store, root } = setup();
    const r = await store.write(nr(), "k");
    assert.ok(await store.read("a", "deadbeef"));
    writeFileSync(join(root, "a", "deadbeef", "meta.json"), JSON.stringify({ ...r, sizeBytes: bad }));
    assert.equal(await store.read("a", "deadbeef"), null, `sizeBytes ${String(bad)}`);
    assert.deepEqual(await store.list("a"), []);
  }
});
