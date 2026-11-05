import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, NewReport, Report, ReportId, ReportStore, Registry } from "@pomtree/core";
import { StaleGenerationError } from "@pomtree/core";
import { SafeOpenError, safeReadFile } from "@pomtree/harness-pi/safe-open";

const CONTENT = "content";
const META = "meta.json";
const MAX_META_BYTES = 1024 * 1024;

// Same traversal guard idiom as GitWorkspace.dir: reject separators, NUL, `..`, and
// leading `-`/`.` so no caller-supplied segment can escape the store root.
function valid(part: string): boolean {
  return !!part && !/[\/\\\0]/.test(part) && !part.includes("..") && !part.startsWith("-") && !part.startsWith(".");
}

// `lstat` never follows the final component, so a symlinked directory or meta.json reads as
// "not a regular file" here — we refuse to follow symlinks anywhere inside the store. Reads of
// the files an agent can touch do not rely on it (check-then-read race): they go through `readSafe`.
function lstatOrNull(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

// Reads a store file through the descriptor-based safe-open primitive (O_NOFOLLOW|O_NONBLOCK, fstat
// regular-file check, size bound). Absent, a link, a FIFO or other non-file, or oversize all read as null.
async function readSafe(p: string, maxBytes: number): Promise<Uint8Array | null> {
  try {
    return await safeReadFile(p, maxBytes);
  } catch (e) {
    if (e instanceof SafeOpenError) return null;
    throw e;
  }
}

// A record is trusted only if its identity matches the directory it was read from.
async function parseMeta(meta: string, agent: AgentId, id: ReportId): Promise<Report | null> {
  try {
    const bytes = await readSafe(meta, MAX_META_BYTES);
    if (!bytes) return null;
    const m = JSON.parse(Buffer.from(bytes).toString("utf8")) as Report;
    if (!m || typeof m !== "object" || m.agent !== agent || m.id !== id || typeof m.createdAt !== "number") return null;
    if (!Number.isSafeInteger(m.sizeBytes) || m.sizeBytes < 0) return null; // bounds the content read
    return m;
  } catch {
    return null;
  }
}

export class DirReportStore implements ReportStore {
  private readonly root: string;
  private readonly registry: Pick<Registry, "get">;

  constructor(opts: { root: string; registry: Pick<Registry, "get"> }) {
    mkdirSync(opts.root, { recursive: true });
    this.root = realpathSync(opts.root);
    this.registry = opts.registry;
  }

  private dir(agent: AgentId): string {
    if (!valid(agent)) throw new Error(`invalid agent id for report store: ${JSON.stringify(agent)}`);
    return join(this.root, agent);
  }

  private reportDir(agent: AgentId, id: ReportId): string {
    if (!valid(id)) throw new Error(`invalid report id for report store: ${JSON.stringify(id)}`);
    return join(this.dir(agent), id);
  }

  async write(r: NewReport, _idempotencyKey: string): Promise<Report> {
    const dir = this.reportDir(r.agent, r.id); // validates agent + id at the boundary
    const meta = join(dir, META);
    const content = join(dir, CONTENT);

    // Refuse to read or write through a symlink: writeFileSync follows symlinks, so a
    // symlinked meta.json (or a symlinked report dir) would let us scribble outside root.
    const dst = lstatOrNull(dir);
    if (dst && !dst.isDirectory()) throw new Error(`report path is not a directory: ${dir}`);
    const mst = lstatOrNull(meta);
    if (mst && !mst.isFile()) throw new Error(`refusing non-file meta.json: ${meta}`);

    // Idempotent by the deterministic report id: an existing record wins, never rewritten.
    if (mst) {
      const existing = await parseMeta(meta, r.agent, r.id);
      if (!existing) throw new Error(`corrupt existing report record: ${meta}`);
      return existing;
    }

    // Fence on generation like CheckpointStore.write: unknown agent -> plain Error,
    // mismatched generation -> StaleGenerationError.
    const a = await this.registry.get(r.agent);
    if (!a) throw new Error(`unknown agent ${r.agent}`);
    if (a.generation !== r.generation) throw new StaleGenerationError(r.agent, r.generation, a.generation);

    // The adapter is authoritative: verify the bytes actually match the claimed size and
    // hash before persisting anything.
    const sizeBytes = r.content.byteLength;
    if (sizeBytes !== r.sizeBytes) throw new Error(`report size mismatch: claimed ${r.sizeBytes}, got ${sizeBytes}`);
    const sha256 = createHash("sha256").update(r.content).digest("hex");
    if (sha256 !== r.sha256) throw new Error(`report sha256 mismatch: claimed ${r.sha256}, got ${sha256}`);

    mkdirSync(dir, { recursive: true });
    // Raw bytes land first under a temp name, then rename, so `content` is never seen
    // half-written; `meta.json` is written last so a partial write reads as absent.
    const tmp = join(dir, `.${CONTENT}-${randomBytes(8).toString("hex")}.tmp`);
    writeFileSync(tmp, r.content);
    renameSync(tmp, content);

    const report: Report = {
      id: r.id,
      agent: r.agent,
      generation: r.generation,
      host: r.host,
      name: r.name,
      mediaType: r.mediaType,
      sizeBytes: r.sizeBytes,
      sha256: r.sha256,
      createdAt: Date.now(),
    };
    writeFileSync(meta, JSON.stringify(report));
    return report;
  }

  async list(agent: AgentId): Promise<Report[]> {
    const dir = this.dir(agent); // validates
    if (!lstatOrNull(dir)?.isDirectory()) return []; // absent or symlinked agent dir
    const reports: Report[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue; // real directories only; symlinks report as links
      const meta = join(dir, ent.name, META);
      const m = await parseMeta(meta, agent, ent.name); // absent, linked, non-file, oversize, corrupt or mismatched meta.json: skip, don't break the page
      if (m) reports.push(m);
    }
    return reports.sort((x, y) => y.createdAt - x.createdAt); // newest first
  }

  async read(agent: AgentId, id: ReportId) {
    const dir = this.reportDir(agent, id); // validates
    if (!lstatOrNull(dir)?.isDirectory()) return null; // absent or symlinked report dir
    const meta = join(dir, META);
    const report = await parseMeta(meta, agent, id);
    if (!report) return null; // absent, linked, non-file, oversize, corrupt or mismatched meta.json
    // Bounded by the size the adapter verified at write, so a grown file is refused, not read whole.
    const content = await readSafe(join(dir, CONTENT), report.sizeBytes);
    if (!content) return null; // absent, linked, non-file or oversize content
    return { report, content };
  }

  async remove(agent: AgentId, id: ReportId): Promise<boolean> {
    const dir = this.reportDir(agent, id);
    const existed = existsSync(dir);
    rmSync(dir, { recursive: true, force: true });
    return existed;
  }
}
