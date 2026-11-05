// CDXJ index lines for a WACZ: `<surt> <14-digit timestamp> <json>`, sorted so replay tools can binary-search them.

// SURT rule source: the Internet Archive `surt` library's default canonicalizer as used by pywb/wabac [knowledge-only, from memory of
// iipc/surt, not re-verified against its source]: drop scheme, userinfo and fragment; lowercase the whole URL; strip a leading `www` / `wwwN`
// label; drop default ports (80/443) but keep others as `host:port`; reverse the host labels joined by `,` (IP hosts stay as is); `)`; then
// the path with a trailing slash removed unless the path is just `/`; then `?` plus the query args sorted lexically and an empty query dropped.
export function surt(url: string): string {
  const u = new URL(url);
  let host = u.hostname.toLowerCase();
  const isIp = /^[\d.]+$/.test(host) || host.startsWith("[");
  host = host.replace(/\.$/, "");
  if (!isIp) host = host.replace(/^www\d*\./, "");
  const labels = isIp ? host : host.split(".").reverse().join(",");
  const port = u.port !== "" ? `:${u.port}` : "";
  let path = u.pathname.toLowerCase();
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const args = u.search.slice(1).toLowerCase().split("&").filter(Boolean).sort();
  return `${labels}${port})${path}${args.length ? `?${args.join("&")}` : ""}`;
}

export function cdxjTimestamp(isoDate: string): string {
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) throw new Error(`cdxj: bad date ${JSON.stringify(isoDate)}`);
  return new Date(t)
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/\D/g, "");
}

export interface CdxjEntry {
  url: string;
  date: string;
  status?: number;
  mime?: string;
  digest?: string; // "sha256:hex" payload digest; absent when the payload was not kept (truncated "unspecified" with no digest in the WARC)
  truncated?: string; // the record's WARC-Truncated reason, as pywb / cdxj-indexer write it
  offset: number;
  length: number;
  filename: string;
  recordType?: string;
}

export function cdxjLines(entries: CdxjEntry[]): string {
  const rows = entries.map((e) => ({ key: surt(e.url), ts: cdxjTimestamp(e.date), e }));
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  let out = "";
  for (const { key, ts, e } of rows) {
    // pywb writes status, length and offset as strings.
    const j: Record<string, string> = { url: e.url };
    if (e.mime !== undefined) j.mime = e.mime;
    if (e.status !== undefined) j.status = String(e.status);
    if (e.digest !== undefined) j.digest = e.digest;
    j.length = String(e.length);
    j.offset = String(e.offset);
    j.filename = e.filename;
    if (e.recordType !== undefined) j.recordType = e.recordType;
    if (e.truncated !== undefined) j.truncated = e.truncated;
    out += `${key} ${ts} ${JSON.stringify(j)}\n`;
  }
  return out;
}

export function parseCdxj(text: string): { key: string; timestamp: string; fields: Record<string, unknown> }[] {
  const out: { key: string; timestamp: string; fields: Record<string, unknown> }[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const m = /^(\S+) (\d{14}) (\{.*\})$/.exec(line);
    if (!m) throw new Error(`cdxj: malformed line ${JSON.stringify(line.slice(0, 80))}`);
    const fields: unknown = JSON.parse(m[3] as string);
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new Error("cdxj: json is not an object");
    out.push({ key: m[1] as string, timestamp: m[2] as string, fields: fields as Record<string, unknown> });
  }
  return out;
}
