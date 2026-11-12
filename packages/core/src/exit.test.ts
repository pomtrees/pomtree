import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_STATE_WORDING,
  classifyExit,
  deadlineAction,
  EXIT_CAUSE_WORDING,
  EXIT_SIGNALS,
  EXIT_STATUS_WORDING,
  START_FAILURE_CAUSE,
  SandboxStartError,
} from "./index.ts";
import type { AgentState, ExitCause, ExitSignal, ExitStatus, Handoff, SandboxExitReason, Signal } from "./index.ts";

test("classifyExit maps exit codes to causes", () => {
  assert.equal(classifyExit({ exitCode: 0 }), undefined);
  assert.equal(classifyExit({ exitCode: 137, oomKilled: true }), "oom_killed");
  assert.equal(classifyExit({ exitCode: 137 }), "host_stopped");
  assert.equal(classifyExit({ exitCode: 143 }), "host_stopped");
  assert.equal(classifyExit({ exitCode: 137, cancelledByUs: true }), undefined);
  assert.equal(classifyExit({ exitCode: 125 }), "exec_failed");
  assert.equal(classifyExit({ exitCode: 126 }), "exec_failed");
  assert.equal(classifyExit({ exitCode: 127 }), "exec_failed");
  assert.equal(classifyExit({ exitCode: 139 }), "signal");
  assert.equal(classifyExit({ exitCode: 1 }), "app_exit");
});

test("EXIT_SIGNALS names only the container stop/kill signals behind a 128+n code", () => {
  assert.deepEqual(EXIT_SIGNALS, { 129: "SIGHUP", 130: "SIGINT", 137: "SIGKILL", 143: "SIGTERM" });
  const sig: ExitSignal | undefined = EXIT_SIGNALS[139];
  assert.equal(sig, undefined, "a segfault (139) is a signal exit but not a named stop signal");
});

test("classifyExit maps endpointUnreachable to endpoint_unreachable (not for clean exits)", () => {
  assert.equal(classifyExit({ exitCode: 1, endpointUnreachable: true }), "endpoint_unreachable");
  assert.equal(classifyExit({ exitCode: 0, endpointUnreachable: true }), undefined);
});

// One row per SandboxExitReason; `satisfies Record<SandboxExitReason, ...>` fails tsc when a new reason has no row.
const REASON_ROWS = {
  exited: { exitCode: 1, cause: "app_exit" },
  oom: { exitCode: 137, cause: "oom_killed" },
  killed: { exitCode: 137, cause: "host_stopped" },
  expired: { exitCode: null, cause: "sandbox_unavailable" },
  preempted: { exitCode: null, cause: "sandbox_unavailable" },
} satisfies Record<SandboxExitReason, { exitCode: number | null; cause: ExitCause }>;

test("classifyExit maps every SandboxExitReason through the table; expired and preempted are sandbox_unavailable, not agent failures", () => {
  for (const [reason, row] of Object.entries(REASON_ROWS) as [SandboxExitReason, (typeof REASON_ROWS)[SandboxExitReason]][]) {
    assert.equal(classifyExit({ exitCode: row.exitCode, reason }), row.cause, reason);
  }
  assert.ok(!["app_exit", "signal", "host_stopped"].includes(classifyExit({ exitCode: null, reason: "expired" })!));
});

test("classifyExit: a provider-ended sandbox the daemon cancelled is explained; clean and flagged exits keep their cause", () => {
  assert.equal(classifyExit({ exitCode: null, reason: "preempted", cancelledByUs: true }), undefined);
  assert.equal(classifyExit({ exitCode: 0, reason: "exited" }), undefined);
  assert.equal(classifyExit({ exitCode: 137, reason: "exited", oomKilled: true }), "oom_killed");
});

test("classifyExit: an unknown reason cast past the union falls back to the exit code, or sandbox_unavailable without one", () => {
  const unknown = "vanished" as SandboxExitReason;
  assert.equal(classifyExit({ exitCode: 1, reason: unknown }), "app_exit");
  assert.equal(classifyExit({ exitCode: 137, reason: unknown }), "host_stopped");
  assert.equal(classifyExit({ exitCode: 0, reason: unknown }), undefined);
  assert.equal(classifyExit({ exitCode: null, reason: unknown }), "sandbox_unavailable");
});

test("classifyExit: a cancelled expiry is explained like a cancelled preemption", () => {
  assert.equal(classifyExit({ exitCode: null, reason: "expired", cancelledByUs: true }), undefined);
  assert.equal(classifyExit({ exitCode: null, reason: "expired" }), "sandbox_unavailable");
});

test("classifyExit fails loudly on a missing exit code", () => {
  assert.throws(() => classifyExit({ exitCode: null, reason: "exited" }), /needs an exit code/);
  assert.throws(() => classifyExit({ exitCode: null }), /needs an exit code.*adapter must report/);
  assert.throws(() => classifyExit({ exitCode: null, reason: "killed" }), /needs an exit code/);
});

test("ExitCause includes the supervisor-assigned causes restart_exhausted and quarantined (never produced by classifyExit)", () => {
  const causes: ExitCause[] = ["restart_exhausted", "quarantined"];
  assert.deepEqual(causes, ["restart_exhausted", "quarantined"]);
  for (const exitCode of [1, 125, 137, 139, 143]) assert.ok(!causes.includes(classifyExit({ exitCode })!));
});

test("SandboxStartError carries kind and retryable", () => {
  const e = new SandboxStartError("pull_failed", "boom", true);
  assert.equal(e.kind, "pull_failed");
  assert.equal(e.retryable, true);
  assert.equal(e.name, "SandboxStartError");
});

test("Signal child_exited handoff fields are additive (the bare shape still type-checks)", () => {
  const bare: Signal = { kind: "child_exited", child: "a", exit: "failed" };
  const rich: Signal = { kind: "child_exited", child: "a", exit: "succeeded", handoff: "h", branch: "agent/a", spentMicros: 1, budgetMicros: 2, files: ["f"] };
  const h: Handoff = { summary: "s", extra: 1 };
  assert.equal(bare.kind, rich.kind);
  assert.equal(h.summary, "s");
});

test("EXIT_CAUSE_WORDING: every cause has a non-empty clause with no control characters; the start causes say what to do", () => {
  const all: ExitCause[] = [
    "oom_killed",
    "host_stopped",
    "resource_exhaustion",
    "journal_unwritable",
    "provider_error",
    "sandbox_unavailable",
    "merge_conflict",
    "empty_branch",
    "signal",
    "endpoint_unreachable",
    "exec_failed",
    "app_exit",
    "restart_exhausted",
    "quarantined",
    "passive_settle",
    "image_unavailable",
    "pull_failed",
    "start_failed",
  ];
  assert.deepEqual(Object.keys(EXIT_CAUSE_WORDING).sort(), [...all].sort());
  for (const c of all) {
    assert.ok(EXIT_CAUSE_WORDING[c].length > 10, c);
    assert.ok(![...EXIT_CAUSE_WORDING[c]].some((ch) => ch.charCodeAt(0) < 0x20), c);
  }
  assert.match(EXIT_CAUSE_WORDING.sandbox_unavailable, /expired, or preempted/);
  assert.match(EXIT_CAUSE_WORDING.image_unavailable, /image/);
});

test("START_FAILURE_CAUSE: Docker down is sandbox_unavailable; unknown and egress failures are start_failed; image kinds keep their name", () => {
  assert.equal(START_FAILURE_CAUSE.endpoint_unreachable, "sandbox_unavailable");
  assert.equal(START_FAILURE_CAUSE.image_unavailable, "image_unavailable");
  assert.equal(START_FAILURE_CAUSE.pull_failed, "pull_failed");
  assert.equal(START_FAILURE_CAUSE.unknown, "start_failed");
  assert.equal(START_FAILURE_CAUSE.egress_start_failed, "start_failed");
  // Negative: a start failure is never classified as an exit-code cause.
  for (const c of Object.values(START_FAILURE_CAUSE)) assert.ok(!["app_exit", "exec_failed", "signal"].includes(c));
});

test("EXIT_CAUSE_WORDING: every cause is a cause clause then an imperative action clause, and the circular start_failed pointer is gone", () => {
  // The shape: "<what happened>; [the operator must] <imperative verb> ...". A verb anywhere else (a cause clause that mentions
  // "free disk" or "checked") does not count as an action.
  const action = /^[^;]+; (?:the operator must )?(?:give|check|free|fix|read|start|resolve|reap|inspect|review|retry)\b/;
  // The specific action each cause names; Record<ExitCause, …> keeps this list closed with the table.
  const named: Record<ExitCause, RegExp> = {
    oom_killed: /; give it more memory/,
    host_stopped: /; check the trace's last entries and `docker events`.*then respawn$/,
    resource_exhaustion: /; free host resources and retry$/,
    journal_unwritable: /; the operator must fix the state store/,
    provider_error: /; read the run's error and provider_error entries.*then respawn$/,
    sandbox_unavailable: /; retry it: if the backend is a local engine, start it; if it is a hosted provider, check its status and your lease or quota$/,
    merge_conflict: /; resolve the conflict and merge again$/,
    empty_branch: /; reap it, or resume it/,
    signal: /; read the end of the trace and check host logs.*then respawn$/,
    endpoint_unreachable: /; the operator must fix the agent endpoint$/,
    exec_failed: /; check the image$/,
    app_exit: /; read the end of the trace.*then respawn$/,
    restart_exhausted: /; inspect the trace before respawning$/,
    quarantined: /; the operator must review it$/,
    passive_settle: /; read the trace.*then respawn with a more specific task$/,
    image_unavailable: /; fix the template or daemon image reference$/,
    pull_failed: /; retry later$/,
    start_failed: /; check that Docker is healthy and has free disk, then respawn$/,
  };
  for (const [cause, text] of Object.entries(EXIT_CAUSE_WORDING)) {
    assert.match(text, action, `${cause} has no action clause`);
    assert.match(text, named[cause as ExitCause], `${cause} lost its specific action`);
  }
  assert.match(EXIT_CAUSE_WORDING.host_stopped, /`docker events`/);
  // negative controls: cause-only sentences, including ones that mention an action verb outside an action clause
  for (const causeOnly of ["the container exploded", "the host had no free disk", "the container exploded; something checked it"])
    assert.doesNotMatch(causeOnly, action, causeOnly);
});

test("EXIT_STATUS_WORDING and AGENT_STATE_WORDING are closed over their unions, with cause and action", () => {
  // Key sets checked against the unions at compile time (`satisfies` rejects a missing or extra key), so the lists are derived.
  const statuses = Object.keys({ succeeded: 1, failed: 1, cancelled: 1, timed_out: 1, over_budget: 1 } satisfies Record<ExitStatus, 1>);
  const states = Object.keys({ pending: 1, running: 1, yielded: 1, exited: 1, reaped: 1 } satisfies Record<AgentState, 1>);
  assert.deepEqual(Object.keys(EXIT_STATUS_WORDING).sort(), [...statuses].sort());
  assert.deepEqual(Object.keys(AGENT_STATE_WORDING).sort(), [...states].sort());
  // compile-time negative control: a partial table does not type-check
  // @ts-expect-error the other statuses are missing
  const partial: Readonly<Record<ExitStatus, string>> = { succeeded: "x" };
  assert.ok(partial);
  assert.match(EXIT_STATUS_WORDING.timed_out, /^its session deadline passed/);
  assert.ok(EXIT_STATUS_WORDING.timed_out.endsWith(deadlineAction()), "the status wording uses the one deadline action");
  assert.match(deadlineAction("a-1"), /`pomtree extend a-1 --deadline DURATION`/);
  assert.match(EXIT_STATUS_WORDING.timed_out, /respawn it with a longer `--deadline`/);
  assert.doesNotMatch(EXIT_STATUS_WORDING.timed_out, /extend it with/); // an exited agent cannot be extended
  assert.match(EXIT_STATUS_WORDING.over_budget, /pomtree decide ID approve/);
  assert.match(AGENT_STATE_WORDING.reaped, /lifecycle state/);
  assert.match(AGENT_STATE_WORDING.reaped, /sandbox and clone were removed/);
  assert.match(AGENT_STATE_WORDING.reaped, /cause fields? say why/);
  assert.doesNotMatch(AGENT_STATE_WORDING.running, /lifecycle state/); // negative control
  for (const t of [...Object.values(EXIT_STATUS_WORDING), ...Object.values(AGENT_STATE_WORDING)]) assert.ok(t.length > 10);
});
