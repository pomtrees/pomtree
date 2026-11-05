import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEgressAuditReader } from "./fakes.ts";

type Rec = { sandbox: string; sequence: number; host: string };
const rec = (sandbox: string, sequence: number): Rec => ({ sandbox, sequence, host: "h" });

test("discover lists every spool with records or a retained ack, sorted", async () => {
  const r = new FakeEgressAuditReader<Rec>();
  r.setRecords("sb-b", [rec("sb-b", 1)]);
  r.setRecords("sb-a", []);
  await r.ack("sb-c", 3);
  assert.deepEqual(await r.discover(), ["sb-a", "sb-b", "sb-c"]);
});

test("read filters by afterSequence, bounds limit, and returns clones", async () => {
  const r = new FakeEgressAuditReader<Rec>();
  r.setRecords(
    "sb",
    [1, 2, 3, 4].map((s) => rec("sb", s)),
  );
  const page = await r.read("sb", 1, 2);
  assert.deepEqual(
    page.map((x) => x.sequence),
    [2, 3],
  );
  page[0]!.host = "mutated";
  assert.equal((await r.read("sb", 1, 2))[0]!.host, "h");
  await assert.rejects(r.read("sb", 0, 257), /limit must be 1..256/);
  await assert.rejects(r.read("sb", 0, 0), /limit must be 1..256/);
  assert.deepEqual(await r.read("unknown", 0), []);
});

test("ack is recorded and never filters later reads", async () => {
  const r = new FakeEgressAuditReader<Rec>();
  r.setRecords(
    "sb",
    [1, 2, 3].map((s) => rec("sb", s)),
  );
  await r.ack("sb", 2);
  await r.ack("sb", 1);
  assert.equal(r.ackedThrough("sb"), 2, "acks only advance");
  assert.deepEqual(
    (await r.read("sb", 0)).map((x) => x.sequence),
    [1, 2, 3],
  );
});

test("scripted failures apply to the next call of each op, in order, then succeed", async () => {
  const r = new FakeEgressAuditReader<Rec>();
  r.setRecords("sb", [rec("sb", 1)]);
  r.failures.discover.push(new Error("d1"), undefined);
  r.failures.read.push(undefined, new Error("r2"));
  r.failures.ack.push(new Error("a1"));
  await assert.rejects(r.discover(), /d1/);
  assert.deepEqual(await r.discover(), ["sb"]);
  assert.equal((await r.read("sb", 0)).length, 1);
  await assert.rejects(r.read("sb", 0), /r2/);
  await assert.rejects(r.ack("sb", 1), /a1/);
  assert.equal(r.ackedThrough("sb"), 0, "a failed ack records nothing");
  await r.ack("sb", 1);
  assert.equal(r.ackedThrough("sb"), 1);
});

test("calls are observable per op with their arguments, including failed ones", async () => {
  const r = new FakeEgressAuditReader<Rec>();
  r.failures.read.push(new Error("boom"));
  await r.discover();
  await assert.rejects(r.read("sb", 4, 8), /boom/);
  await r.ack("sb", 9);
  assert.deepEqual(r.calls, [{ op: "discover" }, { op: "read", sandbox: "sb", afterSequence: 4, limit: 8 }, { op: "ack", sandbox: "sb", throughSequence: 9 }]);
});

test("append adds one record and stores a clone", async () => {
  const r = new FakeEgressAuditReader<Rec>();
  const x = rec("sb", 1);
  r.append("sb", x);
  x.host = "changed";
  assert.equal((await r.read("sb", 0))[0]!.host, "h");
});
