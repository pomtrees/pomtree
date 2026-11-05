import { join } from "node:path";
import { GitWorkspace } from "@pomtree/workspace-git";
import { WORKSPACE_GIT_EXCLUDES } from "../../../pomtreed/src/daemon-util.ts";

// The demos' workspace, built as pomtreed's main.ts builds it: `infoExclude` keeps the agent's own `.pi-session/` out of the
// uncommitted-work check, so `pomtree result` is not refused. Every demo goes through here (demo-wiring.test.ts enforces it).
export function demoWorkspace(o: { repoDir: string; stateDir: string }): GitWorkspace {
  return new GitWorkspace({
    repoDir: o.repoDir,
    mirrorDir: join(o.stateDir, "mirror.git"),
    foldersRoot: join(o.stateDir, "workspaces"),
    infoExclude: WORKSPACE_GIT_EXCLUDES,
  });
}
