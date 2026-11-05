import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { existsSync } from "node:fs";
import { pomtree, pomtreeEnv, pomtreeFailureMessage } from "./browser-capture.ts";
import { CONTAINER_CONFIG_ENV, FIXED_PATH, PROXY_ENV_NAMES } from "./container-contract.gen.ts";

// A fake pomtree, injected by path (never found through PATH). Its behavior is selected by POMTREE_FAKE_MODE
// (passed through the explicit env) and it records its argv for assertions.
const FAKE_POMTREE = `#!/bin/sh
printf '%s\\n' "$@" > "$POMTREE_FAKE_ARGV"
case "$POMTREE_FAKE_MODE" in
  ok) printf '%s\\n' '{"id":"r1","sha256":"abc"}' ;;
  fail) echo "daemon internal detail" >&2; exit 3 ;;
  badjson) echo "not json" ;;
  big) head -c 100000 /dev/zero | tr '\\0' a ;;
  hang) exec sleep 30 ;;
  env) env ;;
esac
`;

let dir: string;
let fake: { file: string; argv: string[] };
const markers = () => [join(dir, "shim-pomtree-ran"), join(dir, "shim-node-ran")];
const env = (m: string) => ({ ...process.env, POMTREE_FAKE_MODE: m, POMTREE_FAKE_ARGV: join(dir, "argv.txt") });
const saved = { PATH: process.env.PATH };

before(() => {
  dir = mkdtempSync(join(tmpdir(), "pomtree-fake-pomtree-"));
  writeFileSync(join(dir, "pomtree-fake.sh"), FAKE_POMTREE);
  fake = { file: "/bin/sh", argv: [join(dir, "pomtree-fake.sh")] };
  // Shims named pomtree and node sit FIRST on PATH, as agent-writable /workspace/.env/npm/bin does in the image. Neither may ever run.
  for (const [name, marker] of [
    ["pomtree", markers()[0]],
    ["node", markers()[1]],
  ] as const) {
    writeFileSync(join(dir, name), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(dir, name), 0o755);
  }
  process.env.PATH = `${dir}:${saved.PATH}`;
});
after(() => {
  process.env.PATH = saved.PATH;
  rmSync(dir, { recursive: true, force: true });
});

const mode = (m: string) => env(m);

test("PATH-planted pomtree and node shims are never executed (default command is process.execPath on pomtree's main.ts)", async () => {
  await assert.rejects(pomtree(["report", "publish"]), /scoped report publication failed/);
  for (const m of markers()) assert.equal(existsSync(m), false, m);
});

test("pomtreeEnv passes a fixed PATH and only POMTREE_*, HOME, TMPDIR, the proxy selectors and the config document", () => {
  const proxies = Object.fromEntries(PROXY_ENV_NAMES.map((k) => [k, `v-${k}`]));
  const out = pomtreeEnv({
    ...proxies,
    ALL_PROXY: "http://not-selected",
    PATH: `${dir}:/usr/bin`,
    POMTREE_TOKEN: "t",
    POMTREE_API: "a",
    HOME: "/h",
    TMPDIR: "/t",
    OPENAI_API_KEY: "k",
    NODE_OPTIONS: "--require x",
    LD_PRELOAD: "x",
    [CONTAINER_CONFIG_ENV]: "{}",
    PTREE_BROWSER_MAX_MS: "1000",
  });
  assert.deepEqual(out, { PATH: FIXED_PATH, POMTREE_TOKEN: "t", POMTREE_API: "a", HOME: "/h", TMPDIR: "/t", [CONTAINER_CONFIG_ENV]: "{}", ...proxies });
});

test("the child sees the fixed PATH and no non-POMTREE secrets", async () => {
  const out = await pomtree([], fake, { ...env("env"), OPENAI_API_KEY: "sk-secret", POMTREE_TOKEN: "tok", HTTP_PROXY: "http://127.0.0.1:3128" });
  assert.match(out, new RegExp(`^PATH=${FIXED_PATH}$`, "m"));
  assert.match(out, /^HTTP_PROXY=http:\/\/127\.0\.0\.1:3128$/m);
  assert.match(out, /^POMTREE_TOKEN=tok$/m);
  assert.doesNotMatch(out, /sk-secret|OPENAI/);
});

test("pomtree resolves with the stdout of a successful invocation and passes args through verbatim", async () => {
  const args = ["report", "publish", "/tmp/x file", "--name", "browser-dom-text", "--json"];
  assert.equal(await pomtree(args, fake, mode("ok")), '{"id":"r1","sha256":"abc"}\n');
  assert.equal(readFileSync(join(dir, "argv.txt"), "utf8"), `${args.join("\n")}\n`);
});

// The message goes only to the capture process's stderr; the extension redacts and bounds it into the operator-only failure entry
// (capture-diagnostic.ts parsePomtreeFailure) and the model sees only the exit code or timeout.
test("pomtree rejects on nonzero exit with the fixed phrase, exit code, timeout flag and one-line stderr", async () => {
  await assert.rejects(pomtree(["report", "publish"], fake, mode("fail")), (err: Error) => {
    assert.equal(err.message, "scoped report publication failed (pomtree code=3 signal=null timedOut=false) stderr: daemon internal detail");
    return true;
  });
});

test("pomtreeFailureMessage collapses multi-line stderr and control characters to one line and omits an empty stderr", () => {
  assert.equal(
    pomtreeFailureMessage({ code: 1 }, "a\n\tb\u001b[0m\r\n"),
    "scoped report publication failed (pomtree code=1 signal=null timedOut=false) stderr: a b [0m",
  );
  assert.equal(
    pomtreeFailureMessage({ code: null, signal: "SIGTERM", killed: true }, ""),
    "scoped report publication failed (pomtree code=null signal=SIGTERM timedOut=true)",
  );
});

test("pomtree returns stdout verbatim even when it is not JSON; parsing is the caller's job", async () => {
  const out = await pomtree(["report", "publish"], fake, mode("badjson"));
  assert.equal(out, "not json\n");
  assert.throws(() => JSON.parse(out));
});

test("pomtree rejects when stdout exceeds the 64 KiB buffer", async () => {
  await assert.rejects(
    pomtree(["report", "publish"], fake, mode("big")),
    /scoped report publication failed \(pomtree code=ERR_CHILD_PROCESS_STDIO_MAXBUFFER signal=\S+ timedOut=false\)/,
  );
});

test("pomtree rejects when the command cannot be spawned", async () => {
  await assert.rejects(
    pomtree(["report", "publish"], { file: "/nonexistent/node", argv: [] }, mode("ok")),
    /scoped report publication failed \(pomtree code=ENOENT signal=null timedOut=false\)/,
  );
});

test("pomtree rejects after the 10 s timeout when the child never exits", { timeout: 30_000 }, async () => {
  const started = Date.now();
  await assert.rejects(
    pomtree(["report", "publish"], fake, mode("hang")),
    /scoped report publication failed \(pomtree code=null signal=SIGTERM timedOut=true\)/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 9_000 && elapsed < 20_000, `elapsed ${elapsed}ms`);
});
