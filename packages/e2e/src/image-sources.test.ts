import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// scripts/image-sources.sh (IMGSRC, image_label_current) is what pomtree-up and gate-series use to decide whether the agent image is current.
// Offline: reads the Dockerfile and runs the sourced bash function in throwaway git repos.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = join(repoRoot, "scripts/image-sources.sh");
const cleanup: string[] = [];
after(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

function imgsrc(): string[] {
  const r = spawnSync("bash", ["-c", `source ${JSON.stringify(script)}; echo "$IMGSRC"`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const list = r.stdout.trim().split(/\s+/).filter(Boolean);
  assert.ok(list.length > 0, "IMGSRC is empty");
  return list;
}

const covered = (path: string, list: string[]) => list.some((e) => path === e || path.startsWith(`${e.replace(/\/$/, "")}/`));

// Source paths of every COPY that reads from the build context (not --from=) into an absolute destination, repo-relative ones only.
function dockerfileSources(): string[] {
  const text = readFileSync(join(repoRoot, "packages/agent-image/Dockerfile"), "utf8").replace(/\\\n/g, " ");
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!/^\s*COPY\s/i.test(line)) continue;
    const args = line.trim().split(/\s+/).slice(1);
    if (args.some((a) => a.startsWith("--from="))) continue;
    const paths = args.filter((a) => !a.startsWith("--"));
    for (const src of paths.slice(0, -1)) {
      if (src.startsWith("/")) continue;
      out.push(src);
    }
  }
  return out;
}

test("every Dockerfile COPY source from the build context lies under an IMGSRC entry", () => {
  const list = imgsrc();
  const sources = dockerfileSources();
  assert.ok(sources.length > 5, `parsed too few COPY sources: ${sources.join(" ")}`);
  assert.ok(sources.some((s) => s.startsWith("packages/agent-image/")));
  const outside = sources.filter((s) => (s.startsWith("packages/") || !s.includes("/")) && !covered(s, list));
  assert.deepEqual(outside, [], `COPY sources outside IMGSRC (widen IMGSRC in scripts/image-sources.sh): ${outside.join(" ")}`);
});

test("negative control: the coverage check rejects a path outside IMGSRC", () => {
  const list = imgsrc();
  assert.equal(covered("packages/observe/src/x.ts", list), false);
  assert.equal(covered("packages/agent-image-extra/x.ts", list), false);
  assert.equal(covered("packages/agent-image/src/x.ts", list), true);
});

test("image_label_current: HEAD, docs-only ancestor and unrelated outcomes in a throwaway repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "image-sources-test-"));
  cleanup.push(dir);
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@localhost", ...a], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const commit = (rel: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), `${rel}\n`);
    git("add", rel);
    git("commit", "-q", "-m", rel);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const base = commit("package.json");
  const check = (label: string) => {
    const r = spawnSync("bash", ["-c", `source ${JSON.stringify(script)}; image_label_current "$1" "$2"`, "x", dir, label], { encoding: "utf8" });
    assert.equal(r.stdout + r.stderr, "", "the function prints nothing");
    return r.status;
  };
  assert.equal(check(base), 0, "full sha equal to HEAD");
  assert.equal(check(base.slice(0, 7)), 0, "short sha equal to HEAD");
  commit("docs/a.md");
  commit("packages/observe/src/x.ts");
  assert.equal(check(base), 0, "ancestor, only non-image paths changed");
  assert.equal(check(base.slice(0, 7)), 0);
  commit("packages/pomtree/src/main.ts");
  assert.notEqual(check(base), 0, "an image source changed since the label");
  assert.equal(check(git("rev-parse", "HEAD")), 0, "label equal to the new HEAD");
  assert.notEqual(check(""), 0, "empty label");
  assert.notEqual(check("deadbeef"), 0, "unresolvable label");
  git("checkout", "-q", "--orphan", "other");
  const orphan = commit("docs/b.md");
  assert.equal(check(orphan), 0, "HEAD of the other history");
  assert.notEqual(check(base), 0, "label from a history that is not an ancestor");
});
