// Child process for repo-store.test.ts (merge-lock): one of two processes merging a different child into the same
// target of one mirror. Each holds at its candidate phase until both have computed a candidate on the same target
// tip, so both reach the compare-and-swap ref move with the same expected old value; only the in-process lock is
// bypassed, by construction. argv: mirrorDir tmpRoot child barrierDir maxAttempts. Prints the MergeResult as JSON.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakes } from "@pomtree/testing";
import { GitRepoStore } from "./repo-store.ts";

const [mirrorDir, tmpRoot, child, barrier, maxAttempts] = process.argv.slice(2) as [string, string, string, string, string];
const peer = child === "c" ? "d" : "c";
const f = createFakes();
await f.registry.create({
  id: "p",
  parent: null,
  name: "p",
  task: "t",
  host: "h",
  budgetMicros: 1,
  spec: { image: "i", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" } },
  idempotencyKey: "p",
});
const store = new GitRepoStore({
  mirrorDir,
  tmpRoot,
  host: "h",
  merges: f.merges,
  maxAttempts: Number(maxAttempts),
  repo: { id: "repo-1", name: "repo", defaultBranch: "main", policy: { deniedPaths: [], check: null } },
  observe: async (e) => {
    if (e.phase !== "candidate") return;
    writeFileSync(join(barrier, child), e.commit ?? "");
    const deadline = Date.now() + 30_000;
    while (!existsSync(join(barrier, peer))) {
      if (Date.now() > deadline) throw new Error("peer never reached its candidate");
      await new Promise((r) => setTimeout(r, 10));
    }
  },
});
const r = await store.merge(
  {
    repo: "repo-1",
    host: "h",
    caller: "p",
    callerGeneration: 0,
    child,
    source: `refs/agents/${child}/heads/agent/${child}`,
    target: "refs/agents/p/heads/agent/p",
  },
  `race-${child}`,
);
process.stdout.write(`${JSON.stringify(r)}\n`);
