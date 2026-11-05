import { classifyExit, EXIT_SIGNALS } from "@pomtree/core";
import type { AgentId, Harness, HarnessEvent, HarnessSession, SandboxHandle } from "@pomtree/core";
import { events as piEvents } from "./normalize.ts";
import { stripControl } from "./control.ts";
import { PI_SINK_PATH } from "./pi-format.ts";
import { SafeOpenError } from "./safe-open.ts";
import { tailFollow, type TailSource } from "./tail.ts";

export interface PiHarnessDeps {
  // steer/stop are injected: SandboxHandle has no stdin and Pi's RPC-mode protocol is unverified (see TODO(steer) below).
  // stop is an optional extra signal to the process; session.stop() ends the event stream whether or not it is wired.
  steer?: (agent: AgentId, message: string) => Promise<void>;
  stop?: (agent: AgentId) => Promise<void>;
  // Where structured events come from. Pi runs in interactive-TTY mode, so stdout is the terminal and events are
  // tail-followed from the pomtree-events file (PI_SINK_PATH in the container, <sessionHostDir>/events.jsonl on the
  // host: see fileTailSource).
  sink: (agent: AgentId) => TailSource;
  sinkPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const STDERR_TAIL = 2000;
// Stable machine-distinguishable error message prefixes (the daemon ignores these when an interrupt is pending).
export const PI_EXIT_PREFIX = "pi exited with code ";
export const PI_NO_RESULT_PREFIX = "agent ended without reporting a result";
export const PI_EXIT_UNKNOWN_PREFIX = "pi exit status unavailable";
export const PI_SINK_REFUSED_PREFIX = "pi event sink refused";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// A TTY merges stderr into the terminal stream, so the diagnostic tail carries colour/cursor escapes and spinner redraws (CR):
// stripControl removes them, one definition with the event text in pi-format.ts.

// `stopped` settles when the caller stops the session: the sink is drained once more and the stream ends without waiting for
// the container, which an interactive Pi keeps alive after an abort and which a failed kill leaves running.
async function* events(
  sandbox: SandboxHandle,
  sink: TailSource,
  tailOpts: { pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  stopped: Promise<void> = new Promise<void>(() => {}),
): AsyncGenerator<HarnessEvent> {
  let raw = "";
  let tail = "";
  let settled = false;
  // The terminal stream is only a diagnostic tail here; the sink carries the records.
  const exit = sandbox.wait();
  exit.catch(() => {}); // rejection is handled below; never leave it unhandled
  // Exit wins a tie with stop, so an exit already observed is still classified.
  const ended = Promise.race([
    exit.then(
      () => "exit" as const,
      () => "exit" as const,
    ),
    stopped.then(() => "stop" as const),
  ]);
  const drain = (async () => {
    for await (const o of sandbox.output()) {
      // Strip the accumulated text, not each chunk, so an escape sequence split across chunks is still removed.
      raw = (raw + o.chunk).slice(-STDERR_TAIL * 4);
      tail = stripControl(raw).slice(-STDERR_TAIL);
    }
  })().catch(() => {});
  // A sink read error (EIO, ...) must not end the generator by throwing: stop tailing, report it, and still classify the exit.
  let tailError: unknown;
  const safeTail = async function* () {
    try {
      yield* tailFollow(sink, {
        ended,
        ...(tailOpts.pollMs !== undefined && { pollMs: tailOpts.pollMs }),
        ...(tailOpts.sleep && { sleep: tailOpts.sleep }),
      });
    } catch (e) {
      tailError = e;
    }
  };
  yield* piEvents(
    safeTail(),
    undefined,
    () => {
      settled = true;
    },
    true,
    () => {
      settled = false; // a new turn began: only a settle that is still the last word excuses a later crash
    },
  );
  // A refused sink (the agent planted a FIFO, symlink or device as events.jsonl) is fatal: the container would otherwise run on
  // unobserved. Ending the stream here is the daemon's fatal path: the pump ends, settle stops the sandbox and the run fails with
  // this error journaled. The message names the container path, never the host one.
  if (tailError instanceof SafeOpenError) {
    yield {
      kind: "error",
      message: `${PI_SINK_REFUSED_PREFIX}: ${tailError.describe(PI_SINK_PATH)}; the run is stopped because its events can no longer be read`,
    };
    return;
  }
  if (tailError !== undefined) yield { kind: "error", message: `pi event sink read failed: ${errText(tailError)}` };
  if (settled) return;
  if ((await ended) === "stop") return; // the caller ended the run; it classifies the sandbox exit itself (settle)
  let exitCode: number;
  let oomKilled: boolean | undefined;
  try {
    ({ exitCode, oomKilled } = await exit);
  } catch (e) {
    await drain;
    yield { kind: "error", message: `${PI_EXIT_UNKNOWN_PREFIX}: ${errText(e)}` };
    return;
  }
  await drain;
  // TODO(exitclass): an interactive pi exits 0 even on SIGTERM (Pi's interactive-mode.js), so in sink mode a clean exit
  // with no settled record cannot be told from a kill or a user quit. Classifying it needs container state (stop reason,
  // finishedAt, who requested the stop) that SandboxHandle.wait() does not expose; current behavior: only oomKilled or a
  // nonzero code names a cause, otherwise PI_NO_RESULT_PREFIX.
  if (exitCode !== 0 || oomKilled) {
    // TODO(auth-perms): the host-side staged auth.json may be unreadable by the image uid; name the cause.
    const authHint = /(EACCES|permission denied)[^\n]*auth\.json|auth\.json[^\n]*(EACCES|permission denied)/i.test(tail)
      ? " [auth.json is not readable by the container user (uid 1000); fix the staged file's ownership/mode]"
      : "";
    // The error event has no cause field (core), so the classified cause rides in the message.
    const cause = classifyExit({ exitCode, oomKilled });
    const signal: string | undefined = Object.hasOwn(EXIT_SIGNALS, exitCode) ? EXIT_SIGNALS[exitCode] : undefined;
    const message = `${PI_EXIT_PREFIX}${exitCode}${signal ? ` [signal=${signal}]` : ""}${cause && cause !== "app_exit" ? ` [cause=${cause}]` : ""}${tail.trim() ? `: ${tail.trim()}` : ""}${authHint}`;
    // The tail is terminal output a page or tool can write, so nothing in it is classified: words like "Author", "OAuth" or
    // "HTTP 429" in it must not turn an OOM kill into an auth stop or a provider backoff. Provider failures come only from Pi's
    // structured records (message_end errorMessage and diagnostics, auto_retry_end; providerFailure in pi-format.ts).
    yield { kind: "error", message };
  } else {
    // A clean exit with no `agent_settled` means Pi never reported a result: surface it instead
    // of letting the run settle `failed` with no journal line.
    yield { kind: "error", message: `${PI_NO_RESULT_PREFIX} (exit ${exitCode}, settled=false)` };
  }
}

export function createPiHarness(deps: PiHarnessDeps): Harness {
  const open = (agent: AgentId, sandbox: SandboxHandle): HarnessSession => {
    let markStopped = () => {};
    const stopped = new Promise<void>((r) => (markStopped = r));
    return {
      session: agent,
      events: () => events(sandbox, deps.sink(agent), { pollMs: deps.sinkPollMs, sleep: deps.sleep }, stopped),
      // TODO(steer): needs SandboxHandle stdin or RPC mode (`--mode rpc`, unverified)
      steer: async (m) => {
        if (!deps.steer) throw new Error("steer unsupported: Pi RPC mode not wired");
        await deps.steer(agent, m);
      },
      // Ends events() at once (drain, then done) even while the container lives. TODO(steer): the process itself is signalled only
      // by an injected deps.stop (none is wired: SandboxHandle cannot signal it); the caller kills or stops the sandbox.
      stop: async () => {
        markStopped();
        await deps.stop?.(agent);
      },
    };
  };
  // The sandbox is started by the caller with piArgv() as its cmd; the harness only consumes output.
  return {
    start: async ({ agent, sandbox }) => open(agent, sandbox),
    resume: async ({ agent, sandbox }) => open(agent, sandbox),
  };
}
