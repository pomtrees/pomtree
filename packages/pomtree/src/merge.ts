// Pure mapping of the daemon's `POST /v1/agents/self/merge` reply to a pomtree exit code and message.

export const MERGE_EXIT = { conflict: 5, checkFailed: 8, approval: 9, moved: 10, escalated: 11, rejected: 12 } as const;

export interface MergeOutcome {
  ok: boolean;
  code: number;
  text: string;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// Returns undefined for a reply that is not a recognised merge outcome (the caller then treats it as a plain HTTP error).
// `clean` strips control characters from daemon-supplied text.
export function mergeOutcome(status: number, body: unknown, child: string | undefined, clean: (s: string) => string): MergeOutcome | undefined {
  const b = (body ?? {}) as {
    ok?: unknown;
    code?: unknown;
    commit?: unknown;
    target?: unknown;
    paths?: unknown;
    reason?: unknown;
    ref?: unknown;
    error?: unknown;
  };
  const from = child ? clean(child) : "your branch";
  if (status < 300 && b.ok === true && typeof b.commit === "string") {
    const target = typeof b.target === "string" ? clean(b.target) : "your branch";
    return {
      ok: true,
      code: 0,
      text: `merged ${from} into ${target} at ${clean(b.commit)}\nrun 'pomtree pull' to fetch the merge commit into your clone before your next push`,
    };
  }
  if (b.code === "key_reuse") return { ok: false, code: 2, text: "this --key was already used for a different merge; omit --key to start a new one" };
  if (b.ok !== false || typeof b.code !== "string") return undefined;
  const detail = typeof b.error === "string" && b.error ? `: ${clean(b.error)}` : "";
  switch (b.code) {
    case "conflict": {
      const paths = strings(b.paths)
        .map((p) => `  ${clean(p)}`)
        .join("\n");
      return {
        ok: false,
        code: MERGE_EXIT.conflict,
        text: `merge conflict merging ${from}; conflicted paths:\n${paths || "  (none reported)"}\n${child ? `resolve it in your clone (pomtree pull --from ${clean(child)}, git merge, fix, pomtree push) and run pomtree merge again, or resume the child with the paths` : "resolve it in your clone (pomtree pull, git merge the default branch from refs/remotes/pomtreed/ into your branch, fix, commit, pomtree push) and run pomtree merge again"}`,
      };
    }
    case "check_failed":
      return {
        ok: false,
        code: MERGE_EXIT.checkFailed,
        text: `the merge check failed${detail}; the target branch is unchanged. Fix the cause and run pomtree merge again`,
      };
    case "policy_rejected": {
      if (b.reason === "approval_required")
        return {
          ok: false,
          code: MERGE_EXIT.approval,
          text: "merge into the default branch awaits the user's approval; nothing has changed yet. Do not retry in a loop: the request is idempotent, so wait for the user (pomtree yield or pomtree ask) and retry the same command with the same --key later",
        };
      const reason = typeof b.reason === "string" ? clean(b.reason) : "unspecified";
      const where = [...strings(b.paths), ...(typeof b.ref === "string" ? [b.ref] : [])].map((x) => `  ${clean(x)}`).join("\n");
      return {
        ok: false,
        code: MERGE_EXIT.rejected,
        text: `merge rejected by policy (${reason})${detail}${where ? `:\n${where}` : ""}\nthis will not succeed on retry; change the branch (or the request) first`,
      };
    }
    case "moved":
      return { ok: false, code: MERGE_EXIT.moved, text: "the target branch moved while merging; nothing changed. Run pomtree pull, then pomtree merge again" };
    case "escalated":
      return {
        ok: false,
        code: MERGE_EXIT.escalated,
        text: `merging ${from} failed three rounds and was escalated to the user. Stop trying: wait for the user's reply`,
      };
    default:
      return undefined;
  }
}
