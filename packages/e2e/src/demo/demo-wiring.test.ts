import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The live demos run in Linux containers, which reach the host only through the agent endpoint the planner binds on the docker
// bridge gateway, and which refuse `pomtree result` when the workspace counts `.pi-session/` as uncommitted work. Four demos once
// hand-rolled a loopback-only `listenAgents(daemon, "127.0.0.1", 0)` and a bare `new GitWorkspace({...})`, so both broke on Linux.
// This lite test keeps every demo on the two shared helpers: `listenAgentEndpoint` (agent-endpoint.ts) and `demoWorkspace`
// (demo-workspace.ts), the only files that may call `listenAgents(` or `new GitWorkspace(`.

const HELPERS = new Set(["agent-endpoint.ts", "demo-workspace.ts"]);

export function wiringViolations(files: { name: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const { name, text } of files) {
    if (HELPERS.has(name) || name.endsWith(".test.ts")) continue;
    if (/\blistenAgents\(/.test(text)) out.push(`${name}: calls listenAgents( directly; use listenAgentEndpoint(daemon) from ./agent-endpoint.ts`);
    if (/\bnew GitWorkspace\(/.test(text))
      out.push(`${name}: calls new GitWorkspace( directly; use demoWorkspace({ repoDir, stateDir }) from ./demo-workspace.ts`);
  }
  return out;
}

test("negative control: a loopback-only listener and a bare GitWorkspace are each flagged", () => {
  const v = wiringViolations([
    { name: "a.ts", text: 'const agents = await listenAgents(daemon, "127.0.0.1", 0);' },
    { name: "b.ts", text: "const workspace = new GitWorkspace({ repoDir: repo, mirrorDir: m, foldersRoot: f });" },
  ]);
  assert.equal(v.length, 2);
  assert.match(v[0] ?? "", /^a\.ts: .*listenAgentEndpoint/);
  assert.match(v[1] ?? "", /^b\.ts: .*demoWorkspace/);
});

test("clean demos, the helpers and test files are not flagged", () => {
  assert.deepEqual(
    wiringViolations([
      { name: "c.ts", text: "const endpoint = await listenAgentEndpoint(daemon);\nconst workspace = demoWorkspace({ repoDir, stateDir });" },
      { name: "agent-endpoint.ts", text: "listenAgents(daemon, h, p)" },
      { name: "demo-workspace.ts", text: "new GitWorkspace({})" },
      { name: "x.test.ts", text: "listenAgents(d, h, p); new GitWorkspace({})" },
    ]),
    [],
  );
});

test("every demo script uses the shared agent endpoint and workspace helpers", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir)
    .filter((n) => n.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  assert.ok(
    files.some((f) => !HELPERS.has(f.name) && !f.name.endsWith(".test.ts") && f.text.includes("listenAgentEndpoint(")),
    `expected at least one demo script calling listenAgentEndpoint( under ${dir}`,
  );
  assert.deepEqual(wiringViolations(files), []);
});
