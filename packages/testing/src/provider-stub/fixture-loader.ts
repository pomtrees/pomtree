import { readFileSync } from "node:fs";

// The locked provider-fixture format (docs of the sandbox-backends conformance design, "Locked fixture format"): one JSONL file per provider scenario.
// Line 1 is the provenance header; every later line is one expected exchange. The loader REJECTS a fixture whose header is missing or incomplete, so a
// fixture never enters a test without saying where its bytes came from (a stub written from the adapter author's reading of the docs mirrors that
// reading's mistakes, so the reader of a green test must be able to tell captured evidence from inference).

export type Provenance = "captured" | "inferred";

export interface FixtureHeader {
  /** `captured`: bytes recorded from the real provider; `inferred`: written by hand from documentation or guesswork. */
  readonly provenance: Provenance;
  readonly provider: string;
  /** Where the bytes came from: a recorder run id, a documentation URL, or a note. */
  readonly source: string;
  /** `YYYY-MM-DD` of the capture or of the reading. */
  readonly date: string;
  /** The provider API version the bytes belong to (for example `v1` or `2024-01`). */
  readonly apiVersion: string;
  /** Ids the scrub scan may find in this file (it reads this field by name). */
  readonly placeholders: readonly string[];
}

export interface StreamStep {
  /** `in`: a frame the client must send next; `out`: a frame the server sends. */
  readonly dir: "in" | "out";
  /** Text frame payload, or base64 when `binary` is set. */
  readonly data: string;
  readonly binary?: boolean;
}

export interface FixtureMatch {
  /** Request headers that must be present with exactly these values (names compared case-insensitively). */
  readonly requestHeaders?: Readonly<Record<string, string>>;
  /** sha256 hex of the request body: canonical JSON (sorted keys) when it parses, else the raw text. */
  readonly requestBodySha256?: string;
}

export interface FixtureEntry {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly requestBody?: unknown;
  readonly match?: FixtureMatch;
  readonly status: number;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly responseBody?: unknown;
  /** Present on an upgrade exchange (status 101): the frame script run after the handshake. */
  readonly stream?: readonly StreamStep[];
}

export interface Fixture {
  readonly name: string;
  readonly header: FixtureHeader;
  readonly entries: readonly FixtureEntry[];
}

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

const HEADER_EXAMPLE =
  '{"provenance":"inferred","provider":"<name>","source":"<doc url or note>","date":"YYYY-MM-DD","apiVersion":"<version>","placeholders":[]}';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrMap = (v: unknown): v is Record<string, string> => isObj(v) && Object.values(v).every((x) => typeof x === "string");

function parseHeader(name: string, line: string | undefined): FixtureHeader {
  const where = `fixture ${name}, line 1`;
  if (line === undefined) throw new FixtureError(`${where}: the file is empty; add the provenance header as the first line, for example ${HEADER_EXAMPLE}`);
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    throw new FixtureError(`${where}: the first line is not JSON, so there is no provenance header; make it the header, for example ${HEADER_EXAMPLE}`);
  }
  if (!isObj(v) || !("provenance" in v)) {
    throw new FixtureError(
      `${where}: the first line has no "provenance" field, so the fixture does not say where its bytes came from; add a header such as ${HEADER_EXAMPLE} (use "captured" only for bytes a recorder took from the provider)`,
    );
  }
  if (v.provenance !== "captured" && v.provenance !== "inferred") {
    throw new FixtureError(
      `${where}: provenance is ${JSON.stringify(v.provenance)}; accepted: "captured" (recorded from the provider) or "inferred" (written by hand)`,
    );
  }
  for (const f of ["provider", "source", "date", "apiVersion"] as const) {
    if (typeof v[f] !== "string" || v[f] === "")
      throw new FixtureError(`${where}: header field "${f}" is missing or not a non-empty string; add it, for example ${HEADER_EXAMPLE}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date as string)) {
    throw new FixtureError(`${where}: header date ${JSON.stringify(v.date)} is not YYYY-MM-DD; write the capture or reading date, for example 2026-11-11`);
  }
  if (!Array.isArray(v.placeholders) || !v.placeholders.every((p) => typeof p === "string")) {
    throw new FixtureError(`${where}: header field "placeholders" must be an array of strings (use [] when the file has none); the scrub scan reads it`);
  }
  return {
    provenance: v.provenance,
    provider: v.provider as string,
    source: v.source as string,
    date: v.date as string,
    apiVersion: v.apiVersion as string,
    placeholders: v.placeholders as string[],
  };
}

function parseStep(where: string, s: unknown): StreamStep {
  if (!isObj(s) || (s.dir !== "in" && s.dir !== "out") || typeof s.data !== "string" || (s.binary !== undefined && typeof s.binary !== "boolean")) {
    throw new FixtureError(`${where}: a stream step must be {"dir":"in"|"out","data":"<text or base64>","binary"?:boolean}; fix the step`);
  }
  return { dir: s.dir, data: s.data, ...(s.binary === undefined ? {} : { binary: s.binary }) };
}

function parseEntry(name: string, lineNo: number, line: string, prevSeq: number): FixtureEntry {
  const where = `fixture ${name}, line ${lineNo}`;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    throw new FixtureError(`${where}: not valid JSON; each line after the header is one JSON object {seq, method, path, status, ...}`);
  }
  if (!isObj(v)) throw new FixtureError(`${where}: expected a JSON object {seq, method, path, status, ...}`);
  if (!Number.isInteger(v.seq) || (v.seq as number) <= prevSeq) {
    throw new FixtureError(
      `${where}: seq ${JSON.stringify(v.seq)} must be an integer greater than the previous entry's (${prevSeq}); number the entries in the order the adapter sends them`,
    );
  }
  if (typeof v.method !== "string" || v.method !== v.method.toUpperCase() || v.method === "") {
    throw new FixtureError(`${where}: method ${JSON.stringify(v.method)} must be an upper-case HTTP method such as "POST"`);
  }
  if (typeof v.path !== "string" || !v.path.startsWith("/") || v.path.includes("?")) {
    throw new FixtureError(`${where}: path ${JSON.stringify(v.path)} must start with "/" and carry no query; put the query in "query"`);
  }
  if (!Number.isInteger(v.status) || (v.status as number) < 100 || (v.status as number) > 599) {
    throw new FixtureError(`${where}: status ${JSON.stringify(v.status)} must be an HTTP status from 100 to 599`);
  }
  if (v.query !== undefined && !isStrMap(v.query)) throw new FixtureError(`${where}: "query" must map names to string values`);
  if (v.responseHeaders !== undefined && !isStrMap(v.responseHeaders)) throw new FixtureError(`${where}: "responseHeaders" must map names to string values`);
  let match: FixtureMatch | undefined;
  if (v.match !== undefined) {
    const m = v.match;
    if (
      !isObj(m) ||
      (m.requestHeaders !== undefined && !isStrMap(m.requestHeaders)) ||
      (m.requestBodySha256 !== undefined && !/^[0-9a-f]{64}$/.test(String(m.requestBodySha256)))
    ) {
      throw new FixtureError(`${where}: "match" must be {requestHeaders?: {name: value}, requestBodySha256?: <64 hex chars>}`);
    }
    match = {
      ...(m.requestHeaders === undefined ? {} : { requestHeaders: m.requestHeaders as Record<string, string> }),
      ...(m.requestBodySha256 === undefined ? {} : { requestBodySha256: m.requestBodySha256 as string }),
    };
  }
  let stream: StreamStep[] | undefined;
  if (v.stream !== undefined) {
    if (!Array.isArray(v.stream) || v.stream.length === 0) throw new FixtureError(`${where}: "stream" must be a non-empty array of steps`);
    if (v.status !== 101) throw new FixtureError(`${where}: an entry with "stream" is a websocket upgrade and must have status 101, not ${v.status}`);
    stream = v.stream.map((s) => parseStep(where, s));
  } else if (v.status === 101) {
    throw new FixtureError(`${where}: status 101 is a websocket upgrade and needs a "stream" array of steps`);
  }
  return {
    seq: v.seq as number,
    method: v.method,
    path: v.path,
    ...(v.query === undefined ? {} : { query: v.query as Record<string, string> }),
    ...("requestBody" in v ? { requestBody: v.requestBody } : {}),
    ...(match === undefined ? {} : { match }),
    status: v.status as number,
    ...(v.responseHeaders === undefined ? {} : { responseHeaders: v.responseHeaders as Record<string, string> }),
    ...("responseBody" in v ? { responseBody: v.responseBody } : {}),
    ...(stream === undefined ? {} : { stream }),
  };
}

/** Parses fixture text. `name` labels errors. Throws `FixtureError` (cause and action in the message) on a missing or incomplete header or a malformed entry. */
export function parseFixture(text: string, name: string): Fixture {
  const lines = text.split("\n").map((l, i) => ({ l: l.trim(), n: i + 1 }));
  const nonEmpty = lines.filter((x) => x.l !== "");
  const header = parseHeader(name, nonEmpty[0]?.l);
  const entries: FixtureEntry[] = [];
  let prev = 0;
  for (const { l, n } of nonEmpty.slice(1)) {
    const e = parseEntry(name, n, l, prev);
    entries.push(e);
    prev = e.seq;
  }
  return { name, header, entries };
}

/** Reads and parses a fixture file (`.jsonl`). */
export function loadFixture(path: string): Fixture {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new FixtureError(`cannot read fixture ${path}: ${(e as Error).message}; check the path, fixtures live beside their adapter package`);
  }
  return parseFixture(text, path);
}

/** Fixtures older than this are stale (a lite test fails on a provenance date older than 180 days). */
export const FIXTURE_MAX_AGE_DAYS = 180;

/**
 * Throws `FixtureError` when the header date is more than `FIXTURE_MAX_AGE_DAYS` before `now` (or after it). A test that scans tracked fixtures
 * calls this with the real clock; tests inject `now`. The loader itself does not reject age, so an old fixture still loads for inspection.
 */
// TODO(fixture-fresh-gate): only provider-stub/server.test.ts calls this, with a fixed clock, so the 180-day limit is enforced on no real fixture;
// current behavior: an old tracked fixture still loads and passes. Add a scan that calls it with the real clock.
export function assertFixtureFresh(fixture: Fixture, now: Date, maxAgeDays: number = FIXTURE_MAX_AGE_DAYS): void {
  const days = Math.floor((now.getTime() - Date.parse(`${fixture.header.date}T00:00:00Z`)) / 86_400_000);
  if (days < 0) {
    throw new FixtureError(
      `fixture ${fixture.name}: header date ${fixture.header.date} is in the future; fix the date to the day the bytes were captured or read`,
    );
  }
  if (days > maxAgeDays) {
    throw new FixtureError(
      `fixture ${fixture.name}: provenance date ${fixture.header.date} is ${days} days old, over the ${maxAgeDays}-day limit; re-check it against the provider (re-record it with the recorder when approved) and update the date`,
    );
  }
}
