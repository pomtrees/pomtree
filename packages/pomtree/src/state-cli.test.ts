import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT, run } from "./cli.ts";
import type { Io } from "./cli.ts";
import { TransportError } from "./client.ts";
import type { Call, Reply } from "./client.ts";
import { harness as kitHarness } from "./test-kit.ts";

const harness = (handler: (c: Call) => Reply | Promise<Reply>, extra: Partial<Io> = {}) => kitHarness(handler, { sleep: async () => {}, ...extra });

const tmp = () => mkdtempSync(join(tmpdir(), "pomtree-state-"));
const doc = { owner: "hn-digest", key: "seen/a", rev: 3, bytes: 7, value: { n: 1 }, createdAt: 0, updatedAt: Date.now(), writer: { operator: true } };

test("state ls: operator lists an owner, passes prefix/limit, prints a table and the next marker", async () => {
  const h = harness(() => ({ status: 200, body: { docs: [{ ...doc }], next: "seen/a" } }));
  assert.equal(await run(["state", "ls", "--owner", "hn-digest", "--prefix", "seen/", "--limit", "5"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/state?owner=hn-digest&prefix=seen%2F&limit=5");
  assert.match(h.out[0]!, /KEY[\s\S]*seen\/a[\s\S]*more after seen\/a/);
});

test("state ls --after continues from the printed marker; it needs --owner and a valid key", async () => {
  const h = harness(() => ({ status: 200, body: { docs: [{ ...doc }] } }));
  assert.equal(await run(["state", "ls", "--owner", "hn-digest", "--after", "seen/a", "--limit", "5"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/state?owner=hn-digest&after=seen%2Fa&limit=5");
  for (const argv of [
    ["ls", "--after", "seen/a"],
    ["ls", "--owner", "o", "--after", "A/../b"],
  ]) {
    const b = harness(() => ({ status: 200, body: {} }));
    assert.equal(await run(["state", ...argv], b.io), EXIT.usage, argv.join(" "));
    assert.equal(b.calls.length, 0);
  }
});

test("state ls: agent without --owner gets the readable owners", async () => {
  const h = harness(() => ({ status: 200, body: { owners: ["hn-digest", "operator"] } }));
  assert.equal(await run(["state", "ls"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/state?");
  assert.deepEqual(h.out, ["hn-digest\noperator"]);
});

test("state show: sanitizes value text; --json passes the doc through", async () => {
  const evil = { ...doc, value: { t: "x\u001b]0;pwn\u0007y\u001b[2Jz" } };
  const h = harness(() => ({ status: 200, body: { doc: evil } }));
  assert.equal(await run(["state", "show", "hn-digest", "seen/a"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/state/doc?owner=hn-digest&key=seen%2Fa");
  assert.ok(!h.out[0]!.includes("\u001b"));
  assert.match(h.out[0]!, /rev 3/);
  const j = harness(() => ({ status: 200, body: { doc } }));
  assert.equal(await run(["state", "show", "hn-digest", "seen/a", "--json"], j.io), EXIT.ok);
  assert.deepEqual(JSON.parse(j.out[0]!), doc);
});

test("state: local validation rejects bad owner/key/prefix before any call", async () => {
  for (const argv of [
    ["show", "Bad", "k"],
    ["show", "o", "a/../b"],
    ["ls", "--owner", "o", "--prefix", ".."],
    ["rm", "o", "A"],
    ["import", "O", "f"],
  ]) {
    const h = harness(() => ({ status: 200, body: {} }));
    assert.equal(await run(["state", ...argv], h.io), EXIT.usage, argv.join(" "));
    assert.equal(h.calls.length, 0);
  }
});

test("state put: JSON arg or --file, expect-rev none/number", async () => {
  const dir = tmp();
  try {
    const f = join(dir, "v.json");
    writeFileSync(f, '{"a":[1]}');
    const h = harness(() => ({ status: 200, body: { doc } }));
    assert.equal(await run(["state", "put", "o", "k", '{"x":1}', "--expect-rev", "none", "--key", "K1"], h.io), EXIT.ok);
    assert.deepEqual(h.calls[0], {
      method: "PUT",
      path: "/v1/state/doc",
      body: { owner: "o", key: "k", value: { x: 1 }, expectRev: null, idempotencyKey: "K1" },
    });
    assert.equal(await run(["state", "put", "o", "k", "--file", f, "--expect-rev", "2"], h.io), EXIT.ok);
    assert.deepEqual((h.calls[1]!.body as { value: unknown; expectRev: number }).value, { a: [1] });
    assert.equal((h.calls[1]!.body as { expectRev: number }).expectRev, 2);
    assert.equal(await run(["state", "put", "o", "k", "{bad"], h.io), EXIT.usage);
    assert.equal(await run(["state", "put", "o", "k"], h.io), EXIT.usage);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state put: 409 conflict shows currentRev and exits 5", async () => {
  const h = harness(() => ({ status: 409, body: { error: "state revision conflict", reason: "conflict", currentRev: 9 } }));
  assert.equal(await run(["state", "put", "o", "k", "1", "--expect-rev", "2"], h.io), EXIT.conflict);
  assert.match(h.err[0]!, /current rev is 9/);
});

test("state rm: confirm, --yes, abort, flag combinations", async () => {
  const ok = () => ({ status: 200, body: { removed: 2, keys: ["a", "b"] } });
  const asked: string[] = [];
  const h = harness(ok, {
    confirm: async (q) => {
      asked.push(q);
      return true;
    },
  });
  assert.equal(await run(["state", "rm", "o", "--prefix", "memo/", "--older-than", "30d", "--key", "K"], h.io), EXIT.ok);
  assert.match(asked[0]!, /every document under o\/memo\/ not updated for 30d/);
  assert.deepEqual(h.calls[0]!.body, { owner: "o", prefix: "memo/", olderThanMs: 30 * 86_400_000, idempotencyKey: "K" });
  assert.deepEqual(h.out, ["removed 2 documents"]);

  const no = harness(ok, { confirm: async () => false });
  assert.equal(await run(["state", "rm", "o", "k"], no.io), EXIT.ok);
  assert.equal(no.calls.length, 0);
  assert.deepEqual(no.out, ["aborted"]);

  const noTty = harness(ok);
  assert.equal(await run(["state", "rm", "o", "k"], noTty.io), EXIT.usage);
  assert.match(noTty.err[0]!, /--yes/);
  assert.equal(noTty.calls.length, 0);

  const y = harness(ok);
  assert.equal(await run(["state", "rm", "o", "k", "--yes", "--expect-rev", "4"], y.io), EXIT.ok);
  assert.equal((y.calls[0]!.body as { key: string; expectRev: number }).expectRev, 4);
  assert.equal(typeof (y.calls[0]!.body as { idempotencyKey: string }).idempotencyKey, "string");

  for (const argv of [
    ["rm", "o", "k", "--prefix", "p", "--yes"],
    ["rm", "o", "--yes"],
    ["rm", "o", "k", "--older-than", "1d", "--yes"],
    ["rm", "o", "--prefix", "p", "--expect-rev", "1", "--yes"],
  ]) {
    const b = harness(ok);
    assert.equal(await run(["state", ...argv], b.io), EXIT.usage, argv.join(" "));
    assert.equal(b.calls.length, 0);
  }
});

test("state mutation: one idempotency key per invocation, reused across a transport retry", async () => {
  let n = 0;
  const h = harness(() => {
    if (++n < 3) throw new TransportError("cannot reach pomtreed: reset");
    return { status: 200, body: { removed: 1, keys: ["k"] } };
  });
  assert.equal(await run(["state", "rm", "o", "k", "--yes"], h.io), EXIT.ok);
  assert.equal(h.calls.length, 3);
  const keys = new Set(h.calls.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey));
  assert.equal(keys.size, 1);
  const again = harness(() => ({ status: 200, body: { removed: 1, keys: ["k"] } }));
  await run(["state", "rm", "o", "k", "--yes"], again.io);
  assert.notEqual((again.calls[0]!.body as { idempotencyKey: string }).idempotencyKey, [...keys][0]);
  // reads are not retried
  const r = harness(() => {
    throw new TransportError("down");
  });
  assert.equal(await run(["state", "show", "o", "k"], r.io), EXIT.unreachable);
  assert.equal(r.calls.length, 1);
});

test("state: each error status prints a useful message and maps to an exit code", async () => {
  const cases: [number, object, number, RegExp][] = [
    [400, { error: "invalid state key" }, EXIT.usage, /invalid state key/],
    [401, { error: "unauthorized" }, EXIT.denied, /unauthorized[\s\S]*token missing/],
    [403, { error: "no write grant for hn-digest" }, EXIT.denied, /no write grant/],
    [404, { error: "no such state document" }, EXIT.notFound, /no such state document/],
    [409, { error: "quota exceeded", kind: "quota" }, EXIT.conflict, /quota exceeded \(quota\)/],
    [413, { error: "document too large", kind: "too-large" }, EXIT.usage, /too large/],
    [503, { error: "store down" }, EXIT.error, /unavailable/],
  ];
  for (const [status, body, code, re] of cases) {
    const h = harness(() => ({ status, body }));
    assert.equal(await run(["state", "show", "o", "k"], h.io), code, String(status));
    assert.match(h.err.join("\n"), re);
  }
});

test("state export -> import round trip into a fake store", async () => {
  const store = new Map<string, { value: unknown; rev: number }>([
    ["seen/a", { value: { n: 1 }, rev: 4 }],
    ["memo/x", { value: "s", rev: 2 }],
  ]);
  const dest = new Map<string, unknown>();
  const handler = (c: Call): Reply => {
    if (c.method === "GET" && c.path.startsWith("/v1/state/export")) {
      const prefix = new URL(`http://x${c.path}`).searchParams.get("prefix") ?? "";
      return {
        status: 200,
        body: { owner: "src", docs: [...store].filter(([k]) => k.startsWith(prefix)).map(([key, d]) => ({ key, rev: d.rev, value: d.value })) },
      };
    }
    if (c.method === "POST" && c.path === "/v1/state/import") {
      const b = c.body as { owner: string; docs: { key: string; value: unknown }[] };
      for (const d of b.docs) dest.set(`${b.owner}/${d.key}`, d.value);
      return { status: 200, body: { imported: b.docs.length } };
    }
    return { status: 404, body: { error: "not found" } };
  };
  const dir = tmp();
  try {
    const file = join(dir, "x.json");
    const h = harness(handler);
    assert.equal(await run(["state", "export", "src", "--out", file], h.io), EXIT.ok);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).docs.length, 2);
    assert.equal(await run(["state", "import", "dst", file, "--key", "I1"], h.io), EXIT.ok);
    assert.deepEqual(h.calls[1]!.body, {
      owner: "dst",
      docs: [
        { key: "seen/a", value: { n: 1 } },
        { key: "memo/x", value: "s" },
      ],
      idempotencyKey: "I1",
    });
    assert.deepEqual(
      [...dest],
      [
        ["dst/seen/a", { n: 1 }],
        ["dst/memo/x", "s"],
      ],
    );
    // stdout export with a prefix
    const s = harness(handler);
    assert.equal(await run(["state", "export", "src", "--prefix", "seen/"], s.io), EXIT.ok);
    assert.deepEqual(JSON.parse(s.out[0]!).docs, [{ key: "seen/a", rev: 4, value: { n: 1 } }]);
    // bad import files are usage errors with no call
    writeFileSync(file, '{"docs":[]}');
    const b = harness(handler);
    assert.equal(await run(["state", "import", "dst", file], b.io), EXIT.usage);
    assert.equal(b.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state: help lists the verbs and an unknown subcommand is a usage error", async () => {
  const h = harness(() => ({ status: 200, body: {} }));
  assert.equal(await run(["state", "bogus"], h.io), EXIT.usage);
  assert.match(h.err[0]!, /usage: pomtree state ls/);
  assert.match(h.err[0]!, /state rm OWNER KEY/);
});

test("state rm --expect-rev none is a usage error with no call; 0 and numbers are sent", async () => {
  const h = harness(() => ({ status: 200, body: { removed: 0, keys: [] } }));
  assert.equal(await run(["state", "rm", "o", "k", "--yes", "--expect-rev", "none"], h.io), EXIT.usage);
  assert.match(h.err[0]!, /--expect-rev/);
  assert.equal(h.calls.length, 0);
  assert.equal(await run(["state", "rm", "o", "k", "--yes", "--expect-rev", "0"], h.io), EXIT.ok);
  assert.equal((h.calls[0]!.body as { expectRev: number }).expectRev, 0);
});

test("state import: a large file goes out in batches under the body limit, each with a derived stable key; a refusal part way says how far it got", async () => {
  const dir = tmp();
  try {
    const file = join(dir, "big.json");
    const docs = Array.from({ length: 12 }, (_, i) => ({ key: `k${String(i).padStart(2, "0")}`, value: "x".repeat(200 * 1024) }));
    writeFileSync(file, JSON.stringify({ docs }));
    const h = harness((c) => ({ status: 200, body: { imported: (c.body as { docs: unknown[] }).docs.length } }));
    assert.equal(await run(["state", "import", "o", file, "--key", "K"], h.io), EXIT.ok);
    const bodies = h.calls.map((c) => c.body as { docs: { key: string }[]; idempotencyKey: string });
    assert.ok(bodies.length > 1);
    for (const b of bodies) assert.ok(Buffer.byteLength(JSON.stringify(b)) < 1 << 20, "every request body fits the daemon's limit");
    assert.deepEqual(
      bodies.flatMap((b) => b.docs.map((d) => d.key)),
      docs.map((d) => d.key),
      "every doc sent once, in order",
    );
    assert.deepEqual(
      bodies.map((b) => b.idempotencyKey),
      bodies.map((_, i) => `K:b${i}`),
    );
    assert.deepEqual(h.out, ["imported 12 documents into o"]);
    // the same --key sends the same derived keys (a re-run replays finished batches)
    const again = harness((c) => ({ status: 200, body: { imported: (c.body as { docs: unknown[] }).docs.length } }));
    await run(["state", "import", "o", file, "--key", "K"], again.io);
    assert.deepEqual(
      again.calls.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey),
      bodies.map((b) => b.idempotencyKey),
    );
    // refusal on the second batch: exit non-zero, the message says how many documents were already written and how to resume
    let n = 0;
    const fail = harness((c) =>
      ++n === 2
        ? { status: 409, body: { error: "quota", kind: "quota-docs" } }
        : { status: 200, body: { imported: (c.body as { docs: unknown[] }).docs.length } },
    );
    assert.notEqual(await run(["state", "import", "o", file, "--key", "K"], fail.io), EXIT.ok);
    assert.match(fail.err.join("\n"), /already imported[\s\S]*--key K/);
    // a small file is still one request under the plain key
    const small = join(dir, "small.json");
    writeFileSync(small, JSON.stringify({ docs: [{ key: "a", value: 1 }] }));
    const one = harness(() => ({ status: 200, body: { imported: 1 } }));
    assert.equal(await run(["state", "import", "o", small, "--key", "K"], one.io), EXIT.ok);
    assert.equal(one.calls.length, 1);
    assert.equal((one.calls[0]!.body as { idempotencyKey: string }).idempotencyKey, "K");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
