import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_MAX_BYTES,
  AUDIT_MAX_SPOOLS,
  DiskEgressAudit,
  FileEgressAuditWriter,
  loadProxyConfig,
  prepareEgressSpool,
  sealAuditChain,
  type EgressAuditEvent,
} from "./audit.ts";
import { IMAGE_REBUILD_ACTION } from "@pomtree/core";

const event: EgressAuditEvent = {
  connection: "c",
  phase: "admission",
  transport: "http",
  authority: "example.test:80",
  outcome: "allowed",
  url: "http://example.test/[redacted]",
  peer: "8.8.8.8",
};
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-egress-audit-")));
  const identity = { sandbox: "sb", agent: "worker", host: "host", generation: 2 };
  const config = { allow: [], relay: [], hostAddresses: [], identity };
  const dirs = prepareEgressSpool(root, "sb", config);
  return { root, identity, config, ...dirs, disk: new DiskEgressAudit({ root }), clean: () => rmSync(root, { recursive: true, force: true }) };
}
test("durable spool: bounded reader validates immutable attribution, retries and ack without deleting evidence", async () => {
  const f = fixture();
  try {
    const writer = new FileEgressAuditWriter(f.logDir, f.identity);
    f.identity.generation = 99; // captured at creation, not a current registry lookup
    writer.append(event);
    writer.append({ ...event, phase: "outcome", outcome: "complete" });
    const resumed = new FileEgressAuditWriter(f.logDir, { ...f.identity, generation: 2 });
    resumed.append(event);
    assert.deepEqual(await f.disk.discover(), ["sb"]);
    const rows = await f.disk.read("sb", 0, 2);
    assert.deepEqual(
      rows.map((r) => [r.eventId, r.agent, r.host, r.generation]),
      [
        ["sb:1", "worker", "host", 2],
        ["sb:2", "worker", "host", 2],
      ],
    );
    assert.deepEqual(
      (await f.disk.read("sb", 2)).map((r) => r.sequence),
      [3],
    );
    await f.disk.ack("sb", 2);
    await f.disk.ack("sb", 1);
    assert.deepEqual(JSON.parse(readFileSync(join(f.logDir, "ack.json"), "utf8")), {
      throughSequence: 2,
      offset: readFileSync(join(f.logDir, "events.jsonl"), "utf8").split("\n").slice(0, 2).join("\n").length + 1,
      chain: (JSON.parse(readFileSync(join(f.logDir, "events.jsonl"), "utf8").split("\n")[1]!) as { chain: string }).chain,
    });
    assert.equal((await f.disk.read("sb", 0)).length, 3);
    await assert.rejects(f.disk.ack("sb", 4), /invalid egress ack/);
    await assert.rejects(f.disk.read("../sb", 0), /invalid egress sandbox/);
    await assert.rejects(f.disk.read("sb", 0, 1000), /invalid egress cursor/);
  } finally {
    f.clean();
  }
});
test("manifest cannot drift; tampered attribution, torn lines, unsafe paths and oversized retained spool fail closed", async () => {
  const f = fixture();
  try {
    assert.throws(() => prepareEgressSpool(f.root, "sb", { ...f.config, identity: { ...f.identity, generation: 3 } }), /immutable/);
    const writer = new FileEgressAuditWriter(f.logDir, f.identity);
    writer.append(event);
    const path = join(f.logDir, "events.jsonl");
    const valid = readFileSync(path, "utf8");
    writeFileSync(path, valid.replace('"generation":2', '"generation":3'));
    await assert.rejects(f.disk.read("sb", 0), /identity/);
    writeFileSync(path, valid);
    appendFileSync(path, '{"torn":');
    const torn = readFileSync(path);
    await assert.rejects(f.disk.read("sb", 0), /torn/);
    await assert.rejects(f.disk.ack("sb", 2), /torn/);
    assert.throws(() => new FileEgressAuditWriter(f.logDir, f.identity), /torn/);
    assert.deepEqual(readFileSync(path), torn, "torn evidence is retained byte-for-byte, never acknowledged or repaired");
    writeFileSync(path, Buffer.alloc(AUDIT_MAX_BYTES + 1, "x"));
    await assert.rejects(f.disk.read("sb", 0), /limit/);
    rmSync(path);
    symlinkSync(join(f.configDir, "config.json"), path);
    assert.throws(() => writer.append(event), /unsafe/);
    assert.throws(() => writer.append(event), /unavailable/);
  } finally {
    f.clean();
  }
});
test("discovery isolates stray/unsafe entries and defers malformed manifests to each candidate read", async (t) => {
  const f = fixture();
  const diagnostics: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    diagnostics.push(args.join(" "));
  });
  try {
    const other = prepareEgressSpool(f.root, "bad", { ...f.config, identity: { ...f.identity, sandbox: "bad" } });
    writeFileSync(join(other.configDir, "config.json"), "DO_NOT_LOG_THIS_PAYLOAD");
    writeFileSync(join(f.root, "stray-secret-name"), "DO_NOT_LOG", { mode: 0o600 });
    symlinkSync(f.root, join(f.root, "unsafe"));
    new FileEgressAuditWriter(f.logDir, f.identity).append(event);
    assert.deepEqual(await f.disk.discover(), ["bad", "sb"]);
    await assert.rejects(f.disk.read("bad", 0), /invalid immutable egress config/);
    assert.equal((await f.disk.read("sb", 0)).length, 1, "bad candidate does not prevent reading healthy source");
    assert.equal(diagnostics.length, 2);
    assert.doesNotMatch(diagnostics.join(" "), /DO_NOT_LOG|stray-secret-name|unsafe$|\/private\/|\/Users\//);
  } finally {
    f.clean();
  }
});

test("immutable config publication is no-clobber; malformed manifests and unknown pending files are retained", (t) => {
  const f = fixture();
  const diagnostics: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    diagnostics.push(args.join(" "));
  });
  try {
    const file = join(f.configDir, "config.json");
    const inode = lstatSync(file).ino;
    prepareEgressSpool(f.root, "sb", f.config);
    assert.equal(lstatSync(file).ino, inode, "matching re-adoption does not replace immutable file");
    assert.equal(lstatSync(file).nlink, 1);
    assert.deepEqual(readdirSync(f.configDir), ["config.json"], "successful publication removes only its own pending file");
    writeFileSync(file, "{partial-manifest-secret");
    assert.throws(() => prepareEgressSpool(f.root, "sb", f.config), /invalid immutable egress config/);
    assert.equal(readFileSync(file, "utf8"), "{partial-manifest-secret");
    rmSync(file); // fixture simulates a crash before a final manifest was ever published
    const pending = join(f.configDir, "config.pending-interrupted");
    writeFileSync(pending, "unknown-identity-secret", { mode: 0o600 });
    assert.throws(() => prepareEgressSpool(f.root, "sb", f.config), /incomplete immutable egress config publication/);
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(pending, "utf8"), "unknown-identity-secret");
    assert.ok(diagnostics.some((s) => s.includes("pending publication retained")));
    assert.doesNotMatch(diagnostics.join(" "), /secret|config.pending-interrupted/);
  } finally {
    f.clean();
  }
});

test("retained root capacity is bounded even when records are acknowledged; nothing evicts evidence", () => {
  const f = fixture();
  try {
    for (let i = 1; i < AUDIT_MAX_SPOOLS; i++) {
      const sandbox = `spool-${i}`;
      mkdirSync(join(f.root, sandbox), { mode: 0o700 }); // an empty directory counts against the cap; skips 256 fsynced prepares
    }
    assert.throws(
      () => prepareEgressSpool(f.root, "over-limit", { ...f.config, identity: { ...f.identity, sandbox: "over-limit" } }),
      new RegExp(`retention limit \\(${AUDIT_MAX_SPOOLS} spools\\).*only vacuumed once closed`),
    );
  } finally {
    f.clean();
  }
});

test("the writer refuses any record the reader would reject, so the spool stays readable", async () => {
  const f = fixture();
  try {
    const writer = new FileEgressAuditWriter(f.logDir, f.identity);
    writer.append(event);
    assert.throws(() => writer.append({ ...event, authority: `${"a".repeat(600)}:80` }), /invalid egress metadata/);
    assert.throws(() => writer.append(event), /unavailable/, "a rejected record fails the writer closed");
    const reopened = new FileEgressAuditWriter(f.logDir, f.identity);
    reopened.append({ ...event, phase: "outcome", outcome: "complete" });
    assert.deepEqual(
      (await f.disk.read("sb", 0)).map((r) => r.sequence),
      [1, 2],
    );
    await f.disk.ack("sb", 2);
    for (const bad of [
      { authority: "user@host:80" },
      { url: "http://example.test/secret?q=1" },
      { method: "get" },
      { bytesIn: -1 },
      { outcome: "bogus" as never },
    ]) {
      assert.throws(() => new FileEgressAuditWriter(f.logDir, f.identity).append({ ...event, ...bad }), /invalid egress|unsafe egress/, JSON.stringify(bad));
    }
  } finally {
    f.clean();
  }
});

test("world-accessible directories and symlinked roots are rejected", () => {
  const f = fixture();
  try {
    chmodSync(f.logDir, 0o777);
    assert.throws(() => new FileEgressAuditWriter(f.logDir, f.identity), /private/);
    chmodSync(f.logDir, 0o700);
    symlinkSync(f.root, join(f.root, "alias"));
    assert.throws(() => prepareEgressSpool(join(f.root, "alias"), "new", f.config), /identity mismatch|unsafe/);
  } finally {
    f.clean();
  }
});
test("large spool: reads resume from the ack checkpoint, so per-tick work is bounded by the unacked window and results are unchanged", async () => {
  const f = fixture();
  try {
    const total = 5000;
    const lines = sealAuditChain(
      "sb",
      Array.from({ length: total }, (_, i) => ({ ...event, ...f.identity, kind: "egress" as const, sequence: i + 1, eventId: `sb:${i + 1}`, at: 1000 + i })),
    ).map((r) => JSON.stringify(r));
    const path = join(f.logDir, "events.jsonl");
    writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
    const seen: number[] = [];
    for (let cursor = 0; cursor < total; ) {
      const page = await f.disk.read("sb", cursor, 256);
      assert.ok(page.length > 0 && page.length <= 256);
      seen.push(...page.map((r) => r.sequence));
      cursor = page[page.length - 1]!.sequence;
      await f.disk.ack("sb", cursor);
    }
    assert.deepEqual(
      seen,
      Array.from({ length: total }, (_, i) => i + 1),
    );
    // Prove no prefix rescan: damage a record that is already acknowledged. Reads and acks past the checkpoint still succeed,
    // and a fully acknowledged spool is answered without opening the log (the damaged line is never parsed).
    const damaged = lines.slice();
    damaged[0] = "{not json".padEnd(lines[0]!.length, " ");
    writeFileSync(path, `${damaged.join("\n")}\n`);
    assert.deepEqual(await f.disk.read("sb", total), []);
    const extra = JSON.stringify(
      sealAuditChain(
        "sb",
        [
          ...lines.map((l) => JSON.parse(l)),
          { ...event, ...f.identity, kind: "egress" as const, sequence: total + 1, eventId: `sb:${total + 1}`, at: 9999 },
        ].map(({ chain: _c, ...r }) => r),
      ).pop(),
    );
    appendFileSync(path, `${extra}\n`);
    assert.deepEqual(
      (await f.disk.read("sb", total)).map((r) => r.sequence),
      [total + 1],
    );
    await f.disk.ack("sb", total + 1);
    // An explicit re-read from before the ack still validates from the start.
    await assert.rejects(f.disk.read("sb", 0), /invalid egress audit record JSON/);
  } finally {
    f.clean();
  }
});

test("an unreadable or invalid immutable config names the reason and the rebuild action, without host paths; a valid one still loads", () => {
  const f = fixture();
  try {
    const file = join(f.configDir, "config.json");
    writeFileSync(file, "{partial", { mode: 0o600 });
    assert.throws(
      () => loadProxyConfig(file),
      (e: Error) => /^invalid immutable egress config \(.+\)/.test(e.message) && /scripts\/pomtree-up --rebuild/.test(e.message) && !e.message.includes(f.root),
    );
    assert.throws(
      () => loadProxyConfig(join(f.root, "missing.json")),
      (e: Error) => /invalid immutable egress config/.test(e.message) && !e.message.includes(f.root),
    );
    rmSync(file);
    writeFileSync(file, JSON.stringify({ ...f.config, limits: { relayMaxBytes: 0 } }), { mode: 0o600 });
    assert.throws(() => loadProxyConfig(file), /invalid egress limits.*pomtree-up --rebuild/);
    // The in-image copy of core's rebuild action (audit.ts cannot import core) must stay word-for-word equal to it.
    assert.throws(
      () => loadProxyConfig(file),
      (e: Error) => e.message.endsWith(`: ${IMAGE_REBUILD_ACTION}`),
    );
    writeFileSync(file, JSON.stringify(f.config), { mode: 0o600 });
    assert.deepEqual(loadProxyConfig(file), f.config);
  } finally {
    f.clean();
  }
});
