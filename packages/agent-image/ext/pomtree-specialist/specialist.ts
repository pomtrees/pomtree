// Core of the research specialist's three tools (`thread_page`, `source_page`, `post_draft`), pure of Pi so it is unit-testable;
// index.ts registers them. The specialist has no shell, network or pomtree tool (TODO(specialist-tools)). The pomtree runner, filtered env,
// page poll, failure-cause mapping and one-shot submit are the shared paged core (../pomtree-paged/paged.ts); this file supplies the
// specialist's names, bounds, the draft's key check and the task page's draft rules (draft-rules.ts, which carry the board's research
// policy, so a registered test the board would refuse is refused here: research-policy.ts). The full validation is the host
// board's validatePost, after the reap.
import { checkDraftRules, type DraftRules, draftRulesOfPage, TASK_PAGE_REPORT } from "./draft-rules.ts";
import {
  failOutcome,
  type PagedDeps,
  type PagedOutcome,
  type PageSpec,
  oneShotResult,
  pagedRuntime,
  reportShowArgv,
  readOwnPage,
  resultKeyArgv,
} from "../pomtree-paged/paged.ts";
import {
  DEEP_STAMPED_FIELDS,
  DRAFT_FIELDS,
  PAGE_OUTPUT_MAX_BYTES,
  PAGE_WAIT_MS,
  PAGE_WAIT_TRIES,
  type PageKind,
  PAGES_MAX,
  POST_MAX_BYTES,
  POST_TOOL,
  type PostDraftResult,
  pageReportName,
  RESULT_KEY,
  RESULT_SUMMARY,
  type SpecialistCause,
  STAMPED_FIELDS,
} from "./specialist-contract.ts";

export { pageToolDetails, type PomtreeRun, type RunPomtree } from "../pomtree-paged/paged.ts";

export type ToolOutcome = PagedOutcome<SpecialistCause>;

// The argv of the one `pomtree` call that reads a page: only the validated agent id and a name built from the kind and the validated number.
export function pageArgv(agent: string, kind: PageKind, page: number): string[] {
  return reportShowArgv(agent, pageReportName(kind, page));
}
export function resultArgv(json: string): string[] {
  return resultKeyArgv(RESULT_KEY, json);
}

export type DraftCheck = { ok: true; json: string } | { ok: false; cause: "invalid_post" | "too_large" | "unknown_field" | "stamped_field"; reason: string };

// The paths (`a/b/0/c`) of every key of a parsed JSON value named in `names`, at any depth below `at`.
function stampedPaths(v: unknown, names: readonly string[], at: string, out: string[]): string[] {
  if (Array.isArray(v)) for (const [i, x] of v.entries()) stampedPaths(x, names, `${at}${i}/`, out);
  else if (typeof v === "object" && v !== null)
    for (const [k, x] of Object.entries(v)) {
      if (names.includes(k)) out.push(`${at}${k}`);
      stampedPaths(x, names, `${at}${k}/`, out);
    }
  return out;
}

// The draft as the exact JSON the host receives: a plain JSON object (given as one, or as its JSON text) of at most POST_MAX_BYTES, whose
// top-level keys are all DRAFT_FIELDS, naming no writer-stamped field (STAMPED_FIELDS at the top level, DEEP_STAMPED_FIELDS at any depth),
// wrapped in the fixed result envelope ({ summary: RESULT_SUMMARY, post }). Keys only: the board's validatePost judges the values.
// A hypothesis's registered test is judged by the task page's draft rules (checkDraftRules, with the board's research policy), after this.
export function serializeDraft(raw: unknown): DraftCheck {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, cause: "invalid_post", reason: "post is not valid JSON" };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, cause: "invalid_post", reason: "post must be a JSON object" };
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return { ok: false, cause: "invalid_post", reason: "post must be a plain JSON object" };
  let draft: string;
  try {
    draft = JSON.stringify(value);
  } catch {
    return { ok: false, cause: "invalid_post", reason: "post is not serializable as JSON" };
  }
  // Checked on the JSON round trip, so the keys judged are exactly the keys sent (no toJSON, getter or undefined-valued key differs).
  const post = JSON.parse(draft) as Record<string, unknown>;
  const deep: readonly string[] = DEEP_STAMPED_FIELDS;
  const stamped: string[] = STAMPED_FIELDS.filter((f) => Object.hasOwn(post, f) && !deep.includes(f));
  stampedPaths(post, deep, "", stamped);
  if (stamped.length > 0)
    return { ok: false, cause: "stamped_field", reason: `post must not set ${stamped.join(", ")}: the board's writer stamps ${STAMPED_FIELDS.join(", ")}` };
  const unknown = Object.keys(post).filter((k) => !(DRAFT_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0)
    return { ok: false, cause: "unknown_field", reason: `post has unknown field ${unknown.join(", ")}: a post's fields are ${DRAFT_FIELDS.join(", ")}` };
  if (Buffer.byteLength(draft) > POST_MAX_BYTES) return { ok: false, cause: "too_large", reason: `post is over ${POST_MAX_BYTES} bytes` };
  const envelope: PostDraftResult = { summary: RESULT_SUMMARY, post };
  return { ok: true, json: JSON.stringify(envelope) };
}

export type SpecialistDeps = PagedDeps;

const pageSpec = (kind: PageKind): PageSpec => ({
  pagesMax: PAGES_MAX,
  reportName: (page) => pageReportName(kind, page),
  outputMaxBytes: PAGE_OUTPUT_MAX_BYTES,
  waitMs: PAGE_WAIT_MS,
  waitTries: PAGE_WAIT_TRIES,
  noun: `${kind} page`,
});
const THREAD = pageSpec("thread");
const SOURCE = pageSpec("source");
// The task page is one report, read by post_draft itself (the model has no tool for it).
const TASK: PageSpec = { ...THREAD, pagesMax: 1, reportName: () => TASK_PAGE_REPORT, noun: "task page" };

export function createSpecialistTools(deps: SpecialistDeps = {}) {
  const rt = pagedRuntime(deps);
  const record = oneShotResult(rt, RESULT_KEY, POST_TOOL);

  // Reads one of this agent's own thread-snapshot or retained-source pages, polling while it is not yet published.
  const readThreadPage = (pageRaw: unknown): Promise<ToolOutcome> => readOwnPage(rt, THREAD, pageRaw);
  const readSourcePage = (pageRaw: unknown): Promise<ToolOutcome> => readOwnPage(rt, SOURCE, pageRaw);

  // The task's draft rules, read from the task page once and kept. An unreadable or malformed page refuses the submit without
  // consuming it: the host publishes the page beside the others, so a retry finds it.
  let rules: DraftRules | null = null;
  const draftRules = async (): Promise<{ ok: true; rules: DraftRules } | { ok: false; outcome: ToolOutcome }> => {
    if (rules !== null) return { ok: true, rules };
    const page = await readOwnPage(rt, TASK, 1);
    if (!page.ok) return { ok: false, outcome: page };
    const parsed = draftRulesOfPage(page.text);
    if (parsed === null) return { ok: false, outcome: failOutcome("read_failed", "the task page does not hold this task's draft rules") };
    rules = parsed;
    return { ok: true, rules };
  };

  // Records the draft once. A refused attempt or a definite pomtree failure does not consume the call, so the model may correct and retry;
  // after an ambiguous failure only the identical draft is replayed (oneShotResult). The draft is checked against the task page's rules
  // (checkDraftRules, the host screen's own check) before it is sent: a violation names the rule and the fix, and the call stays open.
  const submit = async (postRaw: unknown): Promise<ToolOutcome> => {
    const r = await draftRules();
    if (!r.ok) return r.outcome;
    return record<SpecialistCause>(() => {
      const draft = serializeDraft(postRaw);
      if (!draft.ok) return { ok: false, outcome: failOutcome(draft.cause, draft.reason) };
      const broken = checkDraftRules(r.rules, (JSON.parse(draft.json) as PostDraftResult).post);
      if (broken === null) return draft;
      const text = `post breaks the rule ${broken.rule} at ${broken.path}: ${broken.message}. Nothing was submitted: correct the draft and call ${POST_TOOL} again`;
      return { ok: false, outcome: failOutcome("draft_rule", text) };
    });
  };

  return { readThreadPage, readSourcePage, submit };
}
