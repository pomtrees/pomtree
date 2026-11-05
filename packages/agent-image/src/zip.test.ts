import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readZip, zipStored } from "./zip.ts";

const b = (s: string) => Buffer.from(s);

test("single stored entry has the hand-computed layout and CRC", () => {
  const z = Buffer.from(zipStored([{ name: "a.txt", data: b("hello") }]));
  assert.equal(z.length, 30 + 5 + 5 + 46 + 5 + 22);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.equal(z.readUInt16LE(6), 0x0800); // UTF-8 name flag
  assert.equal(z.readUInt16LE(8), 0); // stored
  assert.equal(z.readUInt32LE(14), 0x3610a686); // CRC32("hello")
  assert.equal(z.readUInt32LE(18), 5);
  assert.equal(z.readUInt32LE(22), 5);
  assert.equal(z.subarray(30, 35).toString(), "a.txt");
  assert.equal(z.subarray(35, 40).toString(), "hello");
  assert.equal(z.readUInt32LE(40), 0x02014b50); // central directory right after the data
  assert.equal(z.readUInt32LE(40 + 42), 0); // its local offset
  const eocd = z.length - 22;
  assert.equal(z.readUInt32LE(eocd), 0x06054b50);
  assert.equal(z.readUInt16LE(eocd + 10), 1);
  assert.equal(z.readUInt32LE(eocd + 12), 51); // central size
  assert.equal(z.readUInt32LE(eocd + 16), 40); // central offset
  const [r] = readZip(z);
  assert.equal(r?.name, "a.txt");
  assert.equal(r?.localOffset, 0);
  assert.equal(r?.dataOffset, 35);
  assert.equal(Buffer.from(r?.data ?? []).toString(), "hello");
});

test("output is deterministic for a fixed mtime and the DOS stamp is UTC", () => {
  const mtime = new Date(Date.UTC(2026, 9, 24, 12, 34, 56));
  const a = zipStored([{ name: "x/y.txt", data: b("1"), mtime }]);
  assert.deepEqual(a, zipStored([{ name: "x/y.txt", data: b("1"), mtime }]));
  const z = Buffer.from(a);
  assert.equal(z.readUInt16LE(10), (12 << 11) | (34 << 5) | 28);
  assert.equal(z.readUInt16LE(12), ((2026 - 1980) << 9) | (10 << 5) | 24);
});

test("multiple entries, UTF-8 names and empty data round-trip with offsets", () => {
  const z = zipStored([
    { name: "one", data: b("1") },
    { name: "dír/é.txt", data: b("") },
    { name: "three", data: Buffer.alloc(1000, 7) },
  ]);
  const r = readZip(z);
  assert.deepEqual(
    r.map((e) => [e.name, e.data.byteLength, e.localOffset]),
    [
      ["one", 1, 0],
      ["dír/é.txt", 0, 30 + 3 + 1],
      ["three", 1000, 34 + 30 + Buffer.byteLength("dír/é.txt")],
    ],
  );
});

test("writer refusals", () => {
  const d = b("x");
  assert.throws(
    () =>
      zipStored([
        { name: "a", data: d },
        { name: "a", data: d },
      ]),
    /duplicate/,
  );
  for (const name of ["../a", "a/../b", "/abs", "a\\b", ""]) assert.throws(() => zipStored([{ name, data: d }]), /unsafe/, name);
  assert.throws(() => zipStored(Array.from({ length: 65536 }, (_, i) => ({ name: `f${i}`, data: d }))), /65535/);
});

test("reader refuses tampering, compression, zip64 and junk", () => {
  const good = Buffer.from(zipStored([{ name: "a.txt", data: b("hello") }]));
  const mut = (f: (z: Buffer) => void) => {
    const z = Buffer.from(good);
    f(z);
    return z;
  };
  assert.throws(() => readZip(mut((z) => z.writeUInt8(0x78, 35))), /CRC/);
  assert.throws(() => readZip(mut((z) => z.writeUInt16LE(8, 50))), /compressed/); // central method
  assert.throws(() => readZip(mut((z) => z.writeUInt16LE(1, 48))), /encrypted/); // central flags
  assert.throws(() => readZip(mut((z) => z.writeUInt32LE(0xffffffff, 40 + 20))), /zip64|sizes/);
  assert.throws(() => readZip(mut((z) => z.writeUInt32LE(1, 14))), /disagree|CRC/); // local crc differs from central
  assert.throws(() => readZip(mut((z) => z.writeUInt8(0x62, 30))), /names differ/);
  assert.throws(() => readZip(mut((z) => z.writeUInt32LE(0, 0))), /local header/);
  assert.throws(() => readZip(good.subarray(0, good.length - 1)), /end-of-central/);
  assert.throws(() => readZip(b("tiny")), /end-of-central/);
  assert.throws(() => readZip(mut((z) => z.writeUInt32LE(900, z.length - 6))), /out of bounds/);
});

// Inserts n junk bytes at pos and patches every later local offset and the EOCD's directory offset, so only the junk itself is wrong.
function insertJunk(z: Buffer, pos: number, n: number): Buffer {
  const out = Buffer.concat([z.subarray(0, pos), Buffer.alloc(n, 0x58), z.subarray(pos)]);
  const eocd = out.length - 22;
  const count = out.readUInt16LE(eocd + 10);
  const cdOffset = out.readUInt32LE(eocd + 16) + (pos <= out.readUInt32LE(eocd + 16) ? n : 0);
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    const lo = out.readUInt32LE(p + 42);
    if (lo >= pos) out.writeUInt32LE(lo + n, p + 42);
    p += 46 + out.readUInt16LE(p + 28) + out.readUInt16LE(p + 30) + out.readUInt16LE(p + 32);
  }
  out.writeUInt32LE(cdOffset, eocd + 16);
  return out;
}

test("reader refuses bytes that belong to no entry", () => {
  const two = Buffer.from(
    zipStored([
      { name: "a", data: b("1") },
      { name: "b", data: b("2") },
    ]),
  );
  assert.equal(readZip(two).length, 2); // the untouched archive still reads
  assert.throws(() => readZip(insertJunk(two, 0, 7)), /zip: 7 unaccounted bytes at offset 0$/); // prepended
  assert.throws(() => readZip(insertJunk(two, 32, 5)), /zip: 5 unaccounted bytes at offset 32$/); // between entries
  assert.throws(() => readZip(insertJunk(two, 64, 3)), /zip: 3 unaccounted bytes at offset 64$/); // before the central directory
  const cdEnd = two.length - 22;
  assert.throws(() => readZip(insertJunk(two, cdEnd, 4)), /zip: 4 unaccounted bytes at offset 158$/); // between directory and EOCD
  assert.throws(() => readZip(Buffer.concat([two, b("tail")])), /end-of-central/); // after the EOCD
});

test("unzip -t accepts the archive", {
  skip: (() => {
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore", timeout: 10000 });
      return false;
    } catch {
      return "unzip is not installed";
    }
  })(),
}, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "zip-test-")));
  try {
    const f = join(dir, "t.zip");
    writeFileSync(
      f,
      zipStored([
        { name: "a.txt", data: b("hello") },
        { name: "d/é.bin", data: Buffer.alloc(300, 1) },
        { name: "empty", data: b("") },
      ]),
    );
    const out = execFileSync("unzip", ["-t", f], { encoding: "utf8", timeout: 30000 });
    assert.match(out, /No errors detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
