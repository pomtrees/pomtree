import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { SANDBOX_PORT_VERSION } from "@pomtree/core";
import type { Sandbox, SandboxBackendDeps } from "@pomtree/core";
import { brokenSandbox, FakeSandbox, scaled } from "@pomtree/testing";
import { conformanceCommand } from "../scripts/sandbox-conformance.ts";
import { parseManifest } from "./extension-manifest.ts";
import { measureExtensionTree } from "./sandbox-provider-load.ts";

// The entry command over fixture extensions written to os.tmpdir() here (none is checked in). The fixture provider's `create` calls a
// factory this test installs on globalThis, which wraps the shared FakeSandbox: the extension itself may import only node: builtins and
// the shipped packages, so it cannot import @pomtree/testing.

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  delete g.__pomtreeConformanceFixture;
  seen = [];
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pomtree-conformance-cmd-"));
  roots.push(d);
  return d;
}

const script = join(import.meta.dirname, "..", "scripts", "sandbox-conformance.ts");
const ID = "cfix";
type Factory = (deps: SandboxBackendDeps) => Sandbox;
const g = globalThis as { __pomtreeConformanceFixture?: Factory };
let seen: SandboxBackendDeps[] = [];
function useSandbox(make: () => Sandbox): void {
  seen = [];
  g.__pomtreeConformanceFixture = (deps) => {
    seen.push(deps);
    return make();
  };
}
const fake = () => new FakeSandbox([], "graceful", { declaration: { backend: ID } });

function writeExtension(opts: { providerExtra?: string; conformance?: string | null } = {}): string {
  const dir = join(tmp(), "ext");
  mkdirSync(dir);
  const declaration = JSON.stringify(fake().declaration);
  const files: Record<string, string> = {
    "manifest.json": JSON.stringify({
      apiVersion: 2,
      name: ID,
      entry: "entry.mjs",
      capabilities: {},
      deps: [],
      provides: [
        {
          kind: "sandbox",
          id: ID,
          entry: "provider.mjs",
          portVersion: SANDBOX_PORT_VERSION,
          credentials: ["apiKey"],
          params: [{ key: "region", kind: "string", doc: "Region.", default: "local" }],
        },
      ],
    }),
    "entry.mjs": "export default {};\n",
    "provider.mjs": `${opts.providerExtra ?? ""}
export const portVersion = ${SANDBOX_PORT_VERSION};
export const declaration = ${declaration};
export function create(deps) { return globalThis.__pomtreeConformanceFixture(deps); }
`,
  };
  // The shared fake cannot stamp the host and generation tags on its listings, so its descriptor relaxes that, as fakeSandboxUnderTest does.
  const conformance = opts.conformance === undefined ? `export default ({ base }) => ({ ...base });\n` : opts.conformance;
  if (conformance !== null) files["conformance.mts"] = conformance;
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, rel), text);
  return dir;
}

async function run(argv: string[], afterPin?: (dir: string) => void) {
  const out: string[] = [];
  const err: string[] = [];
  const rc = await conformanceCommand(argv, { out: (l) => out.push(l), err: (l) => err.push(l), cwd: process.cwd(), ...(afterPin && { afterPin }) });
  return { rc, out, err, text: [...out, ...err].join("\n") };
}

test("an invalid manifest exits non-zero and prints the daemon's parse message verbatim (the real command line)", () => {
  const dir = join(tmp(), "bad");
  mkdirSync(dir);
  const raw = JSON.stringify({ apiVersion: 2, name: "Bad Name", entry: "entry.mjs" });
  writeFileSync(join(dir, "manifest.json"), raw);
  let expected = "";
  try {
    parseManifest(raw);
  } catch (e) {
    expected = (e as Error).message;
  }
  assert.ok(expected !== "", "the fixture manifest must be one the daemon's parser refuses");
  const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8", timeout: scaled(60_000), env: { ...process.env, INIT_CWD: process.cwd() } });
  assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(r.stderr.split("\n").includes(expected), `stderr must hold the parser's message ${JSON.stringify(expected)} on its own line; got ${r.stderr}`);
});

// The real command line: a child `node <script> ext` run from another directory, with INIT_CWD (set by pnpm) naming where the relative
// directory resolves. A preload written next to the fixture installs the fixture factory in the child, since the child shares no globals.
function spawnCommand(breakMode?: string) {
  const dir = writeExtension();
  const testing = pathToFileURL(join(import.meta.dirname, "..", "..", "testing", "src", "index.ts")).href;
  const preload = join(dirname(dir), "preload.mjs");
  const make = breakMode === undefined ? "fake()" : `brokenSandbox(fake(), ${JSON.stringify(breakMode)})`;
  writeFileSync(
    preload,
    `import { FakeSandbox, brokenSandbox } from ${JSON.stringify(testing)};
const fake = () => new FakeSandbox([], "graceful", { declaration: { backend: ${JSON.stringify(ID)} } });
globalThis.__pomtreeConformanceFixture = () => ${make};
`,
  );
  return spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, script, "ext"], {
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: scaled(60_000),
    env: { ...process.env, INIT_CWD: dirname(dir) },
  });
}

test("the real command line: a conformant fixture extension exits 0 with the summary and floor lines", () => {
  const r = spawnCommand();
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /^pin: cfix=sha256:[0-9a-f]{64}$/m);
  assert.match(r.stdout, /^CONFORMANCE cfix: conformance: \d+ passed, 0 failed/m);
  assert.match(r.stdout, /^CONFORMANCE cfix floor: \d+ capabilities covered, \d+ deferred$/m);
});

test("the real command line: a fixture whose sandbox breaks a clause exits 1 naming it", () => {
  const r = spawnCommand("swallow-exit-code");
  assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /^FAIL lifecycle-run:/m);
});

test("a conformant fixture extension passes through the whole path: pin, guarded load, facade deps, clauses and floor", async () => {
  useSandbox(fake);
  const dir = writeExtension();
  const r = await run([dir]);
  assert.equal(r.rc, 0, r.text);
  assert.ok(r.out.includes(`pin: ${ID}=${measureExtensionTree(dir).hash}`), r.text);
  assert.ok(r.out.includes("PASS lifecycle-run"), r.text);
  assert.ok(
    r.out.some((l) => l.startsWith(`CONFORMANCE ${ID}: conformance: `) && l.includes(" 0 failed")),
    r.text,
  );
  assert.ok(
    r.out.some((l) => /^CONFORMANCE cfix floor: \d+ capabilities covered, \d+ deferred$/.test(l)),
    r.text,
  );
  assert.ok(!r.out.some((l) => l.startsWith("FAIL ") || l.startsWith("FLOOR ")), r.text);
  // The provider was built from the daemon's facade: frozen, a sentinel for its declared credential, the param default as config.
  const deps = seen[0];
  assert.ok(deps !== undefined && Object.isFrozen(deps));
  assert.equal(await deps.credential("apiKey"), `conformance-sentinel-${ID}-apiKey`);
  await assert.rejects(() => deps.credential("other"), /did not declare/);
  assert.deepEqual(deps.config, { region: "local" });
  await assert.rejects(() => deps.fetch("https://example.invalid/"), /only loopback hosts are reachable/);
});

test("a fixture whose sandbox breaks a clause exits 1 naming the clause", async () => {
  useSandbox(() => brokenSandbox(fake(), "swallow-exit-code"));
  const r = await run([writeExtension()]);
  assert.equal(r.rc, 1, r.text);
  assert.ok(
    r.out.some((l) => l.startsWith("FAIL lifecycle-run:")),
    r.text,
  );
});

test("without conformance.mts the owner stamp is required, so a backend that does not report it fails owner-stamp and the stamping fake passes it", async () => {
  const unstamped = (): Sandbox =>
    new Proxy(fake(), {
      get(target, prop) {
        if (prop === "list") return async (o: Parameters<Sandbox["list"]>[0]) => (await target.list(o)).map((l) => ({ ...l, host: null, generation: null }));
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  useSandbox(unstamped);
  const r = await run([writeExtension({ conformance: null })]);
  assert.equal(r.rc, 1, r.text);
  assert.ok(
    r.out.some((l) => l.startsWith("FAIL owner-stamp:") && l.includes("must report the host")),
    r.text,
  );
  useSandbox(fake);
  const ok = await run([writeExtension({ conformance: null })]);
  assert.ok(!ok.out.some((l) => l.startsWith("FAIL owner-stamp")), ok.text);
});

test("a file changed after pinning is refused before anything is imported", async () => {
  let created = 0;
  useSandbox(() => {
    created++;
    return fake();
  });
  const r = await run([writeExtension()], (dir) => appendFileSync(join(dir, "provider.mjs"), "\n// changed after review\n"));
  assert.equal(r.rc, 2, r.text);
  assert.match(r.text, /does not match its pin/);
  assert.equal(created, 0);
});

test("the resolve guard is installed: a provider importing an unshipped package is refused", async () => {
  useSandbox(fake);
  const r = await run([writeExtension({ providerExtra: 'import "@pomtree/testing";' })]);
  assert.equal(r.rc, 2, r.text);
  assert.match(r.text, /may not import "@pomtree\/testing"/);
});

test("a backend gated by its conformance.mts (no live endpoint here) exits non-zero, unless --accept-closed", async () => {
  useSandbox(fake);
  const dir = writeExtension({
    conformance: `export default ({ base }) => ({ ...base, gate: () => "no live endpoint in this run" });\n`,
  });
  const closed = await run([dir]);
  assert.equal(closed.rc, 1, closed.text);
  assert.ok(
    closed.out.some((l) => l === "GATED lifecycle-run: conformance gated: no live endpoint in this run"),
    closed.text,
  );
  assert.ok(
    closed.out.some((l) => l.startsWith("FLOOR ") && l.includes("--accept-closed")),
    closed.text,
  );
  const accepted = await run([dir, "--accept-closed"]);
  assert.equal(accepted.rc, 0, accepted.text);
});

test("arguments: a missing directory, an unknown option and an unknown --backend are refused with the usage or the ids", async () => {
  const none = await run([]);
  assert.equal(none.rc, 2);
  assert.match(none.text, /missing the extension directory[\s\S]*usage: pnpm conformance:sandbox/);
  assert.equal((await run(["x", "--bogus"])).rc, 2);
  useSandbox(fake);
  const wrong = await run([writeExtension(), "--backend", "cfix-other"]);
  assert.equal(wrong.rc, 2);
  assert.match(wrong.text, /does not provide sandbox backend cfix-other \(it provides cfix\)/);
  const missing = await run([join(tmp(), "nowhere")]);
  assert.equal(missing.rc, 2);
  assert.match(missing.text, /cannot read .*manifest\.json/);
});
