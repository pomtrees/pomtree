import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_PROFILES, isBrowserProfile } from "@pomtree/core";
import { interactiveProfile, interactiveRefusal, browserEvidence } from "../ext/pomtree-browser/browser.ts";
import {
  clearFinishMarker,
  createFinish,
  FINISH_MAX_ATTEMPTS,
  finishArgv,
  finishKey,
  writeFinishMarker,
  type FinishRun,
  type RunFinish,
} from "../ext/pomtree-browser/finish.ts";
import {
  BROWSER_INTERACTIVE_TOOLS,
  BROWSER_PROFILE_TOOLS,
  FINISH_GRACE_MS,
  FINISH_POLL_MS,
  browserExitCode,
  browserProfile,
  readFinishMarker,
  superviseRun,
} from "./browser-run.ts";

const timedOut: FinishRun = { ok: false, code: null, signal: "SIGTERM", timedOut: true, stderr: "" };
const refused = (code: number): FinishRun => ({ ok: false, code, signal: null, timedOut: false, stderr: "" });

test("capture_finish passes one stable --key per (status, summary): a retry replays, a different answer is a different request", async () => {
  const keys: string[] = [];
  const run: RunFinish = async (_f, argv) => {
    keys.push(argv[argv.indexOf("--key") + 1] as string);
    return keys.length === 1 ? timedOut : { ok: true };
  };
  const finish = createFinish({ run, env: {}, interactive: true });
  assert.equal((await finish("succeeded", "answer")).ok, false);
  assert.equal((await finish("succeeded", "answer")).ok, true);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(finishKey("succeeded", "answer"), finishKey("failed", "answer"));
  assert.notEqual(finishKey("succeeded", "answer"), finishKey("succeeded", "answer2"));
  assert.deepEqual(finishArgv("failed", "x").slice(-2), ["--key", finishKey("failed", "x")]);
});

test("the finish marker is written pending before pomtree runs: a timeout leaves it standing, a refusal removes it, success settles it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finish-pending-"));
  const path = join(dir, "m.json");
  try {
    const hooks = (run: RunFinish) =>
      createFinish({
        run,
        env: {},
        interactive: true,
        onPending: (s) => writeFinishMarker(s, path, true),
        onUnrecorded: () => clearFinishMarker(path),
        onRecorded: (s) => writeFinishMarker(s, path),
      });
    let seenDuringRun: unknown;
    const t = hooks(async () => {
      seenDuringRun = readFinishMarker(path, true);
      return timedOut;
    });
    await t("succeeded", "s");
    assert.equal(seenDuringRun, "succeeded", "the intent exists before the pomtree call returns");
    // Timeout between `pomtree result` recording and the settled marker: the exit code still follows the intent, and the finish watch does not fire.
    assert.equal(readFinishMarker(path, true), "succeeded");
    assert.equal(readFinishMarker(path), undefined);
    assert.equal(browserExitCode("timeout", 143, readFinishMarker(path, true)), 0);
    await hooks(async () => refused(5))("failed", "s");
    assert.equal(readFinishMarker(path, true), undefined, "a refusal cannot have recorded: the marker is gone");
    assert.equal(browserExitCode("timeout", 143, readFinishMarker(path, true)), 124);
    await hooks(async () => ({ ok: true }))("failed", "s");
    assert.equal(readFinishMarker(path), "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed settled-marker write after success leaves the pending intent, so the exit code is still the recorded outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "finish-lost-"));
  const path = join(dir, "m.json");
  try {
    const finish = createFinish({
      run: async () => ({ ok: true }),
      env: {},
      interactive: true,
      onPending: (s) => writeFinishMarker(s, path, true),
      onRecorded: () => {
        /* the settled write failed (logged by index.ts); nothing replaces the pending marker */
      },
    });
    await finish("failed", "s");
    assert.equal(browserExitCode("timeout", 143, readFinishMarker(path, true)), 1);
    assert.equal(browserExitCode(undefined, 0, readFinishMarker(path, true)), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the finish watch ignores a pending marker and arms the bounded kill after the finish stop", () => {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const clock = {
    set: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clear: (h: unknown) => void timers.splice(timers.indexOf(h as (typeof timers)[number]), 1),
  };
  const dir = mkdtempSync(join(tmpdir(), "finish-watch-"));
  const path = join(dir, "m.json");
  try {
    const events: string[] = [];
    superviseRun({
      ms: 600_000,
      interactive: true,
      stop: (c) => events.push(`${c}@${now}`),
      killAll: () => events.push(`kill@${now}`),
      recorded: () => readFinishMarker(path),
      clock,
    });
    const advance = (to: number) => {
      while (true) {
        const next = timers.filter((t) => t.at <= to).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.fn();
      }
      now = to;
    };
    writeFinishMarker("succeeded", path, true);
    advance(60_000);
    assert.deepEqual(events, [], "an in-flight pomtree call is not a recorded result");
    writeFinishMarker("succeeded", path);
    advance(60_000 + FINISH_POLL_MS);
    const seen = now;
    advance(seen + FINISH_GRACE_MS);
    advance(seen + FINISH_GRACE_MS + 2000);
    assert.deepEqual(events, [`finished@${seen + FINISH_GRACE_MS}`, `kill@${seen + FINISH_GRACE_MS + 2000}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interactive: rejected capture_finish calls spend attempts, so the cap matches the extension's call count", async () => {
  const finish = createFinish({ run: async () => ({ ok: true }), env: {}, interactive: true });
  let last = { ok: true, text: "" };
  for (let i = 0; i < FINISH_MAX_ATTEMPTS; i++) last = await finish("bogus", "s");
  assert.match(last.text, /gives up/);
  assert.match(last.text, /\(cause=finish_failed\)$/);
  assert.match((await finish("succeeded", "s")).text, /gave up/);
});

test("browser tools other than navigate refuse any url; browser_tabs takes only list/new/close/select and an integer index", () => {
  for (const url of [
    "file:///proc/self/environ",
    "chrome://settings",
    "data:text/html,x",
    "view-source:https://a.example",
    "javascript:alert(1)",
    "https://u:p@a.example/",
    "https://a.example",
  ])
    for (const tool of BROWSER_INTERACTIVE_TOOLS.filter((t) => t.startsWith("browser_") && t !== "browser_navigate"))
      assert.match(interactiveRefusal(tool, { action: "new", url }) ?? "", /takes no url/, `${tool} ${url}`);
  for (const action of ["list", "new", "close", "select"]) assert.equal(interactiveRefusal("browser_tabs", { action, index: 0 }), undefined, action);
  for (const bad of [
    {},
    { action: "open" },
    { action: 1 },
    { action: "select", index: -1 },
    { action: "select", index: 1.5 },
    { action: "select", index: "0" },
  ])
    assert.match(interactiveRefusal("browser_tabs", bad) ?? "", /browser_tabs/, JSON.stringify(bad));
  const ev = browserEvidence({ maxSteps: 10, interactive: true, record: () => {}, publish: async () => ({}) as never });
  const r = ev.call({ toolName: "browser_tabs", toolCallId: "t", input: { action: "new", url: "file:///etc/passwd" } }) as { block: boolean; reason: string };
  assert.equal(r.block, true);
  assert.match(r.reason, /cause=refused/);
});

test("PTREE_BROWSER_PROFILE: core, the worker and the extension accept exactly the same values and each has a tool set", () => {
  const values = [...BROWSER_PROFILES, "", "capture", "INTERACTIVE", " interactive", "toString", "__proto__", "constructor"];
  for (const v of values) {
    const env = { PTREE_BROWSER_PROFILE: v };
    const core = isBrowserProfile(v);
    const attempt = (f: () => unknown) => {
      try {
        f();
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(
      attempt(() => browserProfile(env)),
      core,
      `worker ${JSON.stringify(v)}`,
    );
    assert.equal(
      attempt(() => interactiveProfile(env)),
      core,
      `extension ${JSON.stringify(v)}`,
    );
    if (core) assert.ok((BROWSER_PROFILE_TOOLS[v as keyof typeof BROWSER_PROFILE_TOOLS]?.length ?? 0) > 0, v);
  }
});
