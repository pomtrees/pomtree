// Store-only ZIP writer and strict reader (PKWARE APPNOTE 6.3.x subset): method 0, no zip64, no encryption, no data descriptors on write.
// WACZ members are already gzip'd (WARC) or tiny text, and stored entries let a replayer range-read a WARC member in place.
import { crc32 } from "node:zlib";

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const DESCRIPTOR_SIG = 0x08074b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const LIMIT = 0xffffffff;
const UTF8_FLAG = 0x0800;

function checkName(name: string): void {
  if (name === "" || name.startsWith("/") || name.includes("\\") || name.includes("\0") || name.split("/").includes("..")) {
    throw new Error(`zip: unsafe entry name ${JSON.stringify(name)}`);
  }
}

// DOS date/time in UTC so output is deterministic; dates before 1980 clamp to 1980-01-01.
function dosStamp(d: Date): { time: number; date: number } {
  const y = d.getUTCFullYear();
  if (y < 1980) return { time: 0, date: (0 << 9) | (1 << 5) | 1 };
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((Math.min(y, 2107) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export function zipStored(entries: { name: string; data: Uint8Array; mtime?: Date }[]): Uint8Array {
  if (entries.length > 0xffff) throw new Error("zip: more than 65535 entries");
  const seen = new Set<string>();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    checkName(e.name);
    if (seen.has(e.name)) throw new Error(`zip: duplicate entry ${JSON.stringify(e.name)}`);
    seen.add(e.name);
    const name = Buffer.from(e.name, "utf8");
    const size = e.data.byteLength;
    if (size >= LIMIT || offset >= LIMIT) throw new Error("zip: size or offset needs zip64");
    const { time, date } = dosStamp(e.mtime ?? new Date(Date.UTC(1980, 0, 1)));
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL_SIG, 0);
    cd.writeUInt16LE(20, 4);
    local.copy(cd, 6, 4, 30); // version needed .. extra length: identical fields in the same order
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    parts.push(local, name, Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength));
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  if (offset + cdSize >= LIMIT) throw new Error("zip: size or offset needs zip64");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, eocd]);
}

export function readZip(bytes: Uint8Array): { name: string; data: Uint8Array; localOffset: number; dataOffset: number }[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (m: string): never => {
    throw new Error(`zip: ${m}`);
  };
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return fail("no end-of-central-directory record");
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) return fail("zip64 is not supported");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0 || buf.readUInt16LE(eocd + 8) !== count) return fail("multi-disk archive");
  if (count === 0xffff || cdSize === LIMIT || cdOffset === LIMIT) return fail("zip64 is not supported");
  if (cdOffset + cdSize > eocd) return fail("central directory out of bounds");
  const out: { name: string; data: Uint8Array; localOffset: number; dataOffset: number }[] = [];
  const seen = new Set<string>();
  const spans: [number, number][] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== CENTRAL_SIG) return fail(`bad central entry ${n}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const next = nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + next > cdOffset + cdSize) return fail(`central entry ${n} overruns the directory`);
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(p + 46, p + 46 + nlen));
      checkName(name);
    } catch {
      return fail(`unsafe or non-UTF-8 name in entry ${n}`);
    }
    if (seen.has(name)) return fail(`duplicate entry ${JSON.stringify(name)}`);
    seen.add(name);
    if (flags & 1 || flags & 0x40) return fail(`${name} is encrypted`);
    if (method !== 0) return fail(`${name} is compressed (method ${method}); only stored entries are supported`);
    if (csize === LIMIT || usize === LIMIT || localOffset === LIMIT) return fail("zip64 is not supported");
    if (csize !== usize) return fail(`${name} stored sizes disagree`);
    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== LOCAL_SIG) return fail(`${name} has a bad local header`);
    const lname = buf.subarray(localOffset + 30, localOffset + 30 + buf.readUInt16LE(localOffset + 26));
    if (!lname.equals(buf.subarray(p + 46, p + 46 + nlen))) return fail(`${name} local and central names differ`);
    const dataOffset = localOffset + 30 + lname.length + buf.readUInt16LE(localOffset + 28);
    if (dataOffset + usize > cdOffset) return fail(`${name} data out of bounds`);
    if (!(flags & 8) && (buf.readUInt32LE(localOffset + 14) !== crc || buf.readUInt32LE(localOffset + 18) !== csize)) {
      return fail(`${name} local and central headers disagree`);
    }
    const data = buf.subarray(dataOffset, dataOffset + usize);
    if (crc32(data) !== crc) return fail(`${name} CRC mismatch`);
    let end = dataOffset + usize;
    if (flags & 8) end += end + 4 <= cdOffset && buf.readUInt32LE(end) === DESCRIPTOR_SIG ? 16 : 12;
    spans.push([localOffset, end]);
    out.push({ name, data, localOffset, dataOffset });
    p += 46 + next;
  }
  // Every byte must belong to an entry (header + data + descriptor), the central directory, or the EOCD.
  spans.sort((a, b) => a[0] - b[0]);
  let at = 0;
  for (const [start, end] of spans) {
    if (start > at) return fail(`${start - at} unaccounted bytes at offset ${at}`);
    if (start < at) return fail(`entries overlap at offset ${start}`);
    at = end;
  }
  if (at < cdOffset) return fail(`${cdOffset - at} unaccounted bytes at offset ${at}`);
  if (at > cdOffset) return fail(`entries overlap the central directory at offset ${cdOffset}`);
  if (p < cdOffset + cdSize) return fail(`${cdOffset + cdSize - p} unaccounted bytes at offset ${p}`);
  if (cdOffset + cdSize < eocd) return fail(`${eocd - cdOffset - cdSize} unaccounted bytes at offset ${cdOffset + cdSize}`);
  return out;
}
