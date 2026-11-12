import assert from "node:assert/strict";
import { test } from "node:test";
import { type CredentialTransport, DEFAULT_SECRET_DIR, deliverCredential } from "./credential-channel.ts";

// The env var name is built from parts: the whole token is not written in tracked files until the rename commit.
const TOKEN = ["POMTREE", "API", "TOKEN"].join("_");
const PATH = `${DEFAULT_SECRET_DIR}/${TOKEN.toLowerCase()}`;
const SECRET = "tok-secret-value-1234";

// A fake sandbox filesystem. `put` is deliberately non-atomic (create empty, then fill), so a writer that targets the
// final path exposes an empty file at the step between; `onStep` lets a reader look at the target at every step.
class FakeFs implements CredentialTransport {
  files = new Map<string, { bytes: string; mode: number }>();
  ops: string[] = [];
  seen: (string | undefined)[] = [];
  failPutOn: string | undefined;
  failRename = false;
  putHook: (() => Error | undefined) | undefined;
  failRemove: (path: string) => boolean = () => false;
  watch: string;
  constructor(watch: string) {
    this.watch = watch;
  }
  private step(op: string) {
    this.ops.push(op);
    this.seen.push(this.files.get(this.watch)?.bytes);
  }
  async put(path: string, bytes: Uint8Array, mode: number) {
    const hook = this.putHook?.();
    if (hook) throw hook;
    if (this.failPutOn !== undefined && path.includes(this.failPutOn)) throw new Error(`write refused, body was ${new TextDecoder().decode(bytes)}`);
    this.files.set(path, { bytes: "", mode });
    this.step(`create ${path}`);
    this.files.set(path, { bytes: new TextDecoder().decode(bytes), mode });
    this.step(`write ${path}`);
  }
  async rename(from: string, to: string) {
    if (this.failRename) throw new Error("rename refused");
    const f = this.files.get(from);
    assert.ok(f, `rename of missing ${from}`);
    this.files.delete(from);
    this.files.set(to, f);
    this.step(`rename ${from} ${to}`);
  }
  async remove(path: string) {
    if (this.failRemove(path)) throw new Error("remove refused");
    this.files.delete(path);
    this.step(`remove ${path}`);
  }
}

const opts = (fs: FakeFs, over: Partial<Parameters<typeof deliverCredential>[0]> = {}) => ({
  transport: fs,
  name: TOKEN,
  value: SECRET,
  mode: 0o400,
  path: PATH,
  ...over,
});

test("delivers into a 0400 file and returns the <NAME>_FILE variable name", async () => {
  const fs = new FakeFs(PATH);
  const h = await deliverCredential(opts(fs));
  assert.equal(h.envName, `${TOKEN}_FILE`);
  assert.equal(h.path, PATH);
  assert.deepEqual(fs.files.get(PATH), { bytes: SECRET, mode: 0o400 });
  assert.deepEqual([...fs.files.keys()], [PATH], "no temp file is left behind");
  assert.equal(JSON.stringify(h).includes(SECRET), false);
});

test("rotation is atomic: a reader never sees an empty or partial target, and the ops are write temp then rename", async () => {
  const fs = new FakeFs(PATH);
  const h = await deliverCredential(opts(fs));
  fs.ops.length = 0;
  fs.seen.length = 0;
  await h.rotate("new-value-5678");
  assert.equal(fs.ops.length, 3);
  assert.match(fs.ops[0] ?? "", /^create .*\.tmp-/);
  assert.match(fs.ops[1] ?? "", /^write .*\.tmp-/);
  assert.match(fs.ops[2] ?? "", /^rename .*\.tmp-[0-9a-f]+ /);
  for (const s of fs.seen) assert.ok(s === SECRET || s === "new-value-5678", `a reader saw ${JSON.stringify(s)}`);
  assert.equal(fs.files.get(PATH)?.bytes, "new-value-5678");
});

test("the atomicity check fails against a writer that fills the final path directly", async () => {
  const fs = new FakeFs(PATH);
  await deliverCredential(opts(fs));
  fs.seen.length = 0;
  await fs.put(PATH, new TextEncoder().encode("new-value-5678"), 0o400);
  assert.ok(
    fs.seen.some((s) => s !== SECRET && s !== "new-value-5678"),
    "the direct write exposed a partial file, so the reader check is capable of failing",
  );
});

test("a failed rotation keeps the old value, removes the temp file and does not echo the value", async () => {
  const fs = new FakeFs(PATH);
  const h = await deliverCredential(opts(fs));
  fs.failPutOn = ".tmp-";
  await assert.rejects(h.rotate("new-value-5678"), (e: Error) => {
    assert.match(e.message, /keeps its previous content/);
    assert.equal(e.message.includes("new-value-5678"), false);
    assert.match(e.message, /\[REDACTED\]/);
    return true;
  });
  assert.equal(fs.files.get(PATH)?.bytes, SECRET);
  assert.deepEqual([...fs.files.keys()], [PATH]);
});

test("revoke removes the file and later rotate is refused with cause and action", async () => {
  const fs = new FakeFs(PATH);
  const h = await deliverCredential(opts(fs));
  await h.revoke();
  assert.equal(fs.files.has(PATH), false);
  await assert.rejects(h.rotate("another"), /was revoked.*deliver a new credential/s);
  assert.equal(fs.files.has(PATH), false, "the refused rotate wrote nothing");
  await h.revoke();
});

test("a failed revoke refuses rotation already and can be retried", async () => {
  const fs = new FakeFs(PATH);
  const h = await deliverCredential(opts(fs));
  const real = fs.remove.bind(fs);
  let fail = true;
  fs.remove = async (p) => {
    if (fail) throw new Error("exec closed");
    return real(p);
  };
  await assert.rejects(h.revoke(), /could not remove.*retry revoke/s);
  await assert.rejects(h.rotate("x"), /was revoked/);
  fail = false;
  await h.revoke();
  assert.equal(fs.files.has(PATH), false);
});

test("refuses modes other than 0400 and 0600", async () => {
  for (const mode of [0o644, 0o444, 0o666, 0o700]) {
    const fs = new FakeFs(PATH);
    await assert.rejects(deliverCredential(opts(fs, { mode })), /would let other users read.*request 0400/s);
    assert.deepEqual(fs.ops, []);
  }
  await deliverCredential(opts(new FakeFs(PATH), { mode: 0o600 }));
});

test("refuses a path outside the secret directory, nested, or traversing", async () => {
  for (const path of [
    "/etc/passwd",
    `${DEFAULT_SECRET_DIR}/../etc/x`,
    `${DEFAULT_SECRET_DIR}/a/b`,
    `${DEFAULT_SECRET_DIR}/`,
    `${DEFAULT_SECRET_DIR}x/f`,
    "relative",
  ]) {
    const fs = new FakeFs(PATH);
    await assert.rejects(deliverCredential(opts(fs, { path })), /not a file directly inside the secret directory/, path);
    assert.deepEqual(fs.ops, []);
  }
});

test("refuses an empty value and a bad name, without writing", async () => {
  const fs = new FakeFs(PATH);
  await assert.rejects(deliverCredential(opts(fs, { value: "" })), /empty value/);
  await assert.rejects(deliverCredential(opts(fs, { name: "lower-case" })), /not an environment-style name/);
  assert.deepEqual(fs.ops, []);
  const h = await deliverCredential(opts(fs));
  await assert.rejects(h.rotate(""), /is empty/);
});

test("the secret value is absent from every trace event and error", async () => {
  const fs = new FakeFs(PATH);
  const events: unknown[] = [];
  const h = await deliverCredential(opts(fs, { trace: (e) => events.push(e) }));
  await h.rotate("new-value-5678");
  await h.revoke();
  const dump = JSON.stringify(events);
  assert.equal(events.length, 3);
  for (const v of [SECRET, "new-value-5678"]) assert.equal(dump.includes(v), false);
});

test("concurrent rotations run in order and the last one wins", async () => {
  const fs = new FakeFs(PATH);
  const h = await deliverCredential(opts(fs));
  await Promise.all([h.rotate("one"), h.rotate("two"), h.rotate("three")]);
  assert.equal(fs.files.get(PATH)?.bytes, "three");
  assert.deepEqual([...fs.files.keys()], [PATH]);
});

const tempsIn = (fs: FakeFs) => [...fs.files.keys()].filter((k) => k.includes(".tmp-"));

test("rename fails after put and the temp is removed; the error names the path, not the value", async () => {
  const fs = new FakeFs(PATH);
  const h = await deliverCredential(opts(fs));
  fs.failRename = true;
  await assert.rejects(h.rotate("new-value-5678"), (e: Error) => {
    assert.match(e.message, /Error: rename refused/);
    assert.equal(e.message.includes("new-value-5678"), false);
    return true;
  });
  assert.deepEqual(tempsIn(fs), []);
  fs.failRename = false;
  await h.rotate("recovered");
  assert.equal(fs.files.get(PATH)?.bytes, "recovered", "a rotate after a rejected one succeeds");
});

test("a temp whose removal fails is reported, kept for retry, and removed by revoke along with the target", async () => {
  const fs = new FakeFs(PATH);
  const h = await deliverCredential(opts(fs));
  fs.failRename = true;
  let failOnce = true;
  fs.failRemove = (p) => {
    if (failOnce && p.includes(".tmp-")) {
      failOnce = false;
      return true;
    }
    return false;
  };
  const err = await h.rotate("new-value-5678").then(
    () => assert.fail("rotate should reject"),
    (e: Error) => e,
  );
  const [tmp] = tempsIn(fs);
  assert.ok(tmp, "the temp file survived the failed cleanup");
  assert.ok(err.message.includes(tmp), "the error names the leftover temp path");
  assert.equal(err.message.includes("new-value-5678"), false);
  await h.revoke();
  assert.deepEqual([...fs.files.keys()], []);
});

test("a temp that cannot be removed at revoke is named in the revoke error and retried", async () => {
  const fs = new FakeFs(PATH);
  const h = await deliverCredential(opts(fs));
  fs.failRename = true;
  fs.failRemove = (p) => p.includes(".tmp-");
  await assert.rejects(h.rotate("new-value-5678"));
  const [tmp] = tempsIn(fs);
  await assert.rejects(h.revoke(), (e: Error) => {
    assert.ok(tmp && e.message.includes(tmp));
    assert.equal(e.message.includes("new-value-5678"), false);
    return true;
  });
  fs.failRemove = () => false;
  await h.revoke();
  assert.deepEqual([...fs.files.keys()], []);
});

test("every encoded form and each line of a multi-line value is redacted from transport errors", async () => {
  const value = "line-one-secret\nline/two+secret==";
  const buf = Buffer.from(value);
  const forms = [
    value,
    "line-one-secret",
    "line/two+secret==",
    buf.toString("base64"),
    buf.toString("base64").replace(/=+$/, ""),
    buf.toString("base64url"),
    buf.toString("hex"),
    buf.toString("hex").toUpperCase(),
    encodeURIComponent(value),
  ];
  for (const form of forms) {
    const fs = new FakeFs(PATH);
    const h = await deliverCredential(opts(fs));
    fs.putHook = () => new Error(`upstream said ${form} is bad`);
    const err = await h.rotate(value).then(
      () => assert.fail("rotate should reject"),
      (e: Error) => e,
    );
    assert.equal(err.message.includes(form), false, `form ${form} leaked`);
    assert.match(err.message, /\[REDACTED\]/);
  }
});

test("a file name containing .tmp- is refused", async () => {
  const fs = new FakeFs(PATH);
  await assert.rejects(deliverCredential(opts(fs, { path: `${DEFAULT_SECRET_DIR}/tok.tmp-1` })), /reserved for the channel's temporary files/);
  assert.deepEqual(fs.ops, []);
});

test("temp names are random and differ between rotations", async () => {
  const fs = new FakeFs(PATH);
  const h = await deliverCredential(opts(fs));
  await h.rotate("a");
  await h.rotate("b");
  const temps = fs.ops.filter((o) => o.startsWith("rename ")).map((o) => o.split(" ")[1]);
  assert.equal(new Set(temps).size, temps.length);
  for (const t of temps) assert.match(t ?? "", /\.tmp-[0-9a-f]{16}$/);
});

test("two handles on one path in one sandbox refuse each other until the first is revoked", async () => {
  const fs = new FakeFs(PATH);
  const h = await deliverCredential(opts(fs));
  await assert.rejects(deliverCredential(opts(fs)), /already owns .*revoke the existing handle/s);
  await deliverCredential(opts(new FakeFs(PATH)));
  await h.revoke();
  await deliverCredential(opts(fs));
});

test("a failed first delivery releases the path", async () => {
  const fs = new FakeFs(PATH);
  fs.failRename = true;
  await assert.rejects(deliverCredential(opts(fs)));
  fs.failRename = false;
  await deliverCredential(opts(fs));
});

test("a throwing trace neither fails deliver, rotate nor revoke", async () => {
  const fs = new FakeFs(PATH);
  const h = await deliverCredential(
    opts(fs, {
      trace: () => {
        throw new Error("sink down");
      },
    }),
  );
  await h.rotate("x");
  await h.revoke();
  assert.equal(fs.files.has(PATH), false);
});

test("revoke is not blocked by a hung rotation, and the overtaken rotation leaves no file", async () => {
  const fs = new FakeFs(PATH);
  const h = await deliverCredential(opts(fs, { sleep: async () => {} }));
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const realPut = fs.put.bind(fs);
  fs.put = async (p, b, m) => {
    await gate;
    return realPut(p, b, m);
  };
  const rotating = h.rotate("late");
  await new Promise((r) => setImmediate(r));
  await h.revoke({ timeoutMs: 5 });
  assert.equal(fs.files.has(PATH), false);
  release();
  await rotating;
  assert.deepEqual([...fs.files.keys()], [], "the late rotation removed what it wrote");
});
