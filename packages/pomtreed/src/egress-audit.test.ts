import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpDir } from "@pomtree/testing";
import { join } from "node:path";
import test from "node:test";
import { openStore } from "@pomtree/store-sqlite";
import {
  DENY_REASONS,
  DiskEgressAudit,
  EGRESS_AUDIT_FIELDS,
  ERROR_CLASSES,
  type EgressAuditEvent,
  FileEgressAuditWriter,
  LIMIT_KINDS,
  prepareEgressSpool,
  sealAuditChain,
} from "@pomtree/sandbox-docker";
import { EgressAuditCollector, EGRESS_AUDIT_KIND } from "./egress-audit.ts";

const spec = { driver: "workflow/capture", input: null };

test("retained spool ingests after worker generation change/reap without relabelling; append-before-ack restart deduplicates", async () => {
  const dir = realpathSync(tmpDir("pomtreed-egress-"));
  const store = openStore(join(dir, "db.sqlite"));
  try {
    const root = await store.registry.create({
      id: "root",
      parent: null,
      name: "root",
      task: "root",
      host: "h",
      budgetMicros: 1000,
      executor: "deterministic",
      spec,
      idempotencyKey: "root",
    });
    const worker = await store.registry.create({
      id: "worker",
      parent: root.id,
      name: "worker",
      task: "capture",
      host: "h",
      budgetMicros: 0,
      executor: "deterministic",
      spec,
      idempotencyKey: "worker",
    });
    const identity = { agent: worker.id, host: worker.host, generation: worker.generation, sandbox: "box_1" };
    const { logDir } = prepareEgressSpool(join(dir, "audit"), identity.sandbox, { identity, allow: [], relay: [] });
    const writer = new FileEgressAuditWriter(logDir, identity);
    writer.append({
      connection: "c1",
      phase: "admission",
      transport: "http",
      authority: "example.test:80",
      url: "http://example.test/[redacted]",
      method: "GET",
      outcome: "allowed",
    });
    await store.registry.transition(worker.id, 0, "running", { idempotencyKey: "run" });
    const bumped = await store.registry.bumpGeneration(worker.id, "h", "bump");
    await store.registry.transition(worker.id, bumped.generation, "exited", { exit: "succeeded", idempotencyKey: "exit" });
    await store.registry.transition(worker.id, bumped.generation, "reaped", { idempotencyKey: "reap" });
    const reader = new DiskEgressAudit({ root: join(dir, "audit") });
    const ack = reader.ack.bind(reader);
    let first = true;
    reader.ack = async (...args) => {
      if (first) {
        first = false;
        throw new Error("crash before ack");
      }
      await ack(...args);
    };
    const collector = new EgressAuditCollector({ reader, journal: store.journal, root: async () => root });
    await assert.rejects(collector.ingest(), /egress audit ingestion failed/);
    assert.equal(collector.healthy(), false);
    const restarted = new EgressAuditCollector({ reader: new DiskEgressAudit({ root: join(dir, "audit") }), journal: store.journal, root: async () => root });
    assert.equal(await restarted.ingest(), 0);
    writer.append({
      connection: "c1",
      phase: "outcome",
      transport: "http",
      authority: "example.test:80",
      outcome: "complete",
      status: 200,
      bytesIn: 100,
      bytesOut: 50,
    });
    assert.equal(await restarted.ingest(), 1);
    assert.equal(await restarted.ingest(), 0);
    const entries = (await store.journal.read({ agent: root.id })).filter((e) => e.payload.kind === EGRESS_AUDIT_KIND);
    assert.equal(entries.length, 2);
    for (const [index, entry] of entries.entries()) {
      assert.equal(entry.agent, root.id, "envelope identifies ingestion, not the worker");
      assert.equal(entry.payload.kind, EGRESS_AUDIT_KIND);
      if (entry.payload.kind !== EGRESS_AUDIT_KIND) throw new Error("unexpected payload");
      const source = entry.payload.source as typeof identity & { eventId: string };
      assert.equal(source.agent, worker.id);
      assert.equal(source.generation, 0, "captured source generation is authoritative even after reap");
      assert.equal(source.eventId, `box_1:${index + 1}`);
    }
    await assert.rejects(
      store.journal.append({ agent: worker.id, host: "h", generation: 0, payload: { kind: "ext.egress.audit", source: identity }, idempotencyKey: "stale" }),
      /stale/i,
      "no historical-append escape hatch",
    );
    assert.equal(restarted.healthy(), true);
  } finally {
    store.close();
  }
});

test("immutable spool identity mismatch is not appended or acknowledged", async () => {
  const dir = realpathSync(tmpDir("pomtreed-egress-invalid-"));
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
      spec,
      idempotencyKey: "root",
    });
    const identity = { agent: "worker", host: "h", generation: 3, sandbox: "box" };
    const { logDir } = prepareEgressSpool(join(dir, "audit"), "box", { identity, allow: [], relay: [] });
    // A writer with different provenance cannot turn its record into authority: reader compares the read-only config.
    const writer = new FileEgressAuditWriter(logDir, { ...identity, generation: 4 });
    writer.append({ connection: "c", phase: "admission", transport: "connect", authority: "example.test:443", outcome: "allowed" });
    const collector = new EgressAuditCollector({ reader: new DiskEgressAudit({ root: join(dir, "audit") }), journal: store.journal, root: async () => root });
    assert.equal(await collector.ingest(), 0);
    assert.equal(collector.healthy(), true, "a tampered spool is quarantined, not a global failure");
    assert.deepEqual(
      (await store.journal.read({ agent: root.id })).map((e) => e.payload.kind),
      ["ext.egress.quarantine"],
    );
  } finally {
    store.close();
  }
});

// Ingest `events` through a real writer/spool/collector; `tamper` may rewrite the raw spool line afterwards (unknown field).
async function ingestEvents(events: EgressAuditEvent[], tamper?: (line: Record<string, unknown>) => Record<string, unknown>) {
  const dir = realpathSync(tmpDir("pomtreed-egress-fields-"));
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
      spec,
      idempotencyKey: "root",
    });
    const identity = { agent: "worker", host: "h", generation: 0, sandbox: "box" };
    const { logDir } = prepareEgressSpool(join(dir, "audit"), "box", { identity, allow: [], relay: [] });
    const writer = new FileEgressAuditWriter(logDir, identity);
    for (const event of events) writer.append(event);
    if (tamper) {
      const path = join(logDir, "events.jsonl");
      const lines = readFileSync(path, "utf8").trim().split("\n");
      writeFileSync(path, `${lines.map((l) => JSON.stringify(tamper(JSON.parse(l)))).join("\n")}\n`);
    }
    const collector = new EgressAuditCollector({ reader: new DiskEgressAudit({ root: join(dir, "audit") }), journal: store.journal, root: async () => root });
    const result = await collector.ingest().then(
      (count) => ({ count, error: undefined as unknown }),
      (error: unknown) => ({ count: 0, error }),
    );
    const rows = (await store.journal.read({ agent: root.id }))
      .filter((e) => e.payload.kind === EGRESS_AUDIT_KIND)
      .map((e) => (e.payload as unknown as { source: Record<string, unknown> }).source);
    return { ...result, rows, healthy: collector.healthy() };
  } finally {
    store.close();
  }
}

const base = { connection: "c", phase: "outcome", transport: "connect", authority: "example.test:443" } as const;
const admittedAt = "2026-10-20T12:00:00.000Z";
// One row per enum value, each carrying peers + admittedAt, so every optional field the writer can emit is exercised.
const richEvents: EgressAuditEvent[] = [
  ...DENY_REASONS.map((denyReason) => ({
    ...base,
    outcome: "denied" as const,
    denyReason,
    admittedAt,
    peers: ["93.184.216.34", "2606:2800:220:1::1"],
    peer: "93.184.216.34",
  })),
  // A coalesced summary: the last folded denial plus the repeat count and the window bounds.
  { ...base, outcome: "denied" as const, denyReason: DENY_REASONS[0]!, repeats: 3, firstAt: 1, lastAt: 2 },
  ...LIMIT_KINDS.map((limitKind) => ({ ...base, outcome: "limit" as const, limitKind, trafficClass: "public" as const, admittedAt, peers: ["93.184.216.34"] })),
  ...ERROR_CLASSES.map((errorClass) => ({ ...base, outcome: "error" as const, errorClass, admittedAt, durationMs: 5 })),
];

test("rows carrying peers/denyReason/limitKind/trafficClass/errorClass/admittedAt from the sandbox writer ingest", async () => {
  const r = await ingestEvents(richEvents);
  assert.equal(r.error, undefined);
  assert.equal(r.count, richEvents.length);
  assert.equal(r.healthy, true);
});

test("legacy rows without the optional fields still ingest", async () => {
  const r = await ingestEvents([{ ...base, phase: "admission", outcome: "allowed" }]);
  assert.equal(r.error, undefined);
  assert.equal(r.count, 1);
});

test("an unknown extra field is rejected by pomtreed's own validator (closed set preserved)", async () => {
  const dir = realpathSync(tmpDir("pomtreed-egress-unknown-"));
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
      spec,
      idempotencyKey: "root",
    });
    const row = { kind: "egress", eventId: "box:1", sequence: 1, at: 1, sandbox: "box", agent: "a", host: "h", generation: 0, ...base, outcome: "complete" };
    const stub = (extra: Record<string, unknown>) => ({
      discover: async () => ["box"],
      read: async () => sealAuditChain("box", [{ ...row, ...extra } as never]),
      ack: async () => {},
      vacuumCandidate: async () => undefined,
      vacuum: () => false,
      reapVacuumed: () => 0,
    });
    const ok = new EgressAuditCollector({ reader: stub({ admittedAt }), journal: store.journal, root: async () => root });
    assert.equal(await ok.ingest(), 1);
    const bad = new EgressAuditCollector({ reader: stub({ surprise: 1 }), journal: store.journal, root: async () => root });
    assert.equal(await bad.ingest(), 0);
    assert.equal(bad.healthy(), true);
    assert.deepEqual(
      (await store.journal.read({ agent: root.id })).map((e) => e.payload.kind).filter((k) => k === "ext.egress.quarantine"),
      ["ext.egress.quarantine"],
    );
  } finally {
    store.close();
  }
});

test("pomtreed accepts every field name the sandbox writer can emit", async () => {
  const emitted = new Set(richEvents.flatMap((e) => Object.keys(e)));
  for (const k of ["method", "url", "status", "bytesIn", "bytesOut"]) emitted.add(k);
  // Every name in the exported constant must appear in a rich row, else this fixture lags the writer.
  const record = {
    ...base,
    kind: "egress",
    eventId: "box:1",
    sequence: 1,
    at: 1,
    sandbox: "box",
    agent: "worker",
    host: "h",
    generation: 0,
    phase: "outcome",
    transport: "http",
    method: "GET",
    url: "http://example.test/[redacted]",
    peer: "93.184.216.34",
    peers: ["93.184.216.34"],
    outcome: "complete",
    status: 200,
    durationMs: 1,
    bytesIn: 1,
    bytesOut: 1,
    admittedAt,
    repeats: 2,
    firstAt: 1,
    lastAt: 1,
    chain: "0".repeat(64),
  } as Record<string, unknown>;
  const all = new Set([...Object.keys(record), "denyReason", "limitKind", "errorClass", "trafficClass"]);
  assert.deepEqual([...all].sort(), [...EGRESS_AUDIT_FIELDS].sort(), "fixture must cover exactly the exported field set");
  for (const field of emitted) assert.ok(EGRESS_AUDIT_FIELDS.includes(field as never), `${field} missing from EGRESS_AUDIT_FIELDS`);
});
