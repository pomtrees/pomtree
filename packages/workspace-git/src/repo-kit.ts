import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MergeRequest } from "@pomtree/core";
import { tmpDir } from "@pomtree/testing";

// Test kit for the merge engine: a plain "work" repository stands in for the agents' clones and a bare "mirror"
// stands in for the controller's; commits are pushed into the mirror under refs/agents/<id>/heads/*.
// Test-side git runs with hooks and fsmonitor forced off, like workspace.test.ts.
const SAFE = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always"];
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...SAFE, ...args], { cwd, encoding: "utf8" }).trim();
}

export const agentRef = (agent: string, branch = `agent/${agent}`): string => `refs/agents/${agent}/heads/${branch}`;

export interface Kit {
  base: string;
  mirror: string;
  work: string;
  root: string; // the shared first commit
  // Commit `files` (null deletes) on top of `parent` in the work repo and return the new commit.
  commit(parent: string, files: Record<string, string | null>, msg?: string): string;
  put(ref: string, sha: string): void; // force-push `sha` to `ref` in the mirror (what ingest does for an agent ref)
  ref(ref: string): string | null;
  request(over?: Partial<MergeRequest>): MergeRequest;
  setupGit(...args: string[]): string; // git in the work repo
  mirrorGit(...args: string[]): string; // git in the mirror
}

export function kit(): Kit {
  const base = tmpDir("repokit-");
  const work = join(base, "work");
  const mirror = join(base, "mirror.git");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", mirror]);
  writeFileSync(join(work, "a.txt"), "one\n");
  writeFileSync(join(work, "b.txt"), "base\n");
  git(work, "add", "a.txt", "b.txt");
  git(work, "commit", "-qm", "root");
  const root = git(work, "rev-parse", "HEAD");
  const k: Kit = {
    base,
    mirror,
    work,
    root,
    commit(parent, files, msg = "c") {
      git(work, "checkout", "-q", "--detach", "--force", parent);
      for (const [f, c] of Object.entries(files)) {
        const p = join(work, f);
        if (c === null) rmSync(p, { force: true });
        else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, c);
        }
      }
      git(work, "add", "-A");
      git(work, "commit", "-q", "--allow-empty", "-m", msg);
      return git(work, "rev-parse", "HEAD");
    },
    put(ref, sha) {
      git(work, "push", "-q", "--force", mirror, `${sha}:${ref}`);
    },
    ref(ref) {
      try {
        return git(mirror, "rev-parse", "--verify", "--quiet", ref);
      } catch {
        return null;
      }
    },
    request(over = {}) {
      return { repo: "repo-1", host: "h", caller: "p", callerGeneration: 0, child: "c", source: agentRef("c"), target: agentRef("p"), ...over };
    },
    setupGit: (...a) => git(work, ...a),
    mirrorGit: (...a) => git(mirror, ...a),
  };
  k.put("refs/heads/main", root);
  k.put(agentRef("p"), root);
  k.put(agentRef("c"), root);
  return k;
}
