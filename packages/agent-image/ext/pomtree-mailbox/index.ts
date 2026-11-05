// Pi extension 'pomtree-mailbox' (TODO(steer) design A): polls the agent inbox with POMTREE_API/POMTREE_TOKEN and
// injects new signals into the session, running or idle. Loaded by default (POMTREED_HARNESS_STEER_EXT=0 disables); UNVERIFIED live
// against a real Pi. Needs POMTREE_API (TCP); with only POMTREE_SOCKET it stays inert. Every Pi API call is wrapped so a
// missing/changed API can never crash the session; polling uses peek, and a signal is marked seen only after injection.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Dedupe, runTick } from "./mailbox.ts";

// A waiting agent only sees messages through this extension. TODO(steer): without it
// the daemon's interrupt backstop (container kill after POMTREED_AGENT_INTERRUPT_GRACE_MS) is the only interrupt mechanism.
const INTERVAL_MS = 3000; // idle poll
const BUSY_INTERVAL_MS = 400; // poll while a tool call is in flight, so interrupts feel instant

export default function (pi: ExtensionAPI) {
  try {
    const dedupe = new Dedupe();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let inFlight = 0;
    let lastCtx: { abort?: () => void } | undefined;
    let busy = false;
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let ackSeq = 0;
    const tick = async (ctx?: { abort?: () => void }) => {
      if (busy) return;
      busy = true;
      try {
        // Idle (waiting) Pi: sendUserMessage starts a turn whatever deliverAs says (the pinned Pi's prompt()); the
        // daemon journals the ack as a steer, which ends the `waiting` flag. Pi reports a failed send via its error channel,
        // not by throwing, so a rejected prompt is still acked (TODO(steer)); a throw/rejection is retried, then logged.
        // Polling goes on after an abort: the interactive Pi stays open, and an abort that did not end the turn is retried
        // (bounded) until agent_settled below marks it handled.
        await runTick({
          env: process.env,
          get: fetch as never,
          post: fetch as never,
          dedupe,
          sendUserMessage: (text, o) => (pi as any).sendUserMessage(text, o),
          abort: () => ctx?.abort?.(),
          nextAckKey: () => `ack-${nonce}-${++ackSeq}`,
          log: (line) => console.error(line),
        });
      } catch {
        // never let a poll error escape into Pi
      } finally {
        busy = false;
      }
    };
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(
        async () => {
          await tick(lastCtx);
          schedule();
        },
        inFlight > 0 || dedupe.abortPending() ? BUSY_INTERVAL_MS : INTERVAL_MS,
      );
      timer.unref?.();
    };
    // TODO(steer): the event names below are UNVERIFIED against a live Pi run.
    (pi as any).on("session_start", async (_e: unknown, ctx: unknown) => {
      try {
        lastCtx = ctx as { abort?: () => void };
        if (!timer) schedule();
      } catch {
        /* inert */
      }
    });
    (pi as any).on("tool_execution_start", async () => {
      inFlight++;
    });
    (pi as any).on("tool_execution_end", async () => {
      inFlight = Math.max(0, inFlight - 1);
    });
    // The turn settled: if an interrupt/cancel abort was in flight it took effect, and the daemon ends the run on this settle.
    (pi as any).on("agent_settled", async () => {
      try {
        if (!dedupe.turnEnded()) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = undefined;
      } catch {
        /* inert */
      }
    });
    (pi as any).on("session_shutdown", async () => {
      try {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = undefined;
      } catch {
        /* inert */
      }
    });
  } catch {
    // extension is best-effort: a changed Pi API leaves it inert
  }
}
