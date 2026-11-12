// The closed set of machine-readable `code` values pomtreed puts on a JSON error body next to the human `error` text, and the pure
// formatters of the messages that carry them. A client (pomtree, the UI, an agent tool) branches on `code`, never on the text; the
// text says the cause and what to do. Routes with their own closed code sets (merge-route, transfer-route) keep them.

import type { StaleGenerationError, TemplateError } from "@pomtree/core";

export const API_ERROR_CODES = [
  "uncommitted_work", // 409 from pomtree result: the workspace has uncommitted changes (or changed since an approved save)
  "stale_generation", // 409: the caller's run was superseded by a newer generation of the same agent
  "token_invalid", // 401: no credential, or one this daemon did not issue
  "token_revoked_or_expired", // 401: an agent credential this daemon issued whose expiry has passed
  "idempotency_conflict", // 409: the idempotency key is already bound to a different request or a finished run
  "template_error", // 422: the template fails validation, or the selected sandbox backend cannot honour it (egress or gVisor it does not declare)
  "unknown_template", // 404: no template of that name
  "unknown_model", // 400: the model is not in the host's catalog
  "budget_exceeds_parent", // 409: the requested child budget is more than the parent has left
  "delegation_exceeds_parent", // 403: the child's egress or resource limits are wider than its non-root container parent's
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

// The 400 for a mutating call that carries no idempotency key (SPEC design rule 4); one definition for every route.
export const IDEMPOTENCY_QUERY_KEY_REQUIRED =
  "key is required: every mutating call carries an idempotency key (send a unique string as ?key=, reused on retry)";
// An extension-registered route carries its key in the JSON body or, for a bodyless or raw-body call, in `?key=`.
export const IDEMPOTENCY_EXT_KEY_REQUIRED =
  "idempotencyKey is required: every mutating call carries one (send a unique string as the body field idempotencyKey, or as ?key= on a bodyless or raw-body call, reused on retry)";

// True when a mutating extension route's request carries no idempotency key (SPEC design rule 4). Applied at both seams that dispatch
// extension routes (handle() and the HTTP server), so no extension can skip it.
export function extensionKeyMissing(method: string, body: unknown, query: URLSearchParams): boolean {
  if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") return false;
  if (query.get("key")) return false;
  if (typeof body !== "object" || body === null || Array.isArray(body) || ArrayBuffer.isView(body)) return true;
  const k = (body as Record<string, unknown>).idempotencyKey;
  return typeof k !== "string" || k === "";
}

export const IDEMPOTENCY_KEY_REQUIRED = "idempotencyKey is required: every mutating call carries one (send a unique string, reused on retry)";

// A JSON error body. `code` is present only for the classes above; every other error is `{ error }` alone.
export type ApiErrorBody = { error: string; code?: ApiErrorCode } & Record<string, unknown>;

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(micros % 10_000 === 0 ? 2 : 4)}`;

// 409 budget_exceeds_parent text: both dollars and micros, so a human and a script read the same numbers.
export function budgetExceedsParentMessage(want: number, available: number): string {
  return `budget ${dollars(want)} (${want} micros) exceeds the ${dollars(available)} (${available} micros) the parent has left; ask for less, or have the parent raise its budget`;
}

export function unknownModelMessage(provider: string, id: string): string {
  return `unknown model: ${provider}/${id}; run \`pomtree models\` to list the models this host can use`;
}

export function unknownTemplateMessage(id: string): string {
  return `no such template: ${id}; GET /v1/templates lists the configured templates`;
}

// Templates are a daemon setting; the message names both ways to set it.
export const TEMPLATES_NOT_CONFIGURED = "templates are not configured: set POMTREED_TEMPLATES_DIR, or create <state>/templates, and restart pomtreed";

// The 409 for a stale generation, worded for the agent that holds the old credential: it must stop, not retry.
export function staleGenerationBody(e: StaleGenerationError): ApiErrorBody {
  return {
    error: `stale generation for ${e.agent}: this run was superseded (generation ${e.got}, current ${e.current}); stop`,
    code: "stale_generation",
  };
}

// The 422 body for a template file that fails validation. TemplateError's message is already `template error: <id>: <why>`.
export function templateErrorBody(e: TemplateError): ApiErrorBody {
  return { error: e.message, code: "template_error" };
}

// 401 bodies. Nothing from the presented credential is echoed. An agent credential gets agent-appropriate text (the
// operator.token hint is the CLI's own, for operator use); everything else keeps the long-standing text.
export function unauthorizedBody(problem: "missing" | "invalid" | "expired", agentCredential: boolean): ApiErrorBody {
  if (problem === "expired")
    return {
      error: "agent token expired: this run's credential is past its lifetime; stop and report what you have through your parent or the operator",
      code: "token_revoked_or_expired",
    };
  if (agentCredential)
    return { error: "agent token is not valid for this daemon (POMTREE_TOKEN was altered or issued by another daemon); stop", code: "token_invalid" };
  return { error: "missing or invalid token", code: "token_invalid" };
}

// 409 uncommitted_work text. The `uncommitted work: ` prefix is a contract: agent-image's capture_finish matches it.
// TODO(dirty-paths): the Sandbox.resultWork port returns no dirty paths, so the text cannot name them; it points at git status.
export function uncommittedWorkMessage(fingerprint: string, dirty: boolean): string {
  const head = dirty ? "uncommitted work" : "workspace changed since approval";
  return `${head}: commit and pomtree push it, or approve daemon commit and local collection by retrying pomtree result with --save-uncommitted ${fingerprint} — only if every uncommitted file (see git status) is meant to be in the result`;
}
