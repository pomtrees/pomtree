import assert from "node:assert/strict";
import test from "node:test";
import type { SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_EXT,
  BROWSER_PI_FLAGS,
  browserExitCode,
  FINISH_GRACE_MS,
  FINISH_POLL_MS,
  readFinishMarker,
  type RecordedStatus,
  type RunClock,
  type StopCause,
  superviseRun,
  browserLimits,
  browserPiArgs,
  browserPiEnv,
  BROWSER_PROXY_URL,
  CHROMIUM_BIN,
  chromiumArgs,
  startChromium,
  startPi,
  withBrowserExtension,
} from "./browser-run.ts";
import { BROWSER_MAX_MS_RANGE, BROWSER_MAX_STEPS_RANGE, EGRESS_BROWSER_PROXY_PORT, EGRESS_PROXY_PORT, FIXED_PATH, NODE_BIN } from "./container-contract.gen.ts";

const EXT = "/opt/pomtree/ext/pomtree-browser";

test("withBrowserExtension appends the extension when argv has no -- separator", () => {
  assert.deepEqual(withBrowserExtension(["--mode", "json", "@model"], EXT), ["--mode", "json", "@model", "--extension", EXT]);
});

test("withBrowserExtension inserts the extension immediately before the first -- separator, leaving the prompt last", () => {
  assert.deepEqual(withBrowserExtension(["--mode", "json", "--", "browse the page"], EXT), ["--mode", "json", "--extension", EXT, "--", "browse the page"]);
});

test("withBrowserExtension only treats the first -- as the separator; prompt text is not altered", () => {
  const prompt = "--extension /evil -- --help";
  assert.deepEqual(withBrowserExtension(["--mode", "json", "--", prompt], EXT), ["--mode", "json", "--extension", EXT, "--", prompt]);
  assert.deepEqual(withBrowserExtension(["--", "--", "x"], EXT), ["--extension", EXT, "--", "--", "x"]);
});

test("withBrowserExtension on empty argv returns only the extension flag", () => {
  assert.deepEqual(withBrowserExtension([], EXT), ["--extension", EXT]);
});

test("withBrowserExtension does not mutate its input", () => {
  const args = ["--", "p"];
  withBrowserExtension(args, EXT);
  assert.deepEqual(args, ["--", "p"]);
});

test("browserLimits requires explicit whole-number step and run-ms budgets within bounds", () => {
  assert.deepEqual(browserLimits({ PTREE_BROWSER_MAX_STEPS: "1", PTREE_BROWSER_MAX_MS: "1000" }), { steps: 1, ms: 1000 });
  assert.deepEqual(browserLimits({ PTREE_BROWSER_MAX_STEPS: "256", PTREE_BROWSER_MAX_MS: "600000" }), { steps: 256, ms: 600000 });
  const bad = [
    {},
    { PTREE_BROWSER_MAX_STEPS: "0", PTREE_BROWSER_MAX_MS: "1000" },
    { PTREE_BROWSER_MAX_STEPS: "257", PTREE_BROWSER_MAX_MS: "1000" },
    { PTREE_BROWSER_MAX_STEPS: "1.5", PTREE_BROWSER_MAX_MS: "1000" },
    { PTREE_BROWSER_MAX_STEPS: "", PTREE_BROWSER_MAX_MS: "1000" },
    { PTREE_BROWSER_MAX_STEPS: "1", PTREE_BROWSER_MAX_MS: "999" },
    { PTREE_BROWSER_MAX_STEPS: "1", PTREE_BROWSER_MAX_MS: "600001" },
    { PTREE_BROWSER_MAX_STEPS: "1", PTREE_BROWSER_MAX_MS: "NaN" },
  ];
  for (const env of bad) assert.throws(() => browserLimits(env), /budgets/, JSON.stringify(env));
  // The ranges are core's template ranges (generated copy), equal to the literals they replaced.
  assert.deepEqual(BROWSER_MAX_STEPS_RANGE, { min: 1, max: 256 });
  assert.deepEqual(BROWSER_MAX_MS_RANGE, { min: 1000, max: 600000 });
});

test("chromiumArgs: sandbox stays enabled, explicit loopback proxy only, no DNS or QUIC/WebRTC leaks, no VNC/keys", () => {
  const args = chromiumArgs("http://127.0.0.1:3128");
  const joined = args.join(" ");
  assert.doesNotMatch(joined, /--no-sandbox|--disable-setuid-sandbox|--single-process|--remote-allow-origins=\*/);
  assert.doesNotMatch(joined, /vnc|VNC|--password|api[_-]?key|--user-agent=.*key/i);
  assert.ok(args.includes("--proxy-server=http://127.0.0.1:3128"));
  assert.ok(args.includes("--proxy-bypass-list=<-loopback>"));
  assert.ok(args.includes("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"));
  assert.ok(args.includes("--disable-quic"));
  assert.ok(args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
  assert.equal(args[args.length - 1], "about:blank");
});

test("chromiumArgs suppresses Chromium background networking", () => {
  const args = chromiumArgs("http://127.0.0.1:3128");
  for (const flag of [
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--no-pings",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-breakpad",
    "--safebrowsing-disable-auto-update",
    "--disable-component-extensions-with-background-pages",
  ])
    assert.ok(args.includes(flag), flag);
  const features = args
    .find((a) => a.startsWith("--disable-features="))
    ?.slice("--disable-features=".length)
    .split(",");
  for (const f of [
    "OptimizationHints",
    "OptimizationHintsFetching",
    "OptimizationGuideModelDownloading",
    "MediaRouter",
    "Translate",
    "NetworkTimeServiceQuerying",
  ])
    assert.ok(features?.includes(f), f);
});

test("chromiumArgs rejects proxies carrying credentials, paths, queries, fragments or non-HTTP schemes", () => {
  for (const proxy of [
    "https://127.0.0.1:3128",
    "http://u:p@127.0.0.1:3128",
    "http://127.0.0.1:3128/x",
    "http://127.0.0.1:3128?q=1",
    "http://127.0.0.1:3128#f",
    "socks5://127.0.0.1:1080",
  ]) {
    assert.throws(() => chromiumArgs(proxy), /credential-free controller proxy/, proxy);
  }
});

test("browserLimits rejects values Number() would coerce (exponent, hex, blanks, sign)", () => {
  for (const v of ["1e3", "0x10", " 5", "5 ", "+5", "-5", "5n"])
    assert.throws(() => browserLimits({ PTREE_BROWSER_MAX_STEPS: v, PTREE_BROWSER_MAX_MS: "1000" }), /explicit positive/, v);
  assert.throws(() => browserLimits({ PTREE_BROWSER_MAX_STEPS: "1", PTREE_BROWSER_MAX_MS: "1e4" }), /explicit positive/);
});

test("browserExitCode: a daemon SIGTERM is 143 (regression: it was 124, which the clean-stop classification does not accept)", () => {
  assert.equal(browserExitCode("SIGTERM", 1), 143);
  assert.equal(browserExitCode("SIGTERM", 0), 143);
  assert.equal(browserExitCode("SIGINT", 1), 130);
  assert.equal(browserExitCode("timeout", 143), 124);
  assert.equal(browserExitCode(undefined, 0), 0);
  assert.equal(browserExitCode(undefined, 7), 7);
});

test("browserExitCode: a recorded result decides the code of a budget expiry, the finish grace and Pi's clean exit; signals and crashes do not change", () => {
  // Regression: a run whose capture_finish had recorded `succeeded` was still killed at its time budget and exited 124.
  assert.equal(browserExitCode("timeout", 143, "succeeded"), 0);
  assert.equal(browserExitCode("timeout", 143, "failed"), 1);
  assert.equal(browserExitCode("finished", 143, "succeeded"), 0);
  assert.equal(browserExitCode("finished", 143, "failed"), 1);
  assert.equal(browserExitCode(undefined, 0, "succeeded"), 0, "Pi's clean shutdown after a succeeded result");
  assert.equal(browserExitCode(undefined, 0, "failed"), 1, "Pi's clean shutdown after a failed result");
  // Negative: no recorded result keeps the old codes; a daemon signal stays 128+n (the clean-stop rule needs it); a Pi crash passes.
  assert.equal(browserExitCode("timeout", 143, undefined), 124);
  assert.equal(browserExitCode("finished", 143, undefined), 1);
  assert.equal(browserExitCode("SIGTERM", 0, "succeeded"), 143);
  assert.equal(browserExitCode("SIGINT", 0, "succeeded"), 130);
  assert.equal(browserExitCode(undefined, 7, "succeeded"), 7);
});

// A fake clock: timers fire in due order as time advances.
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: RunClock = {
    set: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => void timers.delete(h as number),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  return { clock, advance, pending: () => timers.size, now: () => now };
}
function supervised(interactive: boolean, ms = 60_000) {
  const c = fakeClock();
  const stops: { cause: StopCause; at: number }[] = [];
  let kills = 0;
  let status: RecordedStatus | undefined;
  const run = superviseRun({
    ms,
    interactive,
    stop: (cause) => stops.push({ cause, at: c.now() }),
    killAll: () => kills++,
    recorded: () => status,
    clock: c.clock,
  });
  return { ...c, stops, kills: () => kills, record: (s: RecordedStatus) => (status = s), run };
}

test("superviseRun (interactive): a recorded result stops the run FINISH_GRACE_MS after the worker sees it, with that outcome's code", () => {
  const s = supervised(true);
  s.advance(10_000);
  assert.deepEqual(s.stops, [], "nothing recorded: the run keeps going");
  s.record("succeeded");
  s.advance(FINISH_POLL_MS + FINISH_GRACE_MS);
  assert.deepEqual(s.stops, [{ cause: "finished", at: 10_000 + FINISH_POLL_MS + FINISH_GRACE_MS }]);
  // Pi then exits from the worker's SIGTERM: the code is the recorded outcome, not 143 or 124.
  assert.equal(browserExitCode("finished", 143, "succeeded"), 0);
  assert.ok(FINISH_GRACE_MS >= 1000 && FINISH_GRACE_MS <= 10_000, "a few seconds: the final message and evidence flush, the run still ends promptly");
  s.run.dispose();
  assert.equal(s.pending(), 0);
});

test("superviseRun (interactive): no result means the budget timer still stops the run as a timeout (124), then the bounded kill", () => {
  const s = supervised(true, 60_000);
  s.advance(60_000);
  assert.deepEqual(s.stops, [{ cause: "timeout", at: 60_000 }]);
  assert.equal(browserExitCode("timeout", 143, undefined), 124);
  s.advance(2000);
  assert.equal(s.kills(), 1);
});

test("superviseRun (interactive): a result recorded just before the budget ends exits with the recorded code, not 124", () => {
  const s = supervised(true, 60_000);
  s.advance(59_900);
  s.record("failed");
  s.advance(100);
  assert.equal(s.stops[0]?.cause, "timeout");
  assert.equal(browserExitCode("timeout", 143, "failed"), 1);
});

test("superviseRun (capture profile): exactly the budget and kill timers, no finish watch", () => {
  const s = supervised(false, 60_000);
  assert.equal(s.pending(), 2);
  s.record("succeeded");
  s.advance(59_999);
  assert.deepEqual(s.stops, [], "the capture worker never reads a marker");
  s.advance(1);
  assert.deepEqual(s.stops, [{ cause: "timeout", at: 60_000 }]);
});

test("readFinishMarker accepts only the closed shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "finish-marker-"));
  try {
    const path = join(dir, "m.json");
    assert.equal(readFinishMarker(path), undefined, "absent");
    for (const [text, want] of [
      ['{"status":"succeeded"}', "succeeded"],
      ['{"status":"failed"}', "failed"],
      ['{"status":"timed_out"}', undefined],
      ['"succeeded"', undefined],
      ["null", undefined],
      ["{", undefined],
    ] as const) {
      writeFileSync(path, text);
      assert.equal(readFinishMarker(path), want, text);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browserPiArgs appends the exact tool allowlist and hardening flags, before the prompt separator", () => {
  assert.deepEqual(BROWSER_PI_FLAGS, [
    "--tools",
    "browser_capture,capture_finish",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
  ]);
  const argv = browserPiArgs(["--tui-mode", "regular", "--extension", "/opt/pomtree/ext/pomtree-events", "--model", "m", "--", "--tools bash"]);
  assert.deepEqual(argv, [
    "--tui-mode",
    "regular",
    "--extension",
    "/opt/pomtree/ext/pomtree-events",
    "--model",
    "m",
    ...BROWSER_PI_FLAGS,
    "--extension",
    BROWSER_EXT,
    "--",
    "--tools bash",
  ]);
  assert.deepEqual(browserPiArgs([]), [...BROWSER_PI_FLAGS, "--extension", BROWSER_EXT]);
  // A template's system prompt (pomtreed harnessArgv) passes through, as a value that cannot add a tool or extension flag.
  const withPrompt = browserPiArgs(["--model", "m", "--append-system-prompt", "--tools bash", "--", "task"]);
  assert.deepEqual(withPrompt.slice(0, 4), ["--model", "m", "--append-system-prompt", "--tools bash"]);
  assert.equal(withPrompt.filter((a) => a === "--tools").length, 1);
  assert.deepEqual(BROWSER_PI_FLAGS[1]?.split(","), ["browser_capture", "capture_finish"], "no read/bash/write/edit");
});

test("browserPiArgs refuses every caller tool-selection flag (all spellings, before the prompt separator only)", () => {
  for (const flag of [
    "-t",
    "--tools",
    "-nt",
    "--no-tools",
    "-nbt",
    "--no-builtin-tools",
    "-xt",
    "--exclude-tools",
    "--tools=bash",
    "-t=bash",
    "--exclude-tools=x",
  ])
    assert.throws(() => browserPiArgs(["--model", "m", flag, "bash"]), /tool set/, flag);
  assert.doesNotThrow(() => browserPiArgs(["--", "-t", "--tools", "bash"]), "text after -- is the prompt");
});

test("browserPiArgs refuses an extension outside /opt/pomtree/ext, in every spelling", () => {
  for (const ext of ["/workspace/evil", "/opt/pomtree/ext/../x", "/opt/pomtree/extra/x", "builtin:foo", "ext/x", "/opt/pomtree/ext/", ""]) {
    assert.throws(() => browserPiArgs(["--extension", ext]), /extensions under/, ext);
    assert.throws(() => browserPiArgs(["-e", ext]), /extensions under/, ext);
    assert.throws(() => browserPiArgs([`--extension=${ext}`]), /extensions under/, ext);
  }
  assert.throws(() => browserPiArgs(["-e"]), /extensions under/);
  assert.doesNotThrow(() => browserPiArgs(["-e", "/opt/pomtree/ext/web_search"]));
});

test("browserPiEnv pins PATH to the fixed system dirs and drops NODE_OPTIONS", () => {
  const env = browserPiEnv({ PATH: "/workspace/.env/npm/bin:/usr/bin", NODE_OPTIONS: "--require /evil.js", POMTREE_TOKEN: "t", HTTP_PROXY: "p" });
  assert.equal(env.PATH, FIXED_PATH);
  assert.equal(FIXED_PATH, "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  assert.equal("NODE_OPTIONS" in env, false);
  assert.equal(env.POMTREE_TOKEN, "t");
  assert.equal(env.HTTP_PROXY, "p");
});

test("chromium, node and Pi are spawned by absolute path with the fixed PATH", () => {
  const calls: { file: string; args: readonly string[]; opts: SpawnOptions }[] = [];
  const fake = ((file: string, args: readonly string[], opts: SpawnOptions) => {
    calls.push({ file, args, opts });
    return {} as never;
  }) as never;
  startChromium("http://127.0.0.1:3128", fake);
  startPi("/usr/local/lib/node_modules/pi/cli.js", ["--", "p"], { PATH: "/workspace/.env/npm/bin", NODE_OPTIONS: "--require /x" }, fake);
  assert.equal(calls[0]?.file, CHROMIUM_BIN);
  assert.equal(CHROMIUM_BIN, "/usr/bin/chromium");
  assert.equal((calls[0]?.opts.env as Record<string, string>)?.PATH, FIXED_PATH);
  assert.equal(calls[1]?.file, NODE_BIN);
  assert.equal(NODE_BIN, "/usr/local/bin/node");
  assert.equal(calls[1]?.args[0], "/usr/local/lib/node_modules/pi/cli.js");
  assert.deepEqual(calls[1]?.args.slice(1), browserPiArgs(["--", "p"]));
  const env = calls[1]?.opts.env as Record<string, string>;
  assert.equal(env.PATH, FIXED_PATH);
  assert.equal("NODE_OPTIONS" in env, false);
});

// Chromium's proxy is the browser listener's bridge, not the relay-reaching HTTP_PROXY port.
test("Chromium is pointed at the browser listener's port, not the relay-reaching one, with no proxy variables in its env", () => {
  assert.equal(BROWSER_PROXY_URL, `http://127.0.0.1:${EGRESS_BROWSER_PROXY_PORT}`);
  assert.notEqual(EGRESS_BROWSER_PROXY_PORT, EGRESS_PROXY_PORT);
  assert.ok(chromiumArgs(BROWSER_PROXY_URL).includes(`--proxy-server=http://127.0.0.1:${EGRESS_BROWSER_PROXY_PORT}`));
  assert.ok(!chromiumArgs(BROWSER_PROXY_URL).some((a) => a.includes(String(EGRESS_PROXY_PORT))));
  let env: Record<string, string> = {};
  startChromium(BROWSER_PROXY_URL, ((_f: string, _a: readonly string[], opts: SpawnOptions) => {
    env = opts.env as Record<string, string>;
    return {} as never;
  }) as never);
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH"]);
});
