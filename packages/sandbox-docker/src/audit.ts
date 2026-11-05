// Adapter-local, visible durable spool. The worker never mounts either directory.
// Completed spools are retained across sandbox cleanup; exhaustion fails closed, never evicts evidence. The only deletion is
// DiskEgressAudit.vacuum, which removes a spool that its sandbox closed (closed.json, written by the host after the proxy is gone),
// that is fully acknowledged, and whose journaled chain head pomtreed has just checked; see the vacuum section below. Within a spool,
// AUDIT_MAX_BYTES / MAX_RECORDS are hard caps: a worker that cycles distinct denied destinations can still exhaust its own spool,
// which closes its proxy (fail closed) rather than evicting evidence; repeated identical denials are coalesced
// (CoalescingEgressAuditWriter) so a plain denial loop does not.
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createHash, randomUUID } from "node:crypto";

// Sizing: a single busy node can start hundreds of sandboxes inside one audit.spoolVacuumGraceMs window (24 h by default), every
// egress mode attributed, and a closed spool only stops counting once vacuumed, so the spool count must clear that (256). The
// per-spool byte cap is halved from 16 MiB because CoalescingEgressAuditWriter removes the dominant growth (denial loops); a typical
// row is about 400 bytes (measured: audit-spool-cap.test.ts), so 8 MiB holds roughly 20k rows against MAX_RECORDS (65536).
// AUDIT_ROOT_MAX_BYTES is the derived disk bound for the whole audit root, enforced by the two caps together (spool count x per-spool
// bytes), not by a separate check.
export const AUDIT_MAX_BYTES = 8 * 1024 ** 2;
// Reserve per-spool capacity up front: retained data cannot grow without bound across completed runs.
export const AUDIT_MAX_SPOOLS = 256;
export const AUDIT_ROOT_MAX_BYTES = AUDIT_MAX_SPOOLS * AUDIT_MAX_BYTES;
const MAX_LINE_BYTES = 8192;
const MAX_RECORDS = 65536;
export interface EgressAuditIdentity {
  sandbox: string;
  agent: string;
  host: string;
  generation: number;
}
export interface EgressProxyConfig {
  // Present for every audited sandbox (any egress mode): the proxy then records each admission, denial and outcome.
  identity?: EgressAuditIdentity;
  // Explicit public mode: only `true` lets the proxy dial public destinations, and only with an identity. Absent means NOT
  // public (fail closed), so an audit writer alone never opens egress.
  auditedPublic?: true;
  allow: string[];
  relay: string[];
  // Not written by the daemon: host-owned addresses change with NIC/VPN/DHCP, so they must not be part of the
  // immutable config; startEgress passes them per start as EGRESS_HOST_ADDRESSES. Retained only because pomtreed tests still pass it.
  hostAddresses?: string[];
  // Relay-class byte cap per proxy connection (the daemon writes it from DockerDeps.egressRelayMaxBytes). Absent: the proxy's
  // DEFAULT_RELAY_MAX_BYTES, the push.maxBytes default. Public-class caps are fixed in the proxy and not configured here.
  limits?: { relayMaxBytes?: number };
}
// Closed enums, never free text. Additive: legacy records without these fields stay valid.
export const DENY_REASONS = ["dns", "private", "hard-class", "not-allowlisted", "reserved", "resolver-limit"] as const;
export const LIMIT_KINDS = ["deadline", "idle", "bytes", "connections"] as const;
export const ERROR_CLASSES = ["dial", "reset", "timeout", "protocol", "internal"] as const;
// Which limits a connection ran under: "relay" (an exact controller relay endpoint), "public" (allowlisted or audited-public).
// TODO(relay-class): "model" is reserved for the model-proxy endpoint; the relay config does not yet tell it apart from the
// daemon API (both are plain host:port relay entries), so the proxy never emits it and model streams run under "relay" limits.
export const TRAFFIC_CLASSES = ["relay", "model", "public"] as const;
export type DenyReason = (typeof DENY_REASONS)[number];
export type LimitKind = (typeof LIMIT_KINDS)[number];
export type ErrorClass = (typeof ERROR_CLASSES)[number];
export type TrafficClass = (typeof TRAFFIC_CLASSES)[number];
export const MAX_PEERS = 8;
export interface EgressAuditEvent {
  connection: string;
  phase: "admission" | "outcome";
  transport: "http" | "connect";
  authority: string;
  method?: string;
  // Origin only, with a constant redacted path. CONNECT has no HTTP/content visibility.
  // Kept for schema stability: derivable from transport + authority (always http://authority/[redacted]).
  url?: string;
  // The dialled address; `peers` is the full validated resolved set (at most MAX_PEERS).
  peer?: string;
  peers?: string[];
  outcome: "allowed" | "denied" | "connected" | "complete" | "error" | "cancelled" | "limit";
  denyReason?: DenyReason; // every denied row
  limitKind?: LimitKind; // every limit row
  errorClass?: ErrorClass; // every error row
  trafficClass?: TrafficClass; // every limit row
  // ISO 8601 instant of the admission decision, carried on the connection's outcome rows so start and duration are recoverable.
  admittedAt?: string;
  status?: number;
  durationMs?: number;
  bytesIn?: number;
  bytesOut?: number;
  // Only on a coalesced summary of identical denials (all three together, outcome "denied"): the number of denials folded into this
  // row (>= 1) and the epoch ms of the first and last of them. The row's own connection is the last folded denial's.
  repeats?: number;
  firstAt?: number;
  lastAt?: number;
}
export interface EgressAuditRecord extends EgressAuditEvent, EgressAuditIdentity {
  // Kept for schema stability: constant "egress".
  kind: "egress";
  eventId: string;
  sequence: number;
  at: number;
  // Hash chain: sha256 over the previous row's chain value and this row without this field (auditChainNext). The first row chains
  // from auditChainGenesis(sandbox). pomtreed recomputes it and journals every row's value, so the journal holds the chain head.
  chain: string;
}
export interface EgressAuditWriter {
  append(event: EgressAuditEvent): void; // returns only after fsync; throws => close flow
}

// The one definition of the audit hash chain. The writer, the spool reader and pomtreed's collector all call these, so they cannot
// disagree. The hashed text is the row's JSON without `chain`, in its written key order (the writer puts `chain` last and
// JSON.parse keeps key order, so a reader reproduces the writer's bytes).
export const AUDIT_CHAIN_RE = /^[0-9a-f]{64}$/;
export function auditChainGenesis(sandbox: string): string {
  return createHash("sha256").update(`pomtree-egress-audit-chain-v1\n${sandbox}`).digest("hex");
}
export function auditChainNext(previous: string, record: Omit<EgressAuditRecord, "chain">): string {
  return createHash("sha256")
    .update(`${previous}\n${JSON.stringify(record)}`)
    .digest("hex");
}
// Recomputes a row's chain value from its predecessor's; true when the row carries exactly that value.
export function auditChainHolds(previous: string, record: EgressAuditRecord): boolean {
  const { chain, ...rest } = record;
  return chain === auditChainNext(previous, rest);
}
// Fills `chain` on records (replacing any it carries), as the writer would (test and fixture helper; records keep their order).
export function sealAuditChain(sandbox: string, records: (Omit<EgressAuditRecord, "chain"> & { chain?: string })[]): EgressAuditRecord[] {
  let head = auditChainGenesis(sandbox);
  return records.map(({ chain: _old, ...r }) => {
    head = auditChainNext(head, r);
    return { ...r, chain: head };
  });
}

function checked(path: string, directory: boolean): string {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile()) || realpathSync(path) !== resolve(path))
    throw new Error("unsafe egress spool path");
  if ((st.mode & 0o077) !== 0) throw new Error("egress spool must be private to daemon uid");
  return path;
}
function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return checked(path, true);
}
function sandboxDir(root: string, sandbox: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sandbox)) throw new Error("invalid egress sandbox id");
  checked(root, true);
  return join(root, sandbox);
}
function readSmall(path: string, max: number): string {
  checked(path, false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(max + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > max) throw new Error("oversized egress file");
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function syncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function createFile(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const data = Buffer.from(text);
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function validateProxyConfig(value: unknown): EgressProxyConfig {
  if (!value || typeof value !== "object") throw new Error("invalid egress config");
  const c = value as EgressProxyConfig;
  for (const entries of [c.allow, c.relay, c.hostAddresses ?? []]) {
    if (!Array.isArray(entries) || entries.length > 1024 || entries.some((s) => typeof s !== "string" || s.length > 512))
      throw new Error("invalid egress config entries");
  }
  if (
    c.identity &&
    ([c.identity.sandbox, c.identity.agent, c.identity.host].some((s) => typeof s !== "string" || s.length < 1 || s.length > 256) ||
      !Number.isSafeInteger(c.identity.generation) ||
      c.identity.generation < 0)
  )
    throw new Error("invalid egress identity");
  if (c.auditedPublic !== undefined && c.auditedPublic !== true) throw new Error("invalid egress config: auditedPublic must be true or absent");
  if (c.auditedPublic && !c.identity) throw new Error("invalid egress config: auditedPublic requires an identity");
  if (
    c.limits !== undefined &&
    (!c.limits ||
      typeof c.limits !== "object" ||
      Array.isArray(c.limits) ||
      Object.keys(c.limits).some((k) => k !== "relayMaxBytes") ||
      (c.limits.relayMaxBytes !== undefined && (!Number.isSafeInteger(c.limits.relayMaxBytes) || c.limits.relayMaxBytes < 1)))
  )
    throw new Error("invalid egress limits");
  return c;
}
export function loadProxyConfig(path: string): EgressProxyConfig {
  try {
    return validateProxyConfig(JSON.parse(readSmall(path, 64 * 1024)));
  } catch (e) {
    // The reason is a validation message or a JSON/read failure; strip anything path-like so no absolute path reaches a log or the model.
    const reason = (e instanceof Error ? e.message : String(e)).replace(/(?:[A-Za-z]:)?[\\/][^\s'"`:,)]*[\\/][^\s'"`:,)]*/g, "<path>");
    // The action is core's IMAGE_REBUILD_ACTION, spelled out because this file ships into the image without core (the one
    // documented copy; audit.test.ts asserts the two are equal).
    throw new Error(
      `invalid immutable egress config (${reason}); this proxy does not accept the config pomtreed sent: rebuild the agent image from the current checkout (scripts/pomtree-up --rebuild), then restart pomtreed`,
    );
  }
}
export function prepareEgressSpool(root: string, sandbox: string, config: EgressProxyConfig): { configDir: string; logDir: string } {
  validateProxyConfig(config);
  if (config.identity && config.identity.sandbox !== sandbox) throw new Error("egress identity mismatch");
  privateDir(root);
  const destination = sandboxDir(root, sandbox);
  // A vacuumed sandbox id is never reused: a fresh spool would restart the sequence at 1 under an id whose rows pomtreed already holds.
  if (existsSync(tombstonePath(root, sandbox))) throw new Error("egress audit spool was vacuumed; its sandbox id cannot be reused");
  if (!existsSync(destination)) {
    const r = egressSpoolRetention(root);
    if (r.spools >= AUDIT_MAX_SPOOLS)
      throw new Error(
        `egress audit root retention limit (${AUDIT_MAX_SPOOLS} spools); ${r.open.length} never closed (crashed, or quarantined${r.open.length > 0 ? `: ${r.open.slice(0, 16).join(" ")}` : ""}) and ${r.closed} closed; ` +
          "evidence is never evicted, only vacuumed once closed, acknowledged and journaled. Operator action: after archiving or reviewing a never-closed spool whose sandbox is gone, " +
          "move its directory under the egress-audit root to <id>.vacuumed (it keeps the evidence, stops counting and blocks reuse of the id)",
      );
  }
  const dir = privateDir(destination);
  // The spool is in use again (a restart of the same sandbox key): it is no longer closed, so it cannot be vacuumed.
  const reopened = join(dir, CLOSED_FILE);
  if (existsSync(reopened)) {
    unlinkSync(reopened);
    syncDir(dir);
  }
  const configDir = privateDir(join(dir, "config"));
  const logDir = privateDir(join(dir, "log"));
  const file = join(configDir, "config.json");
  if (readdirSync(configDir).some((entry) => entry.startsWith("config.pending-"))) {
    // TODO(cleanup): interrupted config publications are retained for explicit scoped operator recovery; never replace an unknown identity.
    console.error(`egress config pending publication retained for sandbox ${sandbox}`);
    if (!existsSync(file)) throw new Error("incomplete immutable egress config publication retained; operator recovery required");
  }
  if (existsSync(file)) {
    if (JSON.stringify(loadProxyConfig(file)) !== JSON.stringify(config)) throw new Error("immutable egress config mismatch");
    // A publication interrupted after linkSync but before unlinkSync leaves a pending name that shares the published inode.
    // That name is our own completed publication, so it is removed; any other pending entry is left alone.
    const published = lstatSync(file).ino;
    let removed = false;
    for (const entry of readdirSync(configDir)) {
      const leftover = join(configDir, entry);
      if (entry.startsWith("config.pending-") && lstatSync(leftover).ino === published) {
        unlinkSync(leftover);
        removed = true;
      }
    }
    if (removed) syncDir(configDir);
  } else {
    const serialized = JSON.stringify(config);
    if (Buffer.byteLength(serialized) > 64 * 1024) throw new Error("oversized egress config");
    const pending = join(configDir, `config.pending-${randomUUID()}`);
    try {
      createFile(pending, serialized);
    } catch {
      // private file, durable before publication
      throw new Error("immutable egress config temporary publication failed; pending evidence retained");
    }
    try {
      linkSync(pending, file); // atomic no-clobber publication; never rename over another identity
    } catch {
      if (!existsSync(file) || JSON.stringify(loadProxyConfig(file)) !== serialized)
        throw new Error("immutable egress config publication failed; pending evidence retained");
    }
    syncDir(configDir);
    unlinkSync(pending); // only our known, fully written publication; never unknown crash remnants
    syncDir(configDir);
  }
  syncDir(dir);
  syncDir(root);
  return { configDir, logDir };
}

// The closed set of field names a spool record may carry; every consumer (pomtreed ingestion) validates against this one list.
export const EGRESS_AUDIT_FIELDS = [
  "kind",
  "eventId",
  "sequence",
  "at",
  "sandbox",
  "agent",
  "host",
  "generation",
  "connection",
  "phase",
  "transport",
  "authority",
  "method",
  "url",
  "peer",
  "outcome",
  "status",
  "durationMs",
  "bytesIn",
  "bytesOut",
  "denyReason",
  "limitKind",
  "errorClass",
  "admittedAt",
  "peers",
  "trafficClass",
  "repeats",
  "firstAt",
  "lastAt",
  "chain",
] as const;

// The one definition of an auditable HTTP method token. The proxy refuses (before forwarding) any method that does not match, and
// normalizes it to AUDIT_METHOD_OTHER in the denial row, so a row the reader or pomtreed cannot represent is never produced.
export const AUDIT_METHOD_RE = /^[A-Z]{1,24}$/;
export const AUDIT_METHOD_OTHER = "OTHER";
export function auditMethod(method: string | undefined): string {
  return method !== undefined && AUDIT_METHOD_RE.test(method) ? method : AUDIT_METHOD_OTHER;
}

// The one predicate for a well-formed spool record. The reader applies it to every line, and the writer
// applies it to every line it is about to append, so the writer can never produce a line the reader rejects.
export function validateRecord(r: EgressAuditRecord, identity: EgressAuditIdentity, sequence: number): void {
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("invalid egress audit record JSON");
  if (
    r.kind !== "egress" ||
    r.sequence !== sequence ||
    r.eventId !== `${identity.sandbox}:${sequence}` ||
    !Number.isFinite(r.at) ||
    Object.entries(identity).some(([k, v]) => r[k as keyof EgressAuditIdentity] !== v)
  )
    throw new Error("egress record identity/sequence mismatch");
  if (
    Object.keys(r).some((k) => !EGRESS_AUDIT_FIELDS.includes(k as never)) ||
    typeof r.connection !== "string" ||
    r.connection.length > 128 ||
    !["admission", "outcome"].includes(r.phase) ||
    !["http", "connect"].includes(r.transport) ||
    !["allowed", "denied", "connected", "complete", "error", "cancelled", "limit"].includes(r.outcome) ||
    typeof r.authority !== "string" ||
    r.authority.length > 512 ||
    /[@/?#\\\s]/.test(r.authority)
  )
    throw new Error("invalid egress metadata");
  if (r.transport === "connect" && (r.url !== undefined || r.status !== undefined || r.method !== undefined)) throw new Error("CONNECT has no HTTP visibility");
  if (r.url !== undefined) {
    const u = new URL(r.url);
    if (u.protocol !== "http:" || u.username || u.password || u.search || u.hash || u.pathname !== "/[redacted]") throw new Error("unsafe egress audit URL");
  }
  for (const key of ["durationMs", "bytesIn", "bytesOut"] as const)
    if (r[key] !== undefined && (!Number.isSafeInteger(r[key]) || r[key]! < 0)) throw new Error("invalid egress accounting");
  if (r.method !== undefined && (typeof r.method !== "string" || !AUDIT_METHOD_RE.test(r.method))) throw new Error("invalid egress method");
  if (r.status !== undefined && (!Number.isInteger(r.status) || r.status < 100 || r.status > 599)) throw new Error("invalid egress status");
  for (const [key, values, outcome] of [
    ["denyReason", DENY_REASONS, "denied"],
    ["limitKind", LIMIT_KINDS, "limit"],
    ["errorClass", ERROR_CLASSES, "error"],
    ["trafficClass", TRAFFIC_CLASSES, "limit"],
  ] as const)
    if (r[key] !== undefined && (!(values as readonly unknown[]).includes(r[key]) || r.outcome !== outcome)) throw new Error(`invalid egress ${key}`);
  if (r.admittedAt !== undefined && (typeof r.admittedAt !== "string" || r.admittedAt.length > 40 || new Date(r.admittedAt).toISOString() !== r.admittedAt))
    throw new Error("invalid egress admittedAt");
  const { repeats, firstAt, lastAt } = r;
  if (repeats !== undefined || firstAt !== undefined || lastAt !== undefined) {
    if (
      repeats === undefined ||
      firstAt === undefined ||
      lastAt === undefined ||
      r.outcome !== "denied" ||
      !Number.isSafeInteger(repeats) ||
      repeats < 1 ||
      !Number.isFinite(firstAt) ||
      !Number.isFinite(lastAt) ||
      firstAt < 0 ||
      firstAt > lastAt ||
      lastAt > r.at
    )
      throw new Error("invalid egress repeat summary");
  }
  if (typeof r.chain !== "string" || !AUDIT_CHAIN_RE.test(r.chain)) throw new Error("invalid egress chain");
  if (r.peers !== undefined && (!Array.isArray(r.peers) || r.peers.length > MAX_PEERS || r.peers.some((p) => typeof p !== "string" || p.length > 64)))
    throw new Error("invalid egress peers");
}
// Deterministic damage in a spool's own bytes (bad row, over a limit, corrupt receipt): retrying cannot help, so the consumer
// quarantines that spool at once. Torn tails and I/O errors stay plain Errors: they can be transient.
export class EgressSpoolCorruptError extends Error {
  readonly corrupt = true;
}
function parseRecord(line: string, identity: EgressAuditIdentity, sequence: number, previous: string): EgressAuditRecord {
  try {
    const r = JSON.parse(line) as EgressAuditRecord;
    validateRecord(r, identity, sequence);
    if (!auditChainHolds(previous, r)) throw new Error("egress audit chain mismatch");
    return r;
  } catch (e) {
    throw new EgressSpoolCorruptError(e instanceof SyntaxError ? "invalid egress audit record JSON" : (e as Error).message);
  }
}
// TODO(audit-tail-recovery): a proxy crash mid-flow leaves an admission/allowed row with no outcome row. Current behavior: a reader
// can tell by grouping rows on `connection` (no phase "outcome" row); nothing synthesizes a closing row, see audit-fields.test.ts.
// Incremental bounded scanner; does not load a whole spool. Torn/oversized lines fail closed.
function scan(logDir: string, identity: EgressAuditIdentity, visit: (record: EgressAuditRecord) => void): { sequence: number; bytes: number; head: string } {
  checked(logDir, true);
  const path = join(logDir, "events.jsonl");
  let head = auditChainGenesis(identity.sandbox);
  if (!existsSync(path)) return { sequence: 0, bytes: 0, head };
  checked(path, false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let sequence = 0;
  let bytes = 0;
  let pending = "";
  const buf = Buffer.alloc(4096);
  const decoder = new StringDecoder("utf8");
  try {
    for (;;) {
      const n = readSync(fd, buf);
      if (!n) break;
      bytes += n;
      if (bytes > AUDIT_MAX_BYTES) throw new Error("egress spool byte limit");
      pending += decoder.write(buf.subarray(0, n));
      while (true) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES || ++sequence > MAX_RECORDS) throw new Error("egress spool record limit");
        const record = parseRecord(line, identity, sequence, head);
        head = record.chain;
        visit(record);
      }
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) throw new Error("egress spool line limit");
    }
    pending += decoder.end();
    if (pending) {
      // TODO(audit-tail-recovery): incomplete audit tail is retained and blocks that spool pending operator recovery.
      // Also current behavior: a reader that scans while the proxy is mid-append can observe a torn tail and fail this read; retry succeeds.
      throw new Error("torn egress audit record retained; operator recovery required");
    }
    return { sequence, bytes, head };
  } finally {
    closeSync(fd);
  }
}
// The proxy holds its log directory read-write, so a compromised proxy can rewrite its own spool, and it can recompute the chain
// (there is no secret: a MAC key would sit in the same container). What the chain buys is in pomtreed: every ingested row's chain
// value is journaled, so any later change to ingested history, a reorder, a deletion, a truncation behind the journaled head or a
// rewrite that re-chains differently is detected at the next read or at vacuum. Rows not yet ingested stay unprotected; the
// ingest interval bounds that window.
export class FileEgressAuditWriter implements EgressAuditWriter {
  private sequence: number;
  private bytes: number;
  private head: string;
  private failed = false;
  private readonly identity: Readonly<EgressAuditIdentity>;
  private readonly logDir: string;
  constructor(logDir: string, identity: EgressAuditIdentity) {
    this.logDir = logDir;
    this.identity = Object.freeze({ ...identity });
    const state = scan(logDir, identity, () => {});
    this.sequence = state.sequence;
    this.bytes = state.bytes;
    this.head = state.head;
  }
  append(event: EgressAuditEvent): void {
    if (this.failed) throw new Error("egress audit unavailable");
    try {
      checked(this.logDir, true);
      const sequence = this.sequence + 1;
      const body: Omit<EgressAuditRecord, "chain"> = {
        ...event,
        ...this.identity,
        kind: "egress",
        sequence,
        eventId: `${this.identity.sandbox}:${sequence}`,
        at: Math.max(Date.now(), event.lastAt ?? 0), // a coalesced summary's lastAt (from another clock) never exceeds its row's at
      };
      const chain = auditChainNext(this.head, body);
      const record: EgressAuditRecord = { ...body, chain };
      const line = `${JSON.stringify(record)}\n`;
      validateRecord(JSON.parse(line) as EgressAuditRecord, this.identity, sequence);
      const size = Buffer.byteLength(line);
      if (size > MAX_LINE_BYTES || this.bytes + size > AUDIT_MAX_BYTES || sequence > MAX_RECORDS) throw new Error("egress audit retention limit");
      const path = join(this.logDir, "events.jsonl");
      if (existsSync(path)) {
        checked(path, false);
        if (lstatSync(path).size !== this.bytes) throw new Error("egress spool changed outside writer");
      }
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const data = Buffer.from(line);
        let written = 0;
        while (written < data.length) written += writeSync(fd, data, written);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      syncDir(this.logDir);
      this.sequence = sequence;
      this.bytes += size;
      this.head = chain;
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }
}

// Repeated identical denials (a worker looping on a blocked destination) would otherwise exhaust the spool's hard caps, and the
// resulting append failure closes the proxy, ending the worker's own run, including its relay to the daemon and model. Only
// outcome "denied" events coalesce; everything else is appended straight through, synchronously. The first denial for a key is
// appended unchanged (never dropped or altered) and opens a window; identical denials inside it are counted, and when the window
// ends (or on flush) one summary row carrying the last folded denial plus repeats/firstAt/lastAt goes through the same inner
// writer, so sequence and chain stay continuous. Summaries are written at window end, so sequence order is write order, not denial
// time order: consumers use firstAt/lastAt. A window's total is 1 (the first row) + repeats. A window with no repeats writes nothing; the next denial after it is a first row.
// Residuals (current behavior): a worker cycling distinct destinations still writes one row per distinct key and can reach the
// hard cap, which fails closed as before; suppressed counts pending at a SIGKILL or crash are lost (the first row is durable).
// TODO(audit-coalesce): distinct-key denial floods are not bounded below the hard cap; pending counts (a window's total is 1 + repeats) are not persisted
// before a crash, so only the first row survives one.
export const AUDIT_COALESCE_WINDOW_MS = 60_000;
export const AUDIT_COALESCE_MAX_PENDING = 1024;
export interface CoalescingEgressAuditOptions {
  now?: () => number;
  windowMs?: number;
  maxPending?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  // Called when a timer-driven summary write fails (the inner writer has latched failed; the owner should close).
  onFailure?: (e: unknown) => void;
}
interface CoalesceWindow {
  last: EgressAuditEvent;
  repeats: number;
  firstAt: number;
  lastAt: number;
  windowEnd: number;
  order: number; // first-suppression order; 0 while no repeat has been seen
  timer: unknown;
}
// Per-connection and timing fields differ on every identical denial; everything else identifies the key.
function coalesceKey(event: EgressAuditEvent): string {
  const { connection: _c, admittedAt: _a, durationMs: _d, ...rest } = event;
  return JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}
export class CoalescingEgressAuditWriter implements EgressAuditWriter {
  private readonly windows = new Map<string, CoalesceWindow>(); // insertion order = window-open order
  private order = 0;
  private failed: unknown;
  private hasFailed = false;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxPending: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onFailure: (e: unknown) => void;
  private readonly inner: EgressAuditWriter;
  constructor(inner: EgressAuditWriter, opts: CoalescingEgressAuditOptions = {}) {
    this.inner = inner;
    this.now = opts.now ?? Date.now;
    this.windowMs = opts.windowMs ?? AUDIT_COALESCE_WINDOW_MS;
    this.maxPending = opts.maxPending ?? AUDIT_COALESCE_MAX_PENDING;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return t;
      });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onFailure = opts.onFailure ?? (() => {});
  }
  append(event: EgressAuditEvent): void {
    if (this.hasFailed) throw this.failed;
    this.guard(() => this.appendOne(event));
  }
  // Once the inner writer has thrown it is latched failed, so every later append rethrows (a suppressed repeat must not return silently).
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.hasFailed = true;
      this.failed = e;
      throw e;
    }
  }
  private appendOne(event: EgressAuditEvent): void {
    const t = this.now();
    this.flushExpired(t);
    if (event.outcome !== "denied") {
      this.inner.append(event);
      return;
    }
    const key = coalesceKey(event);
    const w = this.windows.get(key);
    if (w) {
      if (w.repeats === 0) {
        w.firstAt = t;
        w.order = ++this.order;
      }
      w.repeats++;
      w.last = event;
      w.lastAt = Math.max(w.lastAt, t); // a clock stepping back never leaves firstAt > lastAt
      return;
    }
    if (this.windows.size >= this.maxPending) {
      const oldest = this.windows.keys().next().value as string;
      this.close1(oldest);
    }
    this.inner.append(event);
    const opened: CoalesceWindow = { last: event, repeats: 0, firstAt: t, lastAt: t, windowEnd: t + this.windowMs, order: 0, timer: undefined };
    opened.timer = this.setTimer(() => {
      try {
        this.guard(() => this.close1(key));
      } catch (e) {
        this.onFailure(e);
      }
    }, this.windowMs);
    this.windows.set(key, opened);
  }
  // Writes every pending summary (in order of first suppression) and ends all windows.
  flush(): void {
    if (this.hasFailed) throw this.failed;
    this.guard(() => this.flushAll());
  }
  private flushAll(): void {
    const pending = [...this.windows.entries()].filter(([, w]) => w.repeats > 0).sort(([, a], [, b]) => a.order - b.order);
    for (const w of this.windows.values()) this.clearTimer(w.timer);
    this.windows.clear();
    for (const [, w] of pending) this.writeSummary(w);
  }
  private flushExpired(t: number): void {
    const expired: [string, CoalesceWindow][] = [];
    for (const entry of this.windows) {
      if (entry[1].windowEnd > t) break; // windows open in time order, so the expired ones are a prefix
      expired.push(entry);
    }
    expired.sort(([, a], [, b]) => a.order - b.order);
    for (const [key, w] of expired) {
      this.windows.delete(key);
      this.clearTimer(w.timer);
    }
    for (const [, w] of expired) if (w.repeats > 0) this.writeSummary(w);
  }
  private close1(key: string): void {
    const w = this.windows.get(key);
    if (!w) return;
    this.windows.delete(key);
    this.clearTimer(w.timer);
    if (w.repeats > 0) this.writeSummary(w);
  }
  private writeSummary(w: CoalesceWindow): void {
    this.inner.append({ ...w.last, repeats: w.repeats, firstAt: w.firstAt, lastAt: w.lastAt });
  }
}

// The id of a spool directory. Anything else under the root (tombstones, vacuum leftovers, strays) has a different shape.
const SPOOL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TOMBSTONE_SUFFIX = ".vacuumed";
const VACUUMING_SUFFIX = ".vacuuming";
const CLOSED_FILE = "closed.json";
const tombstonePath = (root: string, sandbox: string): string => join(root, `${sandbox}${TOMBSTONE_SUFFIX}`);

// Written by the host (never the proxy; the sandbox directory itself is not mounted) once the sandbox's proxy container is gone, so
// no row can be appended after it. Its presence is the only thing that makes a spool vacuumable; prepareEgressSpool removes it when a
// start reuses the spool. Best effort: a spool that never gets one is simply retained, as before.
export function markEgressSpoolClosed(root: string, sandbox: string, now: number = Date.now()): boolean {
  if (!existsSync(root)) return false; // no spool root: this sandbox never audited, so there is nothing to close
  const dir = sandboxDir(root, sandbox);
  if (!existsSync(dir)) return false;
  checked(dir, true);
  const file = join(dir, CLOSED_FILE);
  if (existsSync(file)) return true;
  const temp = join(dir, `${CLOSED_FILE}.pending`);
  if (existsSync(temp)) unlinkSync(temp);
  createFile(temp, JSON.stringify({ closedAt: now }));
  renameSync(temp, file);
  syncDir(dir);
  return true;
}
function readClosedAt(dir: string): number | undefined {
  const file = join(dir, CLOSED_FILE);
  if (!existsSync(file)) return undefined;
  let c: { closedAt?: unknown } | null;
  try {
    c = JSON.parse(readSmall(file, 256)) as { closedAt?: unknown } | null;
  } catch (e) {
    // Deterministic damage in the marker itself: surfaced as a corrupt spool (pomtreed quarantines it) rather than retried forever.
    if (e instanceof SyntaxError || (e as Error).message === "oversized egress file") throw new EgressSpoolCorruptError("corrupt egress closed marker");
    throw e;
  }
  if (c === null || typeof c !== "object" || !Number.isSafeInteger(c.closedAt) || (c.closedAt as number) < 0)
    throw new EgressSpoolCorruptError("corrupt egress closed marker");
  return c.closedAt as number;
}

// What the spool root holds against AUDIT_MAX_SPOOLS: `open` are spools with no closed marker (still running, crashed before closing, or
// quarantined by pomtreed, which the host cannot tell apart); `closed` await acknowledgement, their grace window and vacuum.
export interface EgressRetention {
  spools: number;
  max: number;
  closed: number;
  open: string[];
}
// Operator procedure (TODO(audit-spool-cap-dos)) when the cap refuses new audited-public sandboxes: list the never-closed ids (this
// function, the refusal message, or EgressAuditCollector.status()); for a spool whose sandbox is gone and whose evidence is archived or
// reviewed, stop pomtreed first or accept one more tick, then `mv <state>/egress-audit/<id> <state>/egress-audit/<id>.vacuumed`. The rename
// keeps the evidence, frees the slot (the name no longer matches a spool id), is skipped by discovery and ingestion, and blocks reuse of
// the id. Nothing is ever deleted automatically: quarantined spools are retained evidence.
export function egressSpoolRetention(root: string): EgressRetention {
  const r: EgressRetention = { spools: 0, max: AUDIT_MAX_SPOOLS, closed: 0, open: [] };
  if (!existsSync(root)) return r;
  checked(root, true);
  for (const entry of readdirSync(root).sort()) {
    if (!SPOOL_ID_RE.test(entry)) continue;
    r.spools++;
    if (existsSync(join(root, entry, CLOSED_FILE))) r.closed++;
    else r.open.push(entry);
  }
  return r;
}

// What pomtreed must have journaled before a spool may be deleted: the spool as it stands, fully verified.
export interface EgressVacuumCandidate {
  sandbox: string;
  throughSequence: number;
  chain: string; // the chain value of the last row (genesis when the spool holds no rows)
  bytes: number;
  closedAt: number;
}
export interface EgressVacuumTombstone {
  sandbox: string;
  throughSequence: number;
  chain: string;
  vacuumedAt: number;
}

export class DiskEgressAudit {
  private readonly root: string;
  constructor(opts: { root: string }) {
    this.root = resolve(opts.root);
  }
  // Safe candidate ids only. Manifest/record validation is per-spool in read(); callers must
  // isolate a failed candidate rather than letting it prevent healthy spools from being ingested.
  async discover(): Promise<string[]> {
    if (!existsSync(this.root)) return [];
    checked(this.root, true);
    const candidates: string[] = [];
    for (const id of readdirSync(this.root)) {
      // Vacuum tombstones and half-removed spools are ours and expected; they are not spools.
      if (id.endsWith(TOMBSTONE_SUFFIX) || id.endsWith(VACUUMING_SUFFIX)) continue;
      try {
        checked(sandboxDir(this.root, id), true);
        candidates.push(id);
      } catch {
        console.error("egress audit discovery skipped unsafe or stray entry");
      }
    }
    return candidates.sort();
  }
  retention(): EgressRetention {
    return egressSpoolRetention(this.root);
  }
  private spool(sandbox: string): { dir: string; identity: EgressAuditIdentity; logDir: string } {
    const dir = checked(sandboxDir(this.root, sandbox), true);
    const config = loadProxyConfig(join(checked(join(dir, "config"), true), "config.json"));
    if (!config.identity || config.identity.sandbox !== sandbox) throw new Error("egress spool attribution mismatch");
    return { dir, identity: config.identity, logDir: checked(join(dir, "log"), true) };
  }
  // The ack receipt is also the scan checkpoint: `offset` is the byte position just past record `throughSequence` and `chain` that
  // row's chain value, written only after those records were validated, so a read resumes there instead of rescanning the spool.
  // A legacy receipt without an offset or chain restarts from byte 0 once (the next ack upgrades it). The receipt lives in the
  // proxy-writable log directory, so pomtreed never trusts its chain: it passes its journaled head and the reader compares.
  private receipt(logDir: string, size: number, sandbox: string): { throughSequence: number; offset: number; head: string } {
    const ack = join(logDir, "ack.json");
    const start = { throughSequence: 0, offset: 0, head: auditChainGenesis(sandbox) };
    if (!existsSync(ack)) return start;
    const c = JSON.parse(readSmall(ack, 512)) as { throughSequence: number; offset?: number; chain?: string };
    if (!Number.isSafeInteger(c.throughSequence) || c.throughSequence < 0) throw new EgressSpoolCorruptError("corrupt egress ack");
    if (c.offset === undefined || c.chain === undefined) return start;
    if (
      !Number.isSafeInteger(c.offset) ||
      c.offset < 0 ||
      c.offset > size ||
      (c.throughSequence === 0) !== (c.offset === 0) ||
      typeof c.chain !== "string" ||
      !AUDIT_CHAIN_RE.test(c.chain)
    )
      throw new EgressSpoolCorruptError("corrupt egress ack");
    return { throughSequence: c.throughSequence, offset: c.offset, head: c.chain };
  }
  // Scans forward from a validated checkpoint (`sequence` records, `offset` bytes, `head` the last row's chain value), awaiting each
  // chunk so a large spool never blocks the event loop. `visit` returns false to stop; work per call is bounded by the caller through
  // `visit`. Every row's chain is verified. Returns the position after the last fully validated record.
  private async scanFrom(
    logDir: string,
    identity: EgressAuditIdentity,
    from: { sequence: number; offset: number; head: string },
    visit: (record: EgressAuditRecord, end: number) => boolean,
  ): Promise<{ sequence: number; offset: number; head: string }> {
    checked(logDir, true);
    const path = join(logDir, "events.jsonl");
    if (!existsSync(path)) return from;
    checked(path, false);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = (await handle.stat()).size;
      if (size > AUDIT_MAX_BYTES) throw new EgressSpoolCorruptError("egress spool byte limit");
      let { sequence, offset, head } = from;
      let pos = offset;
      let pending = Buffer.alloc(0);
      const buf = Buffer.alloc(65536);
      while (pos < size || pending.length > 0) {
        if (pos < size) {
          const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - pos), pos);
          if (!bytesRead) break;
          pos += bytesRead;
          pending = Buffer.concat([pending, buf.subarray(0, bytesRead)]);
        }
        for (let end = pending.indexOf(10); end >= 0; end = pending.indexOf(10)) {
          const line = pending.subarray(0, end);
          if (line.length > MAX_LINE_BYTES || sequence + 1 > MAX_RECORDS) throw new EgressSpoolCorruptError("egress spool record limit");
          sequence++;
          const record = parseRecord(line.toString("utf8"), identity, sequence, head);
          head = record.chain;
          offset += end + 1;
          pending = pending.subarray(end + 1);
          if (!visit(record, offset)) return { sequence, offset, head };
        }
        if (pending.length > MAX_LINE_BYTES) throw new EgressSpoolCorruptError("egress spool line limit");
        if (pos >= size) break;
      }
      // TODO(audit-tail-recovery): incomplete audit tail is retained and blocks that spool pending operator recovery.
      if (pending.length > 0) throw new Error("torn egress audit record retained; operator recovery required");
      return { sequence, offset, head };
    } finally {
      await handle.close();
    }
  }
  // Records after the cursor, at most `limit` rows and 1 MiB, scanning only from the ack checkpoint: per-call work is bounded by
  // the unacknowledged window, never by the spool size. Corruption is detected where the scan reaches it.
  // `afterChain` is the caller's own record of the chain value of row `afterSequence` (pomtreed's journaled head). When given, the
  // spool must reproduce it: a spool that no longer has that row, or hashes it differently, is corrupt (rewritten or truncated
  // history), whatever its ack receipt claims.
  async read(sandbox: string, afterSequence: number, limit = 256, afterChain?: string): Promise<EgressAuditRecord[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isInteger(limit) || limit < 1 || limit > 256)
      throw new Error("invalid egress cursor/limit");
    const { identity, logDir } = this.spool(sandbox);
    const path = join(logDir, "events.jsonl");
    const size = existsSync(path) ? lstatSync(path).size : 0;
    const receipt = this.receipt(logDir, size, sandbox);
    const anchored = afterChain !== undefined && afterSequence > 0;
    // Fully acknowledged (or empty) spool: no scan at all.
    if (receipt.offset === size && afterSequence >= receipt.throughSequence) {
      if (anchored && (afterSequence > receipt.throughSequence || receipt.head !== afterChain))
        throw new EgressSpoolCorruptError("egress spool contradicts the journaled chain head");
      this.lastRead.delete(sandbox);
      return [];
    }
    // A cursor behind the ack (explicit re-read of retained evidence) rescans from the start; the daemon never does this.
    const from = afterSequence >= receipt.throughSequence ? receipt : { throughSequence: 0, offset: 0, head: auditChainGenesis(sandbox) };
    if (anchored && afterSequence === from.throughSequence && from.head !== afterChain)
      throw new EgressSpoolCorruptError("egress spool contradicts the journaled chain head");
    const rows: EgressAuditRecord[] = [];
    let bytes = 0;
    let last = from;
    const end = await this.scanFrom(logDir, identity, { sequence: from.throughSequence, offset: from.offset, head: from.head }, (r, offset) => {
      if (r.sequence <= afterSequence) {
        if (anchored && r.sequence === afterSequence && r.chain !== afterChain)
          throw new EgressSpoolCorruptError("egress spool contradicts the journaled chain head");
        last = { throughSequence: r.sequence, offset, head: r.chain };
        return true;
      }
      const rowSize = Buffer.byteLength(JSON.stringify(r));
      if (rows.length > 0 && bytes + rowSize > 1024 ** 2) return false;
      rows.push(r);
      bytes += rowSize;
      last = { throughSequence: r.sequence, offset, head: r.chain };
      return rows.length < limit;
    });
    if (anchored && end.sequence < afterSequence) throw new EgressSpoolCorruptError("egress spool is shorter than the journaled cursor");
    this.lastRead.set(sandbox, last);
    return rows;
  }
  private readonly lastRead = new Map<string, { throughSequence: number; offset: number; head: string }>();
  // `chain`, when given, is the caller's journaled chain value for row `throughSequence`; the spool must reproduce it.
  async ack(sandbox: string, throughSequence: number, chain?: string): Promise<void> {
    const { identity, logDir } = this.spool(sandbox);
    const path = join(logDir, "events.jsonl");
    const size = existsSync(path) ? lstatSync(path).size : 0;
    const current = this.receipt(logDir, size, sandbox);
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) throw new Error("invalid egress ack");
    if (throughSequence <= current.throughSequence) return;
    // Position of the record being acknowledged: the last read when it ends there, else a bounded scan from the checkpoint.
    let at: { throughSequence: number; offset: number; head: string } | undefined = this.lastRead.get(sandbox);
    if (at?.throughSequence !== throughSequence) {
      at = undefined;
      await this.scanFrom(logDir, identity, { sequence: current.throughSequence, offset: current.offset, head: current.head }, (r, offset) => {
        if (r.sequence === throughSequence) at = { throughSequence, offset, head: r.chain };
        return r.sequence < throughSequence;
      });
    }
    if (!at) {
      // With a journaled head the caller already holds this row, so a spool that does not reach it was truncated: deterministic.
      if (chain !== undefined) throw new EgressSpoolCorruptError("egress spool is shorter than the journaled cursor");
      throw new Error("invalid egress ack");
    }
    if (chain !== undefined && at.head !== chain) throw new EgressSpoolCorruptError("egress spool contradicts the journaled chain head");
    const ack = join(logDir, "ack.json");
    const temp = join(logDir, "ack.pending");
    // A crash before rename may leave an immutable pending receipt; never follow or overwrite it.
    if (existsSync(temp)) {
      checked(temp, false);
      unlinkSync(temp);
    }
    createFile(temp, JSON.stringify({ throughSequence, offset: at.offset, chain: at.head }));
    renameSync(temp, ack);
    syncDir(logDir);
  }

  // --- vacuum -------------------------------------------------------------------------------------------------------------
  // A spool is deleted only when every one of these holds, so an un-acked row is never removed:
  //  1. closed.json exists and is at least `graceMs` old (the proxy is gone: nothing can append);
  //  2. ack.json covers the whole file (offset === size);
  //  3. a full rescan from row 1 verifies every row and chain, and ends at the acked sequence and chain.
  // The caller (pomtreed) then checks the result against what it has journaled and journals the deletion BEFORE calling vacuum().
  // Returns undefined when the spool is simply not eligible (yet); throws on a spool whose own bytes are bad.
  async vacuumCandidate(sandbox: string, graceMs: number, now: number): Promise<EgressVacuumCandidate | undefined> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error("invalid egress vacuum grace");
    const { dir, identity, logDir } = this.spool(sandbox);
    const closedAt = readClosedAt(dir);
    if (closedAt === undefined || now - closedAt < graceMs) return undefined;
    const path = join(logDir, "events.jsonl");
    const size = existsSync(path) ? lstatSync(path).size : 0;
    const receipt = this.receipt(logDir, size, sandbox);
    if (receipt.offset !== size) return undefined;
    const end = await this.scanFrom(logDir, identity, { sequence: 0, offset: 0, head: auditChainGenesis(sandbox) }, () => true);
    if (end.sequence !== receipt.throughSequence || end.offset !== size || end.head !== receipt.head)
      throw new EgressSpoolCorruptError("egress spool contradicts its acknowledgement");
    return { sandbox, throughSequence: end.sequence, chain: end.head, bytes: size, closedAt };
  }
  // Synchronous end to end, so nothing in this process (notably prepareEgressSpool reusing the spool) can interleave with the
  // re-check and the removal. Order: tombstone (so a later start cannot reuse the id and restart the sequence), then an atomic
  // rename of the directory to a `.vacuuming` name (the spool disappears from discovery in one step), then the recursive removal.
  // A crash after the rename leaves only the `.vacuuming` leftover, which reapVacuumed() removes. Returns false when the spool
  // changed since vacuumCandidate (reopened, grown, re-acked): nothing is removed.
  vacuum(candidate: EgressVacuumCandidate, now: number = Date.now()): boolean {
    const { sandbox } = candidate;
    const { dir, logDir } = this.spool(sandbox);
    if (readClosedAt(dir) !== candidate.closedAt) return false;
    const path = join(logDir, "events.jsonl");
    const size = existsSync(path) ? lstatSync(path).size : 0;
    const receipt = this.receipt(logDir, size, sandbox);
    if (size !== candidate.bytes || receipt.offset !== size || receipt.throughSequence !== candidate.throughSequence || receipt.head !== candidate.chain)
      return false;
    const tomb: EgressVacuumTombstone = { sandbox, throughSequence: candidate.throughSequence, chain: candidate.chain, vacuumedAt: now };
    const file = tombstonePath(this.root, sandbox);
    if (!existsSync(file)) {
      createFile(file, JSON.stringify(tomb));
      syncDir(this.root);
    }
    const doomed = join(this.root, `${sandbox}${VACUUMING_SUFFIX}`);
    rmSync(doomed, { recursive: true, force: true });
    renameSync(dir, doomed);
    syncDir(this.root);
    rmSync(doomed, { recursive: true, force: true });
    return true;
  }
  // Removes half-removed spools left by a crash between vacuum()'s rename and its removal. Returns how many were removed.
  reapVacuumed(): number {
    if (!existsSync(this.root)) return 0;
    checked(this.root, true);
    let removed = 0;
    for (const entry of readdirSync(this.root)) {
      if (!entry.endsWith(VACUUMING_SUFFIX) || !SPOOL_ID_RE.test(entry.slice(0, -VACUUMING_SUFFIX.length))) continue;
      const path = join(this.root, entry);
      if (!lstatSync(path).isDirectory()) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    }
    return removed;
  }
}
