import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { run } from "@pomtree/pomtree";

// Drift-proof: every `pomtree ...` line in the agent guide's code blocks must match pomtree's real USAGE.
const guide = readFileSync(new URL("../../harness-pi/src/agent-guide.md", import.meta.url), "utf8");
const recipes = guide.slice(guide.indexOf("## Recipes"), guide.indexOf("## Finishing"));

const OPERATOR_FLAGS = new Set(["--from-commit", "--session", "--interrupt", "--force", "--deadline", "--template"]);
// Operator-only on every command, `push` included: an agent's `push --force` is refused by the daemon (403), so no recipe may use it.

async function usage(): Promise<string> {
  const out: string[] = [];
  await run(["--help"], {
    call: async () => {
      throw new Error("no call");
    },
    out: (s) => out.push(s),
    err: () => {},
    version: "0",
  });
  return out.join("\n");
}

// The agent-available commands come from pomtree's own help ("agents can use: spawn, wait, ... report publish, sched)"), so a
// command added to or removed from the CLI cannot drift from this checker.
function agentCmds(u: string): Set<string> {
  const m = /inside an agent container use:\s*([^)]*)\)/.exec(u);
  assert.ok(m, "pomtree --help no longer names the agent-available commands");
  return new Set(
    m[1]!
      .split(",")
      .map((c) => c.trim().split(/\s+/)[0]!)
      .filter(Boolean),
  );
}

function blocks(text: string): string[] {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

// Shell-ish split; tracks whether each token was quoted.
function split(line: string): { t: string; quoted: boolean }[] {
  const out: { t: string; quoted: boolean }[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of line.matchAll(re)) out.push({ t: m[1] ?? m[2] ?? m[3]!, quoted: m[3] === undefined });
  return out;
}

function pomtreeCommands(): string[][][] {
  const cmds: string[][][] = [];
  const lines: string[] = [];
  for (const b of blocks(recipes)) for (const l of b.split("\n")) lines.push(l);
  for (const l of lines) {
    // split on && / ; / | so `a && pomtree x` is found; only segments starting with `pomtree`.
    for (const seg of l.split(/&&|\|\||;|\|/)) {
      const s = seg.trim().replace(/^.*?(?=\bpomtree\s)/, "");
      if (/^pomtree\s/.test(s)) cmds.push([split(s.replace(/\s+(>|2>).*$/, ""))] as unknown as string[][]);
    }
  }
  return cmds;
}

test("guide recipes: every pomtree line uses real, agent-available commands and flags", async () => {
  const u = await usage();
  const AGENT_CMDS = agentCmds(u);
  assert.ok(AGENT_CMDS.has("push") && AGENT_CMDS.has("pull"), "push and pull are agent commands");
  const lines = pomtreeCommands().map((c) => c[0] as unknown as { t: string; quoted: boolean }[]);
  assert.ok(lines.length >= 15, `expected many pomtree examples, found ${lines.length}`);
  for (const toks of lines) {
    const text = toks.map((x) => x.t).join(" ");
    const [, cmd, ...rest] = toks.map((x) => x.t);
    assert.ok(AGENT_CMDS.has(cmd!), `operator/unknown command in recipe: ${text}`);
    const sub = cmd === "report" || cmd === "ext" ? rest[0] : undefined;
    const usageRe = new RegExp(`^ {2}${cmd}(?: [a-z|]*\\b${sub ?? ""}\\b[a-z|]*)? `, "m");
    assert.match(u, usageRe, `command not in USAGE: ${text}`);
    const usageLine = u
      .split("\n")
      .filter((l) => new RegExp(`^ {2}${cmd}\\b`).test(l) && (!sub || l.includes(sub)))
      .join("\n");
    for (const { t } of toks) {
      if (!t.startsWith("--")) continue;
      assert.ok(!OPERATOR_FLAGS.has(t), `operator-only flag in recipe: ${text}`);
      assert.ok(usageLine.includes(t), `flag ${t} not in USAGE for ${cmd}: ${text}`);
    }
    // Positionals (non-flag, non-flag-value) must be <placeholders> or quoted.
    const valueFlags = new Set([...usageLine.matchAll(/(--[a-z-]+) [A-Za-z<$]/g)].map((m) => m[1]!));
    const args = toks.slice(2 + (sub ? 1 : 0));
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a.t.startsWith("--")) {
        if (valueFlags.has(a.t)) i++;
        continue;
      }
      assert.ok(a.quoted || /<[^>]+>/.test(a.t), `positional not a <placeholder> or quoted: ${a.t} in ${text}`);
    }
  }
});

test("guide recipes: yield conditions are real", () => {
  for (const m of recipes.matchAll(/pomtree yield --until (\S+)/g)) {
    const c = m[1]!.replace(/<[^>]+>/g, "x");
    assert.match(c, /^(message|timer:x|child_exited:(all:|any:)?x(,x)*)$/, `bad yield cond ${m[1]}`);
  }
});

// Agents have a writable private clone, so local git writes (commit, add, checkout -b, merge, rebase, branch, switch) are fine.
// Never in a recipe: operator-only commands, `git push` (agents use `pomtree push`; the clone has no working remote), remote edits,
// and git config that weakens the controller's safety.
const BAD_RECIPE: [RegExp, string][] = [
  [/\bgit\s+(?:-\S+\s+)*push\b/, "git push (use pomtree push)"],
  [/\bgit\s+remote\s+(add|set-url|remove|rm|rename|set-head)\b/, "git remote change"],
  [/\bgit\b[^\n]*\b(hooksPath|fsmonitor|protocol\.[\w.]*allow|sshCommand)\b/i, "git config that disables safety"],
  [/\bgit\s+config\b[^\n]*\b(hooks|filter|protocol|fsmonitor)/i, "git config that disables safety"],
  [/\bpomtree (ps|tree|top|drain|cancel|kill|show|logs|template|escalations)\b/, "operator command"],
  [/\bpomtreectl\b|\bpomtreed\b/, "daemon admin"],
  [/from_commit|--from-commit|--session/, "operator-only flag"],
];
const violations = (b: string): string[] => BAD_RECIPE.filter(([re]) => re.test(b)).map(([, why]) => why);

test("guide recipes: no git push, remote or safety-config edits, and no operator commands inside code blocks", () => {
  for (const b of blocks(recipes)) assert.deepEqual(violations(b), [], `bad recipe block:\n${b}`);
  // the checker still bites on a deliberately bad recipe, and lets clone-local git through
  const bad = "git push origin main\ngit remote add x url\ngit -c core.hooksPath=/x commit\npomtree kill <id>\npomtreectl drain";
  assert.equal(violations(bad).length, 5);
  assert.deepEqual(violations("git add -A && git commit -m x && git checkout -b feat && git merge other && pomtree push"), []);
});

test("the guide never recommends push --force to an agent (operator-only, refused with 403)", () => {
  assert.doesNotMatch(guide.replace(/\s+/g, " "), /pomtree push[^.]*--force[^.]*(only for|if you)/);
  assert.match(guide.replace(/\s+/g, " "), /`--force` is operator-only and refused for agents/);
});
