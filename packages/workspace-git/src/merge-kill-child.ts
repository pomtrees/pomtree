// Child process for repo-store.test.ts: runs one merge against an existing mirror and SIGKILLs itself between
// the candidate commit and the ref update (the window the engine must survive). argv: mirrorDir tmpRoot.
import { createFakes } from "@pomtree/testing";
import { GitRepoStore } from "./repo-store.ts";

const [mirrorDir, tmpRoot] = process.argv.slice(2) as [string, string];
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
  repo: { id: "repo-1", name: "repo", defaultBranch: "main", policy: { deniedPaths: [], check: null } },
  observe: (e) => {
    if (e.phase !== "candidate") return;
    process.stdout.write(`candidate ${e.commit}\n`, () => process.kill(process.pid, "SIGKILL"));
    return new Promise<void>(() => {}); // hold here until the kill lands
  },
});
const self = process.argv[4] === "self"; // top-level self-merge into main instead of child into parent
await store.merge(
  self
    ? {
        repo: "repo-1",
        host: "h",
        caller: "p",
        callerGeneration: 0,
        child: "p",
        source: "refs/agents/p/heads/agent/p",
        target: "refs/heads/main",
        approval: "appr-1",
      }
    : { repo: "repo-1", host: "h", caller: "p", callerGeneration: 0, child: "c", source: "refs/agents/c/heads/agent/c", target: "refs/agents/p/heads/agent/p" },
  "kill-1",
);
console.log("unreachable: merge completed");
