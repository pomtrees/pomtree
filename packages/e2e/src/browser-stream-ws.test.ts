import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServerFrames, WS_OPCODE } from "./browser-stream-ws.ts";

const frame = (b0: number, payload: Buffer) => {
  const head = payload.length < 126 ? Buffer.from([b0, payload.length]) : Buffer.from([b0, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([head, payload]);
};

test("browser-stream ws parser: text and binary messages, a 16-bit length, a continuation and a split frame", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(300, 7)]);
  const all = Buffer.concat([frame(0x81, Buffer.from('{"type":"status"}')), frame(0x82, jpeg), frame(0x02, Buffer.from("ab")), frame(0x80, Buffer.from("cd"))]);
  const whole = parseServerFrames(all);
  assert.deepEqual(
    whole.messages.map((m) => [m.opcode, m.payload.length]),
    [
      [WS_OPCODE.text, 17],
      [WS_OPCODE.binary, 303],
      [WS_OPCODE.binary, 4],
    ],
  );
  assert.equal(whole.messages[1]!.payload.subarray(0, 3).toString("hex"), "ffd8ff");
  assert.equal(whole.rest.length, 0);
  // Negative: a truncated frame yields nothing and keeps its bytes for the next read.
  const cut = parseServerFrames(all.subarray(0, 25));
  assert.equal(cut.messages.length, 1);
  assert.ok(cut.rest.length > 0);
  assert.throws(() => parseServerFrames(frame(0x80, Buffer.from("x"))), /continuation/);
});
