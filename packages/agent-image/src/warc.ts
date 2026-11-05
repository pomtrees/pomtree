// Pure WARC 1.1 writer and bounded reader. No fs or net: it runs inside the model-free capture worker and in offline verification.
// Page-controlled strings (URLs, header values) flow into header blocks here, so every value is checked for CR/LF/NUL rather than escaped:
// a smuggled line break would forge a header (WARC-Payload-Digest, say) that a verifier would then trust.
import { createHash, randomUUID } from "node:crypto";
import { crc32, gzipSync, inflateRawSync, type ZlibOptions } from "node:zlib";

export type WarcRecordType = "warcinfo" | "request" | "response" | "resource" | "metadata";

export interface WarcRecordInput {
  type: WarcRecordType;
  recordId?: string; // "<urn:uuid:...>"; default random
  date: string; // WARC-Date, ISO 8601 UTC, second or finer precision
  targetUri?: string;
  contentType: string;
  block: Uint8Array;
  concurrentTo?: string;
  refersTo?: string;
  ipAddress?: string;
  warcinfoId?: string;
  filename?: string; // warcinfo only
  extra?: [string, string][];
  // No WARC-Payload-Digest on an http record: the payload was not kept, so a digest of the empty remainder would claim a genuine empty body. Requires a WARC-Truncated extra.
  omitPayloadDigest?: boolean;
}

export const MAX_WARC_HEADER_BYTES = 64 * 1024;
const MAX_MEMBER_BYTES = 256 * 1024 * 1024;
const HEADER_END = Buffer.from("\r\n\r\n");
const DATE_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const URN_TARGET_RE = /^urn:[a-z][a-z0-9-]{0,31}:/;
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HTTP_VERSION_RE = /^HTTP\/\d(\.\d)?$/;

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function clean(what: string, v: string): string {
  if (/[\r\n\0]/.test(v)) throw new Error(`warc: ${what} contains CR, LF or NUL`);
  return v;
}

function httpUrl(what: string, v: string): URL {
  clean(what, v);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`warc: ${what} is not an absolute URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`warc: ${what} is not an http(s) URL`);
  return u;
}

// Splits an HTTP message block into its head (without the blank line) and entity body; null when there is no header terminator.
// The head is UTF-8: httpResponseBlock and httpRequestBlock encode it so, because CDP hands over header values as JS strings that can hold any character.
export function splitHttpBlock(block: Uint8Array): { head: string; body: Uint8Array } | null {
  const i = Buffer.from(block.buffer, block.byteOffset, block.byteLength).indexOf(HEADER_END);
  if (i < 0) return null;
  return { head: Buffer.from(block.subarray(0, i)).toString("utf8"), body: block.subarray(i + 4) };
}

export function warcRecord(r: WarcRecordInput): Uint8Array {
  if (!DATE_RE.test(r.date)) throw new Error("warc: date must be ISO 8601 UTC with second or finer precision");
  const id = clean("recordId", r.recordId ?? `<urn:uuid:${randomUUID()}>`);
  if (!/^<urn:uuid:[0-9a-fA-F-]{36}>$/.test(id)) throw new Error("warc: recordId must be <urn:uuid:...>");
  const needsUri = r.type === "request" || r.type === "response" || r.type === "resource";
  if (needsUri && r.targetUri === undefined) throw new Error(`warc: ${r.type} record needs a targetUri`);
  if (r.targetUri !== undefined) {
    // urn:<ns>:<http url> names a derived view (screenshot, text) of a page so it cannot collide with the page's own URL on replay; resource and metadata only.
    const urn = URN_TARGET_RE.exec(r.targetUri);
    if (urn && r.type !== "resource" && r.type !== "metadata") throw new Error(`warc: a urn: targetUri is for resource and metadata records, not ${r.type}`);
    httpUrl("targetUri", urn ? r.targetUri.slice(urn[0].length) : r.targetUri);
    clean("targetUri", r.targetUri);
  }
  if (r.omitPayloadDigest && !(r.extra ?? []).some(([k]) => k.toLowerCase() === "warc-truncated"))
    throw new Error("warc: omitPayloadDigest needs a WARC-Truncated extra header");
  if (r.filename !== undefined && r.type !== "warcinfo") throw new Error("warc: filename is for warcinfo records only");
  const h: [string, string][] = [
    ["WARC-Type", r.type],
    ["WARC-Record-ID", id],
    ["WARC-Date", r.date],
  ];
  if (r.targetUri !== undefined) h.push(["WARC-Target-URI", r.targetUri]);
  if (r.concurrentTo !== undefined) h.push(["WARC-Concurrent-To", r.concurrentTo]);
  if (r.refersTo !== undefined) h.push(["WARC-Refers-To", r.refersTo]);
  if (r.ipAddress !== undefined) h.push(["WARC-IP-Address", r.ipAddress]);
  if (r.warcinfoId !== undefined) h.push(["WARC-Warcinfo-ID", r.warcinfoId]);
  if (r.filename !== undefined) h.push(["WARC-Filename", r.filename]);
  for (const [k, v] of r.extra ?? []) {
    if (!TOKEN_RE.test(k)) throw new Error("warc: extra header name is not a token");
    h.push([k, v]);
  }
  h.push(["Content-Type", r.contentType], ["Content-Length", String(r.block.byteLength)]);
  h.push(["WARC-Block-Digest", `sha256:${sha256Hex(r.block)}`]);
  if ((r.type === "request" || r.type === "response") && /^application\/http\s*;\s*msgtype=/i.test(r.contentType)) {
    const parts = splitHttpBlock(r.block);
    if (!parts) throw new Error("warc: http block has no header terminator");
    if (!r.omitPayloadDigest) h.push(["WARC-Payload-Digest", `sha256:${sha256Hex(parts.body)}`]);
  }
  let head = "WARC/1.1\r\n";
  for (const [k, v] of h) head += `${k}: ${clean(k, v)}\r\n`;
  return Buffer.concat([Buffer.from(`${head}\r\n`, "utf8"), r.block, HEADER_END]);
}

function headerLines(headers: [string, string][]): string {
  let s = "";
  for (const [k, v] of headers) {
    if (!TOKEN_RE.test(k)) throw new Error(`warc: http header name ${JSON.stringify(k)} is not a token`);
    s += `${k}: ${clean(`http header ${k}`, v)}\r\n`;
  }
  return s;
}

export function httpResponseBlock(r: { status: number; statusText: string; httpVersion?: string; headers: [string, string][]; body: Uint8Array }): Uint8Array {
  const ver = r.httpVersion ?? "HTTP/1.1";
  if (!HTTP_VERSION_RE.test(ver)) throw new Error("warc: bad http version");
  if (!Number.isInteger(r.status) || r.status < 100 || r.status > 999) throw new Error("warc: bad http status");
  const head = `${ver} ${r.status} ${clean("statusText", r.statusText)}\r\n${headerLines(r.headers)}\r\n`;
  return Buffer.concat([Buffer.from(head, "utf8"), r.body]);
}

export function httpRequestBlock(r: { method: string; url: string; httpVersion?: string; headers: [string, string][]; body?: Uint8Array }): Uint8Array {
  const ver = r.httpVersion ?? "HTTP/1.1";
  if (!HTTP_VERSION_RE.test(ver)) throw new Error("warc: bad http version");
  if (!TOKEN_RE.test(r.method)) throw new Error("warc: bad http method");
  const u = httpUrl("request url", r.url);
  const head = `${r.method} ${u.pathname}${u.search} ${ver}\r\n${headerLines(r.headers)}\r\n`;
  return Buffer.concat([Buffer.from(head, "utf8"), r.body ?? new Uint8Array(0)]);
}

// Deterministic across platforms: zlib stamps the build's OS code into byte 9, so pin it (the CRC does not cover the header).
export function warcGzMember(record: Uint8Array): Uint8Array {
  const out = gzipSync(record);
  out[9] = 3;
  return out;
}

export interface ParsedWarcRecord {
  offset: number;
  length: number; // compressed member span
  headers: Map<string, string>; // lowercase names; a repeated name keeps its first value
  block: Uint8Array;
}

export function parseWarcRecord(bytes: Uint8Array): { headers: Map<string, string>; block: Uint8Array } {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = buf.subarray(0, MAX_WARC_HEADER_BYTES + 4).indexOf(HEADER_END);
  if (end < 0) throw new Error(buf.length > MAX_WARC_HEADER_BYTES ? "warc: header block over 64 KiB" : "warc: no header terminator");
  const lines = buf.subarray(0, end).toString("utf8").split("\r\n");
  if (!/^WARC\/1\.[01]$/.test(lines[0] ?? "")) throw new Error("warc: bad version line");
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const c = line.indexOf(":");
    if (c <= 0) throw new Error("warc: malformed header line");
    const k = line.slice(0, c).trim().toLowerCase();
    if (!headers.has(k)) headers.set(k, line.slice(c + 1).trim());
  }
  const len = headers.get("content-length");
  if (len === undefined || !/^\d+$/.test(len)) throw new Error("warc: missing or bad Content-Length");
  const start = end + 4;
  const n = Number(len);
  if (!Number.isSafeInteger(n) || start + n > buf.length) throw new Error("warc: Content-Length beyond the data");
  if (!buf.subarray(start + n).equals(HEADER_END)) throw new Error("warc: record does not end with CRLF CRLF");
  return { headers, block: buf.subarray(start, start + n) };
}

// Gzip members are found by parsing each header, inflating raw deflate, and reading how many input bytes the engine consumed
// (engine.bytesWritten with info:true); gunzipSync would merge members and lose the boundaries that CDXJ offsets address.
function gzipMember(buf: Buffer, at: number, maxOut: number): { data: Buffer; end: number } {
  if (buf[at] !== 0x1f || buf[at + 1] !== 0x8b || buf[at + 2] !== 8) throw new Error("gzip: bad member header");
  const flags = buf[at + 3] ?? 0;
  let p = at + 10;
  if (flags & 4) {
    if (p + 2 > buf.length) throw new Error("gzip: truncated header");
    p += 2 + buf.readUInt16LE(p);
  }
  for (const bit of [8, 16]) {
    if (flags & bit) {
      const z = buf.indexOf(0, p);
      if (z < 0) throw new Error("gzip: unterminated header string");
      p = z + 1;
    }
  }
  if (flags & 2) p += 2;
  if (p > buf.length) throw new Error("gzip: truncated header");
  // @types/node has no overload for info:true, which returns { buffer, engine }.
  const r = inflateRawSync(buf.subarray(p), { info: true, maxOutputLength: maxOut } as ZlibOptions) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const end = p + r.engine.bytesWritten + 8;
  if (end > buf.length) throw new Error("gzip: truncated trailer");
  if (buf.readUInt32LE(end - 8) !== crc32(r.buffer) || buf.readUInt32LE(end - 4) !== r.buffer.length >>> 0) throw new Error("gzip: trailer mismatch");
  return { data: r.buffer, end };
}

export function parseWarcGz(bytes: Uint8Array, opts: { maxRecordBytes?: number } = {}): ParsedWarcRecord[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: ParsedWarcRecord[] = [];
  for (let at = 0; at < buf.length; ) {
    const m = gzipMember(buf, at, opts.maxRecordBytes ?? MAX_MEMBER_BYTES);
    const rec = parseWarcRecord(m.data);
    out.push({ offset: at, length: m.end - at, headers: rec.headers, block: rec.block });
    at = m.end;
  }
  return out;
}
