import assert from "node:assert/strict";
import { tmpDir } from "@pomtree/testing";
import { join } from "node:path";
import test from "node:test";
import { type EgressAuditRecord, validateRecord } from "@pomtree/sandbox-docker";
import { openStore } from "@pomtree/store-sqlite";
import { EGRESS_AUDIT_KIND, EgressAuditCollector, validateEgressAuditRecord } from "./egress-audit.ts";
import { ChainedEgressAuditReader } from "./egress-audit.fixtures.ts";

const identity = { sandbox: "box", agent: "capture", host: "h", generation: 4 };
const base: EgressAuditRecord = {
  kind: "egress",
  ...identity,
  eventId: "box:1",
  sequence: 1,
  at: 100,
  connection: "c",
  phase: "admission",
  transport: "http",
  authority: "example.test:80",
  method: "GET",
  url: "http://example.test:80/[redacted]",
  outcome: "allowed",
  chain: "0".repeat(64),
};
const outcome = { ...base, phase: "outcome" } as const;
const fromJson = (json: string): EgressAuditRecord => JSON.parse(json) as EgressAuditRecord;

// Each row is one hostile or garbled spool line with the verdict both validators must give it. `sequence` is the position
// the reader expects (default 1). The proxy holds the log directory read-write, so none of these may be trusted.
const corpus: { name: string; row: unknown; ok: boolean; sequence?: number }[] = [
  { name: "valid http admission", row: base, ok: true },
  { name: "valid connect admission", row: { ...base, transport: "connect", method: undefined, url: undefined, authority: "example.test:443" }, ok: true },
  { name: "legacy row without newer optional fields", row: { ...base, method: undefined, url: undefined }, ok: true },
  {
    name: "full denied row with peers and admittedAt",
    row: {
      ...outcome,
      outcome: "denied",
      denyReason: "private",
      peer: "10.0.0.1",
      peers: ["10.0.0.1"],
      admittedAt: "2026-01-01T00:00:00.000Z",
      status: 403,
      bytesIn: 0,
      bytesOut: 0,
      durationMs: 3,
    },
    ok: true,
  },
  { name: "valid coalesced summary row", row: { ...outcome, outcome: "denied", denyReason: "private", repeats: 3, firstAt: 50, lastAt: 100 }, ok: true },
  { name: "summary with repeats but no window", row: { ...outcome, outcome: "denied", denyReason: "private", repeats: 3 }, ok: false },
  { name: "summary with repeats below 1", row: { ...outcome, outcome: "denied", denyReason: "private", repeats: 0, firstAt: 50, lastAt: 100 }, ok: false },
  { name: "normalized unrepresentable method token", row: { ...base, method: "OTHER", outcome: "denied", denyReason: "not-allowlisted" }, ok: true },
  { name: "bad method (hyphenated, e.g. M-SEARCH)", row: { ...base, method: "M-SEARCH" }, ok: false },
  { name: "bad method (digits)", row: { ...base, method: "GET2" }, ok: false },
  { name: "bad method (lowercase)", row: { ...base, method: "get" }, ok: false },
  { name: "bad method (too long)", row: { ...base, method: "A".repeat(33) }, ok: false },
  { name: "https url", row: { ...base, url: "https://example.test:80/[redacted]" }, ok: false },
  { name: "url with query", row: { ...base, url: "http://example.test:80/[redacted]?x=1" }, ok: false },
  { name: "url with credentials", row: { ...base, url: "http://u:p@example.test:80/[redacted]" }, ok: false },
  { name: "url with unredacted path", row: { ...base, url: "http://example.test:80/secret" }, ok: false },
  { name: "denyReason outside the enum", row: { ...outcome, outcome: "denied", denyReason: "because" }, ok: false },
  { name: "denyReason on a non-denied outcome", row: { ...outcome, outcome: "complete", denyReason: "dns" }, ok: false },
  { name: "limitKind outside the enum", row: { ...outcome, outcome: "limit", limitKind: "forever" }, ok: false },
  { name: "limitKind on a non-limit outcome", row: { ...outcome, outcome: "denied", limitKind: "idle" }, ok: false },
  { name: "errorClass outside the enum", row: { ...outcome, outcome: "error", errorClass: "boom" }, ok: false },
  { name: "errorClass on a non-error outcome", row: { ...outcome, outcome: "complete", errorClass: "dial" }, ok: false },
  { name: "oversize bytes (unsafe integer)", row: { ...outcome, outcome: "complete", bytesIn: 2 ** 60 }, ok: false },
  { name: "negative bytes", row: { ...outcome, outcome: "complete", bytesOut: -1 }, ok: false },
  { name: "fractional duration", row: { ...outcome, outcome: "complete", durationMs: 1.5 }, ok: false },
  { name: "status out of range", row: { ...outcome, outcome: "complete", status: 99 }, ok: false },
  { name: "non-ISO admittedAt", row: { ...outcome, admittedAt: "yesterday" }, ok: false },
  { name: "admittedAt not in canonical ISO form", row: { ...outcome, admittedAt: "2026-01-01" }, ok: false },
  { name: "peers not an array", row: { ...outcome, peers: "10.0.0.1" }, ok: false },
  { name: "too many peers", row: { ...outcome, peers: Array.from({ length: 9 }, (_, i) => `10.0.0.${i}`) }, ok: false },
  { name: "non-string peer", row: { ...outcome, peers: [1] }, ok: false },
  { name: "sequence gap", row: { ...base, eventId: "box:3", sequence: 3 }, ok: false },
  { name: "sequence regression", row: { ...base, eventId: "box:1", sequence: 1 }, ok: false, sequence: 2 },
  { name: "eventId for a different sandbox", row: { ...base, eventId: "other:1" }, ok: false },
  { name: "wrong sandbox", row: { ...base, sandbox: "other", eventId: "other:1" }, ok: false },
  { name: "wrong kind", row: { ...base, kind: "other" }, ok: false },
  { name: "CONNECT with a url", row: { ...base, transport: "connect", authority: "example.test:443" }, ok: false },
  { name: "CONNECT with a status", row: { ...base, transport: "connect", method: undefined, url: undefined, status: 200 }, ok: false },
  { name: "extra field", row: { ...base, extra: "x" }, ok: false },
  { name: "missing connection", row: { ...base, connection: undefined }, ok: false },
  { name: "overlong connection", row: { ...base, connection: "c".repeat(129) }, ok: false },
  { name: "authority with a path", row: { ...base, authority: "example.test/x" }, ok: false },
  { name: "authority with a backslash", row: { ...base, authority: "example.test\\x" }, ok: false },
  { name: "unknown phase", row: { ...base, phase: "later" }, ok: false },
  { name: "unknown outcome", row: { ...base, outcome: "exploded" }, ok: false },
  { name: "__proto__ own key", row: fromJson(`{"__proto__":{"polluted":true},${JSON.stringify(base).slice(1)}`), ok: false },
  { name: "constructor key", row: { ...base, constructor: { prototype: {} } }, ok: false },
  { name: "null row", row: null, ok: false },
  { name: "array row", row: [], ok: false },
];

function verdict(run: () => void): boolean {
  try {
    run();
    return true;
  } catch {
    return false;
  }
}

test("sandbox-docker validateRecord and pomtreed's ingest validator agree on every corpus row", () => {
  for (const { name, row, ok, sequence = 1 } of corpus) {
    const r = row as EgressAuditRecord;
    assert.equal(
      verdict(() => validateRecord(r, identity, sequence)),
      ok,
      `sandbox-docker verdict for: ${name}`,
    );
    assert.equal(
      verdict(() => validateEgressAuditRecord(r, "box", sequence)),
      ok,
      `pomtreed verdict for: ${name}`,
    );
  }
  assert.equal(Object.prototype.hasOwnProperty.call({}, "polluted"), false);
});

test("a single hostile row mid-spool quarantines its spool at its cursor without leaking raw row content", async () => {
  const dir = tmpDir("egress-corpus-");
  const store = openStore(join(dir, "db.sqlite"));
  try {
    const root = await store.registry.create({
      id: "root",
      parent: null,
      name: "root",
      task: "root",
      host: "h",
      budgetMicros: 0,
      executor: "deterministic",
      spec: { driver: "root", input: null },
      idempotencyKey: "root",
    });
    const secret = "SECRET-RAW-ROW-CONTENT";
    const rows: EgressAuditRecord[] = [1, 2, 3].map((n) => ({ ...base, eventId: `box:${n}`, sequence: n, connection: `c${n}` }));
    // Row 2 is hostile: an enum value the sandbox-docker reader rejects (and pomtreed previously did not look at).
    rows[1] = { ...rows[1]!, outcome: "complete", phase: "outcome", denyReason: secret as never };
    const reader = new ChainedEgressAuditReader();
    reader.setRecords("box", rows);
    const collector = new EgressAuditCollector({ reader, journal: store.journal, root: async () => root });
    // A row that fails validation quarantines its spool; the tick succeeds and health is unaffected.
    assert.equal(await collector.ingest(), 1);
    assert.equal(collector.healthy(), true);
    const all = JSON.stringify(await store.journal.read({ agent: root.id, from: 0, limit: 10 }));
    assert.equal(all.includes(secret), false);
    assert.match(all, /ext\.egress\.quarantine/);
    assert.equal(reader.ackedThrough("box"), 0);
    const journaled = (await store.journal.read({ agent: root.id, from: 0, limit: 10 })).filter((e) => e.payload.kind === EGRESS_AUDIT_KIND);
    assert.equal(journaled.length, 1, "only the row before the hostile one is ingested");
  } finally {
    store.close?.();
  }
});
