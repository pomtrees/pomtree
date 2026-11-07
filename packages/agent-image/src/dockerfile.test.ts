import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_POMTREE_MAIN, LOOPBACK_BRIDGE_MAIN } from "./container-contract.gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(resolve(here, "..", "Dockerfile"), "utf8");

test("pi-trust: settings.json and auth.json are staged per agent by pomtreed, not baked into the (tmpfs-shadowed) image home", () => {
  assert.doesNotMatch(dockerfile, /defaultProjectTrust/);
  assert.match(dockerfile, /PI_CODING_AGENT_DIR=\/home\/node\/\.pi\/agent/);
});

test("no git shim: the agent runs the real git in its own clone", () => {
  assert.doesNotMatch(dockerfile, /bin\/git\b/);
  assert.match(dockerfile, /apt-get install[^\n]*\bgit\b/);
});

test("entrypoint sets a per-agent git author from POMTREE_AGENT_ID, env only", (t) => {
  assert.match(dockerfile, /COPY --chmod=0?755 packages\/agent-image\/bin\/pomtree-entrypoint \/usr\/local\/bin\/pomtree-entrypoint/);
  assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/local\/bin\/pomtree-entrypoint"\]/m);
  const sh = join(here, "..", "bin", "pomtree-entrypoint");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-entrypoint-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Only bypass the packaged byte-bridge location; exercise the real entrypoint's env logic. The entrypoint execs node by absolute path
  // (PATH starts with agent-writable dirs), so the test runs a copy whose node path points at a stand-in.
  const fakeNode = join(dir, "node");
  writeFileSync(fakeNode, '#!/bin/sh\nshift\nexec "$@"\n');
  chmodSync(fakeNode, 0o755);
  const copy = join(dir, "entrypoint");
  writeFileSync(copy, readFileSync(sh, "utf8").replace("exec /usr/local/bin/node ", `exec ${fakeNode} `));
  chmodSync(copy, 0o755);
  const run = (env: Record<string, string>) =>
    spawnSync(copy, ["sh", "-c", 'echo "$GIT_AUTHOR_NAME|$GIT_AUTHOR_EMAIL|$GIT_COMMITTER_NAME|$GIT_COMMITTER_EMAIL"'], {
      encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH!}`, ...env },
    }).stdout.trim();
  assert.equal(run({ POMTREE_AGENT_ID: "a1" }), "a1|a1@agents.pomtree|a1|a1@agents.pomtree");
  assert.equal(run({ POMTREE_AGENT_ID: "a1", GIT_AUTHOR_NAME: "op" }), "op|a1@agents.pomtree|a1|a1@agents.pomtree");
  assert.equal(run({ POMTREE_AGENT_ID: "a b;x" }), "|||");
  assert.equal(run({}), "|||");
});

test("job wrapper is installed executable on PATH", async () => {
  const { statSync } = await import("node:fs");
  assert.match(dockerfile, /COPY --chmod=0?755 packages\/agent-image\/bin\/pomtree-job-run \/usr\/local\/bin\/pomtree-job-run/);
  const f = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "pomtree-job-run");
  assert.ok(statSync(f).mode & 0o111);
});

// Static checks read instructions only; prose in comments may name what the recipe avoids.
const instructions = dockerfile
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

test("browser recipe: pinned pi-browser commit, Node-hosted Pi, Chromium packages, no Bun, VNC or --no-sandbox", () => {
  assert.match(dockerfile, /git checkout --quiet 32b5baaf7ca0d6258b1d0841cff9c6c88aafff2b/);
  assert.match(dockerfile, /npm ci --omit=dev --omit=peer --ignore-scripts/);
  assert.match(dockerfile, /apt-get install[^\n]*\bchromium\b/);
  assert.match(dockerfile, /npm install -g --ignore-scripts --no-audit --no-fund "\/tmp\/earendil-works-pi-coding-agent-\$PI_VERSION\.tgz"/);
  assert.match(dockerfile, /ARG PI_VERSION\nARG PI_NPM_INTEGRITY/);
  assert.doesNotMatch(instructions, /\bbun\b|vnc|x11vnc|novnc|--no-sandbox|PI_TARBALL_URL|PI_SHA256/i);
  assert.doesNotMatch(instructions, /ARG\s+(OPENAI|ANTHROPIC|OPENROUTER|.*_API_KEY)/i);
});

test("sidecar source is COPYed immutably, never bind-mounted from the host", () => {
  assert.match(
    dockerfile,
    /^COPY packages\/sandbox-docker\/src\/proxy\.ts packages\/sandbox-docker\/src\/audit\.ts packages\/sandbox-docker\/src\/worker\.ts packages\/sandbox-docker\/src\/worker-ready\.ts packages\/sandbox-docker\/src\/container-contract\.gen\.ts \/opt\/pomtree\/egress\//m,
  );
  assert.doesNotMatch(instructions, /--mount|bind/i);
});

test("the pomtree wrapper and the entrypoint exec node by absolute path, never through PATH", () => {
  assert.match(dockerfile, /printf '#!\/bin\/sh\\nexec \/usr\/local\/bin\/node \/opt\/pomtree\/pomtree\/src\/main\.ts "\$@"\\n' > \/usr\/local\/bin\/pomtree/);
  const entrypoint = readFileSync(join(here, "..", "bin", "pomtree-entrypoint"), "utf8");
  assert.match(entrypoint, /^exec \/usr\/local\/bin\/node \/opt\/pomtree\/egress\/worker\.ts "\$@"$/m);
  assert.doesNotMatch(entrypoint, /^\s*exec node /m);
});

// The image facts and container config bounds have one source (core, via the generated container-contract.gen.ts copies that
// packages/core/src/config/container-gen.test.ts regenerates and compares). Each flat COPY set ships its own copy, and no shipped file re-declares a fact.
test("every flat COPY set ships its generated container contract copy", () => {
  assert.match(instructions, /^COPY packages\/agent-image\/src\/container-contract\.gen\.ts \/opt\/pomtree\/container-contract\.gen\.ts$/m);
  assert.match(instructions, /^COPY [^\n]*packages\/sandbox-docker\/src\/container-contract\.gen\.ts [^\n]*\/opt\/pomtree\/egress\/$/m);
  // The extension's copy rides the whole-directory COPY of ext/.
  assert.match(instructions, /^COPY packages\/agent-image\/ext \/opt\/pomtree\/ext$/m);
  assert.match(instructions, /^COPY packages\/pomtree\/src \/opt\/pomtree\/pomtree\/src$/m);
  // The pomtree wrapper runs the same main the generated CLI_POMTREE_MAIN names.
  assert.ok(instructions.includes(`exec /usr/local/bin/node ${CLI_POMTREE_MAIN} `));
});

test("the model-free capture worker and its modules are COPYed flat beside the browser files it imports", () => {
  assert.match(
    instructions,
    /^COPY packages\/agent-image\/src\/capture-worker\.ts packages\/agent-image\/src\/cdp-recorder\.ts packages\/agent-image\/src\/capture-types\.ts packages\/agent-image\/src\/warc\.ts packages\/agent-image\/src\/cdxj\.ts packages\/agent-image\/src\/zip\.ts packages\/agent-image\/src\/wacz\.ts \/opt\/pomtree\/$/m,
  );
});

test("the loopback bridge and its core are COPYed flat into the browser stage only, at the generated main path", () => {
  const copy = /^COPY packages\/agent-image\/src\/loopback-bridge\.ts packages\/agent-image\/src\/loopback-bridge-core\.ts \/opt\/pomtree\/$/m;
  assert.match(instructions, copy);
  assert.equal(LOOPBACK_BRIDGE_MAIN, "/opt/pomtree/loopback-bridge.ts");
  const [, , appBrowser] = instructions.split(/^FROM .*$/m).slice(1);
  assert.match(appBrowser ?? "", copy);
});

test("no shipped browser file re-declares an image fact or a delivered bound (negative guard against new hand copies)", () => {
  const files = [
    join(here, "browser-run.ts"),
    join(here, "browser-capture.ts"),
    join(here, "main-content.ts"),
    join(here, "capture-worker.ts"),
    join(here, "cdp-recorder.ts"),
    ...["finish.ts", "index.ts", "browser.ts", "capture-diagnostic.ts"].map((f) => join(here, "..", "ext", "pomtree-browser", f)),
  ];
  const copies =
    /\b(?:PROXY_ENV_NAMES = \[|FIXED_PATH = "|CLI_POMTREE_MAIN = "|CDP_PORT = |CLI_POMTREE_TIMEOUT_MS = |MAX_SUMMARY_BYTES|MAX_HANDOFF_BYTES = |BROWSER_TEXT_MAX_BYTES|BROWSER_SCREENSHOT_MAX_BYTES|BROWSER_RAW_ALLOCATION_CEILING)/;
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), copies, f);
  // The old literal bounds of the capture and the step/time ranges are gone too.
  const literals = /maxBytes > 1024 \*\* 2|maximum: 1048576|maximum: 120000|maxSteps > 256|steps > 256|ms > 600_000|8 \* 1024 \*\* 2|at most 8192 bytes/;
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), literals, f);
});
