import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle } from "@pomtree/core";
import {
  createPiHarness,
  fileTailSource,
  normalize,
  PI_EXIT_PREFIX,
  PI_EXIT_UNKNOWN_PREFIX,
  PI_NO_RESULT_PREFIX,
  PI_SINK_PATH,
  PI_TTY_ENV,
  tailFollow,
  type TailSource,
} from "./index.ts";

const j = (o: unknown) => `${JSON.stringify(o)}\n`;
const noSleep = async () => {};

// Scripted source: each read returns the next step (null = file missing); the last step repeats as "no news".
function scripted(steps: ({ text: string; offset: number } | null)[]): TailSource & { offsets: number[] } {
  const offsets: number[] = [];
  let i = 0;
  return {
    offsets,
    async read(o) {
      offsets.push(o);
      return steps[Math.min(i++, steps.length - 1)] ?? null;
    },
  };
}
const collect = async (it: AsyncIterable<string>) => {
  let s = "";
  for await (const c of it) s += c;
  return s;
};

test("tailFollow: waits through a missing file, yields appended text, drains after the producer ends", async () => {
  let end!: () => void;
  const ended = new Promise<void>((r) => {
    end = r;
  });
  const src = scripted([null, { text: "a\n", offset: 2 }, { text: "", offset: 2 }, { text: "b\n", offset: 4 }, { text: "", offset: 4 }]);
  let sleeps = 0;
  const got = collect(
    tailFollow(src, {
      ended,
      sleep: async () => {
        if (++sleeps === 3) end();
      },
    }),
  );
  assert.equal(await got, "a\nb\n");
  assert.deepEqual(src.offsets.slice(0, 4), [0, 0, 2, 2]);
});

test("tailFollow: records written just before the producer exits are still drained", async () => {
  const src = scripted([
    { text: "last\n", offset: 5 },
    { text: "", offset: 5 },
  ]);
  assert.equal(await collect(tailFollow(src, { ended: Promise.resolve(), sleep: noSleep })), "last\n");
});

test("tailFollow: a truncated source restarts from the offset it reports", async () => {
  const src = scripted([
    { text: "old\n", offset: 4 },
    { text: "", offset: 0 },
    { text: "new\n", offset: 4 },
    { text: "", offset: 4 },
  ]);
  let end!: () => void;
  const ended = new Promise<void>((r) => {
    end = r;
  });
  let sleeps = 0;
  assert.equal(
    await collect(
      tailFollow(src, {
        ended,
        sleep: async () => {
          if (++sleeps === 2) end();
        },
      }),
    ),
    "old\nnew\n",
  );
});

test("fileTailSource: follows appends, keeps split multibyte chars, detects truncation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sink-"));
  try {
    const p = join(dir, "events.jsonl");
    const src = fileTailSource(p);
    assert.equal(await src.read(0), null);
    const smile = Buffer.from("😀");
    writeFileSync(p, Buffer.concat([Buffer.from("x"), smile.subarray(0, 2)]));
    const a = (await src.read(0))!;
    assert.equal(a.text, "x");
    appendFileSync(p, Buffer.concat([smile.subarray(2), Buffer.from("\n")]));
    const b = (await src.read(a.offset))!;
    assert.equal(b.text, "😀\n");
    writeFileSync(p, "");
    assert.deepEqual(await src.read(b.offset), { text: "", offset: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A sandbox whose stdout is terminal noise (ANSI), exiting with `exitCode`.
const tty = (exitCode: number, oomKilled = false, stderrish = ""): SandboxHandle =>
  ({
    id: "sb",
    async *output() {
      yield { stream: "stdout" as const, chunk: `\u001b[2J\u001b[1mpi\u001b[0m\r\n${stderrish}` };
    },
    wait: async () => ({ exitCode, oomKilled }),
  }) as unknown as SandboxHandle;

const run = async (sink: TailSource, sandbox: SandboxHandle) => {
  const s = await createPiHarness({ sink: () => sink, sleep: noSleep }).start({ agent: "a", sandbox, prompt: "p" });
  const got: any[] = [];
  for await (const e of s.events()) got.push(e);
  return got;
};
const once = (text: string): TailSource =>
  scripted([
    { text, offset: text.length },
    { text: "", offset: text.length },
  ]);

test("sink mode: events come from the sink, not stdout; agent_settled yields a settled event", async () => {
  const text =
    j({ type: "message_end", message: { role: "user", content: "go" } }) +
    j({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "h" } }) +
    j({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 1, output: 2, cost: { total: 0 } } } }) +
    j({ type: "agent_settled" });
  const sandbox = {
    id: "sb",
    async *output() {
      yield { stream: "stdout" as const, chunk: "\u001b[?25l" };
    },
    wait: async () => ({ exitCode: 0 }),
  } as unknown as SandboxHandle;
  assert.deepEqual(await run(once(text), sandbox), [
    { kind: "message", role: "user", text: "go" },
    { kind: "message", role: "assistant", text: "hi" },
    { kind: "usage", inputTokens: 1, outputTokens: 2, costMicros: 0 },
    { kind: "settled" },
  ]);
});

test("sink mode: an `aborted` flag on agent_settled is carried through on the settled event", async () => {
  const sandbox = {
    id: "sb",
    async *output() {
      yield { stream: "stdout" as const, chunk: "" };
    },
    wait: async () => ({ exitCode: 0 }),
  } as unknown as SandboxHandle;
  assert.deepEqual(await run(once(j({ type: "agent_settled", aborted: true }) + j({ type: "agent_settled", aborted: false })), sandbox), [
    { kind: "settled", aborted: true },
    { kind: "settled" },
  ]);
});

test("sink mode: a user_input line becomes a user_input event (known type, no drift error)", async () => {
  const sandbox = {
    id: "sb",
    async *output() {
      yield { stream: "stdout" as const, chunk: "" };
    },
    wait: async () => ({ exitCode: 0 }),
  } as unknown as SandboxHandle;
  assert.deepEqual(await run(once(j({ type: "user_input", text: "hi" }) + j({ type: "agent_settled" })), sandbox), [
    { kind: "user_input", text: "hi" },
    { kind: "settled" },
  ]);
});

test("sink mode: an operator_diagnostic line becomes one bounded error event (known type, no drift error); a line without a message is ignored", async () => {
  const sandbox = {
    id: "sb",
    async *output() {
      yield { stream: "stdout" as const, chunk: "" };
    },
    wait: async () => ({ exitCode: 0 }),
  } as unknown as SandboxHandle;
  const big = "x".repeat(40 * 1024);
  const got = await run(
    once(
      j({ type: "operator_diagnostic", message: "operator-diagnostic a {}" }) +
        j({ type: "operator_diagnostic" }) +
        j({ type: "operator_diagnostic", message: big }) +
        j({ type: "agent_settled" }),
    ),
    sandbox,
  );
  assert.equal(got.length, 3);
  assert.deepEqual(got[0], { kind: "error", message: "operator-diagnostic a {}" });
  assert.equal(got[1].kind, "error");
  assert.ok(got[1].message.length < big.length && got[1].message.includes("truncated"));
  assert.deepEqual(got[2], { kind: "settled" });
});

test("sink mode: exit 0 without a settled record keeps the no-result prefix (exit code alone proves nothing)", async () => {
  const got = await run(once(j({ type: "message_end", message: { role: "user", content: "go" } })), tty(0));
  assert.equal(got.at(-1).kind, "error");
  assert.ok(got.at(-1).message.startsWith(PI_NO_RESULT_PREFIX));
});

test("sink mode: nonzero exit and OOM are named, and the ANSI-stripped terminal tail rides along", async () => {
  const [e143] = await run(once(""), tty(143));
  assert.ok(e143.message.startsWith(`${PI_EXIT_PREFIX}143`) && e143.message.includes("[signal=SIGTERM]"));
  const [oom] = await run(once(""), tty(0, true));
  assert.ok(oom.message.startsWith(`${PI_EXIT_PREFIX}0`) && oom.message.includes("[cause=oom_killed]"));
  const [t] = await run(once(""), tty(1, false, "\u001b[31mboom\u001b[0m"));
  assert.ok(t.message.includes("boom") && !t.message.includes("\u001b"));
});

test("sink mode: a failed assistant message and compaction failure surface as errors before settle", async () => {
  const text =
    j({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 Too Many Requests" } }) +
    j({ type: "session_compact_failed", reason: "threshold", errorMessage: "ctx", aborted: false }) +
    j({ type: "agent_settled" });
  const got = await run(once(text), tty(0));
  assert.deepEqual(got, [
    { kind: "provider_error", code: "rate_limit", message: "429 Too Many Requests", retryable: true },
    { kind: "error", message: "compaction failed: ctx" },
    { kind: "settled" },
  ]);
});

test("sink-only extension record types are not protocol drift", async () => {
  const text = j({ type: "thinking_level_select", level: "high" }) + j({ type: "session_compact", reason: "manual" }) + j({ type: "agent_settled" });
  assert.deepEqual(await run(once(text), tty(0)), [{ kind: "settled" }]);
});

test("normalize: session_compact_failed with abort is silent", () => {
  assert.deepEqual(normalize(JSON.stringify({ type: "session_compact_failed", aborted: true, errorMessage: "x" })), []);
});

test("sink path sits beside the session file; TTY env is set", () => {
  assert.equal(PI_SINK_PATH, "/workspace/.pi-session/events.jsonl");
  assert.deepEqual(PI_TTY_ENV, { TERM: "xterm-256color", COLORTERM: "truecolor" });
});

test("sink mode: agent_settled yields a settled event and the stream keeps tailing until the process exits (Esc abort, then steer)", async () => {
  // aborted turn -> settled (no result) -> user steers -> second turn -> settled -> container exit
  const text =
    j({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } }) +
    j({ type: "agent_end", messages: [] }) +
    j({ type: "agent_settled" }) +
    j({ type: "message_end", message: { role: "user", content: "steer" } }) +
    j({ type: "agent_settled" });
  const got = await run(once(text), tty(143)); // killed after the result: a prior settled keeps the exit silent
  assert.deepEqual(
    got.map((e) => e.kind),
    ["settled", "message", "settled"],
  );
});

test("sink mode: a crash in a turn started after a settle is still reported (settled is per-turn)", async () => {
  const text = j({ type: "agent_settled" }) + j({ type: "agent_start" });
  const got = await run(once(text), tty(137));
  assert.equal(got.at(-1).kind, "error");
  assert.ok(got.at(-1).message.startsWith(`${PI_EXIT_PREFIX}137`));
  // A settle that is still the last word keeps a later exit quiet.
  const quiet = await run(once(j({ type: "agent_start" }) + j({ type: "agent_settled" })), tty(143));
  assert.deepEqual(
    quiet.map((e) => e.kind),
    ["settled"],
  );
});

test("sink mode: wait() rejection yields an error event instead of throwing", async () => {
  const sb = { ...tty(0), wait: async () => Promise.reject(new Error("inspect failed")) } as unknown as SandboxHandle;
  const got = await run(once(""), sb);
  assert.equal(got.at(-1).kind, "error");
  assert.ok(got.at(-1).message.startsWith(PI_EXIT_UNKNOWN_PREFIX) && got.at(-1).message.includes("inspect failed"));
});

test("sink mode: a sink read error is reported and the exit is still classified", async () => {
  const bad: TailSource = {
    async read() {
      throw new Error("EIO");
    },
  };
  const got = await run(bad, tty(1));
  assert.ok(got[0].message.includes("sink read failed") && got[0].message.includes("EIO"));
  assert.ok(got.at(-1).message.startsWith(`${PI_EXIT_PREFIX}1`));
});

test("sink mode: exit 129 is labelled SIGHUP, not SIGTERM", async () => {
  const [e] = await run(once(""), tty(129));
  assert.ok(e.message.includes("[signal=SIGHUP]") && !e.message.includes("SIGTERM"));
});

test("normalize.events: distinct unknown record types are bounded", async () => {
  const { events, MAX_UNKNOWN_TYPES } = await import("./normalize.ts");
  const text = Array.from({ length: MAX_UNKNOWN_TYPES + 20 }, (_, i) => j({ type: `weird_${i}` })).join("");
  const got: any[] = [];
  for await (const e of events(
    (async function* () {
      yield text;
    })(),
  ))
    got.push(e);
  assert.equal(got.length, 1);
  assert.ok(got[0].message.includes('"(other)" (x20)'));
});
