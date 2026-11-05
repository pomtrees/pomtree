import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmp } from "./harness.ts";

// scripts/live/verify-relay.mjs is the offline checker for the live relay runs (RLY-5/RLY-6/CUS-1). This drives it over a synthetic
// k=2 run directory (relay-1 -> relay-2 -> relay-3) so its checks are exercised without a key, a network or Docker.

const SCRIPT = fileURLToPath(new URL("../../../scripts/live/verify-relay.mjs", import.meta.url));
const POEM = "roses are red\nviolets are blue";
const TOP_BUDGET = 1_000;

interface Opts {
  leafSummary?: string;
  spend?: number;
  topExit?: string;
  leafState?: string;
  leafBudget?: number;
  leafUnused?: number;
  midTrace?: string;
}

// Budgets 1000 > 600 > 300; settlements relay-1 0, relay-2 50, relay-3 100, so a reap returns the carve minus the agent's OWN spend minus the carves still out with its children (relay-2: 600 - 50 - 300).
function runDir(o: Opts = {}): string {
  const dir = tmp("verify-relay");
  mkdirSync(dir, { recursive: true });
  const agent = (
    name: string,
    id: string,
    parent: string | null,
    budgetMicros: number,
    state: string,
    summary: string,
    unusedMicros?: number,
    exit = "succeeded",
  ) => ({
    agent: { name, id, parent, budgetMicros, state, exit, generation: 0, result: { summary } },
    events: unusedMicros === undefined ? [] : [{ payload: { kind: "ext.pomtreed.op", op: "reap", unusedMicros } }],
  });
  const shows = [
    agent("relay-1", "ag-aaa", null, TOP_BUDGET, "exited", POEM, undefined, o.topExit),
    agent("relay-2", "ag-bbb", "ag-aaa", 600, "reaped", POEM, 600 - 50 - 300),
    agent("relay-3", "ag-ccc", "ag-bbb", o.leafBudget ?? 300, o.leafState ?? "reaped", o.leafSummary ?? POEM, o.leafUnused ?? 300 - 100),
  ];
  for (const s of shows) writeFileSync(join(dir, `show-${s.agent.id}.json`), JSON.stringify(s));
  writeFileSync(join(dir, "trace-ag-aaa.md"), "model_settlement\npomtree reap ag-bbb\n");
  writeFileSync(join(dir, "trace-ag-bbb.md"), o.midTrace ?? 'model_settlement {"micros":50}\npomtree reap ag-ccc\n');
  writeFileSync(join(dir, "trace-ag-ccc.md"), 'model_settlement {"micros":100}\n');
  writeFileSync(join(dir, "poem.html"), `<html><body>${POEM.replace("\n", "<br>")}</body></html>`);
  writeFileSync(join(dir, "spend.json"), JSON.stringify({ totalSpendMicros: o.spend ?? 150 }));
  return dir;
}

// The verifier exits nonzero when a check fails, which is the whole point of it: an earlier version printed FAIL
// lines and always exited 0, so a broken relay scored a pass. execFileSync therefore throws on every negative
// control below, and the check lines we assert on arrive as the error's stdout.
const verify = (dir: string): string[] => {
  try {
    return execFileSync("node", [SCRIPT, dir, String(TOP_BUDGET), "2"], { encoding: "utf8" }).split("\n");
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    if (typeof out !== "string") throw e;
    return out.split("\n");
  }
};

test("verify-relay: a consistent k=2 relay run directory passes every check", () => {
  const lines = verify(runDir());
  const checks = lines.filter((l) => /^(ok {2}|FAIL) /.test(l));
  assert.deepEqual(
    checks.filter((l) => !l.startsWith("ok  ")),
    [],
    "no check fails",
  );
  for (const name of [
    "levels: k given",
    "top succeeded",
    "poem: top result == leaf result",
    "poem: report == leaf result",
    "relay-2 reaped",
    "relay-3 reap unusedMicros == carve - own spend - carves to children",
    "relay-3 reaped by its parent's own pomtree reap",
    "total spend <= top budget",
  ])
    assert.ok(
      checks.some((l) => l.startsWith(`ok   ${name}:`)),
      `${name} reported ok`,
    );
  assert.ok(lines.includes("SPEND 150"));
});

test("verify-relay: a leaf poem that differs from the top result and the report fails those checks", () => {
  const lines = verify(runDir({ leafSummary: "something else entirely" }));
  assert.ok(lines.some((l) => l.startsWith("FAIL poem: top result == leaf result:")));
  assert.ok(lines.some((l) => l.startsWith("FAIL poem: report == leaf result:")));
});

test("verify-relay: total spend over the top budget fails the cap check", () => {
  const lines = verify(runDir({ spend: TOP_BUDGET + 1 }));
  assert.ok(lines.some((l) => l.startsWith("FAIL total spend <= top budget:")));
});

// Negative controls: each mutation must print FAIL on exactly the checks it names while every other check still prints ok.
// Most break one check. "A child budget not below its parent's" breaks two on purpose: a child carve equal to its parent's 600 leaves the
// parent holding 600 - 50 own - 600 carved = -50, which no real reap can return, so relay-2's reap arithmetic is genuinely inconsistent too;
// holding that to one failure would need a fixture in which the parent spent nothing, i.e. encode a false premise, as the old formula did.
const negatives: { name: string; opts: Opts; fails: string[] }[] = [
  { name: "a wrong reap unusedMicros", opts: { leafUnused: 1 }, fails: ["relay-3 reap unusedMicros == carve - own spend - carves to children"] },
  {
    name: "a parent trace without its own pomtree reap",
    opts: { midTrace: 'model_settlement {"micros":50}\nreaping ag-ccc\n' },
    fails: ["relay-3 reaped by its parent's own pomtree reap"],
  },
  { name: "a child whose state is not reaped", opts: { leafState: "exited" }, fails: ["relay-3 reaped"] },
  {
    name: "a child budget not below its parent's",
    opts: { leafBudget: 600, leafUnused: 600 - 100 },
    fails: ["relay-2 reap unusedMicros == carve - own spend - carves to children", "relay-3 budget <= parent budget"],
  },
  { name: "a top agent that did not succeed", opts: { topExit: "failed" }, fails: ["top succeeded"] },
];
for (const c of negatives)
  test(`verify-relay: ${c.name} fails only ${c.fails.map((f) => `"${f}"`).join(" and ")}`, () => {
    const checks = verify(runDir(c.opts)).filter((l) => /^(ok {2}|FAIL) /.test(l));
    const failed = checks.filter((l) => l.startsWith("FAIL"));
    assert.deepEqual(
      failed.map((l) => l.slice("FAIL ".length, l.indexOf(": "))).sort(),
      [...c.fails].sort(),
      `exactly the named checks fail: ${failed.join(" | ")}`,
    );
    assert.ok(
      checks.some((l) => l.startsWith("ok   levels:")) && checks.some((l) => l.startsWith("ok   total spend <= top budget:")),
      "unmutated checks still ok",
    );
  });
