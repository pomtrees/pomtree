import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { conformanceCommand } from "../scripts/sandbox-conformance.ts";

// The template sandbox backend (examples/sandbox-loopback) and its seeded broken copy (packages/testing/src/sandbox-loopback-broken),
// run through the real entry command, `pnpm conformance:sandbox`, in process. The template must pass; the copy carries four marked
// defects and must fail on exactly the four clauses they name, so the command and the suite are shown able to catch each one.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const TEMPLATE = join(ROOT, "examples", "sandbox-loopback");
const BROKEN = join(ROOT, "packages", "testing", "src", "sandbox-loopback-broken");
const SEEDED = ["label-rules", "lifecycle-run", "list-by-owner", "user-agent-stamped"];

async function run(dir: string) {
  const out: string[] = [];
  const err: string[] = [];
  const rc = await conformanceCommand([dir], { out: (l) => out.push(l), err: (l) => err.push(l), cwd: ROOT });
  return { rc, out, text: [...out, ...err].join("\n") };
}
const failed = (out: readonly string[]) =>
  out
    .filter((l) => l.startsWith("FAIL "))
    .map((l) => l.slice(5, l.indexOf(":")))
    .sort();

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

test("the loopback template passes the conformance command: exit 0, no failed clause, no floor finding", async () => {
  const r = await run(TEMPLATE);
  assert.equal(r.rc, 0, r.text);
  assert.match(r.text, /^pin: loopback=sha256:[0-9a-f]{64}$/m);
  assert.deepEqual(failed(r.out), [], r.text);
  assert.ok(!r.out.some((l) => l.startsWith("FLOOR ")), r.text);
  assert.ok(r.out.includes("PASS user-agent-stamped") && r.out.includes("PASS unknown-outcome-retry"), r.text);
});

test("the seeded broken copy fails the conformance command on exactly its four seeded clauses", async () => {
  const r = await run(BROKEN);
  assert.equal(r.rc, 1, r.text);
  assert.deepEqual(failed(r.out), SEEDED, r.text);
  // The list defect also leaves list.byTag uncovered, which the floor reports; nothing else may.
  assert.deepEqual(
    r.out.filter((l) => l.startsWith("FLOOR ")),
    ["FLOOR backend loopback declares list.byTag, but none of its clauses (list-by-owner) passed; run them, or declare list.byTag false"],
    r.text,
  );
});

test("the broken copy is the template plus marked defects: same files, only provider.mts differs, one marker per seeded clause", () => {
  const own = new Set(["README.md", "tsconfig.json", "wire.test.mts"]); // the template's docs, typecheck config and unit tests stay out of the copy
  assert.deepEqual(
    files(BROKEN).filter((f) => f !== "README.md"),
    files(TEMPLATE).filter((f) => !own.has(f)),
  );
  for (const f of files(BROKEN).filter((x) => x !== "README.md" && x !== "provider.mts")) {
    assert.equal(readFileSync(join(BROKEN, f), "utf8"), readFileSync(join(TEMPLATE, f), "utf8"), `${f} must be byte-identical to the template's`);
  }
  const provider = readFileSync(join(BROKEN, "provider.mts"), "utf8");
  const markers = [...provider.matchAll(/Seeded defect \(([a-z-]+)\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(markers, SEEDED);
});
