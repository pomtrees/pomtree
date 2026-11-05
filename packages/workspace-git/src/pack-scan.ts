// Pure pre-execution scan of a git pack: walks every object entry and inflates each zlib stream while counting
// output bytes, so a small compressed pack that expands hugely (a zlib bomb) is refused by an inflated-size cap
// BEFORE index-pack runs. index-pack inflates every object to hash it, so size accounting that runs only after
// it cannot bound the disk or memory a bomb uses during verification. Delta objects add the result size their
// header declares (what git will materialize), so a lying delta header is caught the same way. The scan never
// trusts sizes the pack merely declares: only actual inflated bytes and delta result sizes count. The pack is
// read through a PackSource in bounded windows (SCAN_WINDOW_BYTES), so a large pack is never held in memory. No
// fs opens, no process: node:zlib only, plus reads through a handle the caller opened.
import { createHash, type Hash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { Inflate } from "node:zlib";

// Random-access bytes of a pack that starts at offset 0 with the PACK signature. `read` returns exactly
// `len` bytes (the scan never asks past `size`). A Buffer is wrapped by bufferSource; a file by fileSource.
export interface PackSource {
  readonly size: number;
  read(pos: number, len: number): Promise<Buffer>;
}

// The largest single read the scan issues: its resident pack bytes stay at about this, whatever the pack size.
export const SCAN_WINDOW_BYTES = 64 * 1024;

export function bufferSource(b: Buffer): PackSource {
  return { size: b.length, read: async (pos, len) => b.subarray(pos, pos + len) };
}

// The pack inside an open file, from byte `start` to the end (`size` bytes). The handle stays the caller's to close.
export function fileSource(fh: FileHandle, start: number, size: number): PackSource {
  return {
    size,
    async read(pos, len) {
      const out = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(out, got, len - got, start + pos + got);
        if (bytesRead === 0) throw new Error("pack file shrank while it was scanned");
        got += bytesRead;
      }
      return out;
    },
  };
}

// One window of the source, refilled forward only when a read falls outside it.
class Window {
  private buf: Buffer = Buffer.alloc(0);
  private at = 0; // buf holds source bytes [at, at + buf.length)
  readonly size: number;
  private src: PackSource;
  constructor(src: PackSource) {
    this.src = src;
    this.size = src.size;
  }
  // Ensures [pos, pos + n) (clamped to the source end) is buffered.
  async need(pos: number, n: number): Promise<void> {
    const end = Math.min(pos + n, this.size);
    if (pos >= this.at && end <= this.at + this.buf.length) return;
    this.buf = await this.src.read(pos, Math.min(SCAN_WINDOW_BYTES, this.size - pos));
    this.at = pos;
  }
  byte(pos: number): number {
    return this.buf[pos - this.at]!;
  }
  // The buffered bytes from `pos` to the window end; `need(pos, 1)` first.
  from(pos: number): Buffer {
    return this.buf.subarray(pos - this.at);
  }
  latin1(pos: number, n: number): string {
    return this.buf.toString("latin1", pos - this.at, pos - this.at + n);
  }
  u32(pos: number): number {
    return this.buf.readUInt32BE(pos - this.at);
  }
}

export type PackScan =
  // oids: the object ids of the pack's NON-DELTA entries (delta results cannot be named without their bases).
  // With it the caller can tell objects the pack carried from objects index-pack --fix-thin adopted.
  { ok: true; objects: number; oids: Set<string> } | { ok: false; code: "too_large" | "bad_bundle"; message: string };

const TYPE_NAME: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const KNOWN_TYPES = new Set([1, 2, 3, 4, 6, 7]); // commit, tree, blob, tag, ofs-delta, ref-delta

type Inflation = { kind: "ok"; consumed: number } | { kind: "abort" } | { kind: "bad" };

// Inflates the single zlib stream starting at `start`, fed window by window. onChunk sees each output chunk and
// returns false to stop early (the cap is hit); bytesWritten then tells where the stream ended, which is where the
// next object starts. zlib stops consuming at the stream end, so a chunk it did not consume fully ends the feed.
async function inflateOne(win: Window, start: number, onChunk: (d: Buffer) => boolean): Promise<Inflation> {
  const inf = new Inflate();
  let settled = false;
  let resolve!: (r: Inflation) => void;
  const result = new Promise<Inflation>((r) => {
    resolve = r;
  });
  const done = (r: Inflation) => {
    if (!settled) {
      settled = true;
      inf.destroy();
      resolve(r);
    }
  };
  inf.on("data", (d: Buffer) => {
    if (!onChunk(d)) done({ kind: "abort" });
  });
  inf.on("end", () => done({ kind: "ok", consumed: Number(inf.bytesWritten) }));
  inf.on("error", () => done({ kind: "bad" }));
  inf.on("close", () => done({ kind: "bad" })); // truncated input ends the writable side without a stream end
  try {
    let off = start;
    while (!settled) {
      if (off >= win.size) {
        inf.end();
        break;
      }
      await win.need(off, 1);
      if (settled) break;
      const chunk = win.from(off);
      await new Promise<void>((r) => inf.write(chunk, () => r()));
      off += chunk.length;
      if (Number(inf.bytesWritten) < off - start) break; // the stream ended inside this chunk; "end" follows
    }
  } catch {
    done({ kind: "bad" }); // a failed read
  }
  return result;
}

// A delta-header varint (7-bit little-endian groups) at `pos`; null when truncated or over 64 bits.
function deltaVarint(buf: Buffer, pos: number): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length || shift > 63n) return null;
    const b = buf[pos++]!;
    value |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if (!(b & 0x80)) return { value, next: pos };
  }
}

// The longest object entry header parsed before the zlib stream: the type and size varint (at most 10 bytes before
// the shift guard trips) plus an offset varint (at most 9) or a ref-delta base id (20).
const MAX_ENTRY_HEAD = 64;

// `input` starts at the PACK signature. The inflated cap applies to the sum of every object's inflated stream
// plus every delta's declared result size — an upper bound on the bytes index-pack will materialize.
export async function scanPack(input: Buffer | PackSource, opts: { maxInflatedBytes: number }): Promise<PackScan> {
  const bad = (message: string): PackScan => ({ ok: false, code: "bad_bundle", message: `pack cannot be pre-verified: ${message}` });
  const cap = BigInt(opts.maxInflatedBytes);
  const pack = new Window(Buffer.isBuffer(input) ? bufferSource(input) : input);
  const fill = async (pos: number, n: number): Promise<boolean> =>
    pack.need(pos, n).then(
      () => true,
      () => false,
    );
  if (pack.size < 12 + 20) return bad("missing pack preamble");
  if (!(await fill(0, 12))) return bad("pack cannot be read");
  if (pack.latin1(0, 4) !== "PACK") return bad("missing pack preamble");
  const version = pack.u32(4);
  if (version !== 2 && version !== 3) return bad(`unsupported pack version ${version}`);
  const count = pack.u32(8);
  const oids = new Set<string>();
  let pos = 12;
  let total = 0n;
  for (let i = 0; i < count; i++) {
    if (pos >= pack.size - 20) return bad("truncated object entry");
    if (!(await fill(pos, MAX_ENTRY_HEAD))) return bad("pack cannot be read");
    let b = pack.byte(pos++);
    const type = (b >> 4) & 7;
    let size = BigInt(b & 0x0f);
    let shift = 4n;
    while (b & 0x80) {
      if (pos >= pack.size - 20 || shift > 60n) return bad("malformed object header");
      b = pack.byte(pos++);
      size |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    }
    if (!KNOWN_TYPES.has(type)) return bad(`unknown object type ${type}`);
    // The id hash needs the declared size up front; a lie desyncs only this entry's id (index-pack rejects the
    // mismatch), never the byte accounting, which counts actual inflated bytes.
    const hash: Hash | null = type in TYPE_NAME ? createHash("sha1").update(`${TYPE_NAME[type]} ${size}\0`) : null;
    if (type === 6) {
      let n = 0;
      for (;;) {
        if (pos >= pack.size - 20 || ++n > 9) return bad("malformed offset delta");
        b = pack.byte(pos++);
        if (!(b & 0x80)) break;
      }
    } else if (type === 7) {
      if (pos + 20 > pack.size - 20) return bad("truncated ref delta");
      pos += 20;
    }
    const head: Buffer[] = []; // first bytes of the inflated stream, for the delta header
    let headLen = 0;
    const r = await inflateOne(pack, pos, (d) => {
      total += BigInt(d.length);
      hash?.update(d);
      if (headLen < 32) {
        const take = Math.min(d.length, 32 - headLen);
        head.push(d.subarray(0, take));
        headLen += take;
      }
      return total <= cap;
    });
    if (r.kind === "abort") return { ok: false, code: "too_large", message: "pack inflates beyond the size cap" };
    if (r.kind === "bad") return bad(`object ${i + 1} does not inflate`);
    pos += r.consumed;
    if (hash) oids.add(hash.digest("hex"));
    if (type === 6 || type === 7) {
      const h = Buffer.concat(head);
      const src = deltaVarint(h, 0);
      const dst = src && deltaVarint(h, src.next);
      if (!src || !dst) return bad(`malformed ${type === 6 ? "offset" : "ref"} delta header`);
      total += dst.value;
      if (total > cap) return { ok: false, code: "too_large", message: "pack deltas expand beyond the size cap" };
    }
  }
  if (pos !== pack.size - 20) return bad("object count does not match the pack preamble");
  return { ok: true, objects: count, oids };
}
