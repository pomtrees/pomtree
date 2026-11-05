import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AUDIT_MAX_SPOOLS,
  DiskEgressAudit,
  type EgressAuditEvent,
  type EgressAuditRecord,
  FileEgressAuditWriter,
  markEgressSpoolClosed,
  prepareEgressSpool,
  sealAuditChain,
} from "@pomtree/sandbox-docker";
import { openStore } from "@pomtree/store-sqlite";
import { FakeEgressAuditReader } from "@pomtree/testing";
import { EGRESS_AUDIT_KIND, EGRESS_QUARANTINE_KIND, EGRESS_VACUUM_KIND, EGRESS_VACUUM_OUTCOME_KIND, EgressAuditCollector } from "./egress-audit.ts";
import { ChainedEgressAuditReader } from "./egress-audit.fixtures.ts";

const DAY = 86_400_000;
const admission: EgressAuditEvent = {
  connection: "c",
  phase: "admission",
  transport: "http",
  authority: "example.test:80",
  outcome: "allowed",
  method: "GET",
  url: "http://example.test/[redacted]",
};
const done: EgressAuditEvent = { ...admission, phase: "outcome", outcome: "complete", status: 200 };

async function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pomtreed-vacuum-")));
  const store = openStore(join(dir, "db.sqlite"));
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
  const auditRoot = join(dir, "audit");
  const identity = { sandbox: "box", agent: "worker", host: "h", generation: 1 };
  const { logDir } = prepareEgressSpool(auditRoot, "box", { identity, allow: [], relay: [] });
  const writer = new FileEgressAuditWriter(logDir, identity);
  const events = join(logDir, "events.jsonl");
  const collector = (opts: { vacuumGraceMs?: number; now?: () => number; reader?: DiskEgressAudit } = {}) =>
    new EgressAuditCollector({ reader: opts.reader ?? new DiskEgressAudit({ root: auditRoot }), journal: store.journal, root: async () => root, ...opts });
  const journal = async () =>
    (await store.journal.read({ agent: root.id, from: 0, limit: 500 })).map((e) => e.payload as { kind: string; source: Record<string, unknown> });
  return {
    store,
    root,
    auditRoot,
    identity,
    logDir,
    writer,
    events,
    collector,
    journal,
    rows: () =>
      readFileSync(events, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as EgressAuditRecord),
    clean: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("round trip: the writer's chain is accepted by the reader and by pomtreed, journaled on every row, and anchors a restarted collector", async () => {
  const t = await setup();
  try {
    t.writer.append(admission);
    t.writer.append(done);
    const first = t.collector();
    assert.equal(await first.ingest(), 2);
    const journaled = (await t.journal()).filter((p) => p.kind === EGRESS_AUDIT_KIND).map((p) => (p.source as unknown as EgressAuditRecord).chain);
    assert.deepEqual(
      journaled,
      t.rows().map((r) => r.chain),
      "the journal holds the chain value of every ingested row",
    );
    t.writer.append(admission);
    const restarted = t.collector(); // heads are rebuilt from the journal
    assert.equal(await restarted.ingest(), 1);
    assert.equal(restarted.healthy(), true);
  } finally {
    t.clean();
  }
});

test("tamper after ingestion: a re-chained rewrite of acknowledged history quarantines the spool at the next read and ingests nothing from it", async () => {
  const t = await setup();
  try {
    t.writer.append(admission);
    t.writer.append(done);
    assert.equal(await t.collector().ingest(), 2);
    // A compromised proxy rewrites row 1, recomputes the whole chain, and forges the ack receipt to match.
    const bare = t.rows().map(({ chain: _c, ...r }) => r);
    bare[0] = { ...bare[0]!, authority: "evil.test:80" };
    const forged = sealAuditChain("box", bare);
    writeFileSync(t.events, `${forged.map((r) => JSON.stringify(r)).join("\n")}\n`);
    writeFileSync(join(t.logDir, "ack.json"), JSON.stringify({ throughSequence: 2, offset: readFileSync(t.events).length, chain: forged[1]!.chain }));
    const forgedHead = forged[1]!.chain;
    const heads = (await t.journal()).filter((p) => p.kind === EGRESS_AUDIT_KIND).map((p) => (p.source as unknown as EgressAuditRecord).chain);
    assert.notEqual(forgedHead, heads[1]);
    // The writer (a restarted proxy) would happily extend the forged chain; pomtreed must refuse it.
    new FileEgressAuditWriter(t.logDir, t.identity).append(admission);
    const restarted = t.collector();
    assert.equal(await restarted.ingest(), 0);
    assert.equal(restarted.healthy(), true);
    const kinds = (await t.journal()).map((p) => p.kind);
    assert.equal(kinds.filter((k) => k === EGRESS_AUDIT_KIND).length, 2, "the forged continuation is not journaled");
    assert.equal(kinds.filter((k) => k === EGRESS_QUARANTINE_KIND).length, 1);
  } finally {
    t.clean();
  }
});

test("pomtreed recomputes the chain itself: a reader that returns a row with a wrong chain is quarantined, not trusted", async () => {
  const t = await setup();
  try {
    const reader = new FakeEgressAuditReader<EgressAuditRecord>();
    const rows = sealAuditChain("box", [
      { kind: "egress", ...t.identity, eventId: "box:1", sequence: 1, at: 1, ...admission },
      { kind: "egress", ...t.identity, eventId: "box:2", sequence: 2, at: 2, ...done },
    ]);
    reader.setRecords("box", [rows[0]!, { ...rows[1]!, authority: "evil.test:80" }]); // row 2 no longer matches its chain value
    const collector = new EgressAuditCollector({ reader, journal: t.store.journal, root: async () => t.root });
    assert.equal(await collector.ingest(), 1, "the intact row before it is ingested");
    const kinds = (await t.journal()).map((p) => p.kind);
    assert.deepEqual(kinds, [EGRESS_AUDIT_KIND, EGRESS_QUARANTINE_KIND]);
    assert.equal(reader.ackedThrough("box"), 0);
  } finally {
    t.clean();
  }
});

test("the collector passes its journaled head to the reader on every read and ack past row 0", async () => {
  const t = await setup();
  try {
    const reader = new ChainedEgressAuditReader();
    const row = (n: number) => ({ kind: "egress" as const, ...t.identity, eventId: `box:${n}`, sequence: n, at: n, ...admission });
    reader.setRecords("box", [row(1), row(2)]);
    const collector = new EgressAuditCollector({ reader, journal: t.store.journal, root: async () => t.root });
    await collector.ingest();
    reader.append("box", row(3));
    await collector.ingest();
    const sealed = await reader.read("box", 0);
    const reads = reader.calls.filter((c) => c.op === "read" && c.sandbox === "box" && c.afterSequence === 2);
    assert.equal(reads[0]?.afterChain, sealed[1]!.chain);
    assert.equal(reader.calls.filter((c) => c.op === "ack").at(-1)?.chain, sealed[2]!.chain);
  } finally {
    t.clean();
  }
});

// --- vacuum -----------------------------------------------------------------------------------------------------------------

test("vacuum: journals the deletion with the chain head first, then removes a closed, acknowledged spool after its grace window", async () => {
  const t = await setup();
  try {
    t.writer.append(admission);
    t.writer.append(done);
    let now = 1_000;
    const collector = t.collector({ vacuumGraceMs: DAY, now: () => now });
    assert.equal(await collector.ingest(), 2);
    assert.ok(existsSync(t.events), "an open spool (no closed marker) is never vacuumed");
    markEgressSpoolClosed(t.auditRoot, "box", 1_000);
    now = 1_000 + DAY - 1;
    await collector.ingest();
    assert.ok(existsSync(t.events), "grace not elapsed");
    now = 1_000 + DAY;
    await collector.ingest();
    assert.equal(existsSync(t.events), false);
    assert.deepEqual(readdirSync(t.auditRoot), ["box.vacuumed"]);
    const vacuum = (await t.journal()).filter((p) => p.kind === EGRESS_VACUUM_KIND);
    assert.equal(vacuum.length, 1);
    const last = (await t.journal()).filter((p) => p.kind === EGRESS_AUDIT_KIND).at(-1)!.source as unknown as EgressAuditRecord;
    assert.deepEqual(vacuum[0]!.source, { sandbox: "box", throughSequence: 2, chain: last.chain, bytes: vacuum[0]!.source.bytes, closedAt: 1_000 });
    const outcome = (await t.journal()).filter((p) => p.kind === EGRESS_VACUUM_OUTCOME_KIND);
    assert.deepEqual(
      outcome.map((p) => p.source),
      [{ sandbox: "box", throughSequence: 2, closedAt: 1_000, removed: true }],
      "the outcome row confirms the deletion",
    );
    assert.equal(await collector.ingest(), 0, "later ticks are quiet");
    assert.equal((await t.journal()).filter((p) => p.kind === EGRESS_VACUUM_KIND).length, 1);
    assert.equal(collector.healthy(), true);
  } finally {
    t.clean();
  }
});

test("vacuum is off unless a grace window is configured, and never removes a quarantined or un-acked spool", async () => {
  const t = await setup();
  try {
    t.writer.append(admission);
    markEgressSpoolClosed(t.auditRoot, "box", 0);
    const off = t.collector({ now: () => 10 * DAY });
    await off.ingest();
    assert.ok(existsSync(t.events), "no vacuumGraceMs: spools are retained as before");
    // an ack that never lands: the row stays un-acked, so nothing may be removed
    const reader = new DiskEgressAudit({ root: t.auditRoot });
    const ack = reader.ack.bind(reader);
    reader.ack = async (sandbox, through, chain) => {
      if (through > 1) return;
      await ack(sandbox, through, chain);
    };
    t.writer.append(done);
    const noAck = t.collector({ vacuumGraceMs: 0, now: () => 10 * DAY, reader });
    await noAck.ingest();
    await noAck.ingest();
    assert.ok(existsSync(t.events));
    assert.equal(readdirSync(t.auditRoot).includes("box.vacuumed"), false);
  } finally {
    t.clean();
  }
});

test("vacuum verification: a spool truncated behind the journaled head is quarantined and retained, never deleted", async () => {
  const t = await setup();
  try {
    t.writer.append(admission);
    t.writer.append(done);
    let now = 0;
    const collector = t.collector({ vacuumGraceMs: 1, now: () => now });
    await collector.ingest();
    // the proxy drops its last row and forges a consistent ack, then the sandbox is closed
    const lines = readFileSync(t.events, "utf8").split("\n").filter(Boolean);
    truncateSync(t.events, lines[0]!.length + 1);
    writeFileSync(join(t.logDir, "ack.json"), JSON.stringify({ throughSequence: 1, offset: lines[0]!.length + 1, chain: t.rows()[0]!.chain }));
    markEgressSpoolClosed(t.auditRoot, "box", 0);
    now = 10;
    await t.collector({ vacuumGraceMs: 1, now: () => now }).ingest();
    assert.ok(existsSync(t.events), "the evidence of tampering is kept");
    const kinds = (await t.journal()).map((p) => p.kind);
    assert.equal(kinds.filter((k) => k === EGRESS_VACUUM_KIND).length, 0);
    assert.equal(kinds.filter((k) => k === EGRESS_QUARANTINE_KIND).length, 1);
  } finally {
    t.clean();
  }
});

test("crash windows: pomtreed dying after the vacuum row but before the deletion resumes next tick with one journal row; a failed deletion never affects health", async () => {
  const t = await setup();
  try {
    t.writer.append(admission);
    t.writer.append(done);
    markEgressSpoolClosed(t.auditRoot, "box", 0);
    const reader = new DiskEgressAudit({ root: t.auditRoot });
    const vacuum = reader.vacuum.bind(reader);
    let crash = true;
    reader.vacuum = (candidate) => {
      if (crash) throw new Error("killed at /secret/path");
      return vacuum(candidate);
    };
    const collector = t.collector({ vacuumGraceMs: 0, now: () => DAY, reader });
    await collector.ingest(); // ingests, journals the vacuum row, deletion "crashes"
    assert.equal(collector.healthy(), true);
    assert.ok(existsSync(t.events), "nothing deleted yet");
    crash = false;
    await t.collector({ vacuumGraceMs: 0, now: () => DAY, reader }).ingest(); // a restarted daemon
    assert.equal(existsSync(t.events), false);
    assert.equal((await t.journal()).filter((p) => p.kind === EGRESS_VACUUM_KIND).length, 1, "the retry is deduplicated by its key");
  } finally {
    t.clean();
  }
});

test("a spool with rows beyond the journal cursor is not vacuumed until they are ingested", async () => {
  const t = await setup();
  try {
    const reader = new ChainedEgressAuditReader();
    const row = (n: number) => ({ kind: "egress" as const, ...t.identity, eventId: `box:${n}`, sequence: n, at: n, ...admission });
    reader.setRecords("box", [row(1), row(2)]);
    reader.close("box", 0);
    const collector = new EgressAuditCollector({ reader, journal: t.store.journal, root: async () => t.root, vacuumGraceMs: 0, now: () => DAY });
    await collector.ingest();
    assert.deepEqual(reader.vacuumed, ["box"], "ingested and acked in the same tick, then vacuumed");
    // rows the collector has not ingested (journal cursor behind the spool): the candidate is ahead of the cursor
    const behind = new ChainedEgressAuditReader();
    behind.setRecords("box2", [{ ...row(1), sandbox: "box2", eventId: "box2:1" }]);
    behind.close("box2", 0);
    const failingRead = new EgressAuditCollector({ reader: behind, journal: t.store.journal, root: async () => t.root, vacuumGraceMs: 0, now: () => DAY });
    behind.failures.read.push(new Error("transient"));
    await assert.rejects(failingRead.ingest());
    assert.deepEqual(behind.vacuumed, []);
  } finally {
    t.clean();
  }
});

test("a vacuum that finds the spool changed (reopened by a restart) journals a kept outcome, not a deletion; a later real vacuum still journals its own removed outcome", async () => {
  const t = await setup();
  try {
    t.writer.append(admission);
    markEgressSpoolClosed(t.auditRoot, "box", 5);
    const reader = new DiskEgressAudit({ root: t.auditRoot });
    const real = reader.vacuum.bind(reader);
    let reopen = true;
    reader.vacuum = (candidate) => {
      if (reopen) prepareEgressSpool(t.auditRoot, "box", { identity: t.identity, allow: [], relay: [] }); // a restart removes closed.json between candidate and removal
      return real(candidate);
    };
    const collector = t.collector({ vacuumGraceMs: 0, now: () => DAY, reader });
    await collector.ingest();
    assert.ok(existsSync(t.events), "the spool was kept");
    let rows = await t.journal();
    assert.equal(rows.filter((p) => p.kind === EGRESS_VACUUM_KIND).length, 1, "the intent stands");
    assert.deepEqual(
      rows.filter((p) => p.kind === EGRESS_VACUUM_OUTCOME_KIND).map((p) => p.source.removed),
      [false],
      "and the journal says the spool was kept",
    );
    // The same closed marker comes back (same closedAt) and the vacuum now succeeds: the intent key is deduplicated, the outcome is new.
    markEgressSpoolClosed(t.auditRoot, "box", 5);
    reopen = false;
    await collector.ingest();
    assert.equal(existsSync(t.events), false);
    rows = await t.journal();
    assert.equal(rows.filter((p) => p.kind === EGRESS_VACUUM_KIND).length, 1);
    assert.deepEqual(
      rows.filter((p) => p.kind === EGRESS_VACUUM_OUTCOME_KIND).map((p) => p.source.removed),
      [false, true],
    );
  } finally {
    t.clean();
  }
});

test("a malformed closed.json quarantines the spool (retained, one marker, health unaffected) instead of logging 'deferred' forever", async () => {
  const t = await setup();
  try {
    t.writer.append(admission);
    writeFileSync(join(t.auditRoot, "box", "closed.json"), "{oops", { mode: 0o600 });
    const collector = t.collector({ vacuumGraceMs: 0, now: () => DAY });
    assert.equal(await collector.ingest(), 1);
    await collector.ingest();
    assert.ok(existsSync(t.events));
    const rows = await t.journal();
    assert.equal(rows.filter((p) => p.kind === EGRESS_QUARANTINE_KIND).length, 1);
    assert.equal(rows.filter((p) => p.kind === EGRESS_VACUUM_KIND).length, 0);
    assert.equal(collector.healthy(), true);
  } finally {
    t.clean();
  }
});

test("a .vacuuming leftover is reaped on a tick that discovers no spool, but only when vacuum is enabled", async () => {
  const t = await setup();
  try {
    rmSync(join(t.auditRoot, "box"), { recursive: true });
    mkdirSync(join(t.auditRoot, "x.vacuuming", "log"), { recursive: true, mode: 0o700 });
    await t.collector().ingest();
    assert.ok(existsSync(join(t.auditRoot, "x.vacuuming")), "vacuum disabled: left alone");
    await t.collector({ vacuumGraceMs: 0 }).ingest();
    assert.equal(existsSync(join(t.auditRoot, "x.vacuuming")), false);
  } finally {
    t.clean();
  }
});

test("status() names the quarantined spools and the retention counts so an operator can free cap slots", async () => {
  const t = await setup();
  try {
    t.writer.append(admission);
    writeFileSync(join(t.auditRoot, "box", "closed.json"), "{oops", { mode: 0o600 });
    const collector = t.collector({ vacuumGraceMs: 0, now: () => DAY });
    assert.deepEqual(collector.status().quarantined, []);
    await collector.ingest();
    const status = collector.status();
    assert.deepEqual(status.quarantined, ["box"]);
    assert.deepEqual(status.retention, { spools: 1, max: AUDIT_MAX_SPOOLS, closed: 1, open: [] });
  } finally {
    t.clean();
  }
});
