import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DirTemplateStore } from "../../packages/template-dir/src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const IDS = ["wiki-reader", "wiki-orchestrator", "wiki-distiller"] as const;
const PROMPT_FILE = { "wiki-reader": "reader", "wiki-orchestrator": "orchestrator", "wiki-distiller": "distiller" } as const;
const read = (rel: string) => readFileSync(join(HERE, rel), "utf8");
const manifest = (id: string) => JSON.parse(read(`templates/${id}.json`)) as Record<string, unknown>;
const prompt = (id: (typeof IDS)[number]) => read(`prompts/${PROMPT_FILE[id]}.md`);

// Words and path fragments that must never appear in committed files; assembled so this file does not contain them itself.
const BANNED_VERB = new RegExp(`${"mi"}${"nt"}`, "i");
const BANNED = [BANNED_VERB, /innerHTML/, new RegExp(`/${"home"}|/${"tmp"}|${"tok"}en|${"sec"}ret`, "i")];

function budgets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of read("budgets.env").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function tempStore(mutate?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "wiki-distill-tpl-"));
  cpSync(join(HERE, "templates"), dir, { recursive: true });
  mutate?.(dir);
  return { dir, store: new DirTemplateStore({ root: dir }), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("wiki-distill templates", () => {
  it("each template loads through the real loader with id = file stem", async () => {
    const t = tempStore();
    try {
      for (const id of IDS) {
        const loaded = await t.store.resolve(id);
        assert.ok(loaded, id);
        assert.equal(loaded.id, id);
        assert.equal(loaded.provider, "openrouter");
        assert.equal(loaded.model, "anthropic/claude-haiku-5.5");
      }
      const reader = await t.store.resolve("wiki-reader");
      // TODO(wiki-distill-live-validation): nothing here has run against a live model or Wikipedia; this only checks the reader keeps a 24-step interactive budget. Unverified: the editorial quality, whether a small model follows the 24-step plan, and the slice URLs against the browser result cap.
      assert.deepEqual(reader?.browser, { maxSteps: 24, maxMs: 600000, profile: "interactive" });
      // TODO(wiki-distill-fetch-reader): the reader is an audited-public browser agent (the loader requires it), so the Wikipedia-only rule rests on the reader prompt; a web_fetch-only agent could be host-confined but has no handoff path.
      assert.equal(reader?.egress.kind, "audited-public");
      assert.equal((await t.store.resolve("wiki-orchestrator"))?.egress.kind, "registry");
      assert.equal((await t.store.resolve("wiki-distiller"))?.egress.kind, "registry");
      assert.equal((await t.store.list()).length, 3);
    } finally {
      t.done();
    }
  });

  it("negative control: the loader refuses a browser template with allowlist egress", async () => {
    const t = tempStore((dir) => {
      const broken = { ...manifest("wiki-reader"), egress: { kind: "allowlist", hosts: ["en.wikipedia.org"] } };
      writeFileSync(join(dir, "wiki-reader.json"), JSON.stringify(broken));
    });
    try {
      await assert.rejects(() => t.store.resolve("wiki-reader"), /browser requires egress\.kind audited-public/);
    } finally {
      t.done();
    }
  });

  it("negative control: a template file whose name field differs from its stem is refused", async () => {
    const t = tempStore((dir) => writeFileSync(join(dir, "wiki-reader.json"), JSON.stringify({ ...manifest("wiki-reader"), name: "other" })));
    try {
      await assert.rejects(() => t.store.resolve("wiki-reader"), /does not match the file stem/);
    } finally {
      t.done();
    }
  });

  const parity = (id: (typeof IDS)[number], m: Record<string, unknown>) => m.systemPrompt === prompt(id).trim();

  it("systemPrompt equals prompts/*.md trimmed", () => {
    for (const id of IDS) assert.ok(parity(id, manifest(id)), id);
  });

  it("negative control: a mutated embedded systemPrompt fails the parity check", () => {
    for (const id of IDS) {
      const m = manifest(id);
      assert.ok(parity(id, m), id);
      assert.ok(!parity(id, { ...m, systemPrompt: `${m.systemPrompt as string} extra` }), id);
      assert.ok(!parity(id, { ...m, systemPrompt: (m.systemPrompt as string).replace("a", "b") }), id);
    }
  });

  it("orchestrator prompt routes tasks and results through files", () => {
    const p = prompt("wiki-orchestrator");
    assert.ok(p.includes('--task "$(cat /workspace/task-<i>.txt)"'));
    assert.ok(p.includes("--summary-file /workspace/brief.txt"));
    assert.ok(p.includes("--summary-file /workspace/result.txt"));
    assert.ok(!/--task "<instructions>"/.test(p));
    assert.ok(!/--summary '<(brief|text)>'/.test(p), "no inline quoted summary");
  });

  it("reader prompt: skip list, conditional snapshot, REV line, no 'two forms'", () => {
    const p = prompt("wiki-reader");
    for (const w of ["References", "Notes", "Footnotes", "Citations", "Bibliography", "Sources", "Further reading", "See also", "External links", "Gallery"])
      assert.ok(p.includes(w), w);
    assert.ok(/only when the navigate result does not show/.test(p));
    assert.ok(p.includes("REV: <REV>"));
    assert.ok(p.includes("the forms below"));
    assert.ok(!p.includes("two forms"));
  });

  it("distiller prompt takes the footer revision from the task verbatim", () => {
    assert.ok(prompt("wiki-distiller").includes("REVISION value from your task exactly as given"));
  });

  it("systemPrompt and prompt files stay under the size limits", () => {
    for (const id of IDS) {
      assert.ok(Buffer.byteLength(manifest(id).systemPrompt as string) < 32768, id);
      assert.ok(Buffer.byteLength(prompt(id)) < 6144, `${id} prompt must stay under 6 KiB`);
    }
  });

  it("budgets.env keys match template budgetMicros and the contract numbers", () => {
    const b = budgets();
    assert.equal(b.MODEL, "openrouter/anthropic/claude-haiku-5.5");
    assert.equal(b.READER_MICROS, "400000");
    assert.equal(b.ORCHESTRATOR_MICROS, "600000");
    assert.equal(b.SUMMARIZER_MICROS, "60000");
    assert.equal(b.DISTILLER_MICROS, "300000");
    assert.equal(manifest("wiki-reader").budgetMicros, Number(b.READER_MICROS));
    assert.equal(manifest("wiki-orchestrator").budgetMicros, Number(b.ORCHESTRATOR_MICROS));
    assert.equal(manifest("wiki-distiller").budgetMicros, Number(b.DISTILLER_MICROS));
  });

  it("the orchestrator prompt spawns summarizers with the budget literal from budgets.env", () => {
    const p = prompt("wiki-orchestrator");
    assert.ok(p.includes(`--budget ${budgets().SUMMARIZER_MICROS}`));
    assert.ok(p.includes("WIKI-SUMMARIZER-TASK"));
    assert.ok(p.includes("wiki-summarizer-<i>"));
    assert.ok(p.includes("wd-<RUN>-sum-<i>"));
    assert.ok(p.includes("NOT READ"));
    assert.ok(p.includes("pomtree reap"));
    assert.ok(p.includes("pomtree result --summary"));
    assert.ok(!/pomtree wait \S+ --timeout (\d{6,}|[3-9]\d{4})/.test(p), "no long blocking wait");
  });

  it("committed files contain no banned words, local paths or credentials words", () => {
    const files = [...IDS.map((id) => `templates/${id}.json`), ...Object.values(PROMPT_FILE).map((f) => `prompts/${f}.md`), "budgets.env"];
    for (const f of files) for (const re of BANNED) assert.ok(!re.test(read(f)), `${f} matches ${re}`);
  });

  it("negative control: the banned-word scan can fail", () => {
    assert.ok(BANNED.every((re) => re.test(`${"mi"}${"nt"} innerHTML /${"home"} /${"tmp"} ${"tok"}en ${"sec"}ret`)));
  });

  it("reader prompt has every section-URL form, the one host and no other hostname", () => {
    const p = prompt("wiki-reader");
    for (const form of [
      "https://en.wikipedia.org/w/api.php?action=parse&page=<TITLE_PARAM>&prop=sections&format=json&formatversion=2",
      "https://en.wikipedia.org/w/api.php?action=parse&oldid=<OLDID>&prop=sections&format=json&formatversion=2",
      "https://en.wikipedia.org/w/api.php?action=parse&oldid=<REV>&prop=wikitext&section=<K>&format=json&formatversion=2",
      "https://en.wikipedia.org/w/api.php?action=parse&page=<TITLE_PARAM>&prop=wikitext&section=<K>&format=json&formatversion=2",
    ])
      assert.ok(p.includes(form), form);
    const hosts = new Set([...p.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]));
    assert.deepEqual([...hosts], ["en.wikipedia.org"]);
    for (const needle of ["p mod N == r0", "SECTIONS", "capture_finish", "NOT READ", "=== NOTES", "3500", "untrusted", "24"])
      assert.ok(p.includes(needle), needle);
  });

  it("distiller prompt carries the publish command and the editorial demands", () => {
    const p = prompt("wiki-distiller");
    assert.ok(p.includes("pomtree report publish /workspace/distillation.html --name distillation.html --key <REPORT_KEY>"));
    assert.ok(p.indexOf("pomtree report publish") < p.indexOf("pomtree result --summary 'published distillation.html'"));
    for (const needle of [
      "thesis",
      "IMPORTANCE",
      "SOURCE_URL",
      "REVISION",
      "NOT READ",
      "prefers-color-scheme",
      "<style>",
      "published <id>",
      "already published <id>",
    ])
      assert.ok(p.includes(needle), needle);
    assert.ok(/no script/i.test(p));
    assert.ok(/no bullet/i.test(p));
  });
});
