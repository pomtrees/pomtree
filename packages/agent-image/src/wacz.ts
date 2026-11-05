// WACZ 1.1.1 builder and offline verifier. Pure: bytes in, bytes out.
// Layout [knowledge-only, from the WACZ 1.1.1 spec and browsertrix output]: archive/*.warc.gz, indexes/index.cdxj, pages/pages.jsonl, and
// datapackage.json last, because it holds the digests of everything before it. The index covers response and resource records, as
// pywb/browsertrix do; request, metadata and warcinfo records are not replay targets and stay out of it.
import { cdxjLines, cdxjTimestamp, type CdxjEntry, parseCdxj, surt } from "./cdxj.ts";
import { parseWarcGz, parseWarcRecord, sha256Hex, splitHttpBlock, warcGzMember, warcRecord, type WarcRecordInput } from "./warc.ts";
import { readZip, zipStored } from "./zip.ts";

export interface WaczPage {
  url: string;
  ts: string; // ISO
  title?: string;
  text?: string;
}

const DATAPACKAGE = "datapackage.json";
const INDEX_PATH = "indexes/index.cdxj";
const PAGES_PATH = "pages/pages.jsonl";
const PAGES_HEADER = { format: "json-pages-1.0", id: "pages", title: "All Pages" };
const MAX_JSONL_BYTES = 64 * 1024 * 1024;

function httpHead(block: Uint8Array): { status: number; headers: Map<string, string> } | null {
  const parts = splitHttpBlock(block);
  if (!parts) return null;
  const [first = "", ...rest] = parts.head.split("\r\n");
  const m = /^HTTP\/\d(?:\.\d)? (\d{3})(?: |$)/.exec(first);
  if (!m) return null;
  const headers = new Map<string, string>();
  for (const line of rest) {
    const c = line.indexOf(":");
    if (c > 0 && !headers.has(line.slice(0, c).trim().toLowerCase())) headers.set(line.slice(0, c).trim().toLowerCase(), line.slice(c + 1).trim());
  }
  return { status: Number(m[1]), headers };
}

export function buildWacz(o: { records: WarcRecordInput[]; pages: WaczPage[]; created: string; software: string; title?: string; warcName?: string }): {
  wacz: Uint8Array;
  warc: Uint8Array;
  cdxj: string;
  datapackage: Record<string, unknown>;
} {
  const warcName = o.warcName ?? "data.warc.gz";
  if (!/^[\w.-]+$/.test(warcName) || warcName.startsWith(".")) throw new Error("wacz: unsafe warcName");
  const members: Buffer[] = [];
  const index: CdxjEntry[] = [];
  let offset = 0;
  for (const r of o.records) {
    const raw = warcRecord(r);
    const member = Buffer.from(warcGzMember(raw));
    // urn: targets (derived views) are not indexed: the index maps page URLs to the page, and a viewer needs no key for a screenshot. verifyWacz exempts them from the every-record-indexed rule.
    if ((r.type === "response" || r.type === "resource") && r.targetUri !== undefined && !r.targetUri.startsWith("urn:")) {
      const rec = parseWarcRecord(raw);
      const http = r.type === "response" ? httpHead(r.block) : null;
      const mime = r.type === "response" ? http?.headers.get("content-type") : r.contentType;
      const payload = rec.headers.get("warc-payload-digest");
      index.push({
        url: r.targetUri,
        date: r.date,
        status: http?.status,
        mime: mime?.split(";")[0]?.trim() || undefined,
        // A response without a payload digest kept no payload (WARC-Truncated); its block digest must not pass for a payload digest.
        digest: payload ?? (r.type === "response" ? undefined : (rec.headers.get("warc-block-digest") as string)),
        truncated: rec.headers.get("warc-truncated"),
        offset,
        length: member.length,
        filename: warcName,
      });
    }
    members.push(member);
    offset += member.length;
  }
  const warc = Buffer.concat(members);
  const cdxj = cdxjLines(index);
  const pages = [
    JSON.stringify(PAGES_HEADER),
    ...o.pages.map((p, i) => {
      cdxjTimestamp(p.ts);
      return JSON.stringify({
        id: `p${i + 1}`,
        url: p.url,
        ts: p.ts,
        ...(p.title !== undefined && { title: p.title }),
        ...(p.text !== undefined && { text: p.text }),
      });
    }),
  ].join("\n");
  const files: { name: string; data: Uint8Array }[] = [
    { name: `archive/${warcName}`, data: warc },
    { name: INDEX_PATH, data: Buffer.from(cdxj, "utf8") },
    { name: PAGES_PATH, data: Buffer.from(`${pages}\n`, "utf8") },
  ];
  const datapackage: Record<string, unknown> = {
    profile: "data-package",
    wacz_version: "1.1.1",
    created: o.created,
    software: o.software,
    ...(o.title !== undefined && { title: o.title }),
    resources: files.map((f) => ({ name: f.name.split("/").pop(), path: f.name, hash: `sha256:${sha256Hex(f.data)}`, bytes: f.data.byteLength })),
  };
  files.push({ name: DATAPACKAGE, data: Buffer.from(`${JSON.stringify(datapackage, null, 2)}\n`, "utf8") });
  const mtime = new Date(o.created);
  return { wacz: zipStored(files.map((f) => ({ ...f, mtime: Number.isNaN(mtime.getTime()) ? undefined : mtime }))), warc, cdxj, datapackage };
}

type Verdict = { ok: true; files: string[]; records: number; pages: number } | { ok: false; problems: string[] };

export function verifyWacz(bytes: Uint8Array): Verdict {
  const problems: string[] = [];
  const bad = (m: string) => problems.push(m);
  try {
    return verify(bytes, bad, problems);
  } catch (e) {
    bad(`unexpected failure: ${(e as Error).message}`);
    return { ok: false, problems };
  }
}

function verify(bytes: Uint8Array, bad: (m: string) => void, problems: string[]): Verdict {
  let entries: ReturnType<typeof readZip>;
  try {
    entries = readZip(bytes);
  } catch (e) {
    bad((e as Error).message);
    return { ok: false, problems };
  }
  const byName = new Map(entries.map((e) => [e.name, e.data]));

  // datapackage.json must list every other member exactly once, with matching digest and size.
  const dp = byName.get(DATAPACKAGE);
  if (!dp) bad("datapackage: datapackage.json is missing");
  else {
    try {
      const pkg = JSON.parse(Buffer.from(dp).toString("utf8")) as Record<string, unknown>;
      if (pkg.profile !== "data-package") bad("datapackage: profile is not data-package");
      if (pkg.wacz_version !== "1.1.1") bad("datapackage: wacz_version is not 1.1.1");
      const listed = new Set<string>();
      for (const r of Array.isArray(pkg.resources) ? (pkg.resources as Record<string, unknown>[]) : []) {
        const path = String(r.path);
        if (listed.has(path)) bad(`datapackage: ${path} is listed twice`);
        listed.add(path);
        const data = byName.get(path);
        if (!data || path === DATAPACKAGE) bad(`datapackage: listed file ${path} is not in the archive`);
        else {
          if (r.hash !== `sha256:${sha256Hex(data)}`) bad(`datapackage: hash mismatch for ${path}`);
          if (r.bytes !== data.byteLength) bad(`datapackage: byte size mismatch for ${path}`);
        }
      }
      if (!Array.isArray(pkg.resources)) bad("datapackage: resources is not a list");
      for (const name of byName.keys()) if (name !== DATAPACKAGE && !listed.has(name)) bad(`datapackage: ${name} is in the archive but not listed`);
    } catch {
      bad("datapackage: datapackage.json is not valid JSON");
    }
  }

  // Every WARC record's digests, and a map from member boundary to record for the index check.
  const warcs = new Map<string, Map<number, ReturnType<typeof parseWarcGz>[number]>>();
  let records = 0;
  for (const [name, data] of byName) {
    if (!name.startsWith("archive/") || !name.endsWith(".warc.gz")) continue;
    let parsed: ReturnType<typeof parseWarcGz>;
    try {
      parsed = parseWarcGz(data);
    } catch (e) {
      bad(`warc: ${name} is unreadable: ${(e as Error).message}`);
      continue;
    }
    const at = new Map<number, (typeof parsed)[number]>();
    parsed.forEach((rec, i) => {
      records++;
      at.set(rec.offset, rec);
      const where = `${name} record ${i}`;
      const block = rec.headers.get("warc-block-digest");
      if (block === undefined) bad(`warc: ${where} has no WARC-Block-Digest`);
      else if (block !== `sha256:${sha256Hex(rec.block)}`) bad(`warc: block digest mismatch in ${where}`);
      const payload = rec.headers.get("warc-payload-digest");
      const type = rec.headers.get("warc-type");
      if (payload !== undefined) {
        const parts = splitHttpBlock(rec.block);
        if (!parts) bad(`warc: ${where} has a payload digest but no http header block`);
        else if (payload !== `sha256:${sha256Hex(parts.body)}`) bad(`warc: payload digest mismatch in ${where}`);
      } else if (
        (type === "response" || type === "request") &&
        /^application\/http/i.test(rec.headers.get("content-type") ?? "") &&
        // Only a body that was not retained (WARC-Truncated: unspecified) goes without a digest; a length-truncated prefix keeps its own.
        rec.headers.get("warc-truncated") !== "unspecified"
      ) {
        bad(`warc: ${where} has no WARC-Payload-Digest`);
      }
    });
    warcs.set(name, at);
  }
  if (warcs.size === 0) bad("warc: no archive/*.warc.gz member");

  // Every index line must land exactly on a member of its WARC and agree with that record; every response/resource must be indexed.
  const indexed = new Set<string>();
  const urls = new Set<string>();
  const idx = byName.get(INDEX_PATH);
  if (!idx) bad(`cdxj: ${INDEX_PATH} is missing`);
  else {
    let lines: ReturnType<typeof parseCdxj> = [];
    try {
      lines = parseCdxj(Buffer.from(idx).toString("utf8"));
    } catch (e) {
      bad(`cdxj: ${(e as Error).message}`);
    }
    for (const [n, l] of lines.entries()) {
      const f = l.fields;
      const where = `cdxj line ${n + 1}`;
      const file = `archive/${String(f.filename)}`;
      const rec = warcs.get(file)?.get(Number(f.offset));
      if (typeof f.url === "string") {
        urls.add(f.url);
        try {
          if (surt(f.url) !== l.key) bad(`cdxj: ${where} key does not match its url`);
        } catch {
          bad(`cdxj: ${where} url is not parseable`);
        }
      } else bad(`cdxj: ${where} has no url`);
      if (!warcs.has(file)) bad(`cdxj: ${where} names ${file}, which is not in the archive`);
      else if (!rec) bad(`cdxj: ${where} offset ${String(f.offset)} is not a gzip member boundary`);
      else {
        indexed.add(`${file}@${rec.offset}`);
        if (String(rec.length) !== String(f.length)) bad(`cdxj: ${where} length ${String(f.length)} is not the member length ${rec.length}`);
        if (rec.headers.get("warc-target-uri") !== f.url) bad(`cdxj: ${where} url differs from the record's WARC-Target-URI`);
        const date = rec.headers.get("warc-date");
        let ts = "";
        try {
          ts = cdxjTimestamp(date ?? "");
        } catch {}
        if (ts !== l.timestamp) bad(`cdxj: ${where} timestamp differs from the record's WARC-Date`);
        const payload = rec.headers.get("warc-payload-digest");
        if ((payload ?? (rec.headers.get("warc-type") === "response" ? undefined : rec.headers.get("warc-block-digest"))) !== f.digest)
          bad(`cdxj: ${where} digest differs from the record's payload digest`);
        if (rec.headers.get("warc-truncated") !== f.truncated) bad(`cdxj: ${where} truncated differs from the record's WARC-Truncated`);
      }
    }
    for (const [file, at] of warcs) {
      for (const rec of at.values()) {
        const type = rec.headers.get("warc-type");
        if ((type === "response" || type === "resource") && !rec.headers.get("warc-target-uri")?.startsWith("urn:") && !indexed.has(`${file}@${rec.offset}`)) {
          bad(`cdxj: ${type} record at ${file}@${rec.offset} (${rec.headers.get("warc-target-uri")}) is not indexed`);
        }
      }
    }
  }

  // pages.jsonl is optional; when present its header must be valid and each page must be replayable from the index.
  let pages = 0;
  const pj = byName.get(PAGES_PATH);
  if (pj && pj.byteLength <= MAX_JSONL_BYTES) {
    const lines = Buffer.from(pj)
      .toString("utf8")
      .split("\n")
      .filter((l) => l !== "");
    try {
      const h = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
      if (h.format !== "json-pages-1.0" || h.id !== "pages") bad("pages: header line is not a json-pages-1.0 header");
    } catch {
      bad("pages: header line is not valid JSON");
    }
    for (const [i, line] of lines.slice(1).entries()) {
      try {
        const p = JSON.parse(line) as Record<string, unknown>;
        pages++;
        if (typeof p.url !== "string") bad(`pages: page ${i + 1} has no url`);
        else if (!urls.has(p.url)) bad(`pages: page ${p.url} has no CDXJ entry`);
      } catch {
        bad(`pages: page line ${i + 1} is not valid JSON`);
      }
    }
  }

  return problems.length ? { ok: false, problems } : { ok: true, files: [...byName.keys()], records, pages };
}
