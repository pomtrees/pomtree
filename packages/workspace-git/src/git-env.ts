// Pure builder for every controller-side git invocation. No fs, no process: it only turns
// (args, options) into the argv and environment the runner spawns, so the hardening is testable
// and cannot differ between call sites. The controller never runs git inside an agent clone as the agent left it:
// the only agent-written folder it runs git in is a fork copy, after workspace.ts sanitises its `.git` (symlinks,
// redirects and extensions rejected or removed, `.git/config` replaced), so no agent-written config is ever read.

export const MIN_SAFE_GIT = [2, 38, 0] as const;

// Config forced on every invocation: no hooks, no fsmonitor, no attributes/filter sources, no
// external transports, no auto gc, file transport allowed only because mirror/quarantine fetches need it.
const HARDENED_CONFIG: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.attributesFile=/dev/null",
  "core.untrackedCache=false",
  "protocol.file.allow=always",
  "protocol.ext.allow=never",
  "gc.auto=0",
  "maintenance.auto=false",
  "advice.detachedHead=false",
  // Agent-written commit-graph and multi-pack-index files are never trusted: git falls back to the object store.
  "core.commitGraph=false",
  "core.multiPackIndex=false",
];

export interface GitInvocationOptions {
  // Extra environment passed through from the operator (e.g. HOME, SSH_AUTH_SOCK for a publish push).
  // Never GIT_* except those named here by the caller; the builder does not inherit anything itself.
  passthrough?: Record<string, string | undefined>;
  // Operator's own global git config (credential helpers, ssh) is honoured. Only for pushes to the
  // operator's remote; everything that touches agent-supplied bytes leaves this false.
  trustOperatorConfig?: boolean;
  // Per-call `-c key=value` pairs placed after the hardened set (cannot weaken the hardened keys: see below).
  config?: string[];
  // Never fetch a missing object from a promisor remote. Set only on calls that run inside a forked agent copy;
  // operator-side calls (e.g. the mirror fetch from a blobless operator repo) must keep lazy fetch. git >= 2.44 honours it.
  noLazyFetch?: boolean;
}

export interface GitInvocation {
  file: "git";
  args: string[];
  env: Record<string, string>;
}

const HARDENED_KEYS = new Set(HARDENED_CONFIG.map((c) => c.slice(0, c.indexOf("=")).toLowerCase()));

export function buildGitInvocation(args: readonly string[], base: { path: string; tmpdir?: string }, opts: GitInvocationOptions = {}): GitInvocation {
  for (const c of opts.config ?? []) {
    const key = c.slice(0, c.indexOf("=")).toLowerCase();
    if (HARDENED_KEYS.has(key)) throw new Error(`config ${key} is fixed by the hardened git builder`);
  }
  const config = [...HARDENED_CONFIG, ...(opts.config ?? [])];
  const env: Record<string, string> = {
    PATH: base.path,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_ASKPASS: "/bin/echo",
  };
  if (!opts.trustOperatorConfig) env.GIT_CONFIG_GLOBAL = "/dev/null";
  if (opts.noLazyFetch) env.GIT_NO_LAZY_FETCH = "1";
  if (base.tmpdir) env.TMPDIR = base.tmpdir;
  for (const [k, v] of Object.entries(opts.passthrough ?? {})) if (v !== undefined) env[k] = v;
  return {
    file: "git",
    args: ["--no-replace-objects", ...config.flatMap((c) => ["-c", c]), ...args],
    env,
  };
}

export function evaluateGitVersion(output: string): { version: string | null; warning: string | null } {
  const need = MIN_SAFE_GIT.join(".");
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!m) return { version: null, warning: `git version could not be determined; require >= ${need}` };
  const v = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  const version = v.join(".");
  for (let i = 0; i < 3; i++) {
    if (v[i]! > MIN_SAFE_GIT[i]!) return { version, warning: null };
    if (v[i]! < MIN_SAFE_GIT[i]!)
      return { version, warning: `git ${version} is older than ${need} (bundle fetch ignores fsck settings, no merge-tree); upgrade` };
  }
  return { version, warning: null };
}
