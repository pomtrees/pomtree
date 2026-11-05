import { randomUUID } from "node:crypto";
import type { Report } from "@pomtree/core";

// Idempotency key (every mutating call carries one): `--key` if given, to retry a publish whose
// reply was lost; else fresh per invocation, so identical intentional publishes create two reports. The daemon derives the report id from this key and
// remains authoritative for the slug, media type, size, and content hash.
export function effectiveReportKey(key?: string): string {
  return key ?? randomUUID();
}

// A report is a static file output; only text/* media types are safe to dump to a terminal.
export function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/");
}

export function reportPublishQuery(o: { name?: string; mediaType?: string; generation?: string; key: string }): string {
  const q = new URLSearchParams();
  if (o.name !== undefined) q.set("name", o.name);
  if (o.mediaType !== undefined) q.set("mediaType", o.mediaType);
  if (o.generation !== undefined) q.set("generation", o.generation);
  q.set("key", o.key);
  return q.toString();
}

export function renderReport(r: Report): string {
  return [
    `id:         ${r.id}`,
    `agent:      ${r.agent}`,
    `name:       ${r.name}`,
    `type:       ${r.mediaType}`,
    `size:       ${r.sizeBytes} bytes`,
    `sha256:     ${r.sha256}`,
    `generation: ${r.generation}`,
    `host:       ${r.host}`,
    `created:    ${new Date(r.createdAt).toISOString()}`,
  ].join("\n");
}
