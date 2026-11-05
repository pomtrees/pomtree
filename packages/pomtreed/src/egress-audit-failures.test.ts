import assert from "node:assert/strict";
import { tmpDir } from "@pomtree/testing";
import { join } from "node:path";
import test from "node:test";
import { type EgressAuditRecord, sealAuditChain } from "@pomtree/sandbox-docker";
import { openStore } from "@pomtree/store-sqlite";
import { EgressAuditCollector, EGRESS_AUDIT_KIND, ingestEgressAuditSafely } from "./egress-audit.ts";
import { ChainedEgressAuditReader } from "./egress-audit.fixtures.ts";

const record: EgressAuditRecord = {
  kind: "egress",
  sandbox: "box",
  agent: "capture",
  host: "h",
  generation: 4,
  eventId: "box:1",
  sequence: 1,
  at: 100,
  connection: "c",
  phase: "admission",
  transport: "connect",
  authority: "example.test:443",
  outcome: "allowed",
  chain: "0".repeat(64),
};

test("append/read failure never acknowledges evidence; retry uses immutable source key and durable cursor", async () => {
  const dir = tmpDir("egress-failure-");
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
    const reader = new ChainedEgressAuditReader();
    reader.setRecords("box", [record]);
    const append = store.journal.append.bind(store.journal);
    let reject = true;
    store.journal.append = async (entry) => {
      if (reject) throw new Error("store full");
      return append(entry);
    };
    const collector = new EgressAuditCollector({ reader, journal: store.journal, root: async () => root });
    await assert.rejects(collector.ingest(), /egress audit ingestion failed/);
    assert.equal(
      reader.calls.some((call) => call.op === "ack"),
      false,
    );
    assert.equal(collector.healthy(), false);
    reject = false;
    reader.failures.read.push(new Error("spool unavailable"));
    await assert.rejects(collector.ingest(), /egress audit ingestion failed/);
    assert.equal(
      reader.calls.some((call) => call.op === "ack"),
      false,
    );
    assert.equal(await collector.ingest(), 1);
    assert.equal(reader.ackedThrough("box"), 1);
    assert.equal(collector.healthy(), true);
    assert.equal(await new EgressAuditCollector({ reader, journal: store.journal, root: async () => root }).ingest(), 0);
    assert.equal((await store.journal.read({ agent: root.id })).length, 1);
  } finally {
    store.close();
  }
});

for (const failure of ["read", "append", "ack"] as const)
  test(`a bad ${failure} spool does not block a later healthy spool; failed pass stays unhealthy and retry deduplicates`, async () => {
    const dir = tmpDir("egress-isolation-");
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
      const reader = new ChainedEgressAuditReader();
      const source = (sandbox: string, sequence: number): EgressAuditRecord => ({ ...record, sandbox, sequence, eventId: `${sandbox}:${sequence}` });
      const read = reader.read.bind(reader);
      const ack = reader.ack.bind(reader);
      const append = store.journal.append.bind(store.journal);
      let broken = false;
      let collector!: EgressAuditCollector;
      reader.read = async (sandbox, after, limit) => {
        if (broken && failure === "read" && sandbox === "a_bad") throw new Error("torn record /private/secret-spool token=secret");
        return read(sandbox, after, limit);
      };
      reader.ack = async (sandbox, through) => {
        if (broken && failure === "ack" && sandbox === "a_bad") throw new Error("ack /private/secret-spool token=secret");
        return ack(sandbox, through);
      };
      store.journal.append = async (entry) => {
        if (entry.payload.kind === EGRESS_AUDIT_KIND) {
          const row = entry.payload.source as EgressAuditRecord;
          if (broken && failure === "append" && row.sandbox === "a_bad" && row.sequence === 2) throw new Error("append /private/secret-spool token=secret");
          if (broken && row.sandbox === "z_healthy")
            assert.equal(collector.healthy(), false, "an observed failure closes admission before healthy processing finishes");
        }
        return append(entry);
      };
      collector = new EgressAuditCollector({ reader, journal: store.journal, root: async () => root });
      assert.equal(await collector.ingest(), 0);
      assert.equal(collector.healthy(), true);
      reader.setRecords("a_bad", failure === "append" ? [source("a_bad", 1), source("a_bad", 2)] : [source("a_bad", 1)]);
      reader.setRecords("z_healthy", [source("z_healthy", 1)]);
      broken = true;
      const beforeBadAck = reader.ackedThrough("a_bad");
      await assert.rejects(collector.ingest(), (error: unknown) => {
        assert.equal(reader.ackedThrough("z_healthy"), 1, "a failed early spool must not block later healthy evidence");
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 1);
        assert.match(String(error.errors[0]), new RegExp(`a_bad.*${failure}`));
        assert.doesNotMatch(`${error.message} ${error.errors.map(String).join(" ")}`, /private|secret|token/);
        return true;
      });
      assert.equal(collector.healthy(), false);
      assert.equal(reader.ackedThrough("a_bad"), beforeBadAck, "bad spool is not acknowledged beyond its prior durable prefix");
      assert.equal(reader.ackedThrough("z_healthy"), 1, "later healthy evidence is still appended and acknowledged");
      broken = false;
      await collector.ingest();
      assert.equal(collector.healthy(), true);
      const rows = await store.journal.read({ agent: root.id });
      const ids = rows.map((entry) => {
        if (entry.payload.kind !== EGRESS_AUDIT_KIND) throw new Error("unexpected journal payload");
        return (entry.payload.source as EgressAuditRecord).eventId;
      });
      assert.equal(new Set(ids).size, ids.length, "retry cannot duplicate durable source events");
      assert.ok(ids.includes("z_healthy:1"));
      assert.equal(ids.length, failure === "append" ? 3 : 2);
      assert.equal(reader.ackedThrough("a_bad"), failure === "append" ? 2 : 1);
      assert.equal(
        await new EgressAuditCollector({ reader, journal: store.journal, root: async () => root }).ingest(),
        0,
        "restart reconstructs appended cursors without duplicates",
      );
    } finally {
      store.close();
    }
  });

test("multiple failed candidates aggregate bounded safe diagnostics after processing the healthy spool", async () => {
  const dir = tmpDir("egress-aggregate-");
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
    const reader = new ChainedEgressAuditReader();
    for (let i = 0; i < 20; i++) {
      const sandbox = `a_bad_${i}`;
      reader.setRecords(sandbox, [{ ...record, sandbox, eventId: `${sandbox}:1` }]);
      reader.failures.read.push(new Error("torn /private/secret token=secret"));
    }
    reader.setRecords("z_healthy", [{ ...record, sandbox: "z_healthy", eventId: "z_healthy:1" }]);
    const discover = reader.discover.bind(reader);
    reader.discover = async () => ["../../private/secret", ...(await discover())];
    const collector = new EgressAuditCollector({ reader, journal: store.journal, root: async () => root });
    await assert.rejects(collector.ingest(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /21 spool/);
      assert.equal(error.errors.length, 16, "diagnostic detail is bounded even when every candidate fails");
      assert.match(String(error.errors[0]), /candidate-1.*identity/);
      assert.doesNotMatch(`${error.message} ${error.errors.map(String).join(" ")}`, /private|secret|token/);
      return true;
    });
    assert.equal(collector.healthy(), false);
    assert.equal(reader.ackedThrough("z_healthy"), 1);
    assert.equal(reader.calls.filter((call) => call.op === "ack" && call.sandbox !== "z_healthy").length, 0);
    assert.equal((await store.journal.read({ agent: root.id })).length, 1);
    assert.deepEqual(
      await reader.read("a_bad_0", 0),
      sealAuditChain("a_bad_0", [{ ...record, sandbox: "a_bad_0", eventId: "a_bad_0:1" }]),
      "failed evidence is retained unchanged for operator repair",
    );
  } finally {
    store.close();
  }
});

test("collector quarantines a spool with source gaps or unsafe metadata, without ack or drop", async () => {
  for (const bad of [
    { ...record, sequence: 2, eventId: "box:2" },
    { ...record, authority: "secret@example.test:443" },
    { ...record, url: "https://example.test/private?token=secret" },
  ]) {
    const dir = tmpDir("egress-invalid-");
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
      const reader = new ChainedEgressAuditReader();
      reader.setRecords("box", [bad]);
      const collector = new EgressAuditCollector({ reader, journal: store.journal, root: async () => root });
      assert.equal(await collector.ingest(), 0);
      assert.equal(collector.healthy(), true);
      assert.equal(
        reader.calls.some((call) => call.op === "ack"),
        false,
      );
      const journal = await store.journal.read({ agent: root.id });
      assert.deepEqual(
        journal.map((e) => e.payload.kind),
        ["ext.egress.quarantine"],
      );
      assert.doesNotMatch(JSON.stringify(journal), /secret/);
    } finally {
      store.close();
    }
  }
});

test("ingestEgressAuditSafely swallows a failed ingest, logs only a fixed line, and leaves the collector unhealthy", async () => {
  const lines: string[] = [];
  const failing = new EgressAuditCollector({
    reader: {
      discover: async () => {
        throw new Error("secret /state/path token=abc");
      },
      read: async () => [],
      ack: async () => {},
      vacuumCandidate: async () => undefined,
      vacuum: () => false,
      reapVacuumed: () => 0,
    },
    journal: { read: async () => [], append: async () => assert.fail("no append expected") } as never,
    root: async () => ({ id: "root", host: "h", generation: 1 }) as never,
  });
  await ingestEgressAuditSafely(failing, (l) => lines.push(l));
  assert.equal(failing.healthy(), false);
  assert.deepEqual(lines, ["pomtreed: egress audit ingestion failed; new public worker admission is closed"]);
  const ok: string[] = [];
  await ingestEgressAuditSafely({ ingest: async () => 3 }, (l) => ok.push(l));
  assert.deepEqual(ok, []);
});
