// Settle policy fold (TODO(no-passive-settle)). Every legitimate settle is declared: by the agent (`pomtree result`, `pomtree yield`,
// `pomtree await-user`) or by the user (Esc, an aborted turn). Any other turn end is passive: it is nudged, and the run fails
// after MAX_PASSIVE_SETTLES in a row with no activity. A human message does NOT make the next settle `waiting`.
// Derived from the journal (never daemon memory), pure so pomtreed and tests fold it identically.
import { POMTREED_KINDS } from "./kinds.ts";
import { WAITING_KIND } from "./waiting.ts";

export const PASSIVE_SETTLE_KIND = POMTREED_KINDS.passiveSettle;
// Journaled by the daemon when `pomtree await-user` is accepted (the agent declares it waits for the human's reply).
export const AWAIT_USER_KIND = POMTREED_KINDS.awaitUser;
// Journaled by the daemon (never the agent) when a terminal viewer's websocket forwards a bare Esc byte to the pty.
export const USER_ESC_KIND = POMTREED_KINDS.userEsc;
// The sink's `aborted` flag is a file the agent can write, so a settle counts as a user abort only if the daemon also saw a
// viewer Esc within this window before it. Pi ends an aborted run within an event-loop turn plus the abort of any in-flight
// tool (a killed process group), normally well under a second; 5s covers a slow tool kill and pump lag while keeping the window
// too short to reuse an old Esc. A late settle just reads as passive (safe direction: one nudge, no lost work).
export const USER_ESC_WINDOW_MS = 5_000;
// HarnessEvent journaled for a message the user typed in the TTY (not one injected by the mailbox extension).
export const USER_INPUT_KIND = "user_input" as const;
// The Nth consecutive passive settle (N = this) fails the run; the earlier ones are nudged (so MAX - 1 nudges). Each nudge
// costs one model turn (visible as ordinary usage entries after the marker).
export const MAX_PASSIVE_SETTLES = 3;

export interface SettleState {
  passive: number; // consecutive passive settles since the last activity
  human: boolean; // an interactive message arrived that no await-user declaration or waiting settle has consumed yet
  declared: boolean; // an accepted await-user is pending for the settle that follows it
  lastEsc: number | null; // ts of the latest daemon-observed viewer Esc not yet consumed by a waiting settle
}
export const initialSettle: SettleState = { passive: 0, human: false, declared: false, lastEsc: null };

// A settle is a user abort only when the sink says aborted AND the daemon saw a viewer Esc within USER_ESC_WINDOW_MS before it.
export const isUserAbort = (s: SettleState, aborted: boolean | undefined, now: number): boolean =>
  aborted === true && s.lastEsc !== null && now - s.lastEsc >= 0 && now - s.lastEsc <= USER_ESC_WINDOW_MS;

// Interactive = typed in the TTY (`user_input`) or a message from a human to this agent (`message_received` on its journal: the
// operator, a UI `to` message or a chat-adapter `to` message).
// Activity that resets the passive count is a tool call or an interactive message (a text-only reply is not). A passive settle
// keeps `human`: the message is still unanswered. A waiting settle consumes everything.
export function settleStep(s: SettleState, e: { ts?: number; payload: { kind: string } }): SettleState {
  switch (e.payload.kind) {
    case PASSIVE_SETTLE_KIND:
      return { ...s, passive: s.passive + 1 };
    case WAITING_KIND:
      return { passive: 0, human: false, declared: false, lastEsc: null };
    case USER_ESC_KIND:
      return { ...s, lastEsc: e.ts ?? null };
    case USER_INPUT_KIND:
    case "message_received":
      return { passive: 0, human: true, declared: false, lastEsc: s.lastEsc };
    case AWAIT_USER_KIND:
      return { ...s, human: false, declared: true };
    case "tool_call":
      return { ...s, passive: 0 };
    default:
      return s;
  }
}
