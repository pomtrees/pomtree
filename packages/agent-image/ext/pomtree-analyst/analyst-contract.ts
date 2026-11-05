// The constants of the digest analyst's two tools. Pure and dependency-free, so the host (examples/hn-digest) imports this one definition
// for its Pi argv, its prompt and its tests instead of keeping a copy; the Pi extension (index.ts) and its core (analyst.ts) read it too.
// The analyst has no bash, read, write or edit (TODO(analyst-allowlist)): these two tools are everything it can call.
export const PAGE_TOOL = "article_page";
export const RESULT_TOOL = "analysis_result";
export const ANALYST_TOOLS = [PAGE_TOOL, RESULT_TOOL] as const;
// Loaded explicitly by the analyst's Pi argv (harness-pi `allowlist`); never part of the default extension loadout.
export const ANALYST_EXT = "/opt/pomtree/ext/pomtree-analyst";

// The analyst's own page reports are named `article-page-NNN` (examples/hn-digest/article-pages.mts publishes them; a test pins the equality).
// The tool builds that name from a validated integer, so no other report name can be asked for.
export const PAGE_NAME_PREFIX = "article-page-";
export const PAGES_MAX = 256;
export const pageReportName = (index: number): string => `${PAGE_NAME_PREFIX}${String(index).padStart(3, "0")}`;
// The page report is published just after the analyst starts: a missing report is polled for this long before it is called unavailable.
export const PAGE_WAIT_MS = 3000;
export const PAGE_WAIT_TRIES = 10;
// One page is at most ext.hnDigest.articlePageMaxBytes <= ext.hnDigest.articleAnalystReadMaxBytes (declared max 1 MiB) of text plus the report's banner and metadata.
export const PAGE_OUTPUT_MAX_BYTES = 1024 * 1024 + 4096;

// The idempotency key and size bound of the analysis result (the host's contract: examples/hn-digest/content-contract.mts ANALYSIS_MAX_BYTES).
export const RESULT_KEY = "hn-content-analysis";
export const RESULT_MAX_BYTES = 8192;

// A POMTREE_AGENT_ID is a plain id; the one definition is shared with the other paged-reader profiles.
export { AGENT_ID_PATTERN } from "../pomtree-paged/paged-contract.ts";

// Closed failure causes: the shared paged core's (PAGED_CAUSES, a compile-time subset check in analyst.ts) plus invalid_result. Each reaches the model and the daemon journal only as the `(cause=<token>)` suffix the daemon parses
// (toolFailureCauseOf), never with pomtree's stderr or any page text.
export const ANALYST_CAUSES = [
  "invalid_page",
  "no_agent",
  "unavailable",
  "too_large",
  "timeout",
  "read_failed",
  "invalid_result",
  "already_submitted",
  "submit_failed",
] as const;
export type AnalystCause = (typeof ANALYST_CAUSES)[number];
