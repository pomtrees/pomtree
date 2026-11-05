import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { tmpDir } from "@pomtree/testing";
import { bufferSource, fileSource, SCAN_WINDOW_BYTES, scanPack, type PackSource } from "./pack-scan.ts";

// Object entry header: type in bits 4-6 of the first byte, then the size little-endian (4 bits, then 7-bit groups).
function entryHead(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push((b | 0x80) & 0xff);
    b = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(b & 0xff);
  return Buffer.from(bytes);
}

// `mid` carries what sits between the header and the zlib stream: a 20-byte base id (ref delta) or an offset varint.
function entry(type: number, content: Buffer, mid?: Buffer): Buffer {
  return Buffer.concat([entryHead(type, content.length), ...(mid ? [mid] : []), deflateSync(content)]);
}

// Delta-header varint: 7-bit little-endian groups, low group first.
function dv(n: bigint): Buffer {
  const bytes: number[] = [];
  let v = n;
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      bytes.push(b);
      break;
    }
    bytes.push(b | 0x80);
  }
  return Buffer.from(bytes);
}

function buildPack(entries: Buffer[], declaredCount = entries.length): Buffer {
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "latin1");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(declaredCount, 8);
  const body = Buffer.concat([head, ...entries]);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

test("scanPack accepts a small valid pack, counts its objects and names the non-delta ones", async () => {
  const blobOid = createHash("sha1").update("blob 5\0hello").digest("hex");
  const commitOid = createHash("sha1").update("commit 7\0tree 0\n").digest("hex");
  const pack = buildPack([entry(3, Buffer.from("hello")), entry(1, Buffer.from("tree 0\n"))]);
  const r = await scanPack(pack, { maxInflatedBytes: 1000 });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.objects, 2);
    assert.deepEqual(r.oids, new Set([blobOid, commitOid]));
  }
});

test("scanPack refuses a zlib bomb: tiny compressed entry, huge inflation", async () => {
  const bomb = entry(3, Buffer.alloc(20 * 1024 * 1024)); // zeros: ~20 MB inflated, ~20 KB compressed
  assert.ok(bomb.length < 100 * 1024);
  const r = await scanPack(buildPack([bomb]), { maxInflatedBytes: 1 << 20 });
  assert.deepEqual(r, { ok: false, code: "too_large", message: "pack inflates beyond the size cap" });
  const ok = await scanPack(buildPack([bomb]), { maxInflatedBytes: 32 * 1024 * 1024 });
  assert.equal(ok.ok, true);
});

test("scanPack refuses a delta whose header declares a huge result size", async () => {
  // copy opcodes are never reached: the declared result size alone busts the cap
  const delta = Buffer.concat([dv(1n), dv(1n << 40n), Buffer.from([0x91, 0x00, 0x01])]);
  const r = await scanPack(buildPack([entry(7, delta, Buffer.alloc(20))]), { maxInflatedBytes: 1 << 20 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "too_large");
});

test("scanPack walks ref and offset deltas and counts their result sizes against the cap", async () => {
  const small = Buffer.concat([dv(5n), dv(5n), Buffer.from([0x90, 0x05])]); // result: copy 5 bytes of the base
  const pack = buildPack([
    entry(3, Buffer.from("hello")),
    entry(7, small, Buffer.alloc(20)),
    entry(6, small, Buffer.from([0x90, 0x0e])), // any well-formed offset varint; resolution is index-pack's job
  ]);
  const r = await scanPack(pack, { maxInflatedBytes: 1000 });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.objects, 3);
    assert.deepEqual([...r.oids], [createHash("sha1").update("blob 5\0hello").digest("hex")]); // deltas are not named
  }
  const tight = await scanPack(pack, { maxInflatedBytes: 14 }); // 5 + 5 + (5 + 5 result sizes) = 20 > 14
  assert.equal(tight.ok, false);
  if (!tight.ok) assert.equal(tight.code, "too_large");
});

test("scanPack refuses malformed packs: no signature, bad type, truncated stream, wrong count, trailing junk", async () => {
  const cap = { maxInflatedBytes: 1 << 20 };
  for (const pack of [
    Buffer.alloc(64), // no PACK signature
    buildPack([entry(5, Buffer.from("x"))]), // type 5 is reserved
    Buffer.from(buildPack([entry(3, randomBytes(200))]).subarray(0, 100)), // truncated mid-stream
    buildPack([entry(3, Buffer.from("a")), entry(3, Buffer.from("b"))], 1), // more objects than declared
    buildPack([entry(3, Buffer.from("a"))], 2), // fewer objects than declared
    Buffer.concat([buildPack([entry(3, Buffer.from("a"))]), Buffer.from("junk")]), // trailing bytes
  ]) {
    const r = await scanPack(Buffer.from(pack), cap);
    assert.equal(r.ok, false, JSON.stringify(r));
    if (!r.ok) assert.equal(r.code, "bad_bundle");
  }
  const badDelta = buildPack([entry(7, Buffer.from([0x81]), Buffer.alloc(20))]); // delta header varint never terminates
  const r = await scanPack(Buffer.from(badDelta), cap);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "bad_bundle");
});

// A source that records every read, for peak-residency accounting (C2b-12: the scan must not buffer the pack).
function recording(b: Buffer): PackSource & { maxRead: number; totalRead: number } {
  const src = bufferSource(b);
  const rec = {
    size: src.size,
    maxRead: 0,
    totalRead: 0,
    async read(pos: number, len: number) {
      rec.maxRead = Math.max(rec.maxRead, len);
      rec.totalRead += len;
      return Buffer.from(await src.read(pos, len)); // a copy: the scan cannot lean on the backing buffer
    },
  };
  return rec;
}

// 2,000 small incompressible blobs plus one 8 MiB blob whose zlib stream spans many windows.
function largePack(): Buffer {
  const entries: Buffer[] = [];
  for (let i = 0; i < 2000; i++) entries.push(entry(3, randomBytes(1000 + (i % 7) * 300)));
  entries.push(entry(3, randomBytes(8 * 1024 * 1024)));
  return buildPack(entries);
}

test("scanPack reads a large pack in bounded windows (peak read <= SCAN_WINDOW_BYTES, each byte about once) with the same result as a buffer", async () => {
  const pack = largePack();
  assert.ok(pack.length > 10 * 1024 * 1024);
  const cap = { maxInflatedBytes: 64 * 1024 * 1024 };
  const src = recording(pack);
  const streamed = await scanPack(src, cap);
  const whole = await scanPack(pack, cap);
  assert.equal(streamed.ok, true, JSON.stringify(streamed));
  assert.deepEqual(streamed, whole);
  if (streamed.ok) assert.equal(streamed.objects, 2001);
  assert.ok(src.maxRead <= SCAN_WINDOW_BYTES, `peak read ${src.maxRead}`);
  assert.ok(src.totalRead < pack.length * 1.01 + SCAN_WINDOW_BYTES, `read ${src.totalRead} bytes of a ${pack.length}-byte pack`);
  // a cap the big blob busts is refused through the source too, and stops reading early
  const tight = recording(pack);
  assert.deepEqual(await scanPack(tight, { maxInflatedBytes: 4 * 1024 * 1024 }), {
    ok: false,
    code: "too_large",
    message: "pack inflates beyond the size cap",
  });
  assert.ok(tight.totalRead < pack.length);
});

test("scanPack over a file: fileSource reads from an offset inside the file (the bundle header precedes the pack)", async () => {
  const pack = largePack();
  const dir = tmpDir("packscan-");
  const file = join(dir, "in.bundle");
  const prefix = Buffer.from("# v2 git bundle\nfake header\n\n");
  writeFileSync(file, Buffer.concat([prefix, pack]));
  const fh = await open(file, "r");
  try {
    const r = await scanPack(fileSource(fh, prefix.length, pack.length), { maxInflatedBytes: 64 * 1024 * 1024 });
    assert.deepEqual(r, await scanPack(pack, { maxInflatedBytes: 64 * 1024 * 1024 }));
    // a source that claims more bytes than the file holds is a read failure, refused as bad_bundle
    const short = await scanPack(fileSource(fh, prefix.length, pack.length + 4096), { maxInflatedBytes: 64 * 1024 * 1024 });
    assert.equal(short.ok, false);
    if (!short.ok) assert.equal(short.code, "bad_bundle");
  } finally {
    await fh.close();
  }
});

test("scanPack through a source refuses the same malformed packs and bombs as the buffer path", async () => {
  const cap = { maxInflatedBytes: 1 << 20 };
  for (const pack of [
    Buffer.alloc(64),
    buildPack([entry(5, Buffer.from("x"))]),
    Buffer.from(buildPack([entry(3, randomBytes(200))]).subarray(0, 100)),
    buildPack([entry(3, Buffer.from("a")), entry(3, Buffer.from("b"))], 1),
    buildPack([entry(3, Buffer.from("a"))], 2),
    Buffer.concat([buildPack([entry(3, Buffer.from("a"))]), Buffer.from("junk")]),
    buildPack([entry(7, Buffer.from([0x81]), Buffer.alloc(20))]),
    buildPack([entry(3, randomBytes(300 * 1024))]).subarray(0, 200 * 1024), // truncated across a window boundary
  ]) {
    const r = await scanPack(recording(Buffer.from(pack)), cap);
    assert.equal(r.ok, false, JSON.stringify(r));
    if (!r.ok) assert.equal(r.code, "bad_bundle");
  }
  const bomb = buildPack([entry(3, Buffer.alloc(20 * 1024 * 1024))]);
  assert.deepEqual(await scanPack(recording(bomb), cap), { ok: false, code: "too_large", message: "pack inflates beyond the size cap" });
});

test("scanPack: a zlib stream that ends exactly on a window boundary still finds the next object", async () => {
  // stored (level 0) deflate has a predictable length; pick the content size that ends the first entry at the boundary
  let first: Buffer | undefined;
  for (let n = SCAN_WINDOW_BYTES - 200; n < SCAN_WINDOW_BYTES; n++) {
    const content = Buffer.alloc(n, 7);
    const e = Buffer.concat([entryHead(3, n), deflateSync(content, { level: 0 })]);
    if (12 + e.length === SCAN_WINDOW_BYTES) first = e;
  }
  assert.ok(first, "no content size lands the entry on the boundary");
  const pack = buildPack([first, entry(3, Buffer.from("next")), entry(1, Buffer.from("tree 0\n"))]);
  const src = recording(pack);
  const r = await scanPack(src, { maxInflatedBytes: 1 << 20 });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (r.ok) {
    assert.equal(r.objects, 3);
    assert.ok(r.oids.has(createHash("sha1").update("blob 4\0next").digest("hex")));
  }
});
