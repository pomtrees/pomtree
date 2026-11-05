import { isIP } from "node:net";
import type { AgentRecord, Journal } from "@pomtree/core";
import {
  EgressSpoolCorruptError,
  type EgressAuditRecord,
  type EgressRetention,
  type EgressVacuumCandidate,
  auditChainGenesis,
  auditChainHolds,
  validateRecord,
} from "@pomtree/sandbox-docker";

// The adapter validates immutable config attribution, contiguous sequence and eventId on every read.
// No registry lookup may reinterpret a late source event as the task's current generation.
export interface EgressAuditReader {
  discover(): Promise<string[]>;
  // `afterChain` / `chain` are pomtreed's journaled chain value for row `afterSequence` / `throughSequence`: the spool must reproduce it.
  read(sandbox: string, afterSequence: number, limit?: number, afterChain?: string): Promise<EgressAuditRecord[]>;
  ack(sandbox: string, throughSequence: number, chain?: string): Promise<void>;
  // Vacuum (see DiskEgressAudit): the candidate is a fully verified, closed, acknowledged spool past its grace window, or undefined.
  vacuumCandidate(sandbox: string, graceMs: number, now: number): Promise<EgressVacuumCandidate | undefined>;
  vacuum(candidate: EgressVacuumCandidate): boolean;
  reapVacuumed(): number;
  // What the spool root holds against the retention cap (see EgressRetention). Optional: a reader without a cap reports nothing.
  retention?(): EgressRetention;
}
// For health and operators: what keeps spools counting toward the cap (quarantined ones are retained evidence, never auto-deleted).
export interface EgressAuditStatus {
  quarantined: string[];
  retention?: EgressRetention;
}
export const EGRESS_AUDIT_KIND = "ext.egress.audit";
// Content-free marker journaled once when a spool is quarantined (source: sandbox id, failing operation, cursor). `egress` is a
// reserved extension name, so only this collector can write either kind.
export const EGRESS_QUARANTINE_KIND = "ext.egress.quarantine";
// The INTENT to delete, journaled BEFORE a fully acknowledged, closed spool is deleted: the sandbox, the last sequence and chain head it
// held (equal to the journaled audit rows), its size and when it was closed. Journal first, so a crash between the two leaves a spool
// the next tick deletes, never a deletion with no record. It does not say the deletion happened: the OUTCOME row below does. Keyed by
// closedAt and sequence, so a retry is deduplicated.
export const EGRESS_VACUUM_KIND = "ext.egress.vacuum";
// Journaled after the deletion was attempted: `removed` true when the spool is gone (a tombstone holds its id), false when the spool
// changed since the candidate (reopened by a restart, grown, re-acked) and was kept; the intent row then stands unfulfilled. Keyed per
// outcome, so a kept spool that is vacuumed later still gets its own `removed: true` row. A crash between the deletion and this row
// leaves an intent with no outcome; the tombstone in the spool root is the authority then.
export const EGRESS_VACUUM_OUTCOME_KIND = "ext.egress.vacuum_outcome";
// Consecutive read/ack failures before a spool is quarantined; a validation failure on a row is deterministic and quarantines at once.
const QUARANTINE_AFTER = 3;

// TODO(audit-identity): check the expected agent, host and generation on ingest. Current behavior: they are taken from the row
// itself and only sanity-checked.
// Per-row rules live in one place: sandbox-docker's validateRecord (the reader's own predicate), so pomtreed can never accept a row
// the spool reader rejects. Only checks specific to ingestion stay here: pomtreed has no expected agent/host/generation (the spool
// config owns them), so those are taken from the row and only sanity-checked.
export function validateEgressAuditRecord(record: EgressAuditRecord, sandbox: string, sequence: number): void {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("invalid egress audit identity/sequence");
  const { agent, host, generation } = record;
  try {
    validateRecord(record, { sandbox, agent, host, generation }, sequence);
  } catch {
    throw new Error("invalid egress audit record");
  }
  for (const field of ["sandbox", "agent", "host"] as const) {
    if (
      typeof record[field] !== "string" ||
      !record[field] ||
      record[field].length > 512 ||
      /\s/.test(record[field]) ||
      [...record[field]].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new Error("invalid egress audit field");
  }
  if (!Number.isSafeInteger(record.generation) || record.generation < 0 || record.at < 0) throw new Error("invalid egress audit event");
  if (record.peer !== undefined && (typeof record.peer !== "string" || !isIP(record.peer))) throw new Error("invalid egress peer");
}

export interface CollectorOptions {
  reader: EgressAuditReader;
  journal: Journal;
  root(): Promise<AgentRecord>;
  // Vacuum a closed, fully ingested spool this long after it closed (audit.spoolVacuumGraceMs). Unset: spools are never vacuumed.
  vacuumGraceMs?: number;
  now?: () => number;
}

export class EgressAuditCollector {
  private cursors: Map<string, number> | undefined;
  // The chain value of the last journaled row per sandbox: the anchor the spool must reproduce. Rebuilt from the journal at boot.
  private readonly heads = new Map<string, string>();
  private readonly quarantined = new Set<string>();
  private readonly strikes = new Map<string, number>();
  private running: Promise<number> | undefined;
  private available = false;
  private readonly opts: CollectorOptions;
  constructor(opts: CollectorOptions) {
    this.opts = opts;
  }
  healthy(): boolean {
    return this.available;
  }
  // Operator view of the spool cap (TODO(audit-spool-cap-dos)): quarantined ids (known from the journal after the first tick) and the
  // reader's retention counts. Sandbox ids only, no paths.
  status(): EgressAuditStatus {
    const retention = this.opts.reader.retention?.();
    return { quarantined: [...this.quarantined].sort(), ...(retention && { retention }) };
  }
  // Serialize ticks; advance only after append. A crash before ack replays the same source key, never duplicate evidence.
  ingest(): Promise<number> {
    if (this.running) return this.running;
    const run = this.ingestNow();
    this.running = run;
    void run.then(
      () => {
        this.running = undefined;
        this.available = true;
      },
      () => {
        this.running = undefined;
        this.available = false;
      },
    );
    return run;
  }
  private async ingestNow(): Promise<number> {
    const { reader, journal } = this.opts;
    const root = await this.opts.root();
    if (!this.cursors) {
      const cursors = new Map<string, number>();
      for (let from = 0; ; ) {
        const page = await journal.read({ agent: root.id, from, limit: 500 });
        for (const entry of page)
          if (entry.payload.kind === EGRESS_QUARANTINE_KIND) this.quarantined.add((entry.payload.source as { sandbox: string }).sandbox);
          else if (entry.payload.kind === EGRESS_AUDIT_KIND) {
            const source = entry.payload.source as EgressAuditRecord;
            try {
              validateEgressAuditRecord(source, source.sandbox, source.sequence);
            } catch {
              continue; // a forged or garbled row never moves a cursor and never wedges ingestion
            }
            if (source.sequence > (cursors.get(source.sandbox) ?? 0)) {
              cursors.set(source.sandbox, source.sequence);
              this.heads.set(source.sandbox, source.chain);
            }
          }
        if (page.length < 500) break;
        from = page[page.length - 1]!.seq + 1;
      }
      this.cursors = cursors;
    }
    // Housekeeping first, so a leftover is reaped even on a tick that discovers no spool at all.
    if (this.opts.vacuumGraceMs !== undefined) {
      try {
        reader.reapVacuumed();
      } catch {
        console.error("pomtreed: egress audit vacuum leftovers could not be reaped");
      }
    }
    let count = 0;
    let failed = 0;
    const errors: Error[] = [];
    for (const [index, sandbox] of (await reader.discover()).entries()) {
      const validIdentity = typeof sandbox === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(sandbox);
      const identity = validIdentity ? sandbox : `candidate-${index + 1}`;
      let sequence = 0;
      let operation = "identity";
      if (validIdentity && this.quarantined.has(sandbox)) continue;
      try {
        if (!validIdentity) throw new Error("invalid egress audit sandbox");
        sequence = this.cursors.get(sandbox) ?? 0;
        // The chain value of the last journaled row. A cursor with no head is a row journaled before the chain existed: the
        // spool cannot be anchored, and its unchained rows fail validation below (the spool is quarantined, not wedged).
        let head = sequence === 0 ? auditChainGenesis(sandbox) : this.heads.get(sandbox);
        // Recover an append-before-ack interruption, even when there are no newly appended records.
        operation = "ack";
        if (sequence > 0) await reader.ack(sandbox, sequence, head);
        operation = "read";
        const rows = await reader.read(sandbox, sequence, 256, sequence > 0 ? head : undefined);
        for (const source of rows) {
          operation = "validate";
          validateEgressAuditRecord(source, sandbox, sequence + 1);
          // pomtreed recomputes the chain itself rather than trusting the reader: the row must extend the journaled head exactly.
          if (head === undefined || !auditChainHolds(head, source)) throw new EgressSpoolCorruptError("egress audit chain mismatch");
          operation = "append";
          await journal.append({
            agent: root.id,
            host: root.host,
            generation: root.generation,
            // Root is the INGESTION envelope. Source identity below is authoritative and never redacted/relabelled.
            payload: { kind: EGRESS_AUDIT_KIND, source: structuredClone(source) },
            idempotencyKey: `egress-audit:${sandbox}:${source.eventId}`,
          });
          sequence = source.sequence;
          head = source.chain;
          this.cursors.set(sandbox, sequence);
          this.heads.set(sandbox, head);
          count++;
        }
        operation = "ack";
        if (rows.length > 0) await reader.ack(sandbox, sequence, head);
        this.strikes.delete(sandbox);
        await this.vacuum(root, sandbox);
      } catch (e) {
        // Retain failed spools unchanged. One bad source must not starve healthy evidence. A spool whose own rows are bad
        // (validation, deterministic corruption, or repeated read/ack failure) is quarantined: a content-free marker is journaled, the spool is no
        // longer ingested, and health is unaffected (that worker's own proxy already failed closed on its spool). Any other
        // failure (e.g. the store) closes new public admission. Never expose raw adapter/store errors (paths or credentials).
        if (validIdentity && operation !== "append" && operation !== "identity") {
          const strikes = (this.strikes.get(sandbox) ?? 0) + 1;
          this.strikes.set(sandbox, strikes);
          if (operation === "validate" || e instanceof EgressSpoolCorruptError || strikes >= QUARANTINE_AFTER) {
            if (await this.quarantine(root, sandbox, operation, sequence)) continue;
            // marker could not be written: fall through and fail like any store error
          }
        }
        this.available = false;
        failed++;
        if (errors.length < 16) errors.push(new Error(`egress audit spool ${identity}: ${operation} failed at cursor ${sequence}`));
      }
    }
    if (failed > 0) throw new AggregateError(errors, `egress audit ingestion failed for ${failed} spool(s)`);
    return count;
  }

  private async quarantine(root: AgentRecord, sandbox: string, operation: string, cursor: number): Promise<boolean> {
    try {
      await this.opts.journal.append({
        agent: root.id,
        host: root.host,
        generation: root.generation,
        payload: { kind: EGRESS_QUARANTINE_KIND, source: { sandbox, operation, cursor } },
        idempotencyKey: `egress-quarantine:${sandbox}`,
      });
      this.quarantined.add(sandbox);
      console.error(`pomtreed: egress audit spool ${sandbox} quarantined after ${operation} failure at cursor ${cursor}`);
      return true;
    } catch {
      return false;
    }
  }

  // Housekeeping after a spool was ingested up to date. It never touches health: a spool that fails its own verification is
  // quarantined (retained, never deleted); any other failure is logged without detail and retried next tick.
  private async vacuum(root: AgentRecord, sandbox: string): Promise<void> {
    const { reader, journal, vacuumGraceMs } = this.opts;
    if (vacuumGraceMs === undefined) return;
    const cursor = this.cursors?.get(sandbox) ?? 0;
    try {
      const candidate = await reader.vacuumCandidate(sandbox, vacuumGraceMs, (this.opts.now ?? Date.now)());
      if (!candidate) return;
      // Rows beyond the journal cursor are not ingested yet (the next tick takes them); the spool must otherwise match the
      // journal exactly, so a spool with fewer rows, or other history, than was journaled is evidence of tampering, not garbage.
      if (candidate.throughSequence > cursor) return;
      const head = cursor === 0 ? auditChainGenesis(sandbox) : this.heads.get(sandbox);
      if (candidate.throughSequence !== cursor || candidate.chain !== head)
        throw new EgressSpoolCorruptError("egress spool contradicts the journaled chain head");
      const key = `egress-vacuum:${sandbox}:${candidate.closedAt}:${candidate.throughSequence}`;
      await journal.append({
        agent: root.id,
        host: root.host,
        generation: root.generation,
        payload: {
          kind: EGRESS_VACUUM_KIND,
          source: { sandbox, throughSequence: candidate.throughSequence, chain: candidate.chain, bytes: candidate.bytes, closedAt: candidate.closedAt },
        },
        idempotencyKey: key,
      });
      const removed = reader.vacuum(candidate);
      await journal.append({
        agent: root.id,
        host: root.host,
        generation: root.generation,
        payload: { kind: EGRESS_VACUUM_OUTCOME_KIND, source: { sandbox, throughSequence: candidate.throughSequence, closedAt: candidate.closedAt, removed } },
        idempotencyKey: `${key}:${removed ? "removed" : "kept"}`,
      });
    } catch (e) {
      if (e instanceof EgressSpoolCorruptError && (await this.quarantine(root, sandbox, "verify", cursor))) return;
      console.error(`pomtreed: egress audit spool ${sandbox} vacuum deferred`);
    }
  }
}

// Swallows ingestion failure (the collector has already closed new public admission via healthy()=false) and logs a fixed
// message: raw errors may carry spool paths or credentials. TODO(otlp): the failure is logged, not journaled.
export async function ingestEgressAuditSafely(collector: Pick<EgressAuditCollector, "ingest">, log: (line: string) => void): Promise<void> {
  try {
    await collector.ingest();
  } catch {
    log("pomtreed: egress audit ingestion failed; new public worker admission is closed");
  }
}
