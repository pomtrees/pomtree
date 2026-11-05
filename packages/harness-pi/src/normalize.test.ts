import { test } from "node:test";
import assert from "node:assert/strict";
import { events } from "./normalize.ts";

async function* oneChunk(text: string): AsyncGenerator<string> {
  yield text;
}

const collect = async (src: AsyncIterable<string>) => {
  const out: any[] = [];
  for await (const e of events(src)) out.push(e);
  return out;
};

test("events: a CRLF-terminated JSON line is parsed, with only the trailing CR stripped", async () => {
  const rec = { type: "message_end", message: { role: "user", content: "go" } };
  const got = await collect(oneChunk(`${JSON.stringify(rec)}\r\n`));
  assert.equal(got.length, 1, `expected exactly one event, got ${JSON.stringify(got)}`);
  assert.equal(got[0].kind, "message", `expected a parsed message, got ${JSON.stringify(got[0])}`);
  assert.equal(got[0].role, "user");
  assert.equal(got[0].text, "go");
});
