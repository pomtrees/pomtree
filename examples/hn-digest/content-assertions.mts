// Pure invariant checks over one finished hn-content run. The caller gathers the facts (store reads, approvals, audit
// stream, spend ledger) and passes them in; this module does no fs, network or clock access. Each check is independent, and
// a malformed input fails the check it breaks instead of throwing, so the verdict always lists every check by name.
import { articleRetryable, hash, inert, normalizeForGrounding, record, seenEligible, type StoryResult } from "./content-contract.mts";
import { checkModelCalls } from "./content-model-calls.mts";
import { ANALYST_TOOLS } from "../../packages/agent-image/ext/pomtree-analyst/analyst-contract.ts";

export type AuditRecord = {
  stream: string;
  sequence: number;
  authority: string;
  port?: number;
  peer?: string;
  dialled?: string; // host rows: the address the dial targeted; never proof of a connection
  outcome: "allowed" | "denied" | "connected" | "complete" | "error" | "cancelled" | "limit" | "pending"; // pending: opened, never settled
  bytes?: number;
  sandbox?: string | null;
  agent?: string;
  story?: string;
  generation?: number;
  at?: string;
  connection?: string;
  phase?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  bytesIn?: number;
  bytesOut?: number;
  denyReason?: string;
  limitKind?: string;
  errorClass?: string;
  admittedAt?: string;
  urlSha256?: string;
  pinnedPeer?: string;
  requestId?: string;
  truncated?: boolean; // host fetch: the consumer stopped at its byte cap; the record is `complete` with the bytes read
  route?: string; // model upstream calls only: request path without query
  upstreamStatus?: number; // model upstream calls only
  model?: string; // passed through when the record carries it
};
export type RunFacts = {
  limit: number;
  modelBudgetMicros: number;
  outcome: "published" | "cancelled" | "denied" | "failed";
  result: {
    report?: { id: string; sha256: string };
    draftSha?: string;
    reportBody?: string;
    stories: StoryResult[];
    failedStories?: unknown[];
    entryIds: number[];
  } | null;
  publishedReport: { sha256: string; body: string } | null;
  seen: number[]; // the seen set after the run: the launch seed plus the ids this run added
  seed?: number[]; // the seen set the launch started from (the stored seen state); absent = empty
  approvals: { kind: string; decision: string; subjectSha: string | null }[];
  spend: { totalMicros: number; byStory: Record<string, number>; unreadable?: string[] };
  retainedSha256: string[];
  // The whole stored article text per story id, read by the collector from the retained text report. Absent or missing for a usable
  // article: its citations cannot be resolved, which fails citations-resolve.
  articleTexts?: Record<string, string>;
  expectedAuthorities: string[];
  audit: AuditRecord[];
  declaredCounts: Record<string, number>;
  // The node relay ports this run granted workers at the Docker host alias (agent API, scoped model proxy). Only rows to exactly these
  // are exempt from no-private-ranges; absent or empty exempts nothing.
  relayPorts?: number[];
  modelCalls?: { requestId: string; micros: number }[]; // one per upstream call; absent skips the check; empty passes only with a zero ledger total
  // The tool name of every tool_call row in each story analyst's journal; absent skips the check (a run that never spawned an analyst has none).
  analystTools?: { storyId: number; tools: string[] }[];
};
export type RunCheck = { name: string; ok: boolean; detail: string };
export type RunVerdict = { ok: boolean; checks: RunCheck[]; warnings: string[] };

// The approval `decision` the daemon records for an approved publish (state "approved", see packages/pomtreed/src/approvals.ts).
const APPROVED = "approved";
const PUBLISH = "publish";
const SERVED: ReadonlySet<string> = new Set(["allowed", "connected", "complete"]);

// Warnings never change `ok`; checkRun prefixes each with the check name.
type Verdict = { ok: boolean; detail: string; warnings?: string[] };
const pass = (detail: string): Verdict => ({ ok: true, detail });
const fail = (detail: string): Verdict => ({ ok: false, detail });
const finiteNonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const list = (values: Iterable<unknown>): string => [...values].join(",");
const sameSet = (a: Set<unknown>, b: Set<unknown>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

function storiesOf(f: RunFacts): StoryResult[] {
  const stories = f.result?.stories;
  if (!Array.isArray(stories)) throw new TypeError("result.stories is not an array");
  return stories;
}

function auditOf(f: RunFacts): AuditRecord[] {
  if (!Array.isArray(f.audit)) throw new TypeError("audit is not an array");
  return f.audit;
}

function byStream(audit: AuditRecord[]): Map<string, AuditRecord[]> {
  const out = new Map<string, AuditRecord[]>();
  for (const r of audit) out.set(r.stream, [...(out.get(r.stream) ?? []), r]);
  return out;
}

// Host part of an authority or peer: "host", "host:port", "[v6]:port", or a bare IPv6 address (several colons, no brackets).
function hostOf(value: string): string {
  const s = value.trim().toLowerCase();
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    return end < 0 ? s : s.slice(1, end);
  }
  return s.split(":").length === 2 ? s.slice(0, s.indexOf(":")) : s;
}

function privateV4(octets: number[]): boolean {
  if (octets.some((o) => o > 255)) return true; // not a valid address: fail closed
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8, unspecified
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 100 && b >= 64 && b <= 127) // 100.64/10 (carrier-grade NAT)
  );
}

// Expands an IPv6 literal (with "::" and an optional dotted IPv4 tail) to eight 16-bit words, or null if malformed.
function parseV6(literal: string): number[] | null {
  let s = literal;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail);
    if (!m) return null;
    const o = m.slice(1).map(Number);
    if (o.some((x) => x > 255)) return null;
    s = `${s.slice(0, lastColon + 1)}${(((o[0] as number) << 8) | (o[1] as number)).toString(16)}:${(((o[2] as number) << 8) | (o[3] as number)).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const words = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const head = words(halves[0] as string);
  const rest = halves.length === 2 ? words(halves[1] as string) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const all = halves.length === 2 ? [...head, ...Array<string>(fill).fill("0"), ...rest] : head;
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => Number.parseInt(g, 16));
}

function privateV6(literal: string): boolean {
  const words = parseV6(literal.split("%")[0] as string);
  if (words === null) return true; // unparseable literal: fail closed
  const [w0, , , , , w5, w6, w7] = words as [number, number, number, number, number, number, number, number];
  const prefixZero = words.slice(0, 5).every((w) => w === 0);
  const tail4 = [w6 >> 8, w6 & 255, w7 >> 8, w7 & 255];
  if (words.every((w) => w === 0)) return true; // ::
  if (words.slice(0, 7).every((w) => w === 0) && w7 === 1) return true; // ::1
  if (prefixZero && (w5 === 0xffff || w5 === 0)) return privateV4(tail4); // IPv4-mapped ::ffff:a.b.c.d (or deprecated ::a.b.c.d)
  return (w0 & 0xfe00) === 0xfc00 || (w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0; // fc00::/7, fe80::/10, fec0::/10
}

// True for every host that is not a public, routable name or address. Unknown IPv6 forms fail closed.
function privateHost(raw: string): boolean {
  const h = raw.replace(/\.$/, "");
  if (h === "") return true;
  if (h.includes(":")) return privateV6(h);
  if (!h.includes(".")) return true; // single-label names such as "localhost" or an intranet short name
  if (h.endsWith(".localhost")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m ? privateV4(m.slice(1).map(Number)) : false;
}

function digestClaimsUnion(f: RunFacts): Verdict {
  if (f.outcome !== "published") return pass("not published");
  const body = f.result?.reportBody;
  if (typeof body !== "string") return fail("published run has no reportBody");
  const lines = body.split("\n");
  const expected = storiesOf(f).flatMap((s) => (s.analysis?.claims ?? []).map((c) => `- Tentative (story ${s.story.id}) ${c.basis}: ${inert(c.observation)}`));
  const missing = expected.filter((line) => !lines.includes(line));
  if (missing.length > 0) return fail(`claim line missing from reportBody: ${JSON.stringify(missing[0])}`);
  const rendered = lines.filter((line) => line.startsWith("- Tentative ")).length;
  if (rendered !== expected.length) return fail(`reportBody has ${rendered} "- Tentative " lines for ${expected.length} validated claims`);
  return pass(`${expected.length} claim lines match validated claims`);
}

function storyCount(f: RunFacts): Verdict {
  if (f.outcome !== "published") return pass("not published");
  const failed = f.result?.failedStories;
  if (failed !== undefined && !Array.isArray(failed)) return fail("failedStories is not an array");
  const analyzed = storiesOf(f).length;
  const total = analyzed + (failed?.length ?? 0);
  return total === f.limit ? pass(`${total} stories accounted for`) : fail(`stories ${analyzed} + failed ${failed?.length ?? 0} != limit ${f.limit}`);
}

// A published run that requested stories must have analysed at least one: all stories failing is not a success.
function analysedStories(f: RunFacts): Verdict {
  if (f.outcome !== "published") return pass("not published");
  if (!Number.isSafeInteger(f.limit) || f.limit < 1) return pass("no stories requested");
  const analysed = storiesOf(f).filter((s) => s.analysis !== null).length;
  return analysed >= 1 ? pass(`${analysed} of ${f.limit} requested stories analysed`) : fail(`0 analysed stories of ${f.limit} requested`);
}

// A published run must have produced at least one usable article when it had URL-bearing stories, unless the pages themselves were the
// reason (thin, boilerplate, non-HTML, blocked, an HTTP error): every article dropped for a worker or verification reason means the run
// produced nothing it could check, which is not a success (the entry exits 3, as for analysed-stories).
function usableArticle(f: RunFacts): Verdict {
  if (f.outcome !== "published") return pass("not published");
  const withUrl = storiesOf(f).filter((s) => s.story.url !== null);
  if (withUrl.length === 0) return pass("no URL-bearing story");
  const retryable = withUrl.filter((s) => articleRetryable(s)).length;
  return retryable < withUrl.length
    ? pass(`${withUrl.length - retryable} of ${withUrl.length} URL-bearing stories have a usable article or a page-reason drop`)
    : fail(`every URL-bearing story's article (${withUrl.length}) was dropped for a worker or verification reason`);
}

function seenSet(f: RunFacts): Verdict {
  if (f.outcome !== "published") return pass("not published");
  if (!Array.isArray(f.seen)) return fail("seen is not an array");
  const entryIds = f.result?.entryIds;
  if (!Array.isArray(entryIds)) return fail("result.entryIds is not an array");
  if (f.seed !== undefined && !Array.isArray(f.seed)) return fail("seed is not an array");
  const seed = new Set(f.seed ?? []);
  const seen = new Set(f.seen);
  // Ids this run newly added; the persistent seen state makes `seen` the union with the seed, so compare only the difference.
  const added = new Set([...seen].filter((id) => !seed.has(id)));
  const entries = new Set(entryIds);
  // Analysed stories, minus those whose article is retried next run (seenEligible).
  const analyzed = new Set(
    storiesOf(f)
      .filter(seenEligible)
      .map((s) => s.story.id),
  );
  const reselected = storiesOf(f)
    .map((s) => s.story.id)
    .filter((id) => seed.has(id));
  if (reselected.length > 0) return fail(`seeded (already seen) ids were selected again: [${list(reselected)}]`);
  if (!sameSet(added, entries)) return fail(`newly seen [${list(added)}] != entryIds [${list(entries)}] (seed [${list(seed)}], seen [${list(seen)}])`);
  if (!sameSet(entries, analyzed)) return fail(`entryIds [${list(entries)}] != seen-eligible analyzed stories [${list(analyzed)}]`);
  return pass(`${added.size} newly seen ids match entryIds and analyzed stories; ${seed.size} seeded ids not re-selected`);
}

// Same whitespace-normalized substring rule as parseAnalysis; an empty normalized quote never grounds.
const grounded = (text: string, quote: string): boolean => {
  const q = normalizeForGrounding(quote);
  return q !== "" && normalizeForGrounding(text).includes(q);
};

// Returns null when the citation resolves to captured text (and retained, for article text), else the reason it does not.
function resolveCitation(ref: unknown, story: StoryResult, retained: ReadonlySet<string>, articleText: string | undefined): string | null {
  if (!record(ref) || typeof ref.quote !== "string" || ref.quote === "") return "citation is not an object with a quote";
  const { evidence } = story;
  if (ref.kind === "article") {
    const a = evidence.article;
    if (a?.status !== "usable") return `article citation but story ${story.story.id} has no usable article`;
    if (ref.id !== story.story.id) return `article citation id ${String(ref.id)} is not story ${story.story.id}`;
    if (ref.sha256 !== a.textHash) return "article citation sha256 is not the captured textHash";
    if (articleText === undefined) return "article text is not available to check the quote against";
    if (!grounded(articleText, ref.quote)) return "article quote is not a substring of captured text";
    if (a.textReport !== undefined && !retained.has(a.textReport.sha256)) return "article textReport is not in retainedSha256";
    return null;
  }
  if (ref.kind === "comment") {
    const c = evidence.comments.find((x) => x.id === ref.id && x.status === "usable");
    if (c === undefined) return `no usable comment ${String(ref.id)} captured for story ${story.story.id}`;
    if (ref.sha256 !== c.sha256) return `comment ${c.id} citation sha256 mismatch`;
    if (!grounded(c.text, ref.quote)) return `comment ${c.id} quote is not a substring of captured text`;
    return null;
  }
  return "citation kind is neither article nor comment";
}

function citationsResolve(f: RunFacts): Verdict {
  if (f.result === null) return pass("no result");
  if (!Array.isArray(f.retainedSha256)) return fail("retainedSha256 is not an array");
  const retained = new Set(f.retainedSha256);
  const problems: string[] = [];
  for (const s of storiesOf(f)) {
    const article = s.evidence.article;
    const articleText = f.articleTexts?.[String(s.story.id)];
    if (article?.status === "usable" && (articleText === undefined || hash(articleText) !== article.textHash))
      problems.push(`story ${s.story.id}: ${articleText === undefined ? "article text was not collected" : "article text does not hash to textHash"}`);
    for (const ref of (s.analysis?.claims ?? []).flatMap((c) => c.citations)) {
      const reason = resolveCitation(ref, s, retained, articleText);
      if (reason !== null) problems.push(`story ${s.story.id}: ${reason}`);
    }
    for (const ref of s.analysis?.sentimentEvidence ?? []) {
      const reason = resolveCitation(ref, s, retained, articleText);
      if (reason !== null) problems.push(`story ${s.story.id}: sentiment ${reason}`);
    }
    for (const id of s.analysis?.sentiment.citations ?? []) {
      const cited = (s.analysis?.sentimentEvidence ?? []).some((ref) => ref.id === id);
      const usable = s.evidence.comments.some((c) => c.id === id && c.status === "usable");
      if (!cited || !usable) problems.push(`story ${s.story.id}: sentiment citation ${id} does not resolve to a usable sampled comment`);
    }
  }
  if (problems.length > 0) return fail(`${problems.length} unresolved; first: ${problems[0]}`);
  return pass("every citation resolves to captured, retained text");
}

function spendTotal(f: RunFacts): Verdict {
  const { totalMicros, unreadable } = f.spend;
  if (unreadable !== undefined && !Array.isArray(unreadable)) return fail("spend.unreadable is not an array");
  if (unreadable !== undefined && unreadable.length > 0) return fail(`spend unreadable for ${unreadable.length} agent(s): ${list(unreadable)}`);
  if (!finiteNonNegative(totalMicros)) return fail(`totalMicros ${String(totalMicros)} is not a finite non-negative number`);
  if (!Number.isFinite(f.modelBudgetMicros)) return fail("modelBudgetMicros is not finite");
  return totalMicros <= f.modelBudgetMicros
    ? pass(`${totalMicros} of ${f.modelBudgetMicros} micros`)
    : fail(`${totalMicros} exceeds budget ${f.modelBudgetMicros}`);
}

function spendPerStory(f: RunFacts): Verdict {
  if (!Number.isSafeInteger(f.limit) || f.limit < 1) return fail("limit is not a positive integer");
  const ceiling = Math.floor(f.modelBudgetMicros / f.limit);
  const entries = Object.entries(f.spend.byStory);
  for (const [story, micros] of entries) {
    if (!finiteNonNegative(micros) || micros > ceiling) return fail(`story ${story} spent ${String(micros)}, per-story ceiling ${ceiling}`);
  }
  return pass(`${entries.length} stories within ${ceiling} micros each`);
}

// An error record proves the connection happened only when a response status was recorded or bytes flowed (`dialled` and `peer` on
// an error row are not proof: a failed dial carries its target); a fetch that only ended in error is then a warning, not a pass without comment, because the content may be partial.
function fetchAudited(f: RunFacts): Verdict {
  const audit = auditOf(f);
  if (!Array.isArray(f.expectedAuthorities)) return fail("expectedAuthorities is not an array");
  const warnings: string[] = [];
  for (const expected of f.expectedAuthorities) {
    const host = hostOf(expected);
    const mine = audit.filter((r) => hostOf(r.authority) === host);
    if (mine.length === 0) return fail(`${host}: no audit record`);
    if (mine.some((r) => r.outcome === "denied")) return fail(`${host}: has a denied audit record`);
    const pending = mine.filter((r) => r.outcome === "pending").length;
    if (pending > 0) warnings.push(`${host}: ${pending} pending audit record(s); the call did not settle`);
    for (const r of mine) {
      const hosts: [string, string][] = [["authority", hostOf(r.authority)]];
      if (r.peer !== undefined) hosts.push(["peer", hostOf(r.peer)]);
      if (r.dialled !== undefined) hosts.push(["dialled", hostOf(r.dialled)]);
      for (const [field, h] of hosts) if (privateHost(h)) return fail(`${host}: audit record has private ${field} ${h}`);
    }
    if (mine.some((r) => SERVED.has(r.outcome))) continue;
    const proof = mine.filter((r) => r.outcome === "error" && ((r.bytes ?? 0) > 0 || r.status !== undefined || r.upstreamStatus !== undefined));
    if (proof.length === 0) return fail(`${host}: no allowed, connected or complete audit record, and no connected error record`);
    const bytes = proof.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
    warnings.push(`${host}: audited only by outcome=error record(s) (bytes ${bytes}); fetch was recorded but did not complete`);
  }
  const detail = `${f.expectedAuthorities.length} expected authorities audited`;
  return warnings.length > 0 ? { ...pass(detail), warnings } : pass(detail);
}

const RELAY_HOST = "host.docker.internal";

// The port of a row: its own field, else the authority's "host:port" suffix.
function portOf(r: AuditRecord): number | undefined {
  if (r.port !== undefined) return r.port;
  const m = /:(\d+)$/.exec(r.authority);
  return m ? Number(m[1]) : undefined;
}

function noPrivateRanges(f: RunFacts): Verdict {
  const audit = auditOf(f);
  if (f.relayPorts !== undefined && !Array.isArray(f.relayPorts)) return fail("relayPorts is not an array");
  const relays = new Set(f.relayPorts ?? []);
  for (const r of audit) {
    // The model/report relays are reached at the Docker host alias, whose address is private by construction (192.168.65.254 on Docker
    // Desktop); rows to exactly the relay ports this run granted (including the unattributed model-route preflight) are exempt. Any other
    // port at the alias, and any other private authority or peer, still fails.
    const port = portOf(r);
    if (hostOf(r.authority) === RELAY_HOST && port !== undefined && relays.has(port)) continue;
    const hosts: [string, string][] = [["authority", hostOf(r.authority)]];
    if (r.peer !== undefined) hosts.push(["peer", hostOf(r.peer)]);
    for (const [field, host] of hosts) {
      if (privateHost(host))
        return fail(`stream ${r.stream} sequence ${r.sequence}: ${field} ${host} is loopback, private, link-local, unspecified or single-label`);
    }
  }
  return pass(`${audit.length} audit records have only public hosts`);
}

function auditContiguous(f: RunFacts): Verdict {
  const streams = byStream(auditOf(f));
  for (const [stream, records] of streams) {
    const seqs = records.map((r) => r.sequence).sort((a, b) => a - b);
    const bad = seqs.findIndex((seq, i) => seq !== i + 1);
    if (bad !== -1) return fail(`stream ${stream}: expected sequence ${bad + 1}, found ${String(seqs[bad])} (gap or duplicate)`);
  }
  return pass(`${streams.size} streams have sequences 1..n`);
}

function auditCounts(f: RunFacts): Verdict {
  const streams = byStream(auditOf(f));
  const declared = new Map(Object.entries(f.declaredCounts));
  for (const [stream, records] of streams) {
    if (declared.get(stream) !== records.length) return fail(`stream ${stream}: declared ${String(declared.get(stream))}, collected ${records.length}`);
  }
  for (const [stream, count] of declared) {
    if (!streams.has(stream) && count !== 0) return fail(`stream ${stream}: declared ${count} records but none collected`);
  }
  return pass(`${streams.size} streams match declared counts`);
}

function approvalSha(f: RunFacts): Verdict {
  if (!Array.isArray(f.approvals)) return fail("approvals is not an array");
  const approved = f.approvals.filter((a) => a.kind === PUBLISH && a.decision === APPROVED);
  if (f.outcome !== "published") {
    return approved.length > 0 && f.publishedReport === null ? fail("approved publish exists but no report was published") : pass("not published");
  }
  if (approved.length !== 1) return fail(`expected exactly one approved publish, found ${approved.length}`);
  const report = f.publishedReport;
  if (report === null) return fail("published run has no publishedReport");
  const shas = {
    subjectSha: approved[0]?.subjectSha,
    publishedSha256: report.sha256,
    bodyHash: hash(report.body),
    draftSha: f.result?.draftSha,
    reportSha256: f.result?.report?.sha256,
  };
  if (Object.values(shas).some((v) => typeof v !== "string")) return fail(`missing hash: ${JSON.stringify(shas)}`);
  if (new Set(Object.values(shas)).size !== 1) return fail(`hash mismatch: ${JSON.stringify(shas)}`);
  return pass("approval subject, published report, draft and report hashes agree");
}

function cancelNothingPublished(f: RunFacts): Verdict {
  if (f.outcome === "published") return pass("published");
  const problems: string[] = [];
  if (f.publishedReport !== null) problems.push("publishedReport is present");
  if (f.result?.report !== undefined) problems.push("result.report is present");
  const seed = new Set(f.seed ?? []);
  const added = f.seen.filter((id) => !seed.has(id));
  if (added.length !== 0) problems.push(`seen gained ${added.length} ids`);
  if ((f.result?.entryIds ?? []).length !== 0) problems.push("result.entryIds is non-empty");
  return problems.length === 0 ? pass(`outcome ${f.outcome}: nothing published or seen`) : fail(problems.join("; "));
}

// Per-call model micros must sum to the ledger total, with unique requestIds. Independent of the other checks: absent rows pass.
function modelCallsMatchLedger(f: RunFacts): Verdict {
  const rows = f.modelCalls;
  if (rows === undefined) return pass("no model-call rows supplied");
  if (!Array.isArray(rows)) return fail("modelCalls is not an array");
  const v = checkModelCalls(rows, f.spend.totalMicros);
  return v.ok ? pass(v.detail) : fail(v.detail);
}

// The analyst's Pi offers exactly ANALYST_TOOLS (TODO(analyst-allowlist)); a journaled call to anything else (bash, read, write, edit, a
// browser tool) means the allowlist did not hold. Like browser-live-audit's FORBIDDEN_WORKER_TOOLS, but a closed allow list, not a deny list.
function analystToolsOnly(f: RunFacts): Verdict {
  const analysts = f.analystTools;
  if (analysts === undefined) return pass("no analyst tool traces supplied");
  if (!Array.isArray(analysts)) return fail("analystTools is not an array");
  const allowed: readonly string[] = ANALYST_TOOLS;
  const bad = analysts.flatMap((a) =>
    [...new Set(a.tools.filter((t) => !allowed.includes(t)))].map((t) => `story ${a.storyId} called ${JSON.stringify(t.slice(0, 64))}`),
  );
  const calls = analysts.reduce((n, a) => n + a.tools.length, 0);
  return bad.length === 0
    ? pass(`${analysts.length} analyst(s), ${calls} tool call(s), only ${allowed.join(" and ")}`)
    : fail(`analyst called a tool outside its allowlist [${allowed.join(", ")}]: ${bad.join("; ")}`);
}

const CHECKS: { name: string; run: (f: RunFacts) => Verdict }[] = [
  { name: "digest-claims-union", run: digestClaimsUnion },
  { name: "story-count", run: storyCount },
  { name: "analysed-stories", run: analysedStories },
  { name: "usable-article", run: usableArticle },
  { name: "seen-set", run: seenSet },
  { name: "citations-resolve", run: citationsResolve },
  { name: "spend-total", run: spendTotal },
  { name: "spend-per-story", run: spendPerStory },
  { name: "fetch-audited", run: fetchAudited },
  { name: "no-private-ranges", run: noPrivateRanges },
  { name: "audit-contiguous", run: auditContiguous },
  { name: "audit-counts", run: auditCounts },
  { name: "approval-sha", run: approvalSha },
  { name: "cancel-nothing-published", run: cancelNothingPublished },
  { name: "model-calls-match-ledger", run: modelCallsMatchLedger },
  { name: "analyst-tools-only", run: analystToolsOnly },
];

export function checkRun(input: RunFacts): RunVerdict {
  const warnings: string[] = [];
  const checks = CHECKS.map(({ name, run }) => {
    let verdict: Verdict;
    try {
      verdict = run(input);
    } catch (error) {
      verdict = fail(`malformed input: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const w of verdict.warnings ?? []) warnings.push(`${name}: ${w}`);
    return { name, ok: verdict.ok, detail: verdict.detail };
  });
  return { ok: checks.every((c) => c.ok), checks, warnings };
}
