// The draft rules of one specialist task: their serialized shape, the one evaluator, and the task page that carries them. Pure and
// dependency-free. The rule VALUES are the host board's (a domain example's board builds them, e.g. a draftRulesFor, from its
// own reserved roles and citation rules); none is written here. The host publishes them on the child's task page (TASK_PAGE_REPORT) and
// screens the reaped draft with checkDraftRules; `post_draft` reads the same page and runs the same check before it submits, so a draft
// the host would refuse is refused in the container while the model can still correct it. The board's validatePost stays the authority.
// The board's research policy rides along as data (`policy`), so a hypothesis's registered test is refused here by the board's own
// function (research-policy.ts hypothesisSpecRefusal), with the board's path and message.
import { hypothesisSpecRefusal, type ResearchPolicy, validatePolicy } from "./research-policy.ts";

// The specialist's task page, published by its coordinator beside the thread and source pages.
export const TASK_PAGE_REPORT = "task-page";
export const TASK_PAGE_KIND = "specialist-task-page";
export const TASK_PAGE_BANNER = "[TASK PAGE: JSON of the rules your post draft must satisfy; post_draft checks them before it submits]";

export type DraftRules = {
  v: 1;
  kinds: string[]; // the kinds this task may draft
  addressees: string[]; // the roles a question or specialist-request may address
  // The reserved roles: a question or request to one is refused, except a question to one of `nonBlockingAddressees` with blocking false.
  reservedAddressees: string[];
  nonBlockingAddressees: string[];
  findingCitationKinds: string[]; // kinds whose finding must cite at least one source item, each citation with an exact quote
  answerNeedsSupport: boolean; // a draft that answers an objection must cite a source item or carry a backtest reference
  policy: ResearchPolicy; // the board's research policy (validatePolicy): a runner test's universe and floors, refused as spec_refused
};

export const DRAFT_RULE_CODES = [
  "kind_not_allowed",
  "addressee_reserved",
  "question_must_not_block",
  "citation_required",
  "answer_unsupported",
  "spec_refused",
] as const;
export type DraftRuleCode = (typeof DRAFT_RULE_CODES)[number];
// `message` states the rule and how to fix the draft, for the model and the host's refusal alike.
export type DraftViolation = { rule: DraftRuleCode; path: string; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const quoted = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(", ");

// The first rule the draft breaks, or null. Shape beyond these rules is the board's to judge.
export function checkDraftRules(rules: DraftRules, post: Record<string, unknown>): DraftViolation | null {
  const kind = post.kind;
  if (typeof kind !== "string" || !rules.kinds.includes(kind))
    return {
      rule: "kind_not_allowed",
      path: "kind",
      message: `kind ${JSON.stringify(kind ?? null)} is not allowed for this task: set kind to one of ${quoted(rules.kinds)}`,
    };
  const addressee = post.addressee;
  if (typeof addressee === "string" && rules.reservedAddressees.includes(addressee)) {
    const nonBlocking = kind === "question" && rules.nonBlockingAddressees.includes(addressee);
    if (nonBlocking && post.blocking === true)
      return {
        rule: "question_must_not_block",
        path: "blocking",
        message: `addressee '${addressee}' requires blocking: false: set blocking to false (a question to '${addressee}' never holds the thread), or address one of ${quoted(rules.addressees)} to block on the answer`,
      };
    if (!nonBlocking)
      return {
        rule: "addressee_reserved",
        path: "addressee",
        message: `addressee '${addressee}' is reserved for a ${kind}: address one of ${quoted(rules.addressees)}${
          rules.nonBlockingAddressees.length > 0 ? `, or ask ${quoted(rules.nonBlockingAddressees)} a question with blocking: false` : ""
        }`,
      };
  }
  if (rules.findingCitationKinds.includes(kind)) {
    const cs = isObj(post.finding) && Array.isArray(post.finding.citations) ? post.finding.citations : [];
    const bad = cs.findIndex((c) => !isObj(c) || typeof c.sourceItemId !== "string" || typeof c.quote !== "string" || c.quote.trim() === "");
    if (cs.length === 0 || bad !== -1)
      return {
        rule: "citation_required",
        path: cs.length === 0 ? "finding/citations" : `finding/citations/${bad}`,
        message: `a ${kind} must cite its source: give finding.citations at least one { sourceItemId: 'si_...', quote: text copied exactly from that source }, every citation with its quote`,
      };
  }
  if (rules.answerNeedsSupport && post.answers !== undefined) {
    const cited = Array.isArray(post.citations) && post.citations.length > 0;
    const result = isObj(post.result) ? post.result : null;
    if (!cited && post.backtest === undefined && result?.backtest === undefined)
      return {
        rule: "answer_unsupported",
        path: "answers",
        message: "a draft that answers an objection needs evidence: cite at least one source item in citations, or drop answers",
      };
  }
  // The board's own check of a registered test, on the draft's strings; a malformed hypothesis is the board's to refuse by shape.
  const h = isObj(post.hypothesis) ? post.hypothesis : null;
  const t = h !== null && isObj(h.test) ? h.test : null;
  if (h !== null && t !== null && typeof t.kind === "string" && typeof t.spec === "string" && typeof h.asset === "string") {
    const refused = hypothesisSpecRefusal(rules.policy, t.kind, h.asset, t.spec);
    if (refused !== null) return { rule: "spec_refused", ...refused };
  }
  return null;
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const RULE_KEYS = ["v", "kinds", "addressees", "reservedAddressees", "nonBlockingAddressees", "findingCitationKinds", "answerNeedsSupport", "policy"];

// The rules as serialized, or null for anything else (a closed shape: unknown keys, another version, a wrong type).
export function parseDraftRules(raw: unknown): DraftRules | null {
  if (!isObj(raw) || Object.keys(raw).some((k) => !RULE_KEYS.includes(k)) || raw.v !== 1) return null;
  const { kinds, addressees, reservedAddressees, nonBlockingAddressees, findingCitationKinds, answerNeedsSupport } = raw;
  if (!strings(kinds) || kinds.length === 0 || !strings(addressees) || !strings(reservedAddressees) || !strings(nonBlockingAddressees)) return null;
  if (!strings(findingCitationKinds) || typeof answerNeedsSupport !== "boolean") return null;
  const policy = validatePolicy(raw.policy);
  if (!policy.ok) return null;
  return { v: 1, kinds, addressees, reservedAddressees, nonBlockingAddressees, findingCitationKinds, answerNeedsSupport, policy: policy.value };
}

// The task page's report body: the banner, a blank line, then the JSON { kind: TASK_PAGE_KIND, draftRules }.
export const taskPageText = (rules: DraftRules): string => `${TASK_PAGE_BANNER}\n\n${JSON.stringify({ kind: TASK_PAGE_KIND, draftRules: rules })}`;

// The rules a task page carries, or null when the text is not a task page. `text` is the report body, or `pomtree report show`'s output,
// which prints the report's metadata lines before the body.
export function draftRulesOfPage(text: string): DraftRules | null {
  const head = `${TASK_PAGE_BANNER}\n\n`;
  const at = text.indexOf(head);
  if (at < 0) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text.slice(at + head.length));
  } catch {
    return null;
  }
  return isObj(doc) && doc.kind === TASK_PAGE_KIND ? parseDraftRules(doc.draftRules) : null;
}
