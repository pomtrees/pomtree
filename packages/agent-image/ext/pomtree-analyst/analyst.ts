// Core of the digest analyst's two tools (`article_page`, `analysis_result`), pure of Pi so it is unit-testable; index.ts registers them.
// The analyst has no shell (TODO(analyst-allowlist)). The pomtree runner, filtered env, page poll, failure-cause mapping and one-shot submit
// are the shared paged core (../pomtree-paged/paged.ts); this file supplies the analyst's names, bounds and analysis validation.
import {
  failOutcome,
  type PagedDeps,
  type PagedOutcome,
  type PageSpec,
  oneShotResult,
  pagedRuntime,
  parseWholePage,
  readOwnPage,
  reportShowArgv,
  resultKeyArgv,
} from "../pomtree-paged/paged.ts";
import {
  type AnalystCause,
  PAGE_OUTPUT_MAX_BYTES,
  PAGE_WAIT_MS,
  PAGE_WAIT_TRIES,
  PAGES_MAX,
  pageReportName,
  RESULT_KEY,
  RESULT_MAX_BYTES,
  RESULT_TOOL,
} from "./analyst-contract.ts";

export { pageToolDetails, type PomtreeRun, type RunPomtree, runPomtree } from "../pomtree-paged/paged.ts";

// Every cause the shared core returns is one of the analyst's: readPage and submit return the core's outcomes as this type, so a shared
// cause missing from ANALYST_CAUSES fails the typecheck.
export type ToolOutcome = PagedOutcome<AnalystCause>;

// The page argument: a whole number 1..PAGES_MAX, nothing else (no numeric strings, no fractions, no names).
export function parsePage(raw: unknown): number | null {
  return parseWholePage(raw, PAGES_MAX);
}

// The argv of the one `pomtree` call that reads a page: only the validated agent id and a name built from the validated page number.
export function pageArgv(agent: string, page: number): string[] {
  return reportShowArgv(agent, pageReportName(page));
}
export function resultArgv(json: string): string[] {
  return resultKeyArgv(RESULT_KEY, json);
}

// The analysis as the exact JSON the host receives: a plain object (given as one, or as its JSON text) with a summary, within RESULT_MAX_BYTES.
export function serializeAnalysis(raw: unknown): { ok: true; json: string } | { ok: false; reason: string } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "analysis is not valid JSON" };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "analysis must be a JSON object" };
  const summary = (value as { summary?: unknown }).summary;
  if (typeof summary !== "string" || summary.trim() === "") return { ok: false, reason: "analysis needs a non-empty summary string" };
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > RESULT_MAX_BYTES) return { ok: false, reason: `analysis is over ${RESULT_MAX_BYTES} bytes` };
  return { ok: true, json };
}

export type AnalystDeps = PagedDeps;

const ARTICLE_PAGE: PageSpec = {
  pagesMax: PAGES_MAX,
  reportName: pageReportName,
  outputMaxBytes: PAGE_OUTPUT_MAX_BYTES,
  waitMs: PAGE_WAIT_MS,
  waitTries: PAGE_WAIT_TRIES,
  noun: "page",
};

export function createAnalystTools(deps: AnalystDeps = {}) {
  const rt = pagedRuntime(deps);
  const record = oneShotResult(rt, RESULT_KEY, RESULT_TOOL);

  // Reads one of this agent's own article pages, polling while it is not yet published (the analyst has no sleep command to wait with).
  const readPage = (pageRaw: unknown): Promise<ToolOutcome> => readOwnPage(rt, ARTICLE_PAGE, pageRaw);

  // Records the analysis once. A refused attempt or a definite pomtree failure does not consume the call, so the model may correct and retry;
  // after an ambiguous failure only the identical analysis is replayed (oneShotResult).
  const submit = (analysisRaw: unknown): Promise<ToolOutcome> =>
    record<AnalystCause>(() => {
      const analysis = serializeAnalysis(analysisRaw);
      return analysis.ok ? analysis : { ok: false, outcome: failOutcome("invalid_result", analysis.reason) };
    });

  return { readPage, submit };
}
