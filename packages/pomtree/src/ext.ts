import { randomUUID } from "node:crypto";
import type { ExtensionResult, ExtensionSpec } from "@pomtree/core";

// The daemon's agent extension call response: `{ callId, ...ExtensionResult }`.
export type ExtCallResult = ExtensionResult & { callId: string };

// Idempotency key (every mutating call carries one): `--key` if given, to retry a call whose reply
// was lost; else fresh per invocation, so identical intentional calls are not deduplicated.
export function effectiveExtKey(key?: string): string {
  return key ?? randomUUID();
}

// `--input` is a JSON value; parse it with a helpful message (the CLI wraps this as Usage).
export function parseInput(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("input must be valid JSON");
  }
}

// NAME | DESCRIPTION
export function renderExtList(specs: readonly ExtensionSpec[]): string {
  if (specs.length === 0) return "no extensions";
  const header = ["NAME", "DESCRIPTION"];
  const rows = specs.map((s) => [s.name, s.description]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [header, ...rows]
    .map((r) =>
      r
        .map((c, i) => c.padEnd(widths[i]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

// A successful call prints its result; a deny/failure prints the reason (the daemon's
// 403 approve-denial is thrown by the HTTP layer, so this handles the gateway's soft
// `{ ok: false, denied?, reason? }` in a 200 body).
export function renderExtCallResult(res: ExtCallResult): string {
  if (!res.ok) return res.reason ?? "denied";
  if (res.result === undefined) return "ok";
  return typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2);
}

export interface SearchItem {
  title: string;
  url: string;
  snippet: string;
}

export function renderSearchItems(items: readonly SearchItem[]): string {
  if (items.length === 0) return "no items";
  return items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}${it.snippet ? `\n   ${it.snippet}` : ""}`).join("\n");
}

export function renderExtSearchResult(res: ExtCallResult): string {
  if (!res.ok) return res.reason ?? "denied";
  const result = res.result as { items?: SearchItem[] } | null | undefined;
  return renderSearchItems(result?.items ?? []);
}

// `pomtree ext fetch` prints the fetched text; a deny/failure prints the reason.
export function renderExtFetchResult(res: ExtCallResult): string {
  if (!res.ok) return res.reason ?? "denied";
  const result = res.result as { body?: string } | null | undefined;
  return result?.body ?? "";
}
