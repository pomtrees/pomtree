// The constants of the research specialist's three tools (a domain example's design,
// TODO(specialist-tools)). Pure and dependency-free, so the host (the domain example's host: the thread coordinator that publishes the
// pages and reaps the draft, and the board that validates it) imports this one definition instead of keeping a copy; the Pi extension
// (index.ts) and its core (specialist.ts) read it too. The specialist has no bash, read, write, edit, network or pomtree tool: these three
// tools are everything it can call.
import type { PagedCause } from "../pomtree-paged/paged-contract.ts";

export { AGENT_ID_PATTERN } from "../pomtree-paged/paged-contract.ts";

export const THREAD_PAGE_TOOL = "thread_page";
export const SOURCE_PAGE_TOOL = "source_page";
export const POST_TOOL = "post_draft";
export const SPECIALIST_TOOLS = [THREAD_PAGE_TOOL, SOURCE_PAGE_TOOL, POST_TOOL] as const;
// Loaded explicitly by the specialist's Pi argv (harness-pi `allowlist`); never part of the default extension loadout.
export const SPECIALIST_EXT = "/opt/pomtree/ext/pomtree-specialist";

// The specialist's own page reports, published onto the child by its thread coordinator: the thread snapshot as `thread-page-NNN` and the
// retained source text as `source-page-NNN`. A tool builds the name from a validated integer, so no other report name can be asked for.
export const THREAD_PAGE_PREFIX = "thread-page-";
export const SOURCE_PAGE_PREFIX = "source-page-";
// The task page (draft-rules.ts): the draft rules `post_draft` checks before it submits, published beside the pages.
export { TASK_PAGE_REPORT } from "./draft-rules.ts";
export const PAGE_KINDS = ["thread", "source"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];
const PREFIXES: Readonly<Record<PageKind, string>> = { thread: THREAD_PAGE_PREFIX, source: SOURCE_PAGE_PREFIX };
export const PAGES_MAX = 256;
export const pageReportName = (kind: PageKind, index: number): string => `${PREFIXES[kind]}${String(index).padStart(3, "0")}`;
// The pages are published just after the specialist starts: a missing report is polled for this long before it is called unavailable.
export const PAGE_WAIT_MS = 3000;
export const PAGE_WAIT_TRIES = 10;
// One page's `pomtree report show` output: at most 1 MiB of page text (the host's page bound must not exceed it) plus the report's banner and metadata.
export const PAGE_OUTPUT_MAX_BYTES = 1024 * 1024 + 4096;

// The idempotency key of the one draft result.
export const RESULT_KEY = "fin-post-draft";
// The UTF-8 bytes of the draft's JSON text. The recorded result is the envelope below, a few dozen bytes more, and travels as ONE argv
// element of `pomtree result` and then one POST /v1/agents/self/result body: far under Linux's per-argument limit (MAX_ARG_STRLEN, 128 KiB)
// and pomtreed's request body limit (MAX_BODY, 1 MiB, packages/pomtreed/src/server.ts), which is the only byte bound the daemon puts on a result.
export const POST_MAX_BYTES = 16384;
// A succeeded result must carry a non-blank `summary` of at most MAX_HANDOFF_BYTES (pomtreed daemon/lifecycle.ts normalizeResult), and a Post
// body has no `summary` key (the board refuses unknown keys), so the draft travels inside a fixed envelope: `summary` is this fixed text
// (no model text reaches the handoff line) and `post` is the draft. The host reaps `result.post` and validates it with the board's validatePost.
export const RESULT_SUMMARY = "specialist post draft";
export type PostDraftResult = { summary: typeof RESULT_SUMMARY; post: Record<string, unknown> };

// The fields the board's single writer stamps (the thread coordinator; the domain example's board Post): a draft naming
// any of them is refused, so a specialist can never claim its identity, its thread, its post key or its time.
export const STAMPED_FIELDS = ["id", "idempotencyKey", "threadId", "author", "createdAt"] as const;
// The stamped fields refused at any depth of a draft. `id` is refused at the top level only: a post's embedded records carry their own
// ids (a finding's DiligenceFinding.id, an execution report's Fill.id), which are agent-authored and validated by the board.
export const DEEP_STAMPED_FIELDS = STAMPED_FIELDS.filter((f) => f !== "id");
// The agent-authored top-level fields of a Post: a draft's top-level keys must all be among them. A hand-kept list, not shared with the
// board (its key list is private to board.mts, and this contract stays free of examples/ imports); the drift guard is the producer-to-
// consumer round-trip test (src/specialist-board.test.ts), which fails when a key here is unknown to the board's validatePost or when a
// well-formed draft of some kind needs a key missing here; a board key that no test draft uses is not caught. A key check only: which fields each kind requires or allows, and every value's shape, are the board's validatePost to judge.
export const DRAFT_FIELDS = [
  "kind",
  "body",
  "citations",
  "replyTo",
  "answers",
  "finding",
  "loadBearing",
  "backtest",
  "override",
  "hypothesis",
  "hypothesisId",
  "result",
  "execution",
  "withdrawal",
  "addressee",
  "blocking",
  "release",
  "reopen",
] as const;

// Closed failure causes: the shared paged core's (PagedCause) plus the draft checks (`draft_rule`: the draft breaks a rule of the task
// page, draft-rules.ts checkDraftRules). Each reaches the model and the daemon journal only as
// the `(cause=<token>)` suffix the daemon parses (toolFailureCauseOf), never with pomtree's stderr or any page text.
export const SPECIALIST_CAUSES = [
  "invalid_page",
  "no_agent",
  "unavailable",
  "too_large",
  "timeout",
  "read_failed",
  "invalid_post",
  "unknown_field",
  "stamped_field",
  "draft_rule",
  "already_submitted",
  "submit_failed",
] as const satisfies readonly (PagedCause | "invalid_post" | "unknown_field" | "stamped_field" | "draft_rule")[];
export type SpecialistCause = (typeof SPECIALIST_CAUSES)[number];
