// The e2e and demo polling helpers are thin wrappers over the shared `until` in @pomtree/testing: they keep their defaults and error
// context, and the budget they report is scaled by POMTREE_TEST_TIMEOUT_SCALE. The two importable helpers (harness.ts, live-harness-util.ts)
// are checked by behavior. The demos run their scenario when imported and the CLI stack helper needs a built stack, so those are checked by
// source: each must call the shared `until` and carry no polling loop of its own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { withLogTail } from "./cli-scenarios-harness.ts";
import { Deadline, until as liveUntil } from "./live-harness-util.ts";
import { until as harnessUntil } from "./harness.ts";

const SCALE_VAR = "POMTREE_TEST_TIMEOUT_SCALE";
const here = dirname(fileURLToPath(import.meta.url));
const source = (rel: string) => readFileSync(join(here, rel), "utf8");

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[SCALE_VAR];
});
afterEach(() => {
  if (saved === undefined) delete process.env[SCALE_VAR];
  else process.env[SCALE_VAR] = saved;
});

const messageOf = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the wait to time out, but it resolved");
};

test("harness until reports its context and the budget at scale 1, then doubled at scale 2", async () => {
  process.env[SCALE_VAR] = "1";
  const one = await messageOf(harnessUntil(() => false, "the thing", 50));
  assert.match(one.message, /timed out waiting for the thing/);
  assert.match(one.message, /budget 50 ms \(50 ms x scale 1\)/);
  process.env[SCALE_VAR] = "2";
  const two = await messageOf(harnessUntil(() => false, "the thing", 50));
  assert.match(two.message, /budget 100 ms \(50 ms x scale 2\)/);
});

test("harness until resolves once the condition holds, awaiting an async condition", async () => {
  let n = 0;
  await harnessUntil(async () => ++n >= 3, "three polls", 2000);
  assert.equal(n, 3);
});

test("live-harness-util until keeps its Deadline message and carries the scaled budget on cause", async () => {
  process.env[SCALE_VAR] = "1";
  const one = await messageOf(liveUntil("the thing", 50, () => undefined));
  assert.ok(one instanceof Deadline);
  assert.equal(one.message, "timeout waiting for the thing");
  assert.match(String((one.cause as Error).message), /budget 50 ms \(50 ms x scale 1\)/);
  process.env[SCALE_VAR] = "2";
  const two = await messageOf(liveUntil("the thing", 50, () => undefined));
  assert.match(String((two.cause as Error).message), /budget 100 ms \(50 ms x scale 2\)/);
});

test("live-harness-util until lets an invalid scale propagate instead of reporting a timeout", async () => {
  process.env[SCALE_VAR] = "abc";
  const e = await messageOf(liveUntil("the thing", 50, () => undefined));
  assert.ok(!(e instanceof Deadline));
  assert.match(e.message, /POMTREE_TEST_TIMEOUT_SCALE/);
});

test("withLogTail adds the log tail to a timeout only; caller and scale errors pass through unchanged", async () => {
  process.env[SCALE_VAR] = "1";
  const timeout = await messageOf(harnessUntil(() => false, "the thing", 20));
  const mapped = withLogTail(timeout, "LOGLINE") as Error;
  assert.match(mapped.message, /timed out waiting for the thing[\s\S]*--- pomtreed log tail\nLOGLINE/);
  assert.equal(mapped.cause, timeout);
  const own = new Error("probe blew up");
  assert.equal(withLogTail(own, "LOGLINE", { e: own }), own);
  const scale = new Error("POMTREE_TEST_TIMEOUT_SCALE is bad");
  assert.equal(withLogTail(scale, "LOGLINE"), scale);
});

test("the defaults are unchanged: 20 s for the harness, the phase budget for the demos", () => {
  assert.match(source("harness.ts"), /export const until = \(cond: [^)]*\) => [^,]*, what: string, ms = 20_000\)/);
  for (const demo of ["yield-resume", "escalation-chain", "budget-escalate"]) {
    const text = source(`demo/${demo}.ts`);
    assert.match(text, /const phaseMs = Number\(env\.POMTREED_DEMO_TIMEOUT_MS \?\? 240_000\);/, demo);
    assert.match(text, /async function until<T>\(what: string, f: [^)]*\) => [^,]*, ms = phaseMs\)/, demo);
  }
});

// The text of the wrapper: from its declaration to the closing brace at the declaration's indent.
const wrapperText = (text: string, start: RegExp, close: string): string => {
  const m = start.exec(text);
  assert.ok(m, `declaration ${start} not found`);
  const end = text.indexOf(close, m.index);
  assert.ok(end > m.index, `end of ${start} not found`);
  return text.slice(m.index, end);
};

const SHARED_IMPORT = /import \{[^}]*\buntil as pollUntil\b[^}]*\} from "@pomtree\/testing";/;
const OWN_LOOP = /Date\.now|performance\.now|setTimeout|\bsleep\(|for \(;;\)|while \(/;

test("each demo and the CLI stack helper delegates to the shared until and keeps no loop of its own", () => {
  const cases: [string, RegExp, string][] = [
    ["demo/yield-resume.ts", /async function until<T>/, "\n}\n"],
    ["demo/escalation-chain.ts", /async function until<T>/, "\n}\n"],
    ["demo/budget-escalate.ts", /async function until<T>/, "\n}\n"],
    ["cli-scenarios-harness.ts", /const until = async \(what: string/, "\n  };"],
  ];
  for (const [file, start, close] of cases) {
    const text = source(file);
    assert.match(text, SHARED_IMPORT, `${file} imports the shared until`);
    const body = wrapperText(text, start, close);
    assert.match(body, /pollUntil\(/, `${file} calls the shared until`);
    assert.doesNotMatch(body, OWN_LOOP, `${file} wrapper has its own polling loop`);
  }
});

test("the source check can fail: a wrapper with its own loop is rejected", () => {
  const mutated = "async function until<T>(what: string) {\n  const deadline = Date.now() + 1;\n  for (;;) { await sleep(400); }\n}\n";
  assert.match(wrapperText(mutated, /async function until<T>/, "\n}\n"), OWN_LOOP);
});
