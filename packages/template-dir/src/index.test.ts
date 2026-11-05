import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT_MAX_BYTES, TemplateError } from "@pomtree/core";
import { DirTemplateStore, KNOWN_EXTENSIONS } from "./index.ts";

// Every temp dir a test makes is removed when the file's tests finish (the package does not depend on @pomtree/testing's tmpDir).
const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const mk = (prefix: string) => {
  const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  made.push(d);
  return d;
};

function setup() {
  const root = mk("template-dir-");
  const store = new DirTemplateStore({ root });
  return { root, store };
}

const put = (root: string, name: string, manifest: unknown) => {
  writeFileSync(join(root, `${name}.json`), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
};

// A well-formed 64-hex sha256 digest and a helper to build a pinned image reference from it.
const DIGEST = "sha256:" + "ab".repeat(32);
const img = (name = "img") => `${name}@${DIGEST}`;
const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");

test("resolve reads a valid manifest and defaults the id from the file stem", async () => {
  const { root, store } = setup();
  put(root, "researcher", { image: img(), systemPrompt: "you research", model: "m" });
  const t = await store.resolve("researcher");
  assert.ok(t);
  assert.equal(t.id, "researcher");
  assert.equal(t.image, img());
  assert.deepEqual(t.egress, { kind: "none" });
  assert.equal(t.systemPrompt, "you research");
  assert.equal(t.model, "m");
});

test("resolve returns null for a missing or non-file entry", async () => {
  const { root, store } = setup();
  assert.equal(await store.resolve("nope"), null);
  // a directory named like a template is not a regular file
  mkdirSync(join(root, "dir.json"));
  assert.equal(await store.resolve("dir"), null);
});

test("constructor creates a missing root directory", async () => {
  const parent = mk("template-dir-parent-");
  const root = join(parent, "missing", "nested");
  const store = new DirTemplateStore({ root });
  assert.ok(statSync(root).isDirectory());
  assert.deepEqual(await store.list(), []);
});

test("resolve refuses to follow a symlink", async () => {
  const { root, store } = setup();
  const target = join(mk("template-dir-outside-"), "target.json");
  writeFileSync(target, JSON.stringify({}));
  symlinkSync(target, join(root, "link.json"));
  assert.equal(await store.resolve("link"), null);
  // ensure list() also skips it (and non-.json entries)
  writeFileSync(join(root, "notes.txt"), "hello");
  assert.deepEqual(
    (await store.list()).map((t) => t.id),
    [],
  );
});

test("a bad file raises TemplateError", async () => {
  const { root, store } = setup();
  const cases: unknown[] = [
    { name: "other" }, // name mismatch
    { provider: "p" }, // provider without model
    { extensions: ["nope"] }, // unknown extension
    { egress: { kind: "bogus" } }, // unknown egress kind
    { egress: { kind: "allowlist" } }, // allowlist without hosts
    { budgetMicros: -1 }, // negative budget
    { cpus: "two" }, // non-number cpus
    [1, 2, 3], // not an object
  ];
  for (const c of cases) {
    put(root, "bad", c);
    await assert.rejects(store.resolve("bad"), TemplateError);
  }
});

test("corrupt JSON raises TemplateError", async () => {
  const { root, store } = setup();
  put(root, "corrupt", "{not json");
  await assert.rejects(store.resolve("corrupt"), TemplateError);
});

test("template names are validated against path traversal", async () => {
  const { store } = setup();
  for (const bad of ["", "a/b", "a\\b", "..", "-x", ".x", "a\0b"]) {
    await assert.rejects(store.resolve(bad), TemplateError);
  }
});

test("validates provider requires model, extension allowlist, and egress shape", async () => {
  const { root, store } = setup();
  put(root, "ok", {
    provider: "p",
    model: "m",
    extensions: [KNOWN_EXTENSIONS[0], KNOWN_EXTENSIONS[0]], // duplicate deduped
    egress: { kind: "allowlist", hosts: ["a", "b", "a"] },
  });
  const t = await store.resolve("ok");
  assert.ok(t);
  assert.deepEqual(t.extensions, [KNOWN_EXTENSIONS[0]]);
  assert.deepEqual(t.egress, { kind: "allowlist", hosts: ["a", "b"] });
});

test("a zero cpus, memoryBytes, shmBytes, diskBytes or budgetMicros is accepted; a negative cpus is refused", async () => {
  const { root, store } = setup();
  put(root, "zero", { cpus: 0, memoryBytes: 0, shmBytes: 0, diskBytes: 0, budgetMicros: 0 });
  const t = await store.resolve("zero");
  assert.ok(t);
  assert.deepEqual([t.cpus, t.memoryBytes, t.shmBytes, t.diskBytes, t.budgetMicros], [0, 0, 0, 0, 0]);
  put(root, "neg", { cpus: -1 });
  await assert.rejects(store.resolve("neg"), (e: unknown) => e instanceof TemplateError && /cpus must be a non-negative number/.test(e.message));
});

test("a non-finite shmBytes (1e999 parses to Infinity) is refused", async () => {
  const { root, store } = setup();
  put(root, "bad", `{"image":"img@${DIGEST}","model":"m","systemPrompt":"x","shmBytes":1e999}`);
  await assert.rejects(store.resolve("bad"), TemplateError);
});

test("a non-string model or provider is refused with the source message", async () => {
  const { root, store } = setup();
  const refused = (message: string) => (e: unknown) => e instanceof TemplateError && e.message === message;
  put(root, "bad", { model: 5 });
  await assert.rejects(store.resolve("bad"), refused("template error: bad: model must be a non-empty string"));
  put(root, "bad", { provider: 5, model: "m" });
  await assert.rejects(store.resolve("bad"), refused("template error: bad: provider must be a non-empty string"));
});

test("list returns every valid template and skips non-template entries", async () => {
  const { root, store } = setup();
  put(root, "a", {});
  put(root, "b", { image: img() });
  writeFileSync(join(root, "skip.txt"), "x");
  writeFileSync(join(root, ".hidden.json"), JSON.stringify({}));
  const ids = (await store.list()).map((t) => t.id).sort();
  assert.deepEqual(ids, ["a", "b"]);
});

test("list ignores a regular file that does not end in .json even when its stem names a template", async () => {
  const { root, store } = setup();
  put(root, "x", {});
  // Not a template file: with the .json extension stripped, "xabcde" also yields the stem "x" of the template above.
  writeFileSync(join(root, "xabcde"), "not a manifest");
  assert.deepEqual(
    (await store.list()).map((t) => t.id),
    ["x"],
  );
});

test("list raises TemplateError when a valid-stem file is malformed", async () => {
  const { root, store } = setup();
  put(root, "good", {});
  put(root, "bad", { cpus: "two" });
  await assert.rejects(store.list(), TemplateError);
});

test("listEntries keeps every valid template and reports each broken file as { id, error } with its field reason", async () => {
  const { root, store } = setup();
  put(root, "good", {});
  put(root, "bad", { cpus: "two" });
  put(root, "torn", "{not json");
  const rows = await store.listEntries();
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.deepEqual([...byId.keys()].sort(), ["bad", "good", "torn"]);
  assert.ok(!("error" in byId.get("good")!));
  const bad = byId.get("bad")!;
  assert.ok("error" in bad && bad.error instanceof TemplateError);
  assert.equal(bad.error.message, "template error: bad: cpus must be a non-negative number");
  const torn = byId.get("torn")!;
  assert.ok("error" in torn && torn.error.message === "template error: torn: corrupt JSON");
  // Negative: an all-valid directory yields no error rows, and an absent directory lists nothing.
  const clean = setup();
  put(clean.root, "a", {});
  assert.deepEqual(
    (await clean.store.listEntries()).map((r) => "error" in r),
    [false],
  );
});

test("env is passed through unchanged", async () => {
  const { root, store } = setup();
  put(root, "env", { env: { FOO: "bar", nested: { a: 1 } } });
  const t = await store.resolve("env");
  assert.ok(t);
  assert.deepEqual(t.env, { FOO: "bar", nested: { a: 1 } });
});

test("a template without egress normalizes to none, not registry", async () => {
  const { root, store } = setup();
  put(root, "plain", { image: img() });
  const t = await store.resolve("plain");
  assert.ok(t);
  assert.deepEqual(t.egress, { kind: "none" });
});

test("egress audited-public is accepted only as an explicit exact kind", async () => {
  const { root, store } = setup();
  put(root, "pub", { image: img(), egress: { kind: "audited-public" } });
  assert.deepEqual((await store.resolve("pub"))?.egress, { kind: "audited-public" });
  // no default: a template without egress stays none
  put(root, "plain", { image: img() });
  assert.deepEqual((await store.resolve("plain"))?.egress, { kind: "none" });
  // malformed audited-public policies carry extra data and are rejected
  const bads: unknown[] = [
    { kind: "audited-public", hosts: ["a.example"] },
    { kind: "audited-public", wildcard: "*" },
    { kind: "audited-public", auditedPublic: { host: "h", generation: 1 } },
    { kind: "Audited-Public" },
    { kind: "audited_public" },
    { kind: "audited-public", "": 1 },
  ];
  for (const egress of bads) {
    put(root, "bad", { egress });
    await assert.rejects(store.resolve("bad"), TemplateError, JSON.stringify(egress));
  }
});

test("image must be a pinned sha256 digest", async () => {
  const { root, store } = setup();
  put(root, "ok", { image: img() });
  assert.equal((await store.resolve("ok"))?.image, img());
  const badImages = [
    "img", // bare name, no digest
    "img:latest", // tag, not a digest
    `img@sha256:${"a".repeat(63)}`, // short digest
    `@${DIGEST}`, // empty repo before the digest
    `img@sha512:${"a".repeat(128)}`, // not a sha256 digest
    `${img()}@${DIGEST}`, // two @ separators
  ];
  for (const image of badImages) {
    put(root, "bad", { image });
    await assert.rejects(store.resolve("bad"), TemplateError);
  }
});

test("example templates resolve through the same validate path", async () => {
  const store = new DirTemplateStore({ root: examplesDir });
  assert.deepEqual((await store.list()).map((t) => t.id).sort(), ["researcher"]);

  const researcher = await store.resolve("researcher");
  assert.ok(researcher);
  assert.deepEqual(researcher.extensions, ["web_search", "web_fetch"]);
  assert.deepEqual(researcher.egress, { kind: "registry" });
  assert.ok(researcher.image && /@sha256:[0-9a-f]{64}$/.test(researcher.image));
});

test("resume, requires, shmBytes and runtime are accepted and normalized", async () => {
  const { root, store } = setup();
  put(root, "gpu", {
    resume: "task",
    requires: ["gpu", "gpu", "nvme"],
    shmBytes: 1024,
    runtime: { docker: { privileged: false }, list: [1] },
  });
  assert.deepEqual(await store.resolve("gpu"), {
    id: "gpu",
    resume: "task",
    requires: ["gpu", "nvme"],
    shmBytes: 1024,
    runtime: { docker: { privileged: false }, list: [1] },
    egress: { kind: "none" },
  });
  for (const resume of ["session", "task", "none"]) {
    put(root, "r", { resume });
    assert.equal((await store.resolve("r"))?.resume, resume);
  }
});

test("absent resume, requires, shmBytes and runtime stay absent", async () => {
  const { root, store } = setup();
  put(root, "plain", {});
  assert.deepEqual(await store.resolve("plain"), { id: "plain", egress: { kind: "none" } });
});

test("bad resume, requires, shmBytes or runtime raise TemplateError", async () => {
  const { root, store } = setup();
  const bads: Record<string, unknown>[] = [
    { resume: "always" },
    { resume: 1 },
    { resume: null },
    { requires: "gpu" },
    { requires: [""] },
    { requires: [1] },
    { requires: null },
    { shmBytes: -1 },
    { shmBytes: "1" },
    { runtime: [] },
    { runtime: "docker" },
    { runtime: null },
    { runtime: 3 },
  ];
  for (const b of bads) {
    put(root, "bad", { ...b });
    await assert.rejects(store.resolve("bad"), TemplateError, JSON.stringify(b));
  }
});

test("a code.json-style manifest round trips and there is no built-in code", async () => {
  const { root, store } = setup();
  assert.equal(await store.resolve("code"), null);
  put(root, "code", { resume: "session" });
  assert.deepEqual(await store.resolve("code"), { id: "code", resume: "session", egress: { kind: "none" } });
  assert.deepEqual(
    (await store.list()).map((t) => t.id),
    ["code"],
  );
});

const AUDITED = { kind: "audited-public" };

test("browser limits are accepted with audited-public egress and normalized", async () => {
  const { root, store } = setup();
  put(root, "web", { egress: AUDITED, browser: { maxSteps: 1, maxMs: 1000 } });
  assert.deepEqual((await store.resolve("web"))?.browser, { maxSteps: 1, maxMs: 1000 });
  put(root, "web", { egress: AUDITED, browser: { maxSteps: 256, maxMs: 600_000 } });
  assert.deepEqual((await store.resolve("web"))?.browser, { maxSteps: 256, maxMs: 600_000 });
  put(root, "plain", {});
  assert.equal("browser" in ((await store.resolve("plain")) as object), false);
});

test("bad browser blocks raise TemplateError", async () => {
  const { root, store } = setup();
  const ok = { maxSteps: 10, maxMs: 5000 };
  const cases: Record<string, unknown>[] = [
    { egress: AUDITED, browser: null },
    { egress: AUDITED, browser: [] },
    { egress: AUDITED, browser: "x" },
    { egress: AUDITED, browser: { maxMs: 5000 } },
    { egress: AUDITED, browser: { maxSteps: 10 } },
    { egress: AUDITED, browser: { ...ok, extra: 1 } },
    { egress: AUDITED, browser: { ...ok, maxSteps: 0 } },
    { egress: AUDITED, browser: { ...ok, maxSteps: 257 } },
    { egress: AUDITED, browser: { ...ok, maxSteps: 1.5 } },
    { egress: AUDITED, browser: { ...ok, maxSteps: "10" } },
    { egress: AUDITED, browser: { ...ok, maxMs: 999 } },
    { egress: AUDITED, browser: { ...ok, maxMs: 600_001 } },
    { egress: AUDITED, browser: { ...ok, maxMs: 1000.5 } },
    { egress: AUDITED, browser: { ...ok, maxMs: null } },
    { browser: ok },
    { egress: { kind: "none" }, browser: ok },
    { egress: { kind: "registry" }, browser: ok },
    { egress: { kind: "allowlist", hosts: ["a.test"] }, browser: ok },
  ];
  for (const c of cases) {
    put(root, "b", c);
    await assert.rejects(() => store.resolve("b"), TemplateError, JSON.stringify(c));
  }
});

test("browser.profile names a closed profile: interactive is carried through with audited-public egress, anything else is refused", async () => {
  const { root, store } = setup();
  const ok = { maxSteps: 30, maxMs: 300_000 };
  put(root, "i", { egress: AUDITED, browser: { ...ok, profile: "interactive" } });
  assert.deepEqual((await store.resolve("i"))?.browser, { ...ok, profile: "interactive" });
  // Absent stays absent (the capture-only worker), so an existing capture template's normalized form and digest are unchanged.
  put(root, "c", { egress: AUDITED, browser: ok });
  assert.equal("profile" in ((await store.resolve("c"))?.browser ?? {}), false);
  for (const profile of ["capture", "", "INTERACTIVE", null, 1, ["interactive"], { name: "interactive" }]) {
    put(root, "bad", { egress: AUDITED, browser: { ...ok, profile } });
    await assert.rejects(store.resolve("bad"), TemplateError, JSON.stringify(profile));
  }
  for (const [label, bad] of [
    ["no egress", { browser: { ...ok, profile: "interactive" } }],
    ["allowlist egress", { egress: { kind: "allowlist", hosts: ["a.test"] }, browser: { ...ok, profile: "interactive" } }],
    ["none egress", { egress: { kind: "none" }, browser: { ...ok, profile: "interactive" } }],
    ["with an allowlist profile", { egress: AUDITED, allowlist: "analyst", browser: { ...ok, profile: "interactive" } }],
  ] as const) {
    put(root, "bad", bad);
    await assert.rejects(store.resolve("bad"), TemplateError, label);
  }
});

test("diskBytes is carried through validation and validated like the other byte limits", async () => {
  const { root, store } = setup();
  put(root, "d", { diskBytes: 4096 });
  assert.equal((await store.resolve("d"))?.diskBytes, 4096);
  put(root, "neg", { diskBytes: -1 });
  await assert.rejects(store.resolve("neg"), TemplateError);
});

test("allowlist names a closed profile: analyst is carried through, anything else is refused", async () => {
  const { root, store } = setup();
  put(root, "an", { allowlist: "analyst" });
  assert.equal((await store.resolve("an"))?.allowlist, "analyst");
  put(root, "plain", {});
  assert.equal("allowlist" in ((await store.resolve("plain")) ?? {}), false);
  for (const bad of ["shell", "", "ANALYST", null, 1, ["analyst"], { name: "analyst" }]) {
    put(root, "bad", { allowlist: bad });
    await assert.rejects(store.resolve("bad"), TemplateError, JSON.stringify(bad));
  }
});

test("disposition is carried through when valid; a bad mode, a bad ttlMs and reap-on-exit with ttlMs are refused; absent stays absent", async () => {
  const { root, store } = setup();
  put(root, "d", { disposition: { mode: "hold", ttlMs: 5000 } });
  assert.deepEqual((await store.resolve("d"))?.disposition, { mode: "hold", ttlMs: 5000 });
  put(root, "r", { disposition: { mode: "reap-on-exit" } });
  assert.deepEqual((await store.resolve("r"))?.disposition, { mode: "reap-on-exit" });
  put(root, "extra", { disposition: { mode: "hold", extra: 1 } });
  assert.deepEqual((await store.resolve("extra"))?.disposition, { mode: "hold" }, "unknown keys are not copied");
  put(root, "plain", {});
  assert.equal("disposition" in ((await store.resolve("plain")) ?? {}), false);
  for (const bad of [{ mode: "keep" }, { mode: "hold", ttlMs: 0 }, { mode: "hold", ttlMs: 1.5 }, { mode: "reap-on-exit", ttlMs: 10 }, "hold", null]) {
    put(root, "bad", { disposition: bad });
    await assert.rejects(store.resolve("bad"), TemplateError, JSON.stringify(bad));
  }
});

const browseExample = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples", "browse-agent");
const browse = { allowlist: "browse", extensions: ["web_fetch"], egress: { kind: "allowlist", hosts: ["example.com"] } };

test("the shipped interactive browsing example validates as an interactive browser worker with audited-public egress", async () => {
  const ex = await new DirTemplateStore({ root: browseExample }).resolve("browse-interactive-haiku");
  assert.deepEqual(ex?.browser, { maxSteps: 30, maxMs: 600_000, profile: "interactive" });
  assert.deepEqual(ex?.egress, { kind: "audited-public" });
  assert.equal(ex?.provider, "openrouter");
  assert.equal(ex?.model, "anthropic/claude-haiku-5.5");
  assert.equal(ex?.budgetMicros, 200_000);
  assert.equal("allowlist" in (ex ?? {}), false);
  assert.match(ex?.systemPrompt ?? "", /untrusted/);
  assert.match(ex?.systemPrompt ?? "", /capture_finish/);
});

test("browse profile: the shipped example validates, and the pairing with web_fetch and an allowlist egress is enforced", async () => {
  const ex = await new DirTemplateStore({ root: browseExample }).resolve("browse-haiku");
  assert.equal(ex?.allowlist, "browse");
  assert.deepEqual(ex?.extensions, ["web_fetch"]);
  assert.equal(ex?.egress?.kind, "allowlist");
  assert.equal(ex?.model, "anthropic/claude-haiku-5.5");
  const { root, store } = setup();
  put(root, "ok", browse);
  assert.equal((await store.resolve("ok"))?.allowlist, "browse");
  for (const [label, bad] of [
    ["no extensions", { ...browse, extensions: undefined }],
    ["web_search only", { ...browse, extensions: ["web_search"] }],
    ["no egress", { ...browse, egress: undefined }],
    ["registry egress", { ...browse, egress: { kind: "registry" } }],
    ["audited-public egress", { ...browse, egress: { kind: "audited-public" } }],
  ] as const) {
    put(root, "bad", bad);
    await assert.rejects(store.resolve("bad"), TemplateError, label);
  }
});

test("every Template key is handled by validate or listed as intentionally ignored", async () => {
  const { HANDLED_TEMPLATE_KEYS } = await import("./index.ts");
  assert.ok(HANDLED_TEMPLATE_KEYS.includes("diskBytes"));
});

test("a systemPrompt with NUL or over the byte bound is refused", async () => {
  const { root, store } = setup();
  put(root, "nul", { image: img(), systemPrompt: "a\0b" });
  await assert.rejects(store.resolve("nul"), /NUL/);
  put(root, "big", { image: img(), systemPrompt: "x".repeat(SYSTEM_PROMPT_MAX_BYTES + 1) });
  await assert.rejects(store.resolve("big"), /at most/);
  put(root, "ok", { image: img(), systemPrompt: "x".repeat(SYSTEM_PROMPT_MAX_BYTES) });
  assert.ok(await store.resolve("ok"));
});

test("analyst and specialist profiles: no listed extensions and only relay egress; each refusal names the template, the rule and the fix", async () => {
  const { root, store } = setup();
  for (const profile of ["analyst", "specialist"] as const) {
    for (const egress of [undefined, { kind: "none" }, { kind: "registry" }]) {
      put(root, "ok", { allowlist: profile, provider: "p", model: "m", ...(egress && { egress }) });
      const t = await store.resolve("ok");
      assert.equal(t?.allowlist, profile);
      assert.equal(t?.egress?.kind, egress?.kind ?? "none");
      assert.equal("extensions" in (t ?? {}), false);
    }
    for (const [label, bad, message] of [
      [
        "web_fetch",
        { extensions: ["web_fetch"] },
        /^template error: bad-ext: allowlist \S+ loads only its own profile extension: remove extensions \["web_fetch"\] from the template$/,
      ],
      ["web_search", { extensions: ["web_search"], egress: { kind: "registry" } }, /remove extensions \["web_search"\]/],
      [
        "allowlist egress",
        { egress: { kind: "allowlist", hosts: ["a.test"] } },
        /^template error: bad-net: allowlist \S+ has no network beyond the node relay: egress.kind must be none or registry, not allowlist; set egress to \{"kind":"registry"\}$/,
      ],
      ["audited-public egress", { egress: { kind: "audited-public" } }, /not audited-public; set egress/],
    ] as const) {
      const file = label.startsWith("web") ? "bad-ext" : "bad-net";
      put(root, file, { allowlist: profile, ...bad });
      await assert.rejects(
        store.resolve(file),
        (e: unknown) => e instanceof TemplateError && message.test(e.message) && e.message.includes(`allowlist ${profile}`),
        `${profile} ${label}`,
      );
    }
  }
});

test("analyst and specialist template files with an env are refused at load", async () => {
  const { root, store } = setup();
  for (const profile of ["analyst", "specialist"] as const) {
    put(root, "bad-env", { allowlist: profile, env: { kind: "python", packages: ["numpy"] } });
    await assert.rejects(
      store.resolve("bad-env"),
      (e: unknown) =>
        e instanceof TemplateError &&
        e.message.startsWith("template error: bad-env: ") &&
        e.message.includes(`allowlist ${profile}`) &&
        e.message.includes("remove env from the template"),
      profile,
    );
  }
});
