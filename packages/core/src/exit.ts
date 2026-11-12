import type { SandboxStartError } from "./errors.ts";
import type { SandboxExitReason } from "./ports.ts";
import type { AgentState, ExitCause, ExitStatus } from "./types.ts";

// Signals named by a shell-style 128+n exit code. Only the ones a stop or kill of a container produces. The one table that
// names a signal behind an observed exit code (journal `exited` detail, harness exit messages).
export const EXIT_SIGNALS: Readonly<Record<number, "SIGHUP" | "SIGINT" | "SIGKILL" | "SIGTERM">> = {
  129: "SIGHUP",
  130: "SIGINT",
  137: "SIGKILL",
  143: "SIGTERM",
};
export type ExitSignal = (typeof EXIT_SIGNALS)[number];

// Pure classification of a sandbox exit into an ExitCause (undefined = clean exit or an exit
// the daemon itself explains, e.g. a cancel it requested). Unexplained 137/143 mean something
// outside the daemon stopped the container. `reason` is the port's SandboxExitReason when the backend reports one: "expired" and
// "preempted" mean the provider ended the sandbox (exit code null), which is not an agent failure, so they end as the retryable
// sandbox_unavailable; "oom" is oom_killed like the `oomKilled` flag. Rules: a null exit code with reason exited, killed or none is an
// adapter contract breach and throws; a reason outside the union (a newer adapter, cast past the type) does not throw: it falls back
// to the exit-code logic, or to sandbox_unavailable when the code is null.
export function classifyExit(o: {
  exitCode: number | null;
  reason?: SandboxExitReason;
  oomKilled?: boolean;
  cancelledByUs?: boolean;
  endpointUnreachable?: boolean;
}): ExitCause | undefined {
  switch (o.reason) {
    case undefined:
    case "exited":
    case "killed":
      break;
    case "oom":
      // Open question for the exit-reason-wiring follow-up: `reason: "oom"` with a code other than 137 skips the daemon's 137 gate
      // (daemon-util `classifySandboxExit` only trusts oomKilled with 137) once the daemon passes the reason through.
      return "oom_killed";
    case "expired":
    case "preempted":
      return o.cancelledByUs ? undefined : "sandbox_unavailable";
    default:
      if (o.exitCode === null) return "sandbox_unavailable";
  }
  if (o.exitCode === null) {
    throw new Error(
      `classifyExit: exit reason ${o.reason ?? "(none)"} needs an exit code; only expired and preempted exits have none, so the adapter must report one`,
    );
  }
  if (o.oomKilled) return "oom_killed";
  if (o.exitCode === 0) return undefined;
  if (o.endpointUnreachable) return "endpoint_unreachable";
  if (o.cancelledByUs) return undefined;
  switch (o.exitCode) {
    case 137:
    case 143:
      return "host_stopped";
    case 125:
    case 126:
    case 127:
      return "exec_failed";
    case 139:
      return "signal";
    default:
      return o.exitCode > 128 ? "signal" : "app_exit";
  }
}

// The one wording table for exit causes: a short clause for a parent agent's synthesized handoff and the operator, saying what
// happened and what to do. Record<ExitCause, …> makes the table closed: a new cause without wording fails the build.
export const EXIT_CAUSE_WORDING: Readonly<Record<ExitCause, string>> = {
  oom_killed: "the container ran out of memory; give it more memory (template memoryBytes) or do less at once",
  host_stopped: "something outside pomtree stopped or killed the container; check the trace's last entries and `docker events` on the host, then respawn",
  resource_exhaustion: "the host ran out of a resource (disk, processes or memory) while starting or running it; free host resources and retry",
  journal_unwritable: "the daemon could not write its journal; the operator must fix the state store (disk space, permissions), then respawn",
  provider_error:
    "the model provider failed (auth, funding, configuration or repeated outages); read the run's error and provider_error entries for which, fix that, then respawn",
  sandbox_unavailable:
    "the sandbox backend was unreachable or ended the sandbox (engine down, lease expired, or preempted); retry it: if the backend is a local engine, start it; if it is a hosted provider, check its status and your lease or quota",
  merge_conflict: "its branch conflicted with the merge target; resolve the conflict and merge again",
  empty_branch: "it pushed no commits, so there was nothing to merge; reap it, or resume it with a clearer task if work was expected",
  signal: "the agent process was killed by a signal pomtree did not send; read the end of the trace and check host logs (dmesg), then respawn",
  endpoint_unreachable: "the container could not reach the daemon API, so it could not call pomtree; the operator must fix the agent endpoint",
  exec_failed: "the container could not run its command (exit 125-127); check the image",
  app_exit: "the agent process exited non-zero on its own; read the end of the trace for its last output, then respawn",
  restart_exhausted: "it died repeatedly and its restart allowance is spent; inspect the trace before respawning",
  quarantined: "it is quarantined and is not resumed automatically; the operator must review it",
  passive_settle:
    "it ended turn after turn without a result, yield or activity; read the trace to see what it was doing, then respawn with a more specific task",
  image_unavailable: "its container image does not exist or cannot be pulled; fix the template or daemon image reference",
  pull_failed: "pulling its container image failed (registry or network); retry later",
  start_failed:
    "its container could not start (the run's error entry names the kind and the cause); check that Docker is healthy and has free disk, then respawn",
};

// SandboxStartError.kind to the exit cause a failed start ends with. Closed like the wording table. `endpoint_unreachable` here
// is the Docker engine being down (not the agent API endpoint), so it ends as sandbox_unavailable.
export const START_FAILURE_CAUSE: Readonly<Record<SandboxStartError["kind"], ExitCause>> = {
  image_unavailable: "image_unavailable",
  pull_failed: "pull_failed",
  endpoint_unreachable: "sandbox_unavailable",
  egress_start_failed: "start_failed",
  unknown: "start_failed",
};

// Operator action sentences that more than one package prints. Each lives only here; the adapter, the daemon and pomtree import it.
// The one copy outside core is the egress proxy's config refusal (sandbox-docker audit.ts ships into the image without core);
// audit.test.ts asserts it equals IMAGE_REBUILD_ACTION.
export const DOCKER_GROUP_ACTION = "add your user to the docker group (sudo usermod -aG docker $USER), then log out and back in";
export const IMAGE_REBUILD_ACTION = "rebuild the agent image from the current checkout (scripts/pomtree-up --rebuild), then restart pomtreed";
// What to do about a passed session deadline; `id` fills the `pomtree extend` example (the glossary keeps the `ID` placeholder).
export const deadlineAction = (id = "ID"): string =>
  `respawn it with a longer \`--deadline\` (an operator can extend a live agent with \`pomtree extend ${id} --deadline DURATION\` before it fires)`;

// The wording for the exit status line (the trace header's "ended because"). Closed like the cause table.
export const EXIT_STATUS_WORDING: Readonly<Record<ExitStatus, string>> = {
  succeeded: "it reported a result and finished",
  failed: "it ended without a successful result; the cause (if any) and the trace's error entries say why, then respawn",
  cancelled: "an operator or its parent cancelled it; respawn if the work is still wanted",
  timed_out: `its session deadline passed (the trace's timed-out error entry says when); ${deadlineAction()}`,
  over_budget: "its budget was spent; approve its budget_raise request with `pomtree decide ID approve --grant $USD`, or respawn it with a larger `--budget`",
};

// The wording for the lifecycle state, closed over AgentState so a glossary can later be generated from it; today only `.reaped`
// has a consumer (the trace header). `reaped` is a state, not an outcome: the cause field is what says why it ended.
export const AGENT_STATE_WORDING: Readonly<Record<AgentState, string>> = {
  pending: "queued and not yet started; it starts when placement admits it",
  running: "its harness is executing now",
  yielded: "parked at a checkpoint, waiting on a timer, message, child or approval; it resumes when the wait is satisfied",
  exited: "finished; the exit status and cause say how, and its sandbox and clone are kept until it is reaped",
  reaped: "a lifecycle state, not an outcome: its sandbox and clone were removed; the exit status and cause fields say why it ended",
};
