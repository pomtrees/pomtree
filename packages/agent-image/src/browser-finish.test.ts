import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFinish,
  FINISH_MARKER_PATH,
  FINISH_MAX_ATTEMPTS,
  FINISH_STATUSES,
  finishArgv,
  finishEnv,
  finishKey,
  sanitizeSummary,
  writeFinishMarker,
  type FinishRun,
  type RunFinish,
} from "../ext/pomtree-browser/finish.ts";
import { INTERACTIVE_FINISH_MARKER, INTERACTIVE_FINISH_MAX_ATTEMPTS, interactivePreamble, readFinishMarker } from "./browser-run.ts";
import { CLI_POMTREE_MAIN, CONTAINER_CONFIG_ENV, FIXED_PATH, MAX_HANDOFF_BYTES, PROXY_ENV_NAMES } from "../ext/pomtree-browser/container-contract.gen.ts";
import { CLI_STDERR_TAIL_CHARS } from "../ext/pomtree-browser/capture-diagnostic.ts";

const FAILED: FinishRun = { ok: false, code: 1, signal: null, timedOut: false, stderr: "" };
const recorder = (ok = true, failure: FinishRun = FAILED) => {
  const calls: { file: string; argv: string[]; env: Record<string, string> }[] = [];
  const run: RunFinish = async (file, argv, env) => {
    calls.push({ file, argv, env });
    return ok ? { ok: true } : failure;
  };
  return { calls, run };
};

test("capture_finish accepts only the closed status values", async () => {
  const { calls, run } = recorder();
  const finish = createFinish({ run, execPath: "/usr/local/bin/node", env: {} });
  for (const bad of ["done", "SUCCEEDED", "", undefined, 1, null, "succeeded --save-uncommitted x"])
    assert.equal((await finish(bad, "s")).ok, false, String(bad));
  assert.equal((await finish("succeeded", 5)).ok, false);
  assert.equal(calls.length, 0);
  assert.equal((await finish("failed", "s")).ok, true);
});

test("capture_finish runs exactly node main.ts result --status S --summary X with no other flags", async () => {
  const { calls, run } = recorder();
  const finish = createFinish({ run, execPath: "/usr/local/bin/node", env: {} });
  await finish("succeeded", "all good");
  assert.deepEqual(calls[0]?.file, "/usr/local/bin/node");
  assert.deepEqual(calls[0]?.argv, [CLI_POMTREE_MAIN, "result", "--status", "succeeded", "--summary", "all good", "--key", finishKey("succeeded", "all good")]);
  assert.deepEqual(finishArgv("failed", "x"), [CLI_POMTREE_MAIN, "result", "--status", "failed", "--summary", "x", "--key", finishKey("failed", "x")]);
  assert.ok(!calls[0]?.argv.some((a) => /summary-file|save-uncommitted/.test(a)));
});

test("capture_finish is callable once; a failed attempt does not consume the call", async () => {
  const ok = recorder();
  const finish = createFinish({ run: ok.run, env: {} });
  const [a, b] = await Promise.all([finish("succeeded", "one"), finish("failed", "two")]);
  assert.deepEqual([a.ok, b.ok], [true, false]);
  assert.equal((await finish("failed", "three")).ok, false);
  assert.equal(ok.calls.length, 1);
  const bad = recorder(false);
  const retry = createFinish({ run: bad.run, env: {} });
  assert.equal((await retry("failed", "x")).ok, false);
  assert.equal((await retry("failed", "x")).ok, false);
  assert.equal(bad.calls.length, 2);
});

test("summary: control characters are stripped and the UTF-8 size is capped at 8 KiB without splitting a code point", () => {
  assert.equal(MAX_HANDOFF_BYTES, 8 * 1024, "the daemon's handoff cap equals the summary cap it replaced");
  assert.equal(sanitizeSummary("a\nb\u0000c\u001b[31md\u0085e\tf"), "a b c [31md e f");
  const long = sanitizeSummary("é".repeat(MAX_HANDOFF_BYTES));
  assert.ok(new TextEncoder().encode(long).length <= MAX_HANDOFF_BYTES);
  assert.ok(!long.includes("\uFFFD"));
  assert.equal(sanitizeSummary("x".repeat(MAX_HANDOFF_BYTES)).length, MAX_HANDOFF_BYTES);
  assert.equal(sanitizeSummary("x".repeat(MAX_HANDOFF_BYTES + 1)).length, MAX_HANDOFF_BYTES);
});

test("the child env is a fixed PATH plus POMTREE_*, the proxy selectors and the config document only; the token is never in the tool outcome", async () => {
  const proxies = Object.fromEntries(PROXY_ENV_NAMES.map((k) => [k, `v-${k}`]));
  const env = finishEnv({
    PATH: "/workspace/.env/npm/bin",
    POMTREE_TOKEN: "tok-secret",
    POMTREE_API: "http://x",
    OPENAI_API_KEY: "k",
    NODE_OPTIONS: "--require /x",
    HOME: "/h",
    ALL_PROXY: "http://not-selected",
    [CONTAINER_CONFIG_ENV]: "{}",
    PTREE_BROWSER_MAX_MS: "1000",
    ...proxies,
  });
  assert.deepEqual(env, { PATH: FIXED_PATH, POMTREE_TOKEN: "tok-secret", POMTREE_API: "http://x", [CONTAINER_CONFIG_ENV]: "{}", ...proxies });
  const { calls, run } = recorder();
  const outcome = await createFinish({ run, env: { POMTREE_TOKEN: "tok-secret" } })("succeeded", "s");
  assert.deepEqual(calls[0]?.env, { PATH: FIXED_PATH, POMTREE_TOKEN: "tok-secret" });
  assert.doesNotMatch(JSON.stringify(outcome), /tok-secret/);
  const failed = await createFinish({ run: recorder(false).run, env: { POMTREE_TOKEN: "tok-secret" } })("succeeded", "s");
  assert.doesNotMatch(JSON.stringify(failed), /tok-secret/);
});

test("a failed pomtree result: exit code in the tool text, redacted one-line bounded stderr tail only in the failure detail", async () => {
  const token = "tok-secret-0123456789";
  const stderr = `${"x".repeat(2000)}\nconnect ECONNREFUSED http://127.0.0.1:3128/v1/result\nusing ${token}\n`;
  const finish = createFinish({ run: recorder(false, { ok: false, code: 1, signal: null, timedOut: false, stderr }).run, env: { POMTREE_TOKEN: token } });
  const outcome = await finish("succeeded", "s");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.text, "recording the result failed (pomtree exit 1); call capture_finish again");
  const tail = outcome.failure?.stderrTail ?? "";
  assert.deepEqual({ ...outcome.failure, stderrTail: "" }, { code: 1, signal: null, timedOut: false, stderrTail: "" });
  assert.ok(Array.from(tail).length <= CLI_STDERR_TAIL_CHARS);
  assert.doesNotMatch(tail, /\n/);
  assert.match(tail, /connect ECONNREFUSED http:\/\/127\.0\.0\.1:3128\/\[path-redacted\] using \[redacted-env\]$/);
  assert.doesNotMatch(JSON.stringify(outcome), /tok-secret|v1\/result/);
});

test("an uncommitted-work refusal names its closed cause and says a retry cannot help; other 409s and exits keep the retry text", async () => {
  const stderr =
    "pomtree: uncommitted work: commit and pomtree push it, or approve daemon commit and local collection by retrying pomtree result with --save-uncommitted 0123abcd\n";
  const outcome = await createFinish({ run: recorder(false, { ok: false, code: 5, signal: null, timedOut: false, stderr }).run, env: {} })("succeeded", "s");
  assert.equal(
    outcome.text,
    "recording the result failed (pomtree exit 5, cause=uncommitted_work): the workspace has changes this worker cannot commit, so calling capture_finish again fails the same way; end the run",
  );
  assert.doesNotMatch(outcome.text, /save-uncommitted|0123abcd/); // the stderr (and its approval digest) never reaches the model
  assert.match(outcome.failure?.stderrTail ?? "", /uncommitted work/);
  for (const other of [
    { code: 5, stderr: "pomtree: unreaped children: c1\n" },
    { code: 1, stderr: "pomtree: uncommitted work: x\n" },
  ]) {
    const o = await createFinish({ run: recorder(false, { ok: false, signal: null, timedOut: false, ...other }).run, env: {} })("succeeded", "s");
    assert.equal(o.text, `recording the result failed (pomtree exit ${other.code}); call capture_finish again`);
  }
});

test("a timed-out pomtree result is reported as a timeout, not as an exit code", async () => {
  const run = recorder(false, { ok: false, code: null, signal: "SIGTERM", timedOut: true, stderr: "" }).run;
  const outcome = await createFinish({ run, env: {} })("failed", "s");
  assert.equal(outcome.text, "recording the result failed (pomtree timed out); call capture_finish again");
  assert.deepEqual(outcome.failure, { code: null, signal: "SIGTERM", timedOut: true, stderrTail: "" });
});

// The interactive profile: every pomtree exit class is named, says what to do, and ends with the closed cause pomtreed's toolFailureCauseOf parses.
const CAUSE_LAST = /\(cause=([a-z_]{1,32})\)$/;
const fail = (code: number | string | null, extra: Partial<Extract<FinishRun, { ok: false }>> = {}): FinishRun => ({
  ok: false,
  code,
  signal: null,
  timedOut: false,
  stderr: "",
  ...extra,
});

test("interactive capture_finish: pomtree 2/3/4/5 are refused deterministically, stop at once and say to end the run in plain text", async () => {
  for (const [code, name] of [
    [2, "usage"],
    [3, "not_found"],
    [4, "denied"],
    [5, "conflict"],
  ] as const) {
    const r = recorder(false, fail(code));
    const finish = createFinish({ run: r.run, env: {}, interactive: true });
    const o = await finish("succeeded", "s");
    assert.equal(
      o.text,
      `recording the result failed (pomtree exit ${code}: ${name}): the daemon refuses this call the same way every time; do not retry: end the run with your full answer as plain assistant text (cause=finish_failed)`,
    );
    assert.equal(o.cause, "finish_failed");
    // A call after the refusal runs no pomtree and repeats the terminal advice.
    const again = await finish("succeeded", "s");
    assert.equal(
      again.text,
      "capture_finish gave up after a failed attempt and runs no more; end the run with your full answer as plain assistant text (cause=finish_failed)",
    );
    assert.equal(r.calls.length, 1, `exit ${code}: no second pomtree run`);
    assert.doesNotMatch(o.text, /call capture_finish again/);
  }
});

test("interactive capture_finish: pomtree 1/6/7 and a runner timeout say to retry, then give up on the third failure", async () => {
  const cases: [FinishRun, string][] = [
    [fail(1), "pomtree exit 1: daemon_error): call capture_finish again"],
    [fail(6), "pomtree exit 6: unreachable): call capture_finish again"],
    [fail(7), "pomtree exit 7: timeout): the result may or may not be recorded; call capture_finish again"],
    [fail(null, { signal: "SIGTERM", timedOut: true }), "pomtree timed out): the result may or may not be recorded; call capture_finish again"],
    [fail("ENOENT"), "pomtree error ENOENT): call capture_finish again"],
  ];
  for (const [failure, head] of cases) {
    const r = recorder(false, failure);
    const finish = createFinish({ run: r.run, env: {}, interactive: true });
    const one = await finish("failed", "s");
    assert.equal(one.text, `recording the result failed (${head} with the same arguments (attempt 1 of ${FINISH_MAX_ATTEMPTS}) (cause=finish_failed)`);
    assert.match((await finish("failed", "s")).text, /attempt 2 of 3\) \(cause=finish_failed\)$/);
    const third = await finish("failed", "s");
    assert.match(third.text, /on attempt 3 of 3; capture_finish gives up: end the run with your full answer as plain assistant text \(cause=finish_failed\)$/);
    assert.match((await finish("failed", "s")).text, /^capture_finish gave up/);
    assert.equal(r.calls.length, FINISH_MAX_ATTEMPTS, "the fourth call runs no pomtree");
  }
  // A success after a retryable failure is recorded once.
  let n = 0;
  const flaky: RunFinish = async () => (++n === 1 ? fail(6) : { ok: true });
  const finish = createFinish({ run: flaky, env: {}, interactive: true });
  assert.equal((await finish("succeeded", "s")).ok, false);
  assert.deepEqual(await finish("succeeded", "s"), { ok: true, text: "result recorded" });
});

test("interactive capture_finish: uncommitted work keeps its cause, last in the text; every failure text parses to one closed cause", async () => {
  const stderr = "pomtree: uncommitted work: approve with --save-uncommitted 0123abcd\n";
  const o = await createFinish({ run: recorder(false, fail(5, { stderr })).run, env: {}, interactive: true })("succeeded", "s");
  assert.equal(
    o.text,
    "recording the result failed (pomtree exit 5: uncommitted_work): the workspace has changes this worker cannot commit, so every retry fails the same way; end the run with your full answer as plain assistant text (cause=uncommitted_work)",
  );
  assert.equal(o.cause, "uncommitted_work");
  assert.doesNotMatch(o.text, /save-uncommitted|0123abcd/);
  for (const code of [1, 2, 3, 4, 5, 6, 7]) {
    const t = (await createFinish({ run: recorder(false, fail(code)).run, env: {}, interactive: true })("succeeded", "s")).text;
    assert.match(t, CAUSE_LAST, `exit ${code}`);
  }
});

test("interactive capture_finish: no POMTREE_TOKEN, stderr or approval digest reaches the text; the redacted tail stays operator-only", async () => {
  const token = "tok-secret-0123456789";
  const stderr = `pomtree: denied for Bearer ${token} at http://127.0.0.1:3128/v1/result digest 0123abcd\n`;
  const o = await createFinish({ run: recorder(false, fail(4, { stderr })).run, env: { POMTREE_TOKEN: token }, interactive: true })("succeeded", "s");
  assert.doesNotMatch(o.text, /tok-secret|Bearer|v1\/result|0123abcd|denied for/);
  assert.doesNotMatch(o.failure?.stderrTail ?? "", /tok-secret/);
  assert.match(o.failure?.stderrTail ?? "", /denied for/);
});

test("the capture profile keeps its exact finish texts for every exit class (no interactive classification)", async () => {
  for (const code of [1, 2, 3, 4, 5, 6, 7]) {
    const r = recorder(false, fail(code));
    const finish = createFinish({ run: r.run, env: {} });
    for (let i = 0; i < 4; i++) {
      const o = await finish("succeeded", "s");
      assert.equal(o.text, `recording the result failed (pomtree exit ${code}); call capture_finish again`);
      assert.equal(o.cause, undefined);
    }
    assert.equal(r.calls.length, 4, "the capture profile never gives up");
  }
});

test("interactive capture_finish reports a recorded result once, only after pomtree result succeeded; a retryable failure does not end the run", async () => {
  const seen: string[] = [];
  let n = 0;
  const flaky: RunFinish = async () => (++n === 1 ? fail(6) : { ok: true });
  const finish = createFinish({ run: flaky, env: {}, interactive: true, onRecorded: (s) => seen.push(s) });
  assert.equal((await finish("failed", "s")).ok, false);
  assert.deepEqual(seen, [], "a retryable failure records nothing, so the worker keeps the run going");
  assert.equal((await finish("failed", "s")).ok, true);
  assert.deepEqual(seen, ["failed"]);
  assert.equal((await finish("failed", "s")).ok, false, "already called");
  assert.deepEqual(seen, ["failed"]);
  // Negative: a refused (non-retryable) failure and an invalid status never report a result.
  const refused: string[] = [];
  const f2 = createFinish({ run: recorder(false, fail(4)).run, env: {}, interactive: true, onRecorded: (s) => refused.push(s) });
  await f2("succeeded", "s");
  await f2("bogus", "s");
  assert.deepEqual(refused, []);
});

test("the capture profile never reports a recorded result (its run ends as before)", async () => {
  const seen: string[] = [];
  const finish = createFinish({ run: recorder().run, env: {}, onRecorded: (s) => seen.push(s) });
  assert.deepEqual(await finish("succeeded", "s"), { ok: true, text: "result recorded" });
  assert.deepEqual(seen, []);
});

test("the finish marker the extension writes is the one the worker reads (same path, round-tripped shape)", () => {
  assert.equal(FINISH_MARKER_PATH, INTERACTIVE_FINISH_MARKER);
  const dir = mkdtempSync(join(tmpdir(), "finish-marker-"));
  try {
    const path = join(dir, "m.json");
    for (const status of FINISH_STATUSES) {
      writeFinishMarker(status, path);
      assert.equal(readFinishMarker(path), status);
    }
    assert.deepEqual(readdirSync(dir), ["m.json"], "no temp file is left behind");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the finish attempt cap is the number the interactive preamble states", () => {
  assert.equal(FINISH_MAX_ATTEMPTS, INTERACTIVE_FINISH_MAX_ATTEMPTS);
  assert.match(interactivePreamble({ steps: 5, ms: 60_000 }), new RegExp(`up to ${FINISH_MAX_ATTEMPTS} calls in total, even past the call budget`));
});

test("the real child runner reports a failing pomtree's exit code and stderr (scripted: /bin/sh cannot open the absent main.ts)", async () => {
  const outcome = await createFinish({ execPath: "/bin/sh", env: { POMTREE_TOKEN: "tok-secret-0123456789" } })("succeeded", "s");
  assert.equal(outcome.ok, false);
  assert.equal(typeof outcome.failure?.code, "number");
  assert.notEqual(outcome.failure?.code, 0);
  assert.equal(outcome.failure?.timedOut, false);
  assert.match(outcome.failure?.stderrTail ?? "", /main\.ts/);
  assert.match(outcome.text, /^recording the result failed \(pomtree exit \d+\); call capture_finish again$/);
});
