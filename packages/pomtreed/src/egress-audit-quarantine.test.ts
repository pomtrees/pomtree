import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiskEgressAudit, FileEgressAuditWriter, prepareEgressSpool } from "@pomtree/sandbox-docker";
import { openStore } from "@pomtree/store-sqlite";
import { EgressAuditCollector } from "./egress-audit.ts";

async function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "egress-method-")));
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
  const disk = new DiskEgressAudit({ root: auditRoot });
  const collector = new EgressAuditCollector({ reader: disk, journal: store.journal, root: async () => root });
  const spool = (sandbox: string) => {
    const identity = { sandbox, agent: "w", host: "h", generation: 1 };
    const { logDir } = prepareEgressSpool(auditRoot, sandbox, { allow: [], relay: [], identity });
    return { logDir, identity, writer: new FileEgressAuditWriter(logDir, identity) };
  };
  return { dir, store, root, auditRoot, disk, collector, spool, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a corrupted spool is quarantined with a content-free marker; healthy spools keep ingesting and health stays true", async () => {
  const f = await fixture();
  const bad = f.spool("bad");
  const good = f.spool("good");
  const ev = { connection: "c", phase: "admission", transport: "connect", authority: "example.test:443", outcome: "allowed" } as const;
  bad.writer.append(ev);
  good.writer.append(ev);
  writeFileSync(join(bad.logDir, "events.jsonl"), '{"garbage secret-token":1}\n');
  try {
    await f.collector.ingest();
    assert.equal(f.collector.healthy(), true);
    const page = await f.store.journal.read({ agent: f.root.id, from: 0, limit: 100 });
    const kinds = page.map((e) => `${e.payload.kind}`);
    assert.ok(kinds.includes("ext.egress.audit"));
    assert.ok(kinds.includes("ext.egress.quarantine"));
    assert.doesNotMatch(JSON.stringify(page), /secret-token/);
    good.writer.append(ev);
    await f.collector.ingest();
    const again = await f.store.journal.read({ agent: f.root.id, from: 0, limit: 100 });
    assert.equal(again.filter((e) => e.payload.kind === "ext.egress.audit").length, 2);
    assert.equal(again.filter((e) => e.payload.kind === "ext.egress.quarantine").length, 1);
    assert.equal(f.collector.healthy(), true);
  } finally {
    f.store.close?.();
    f.clean();
  }
});
