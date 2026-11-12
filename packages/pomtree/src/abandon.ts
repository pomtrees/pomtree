// `pomtree abandon <agent> [--reason TEXT]`: the request body and the human text of the daemon's reply. The daemon decides what
// happened (pomtreed abandon.ts); this module only validates the reply's shape and prints it.

export type AbandonOutcome = "released" | "left" | "no_sandbox" | "already_abandoned";

export interface AbandonReply {
  agent: string;
  outcome: AbandonOutcome;
  message: string;
}

const OUTCOMES: readonly string[] = ["released", "left", "no_sandbox", "already_abandoned"];

// True when the run was abandoned but its sandbox was left on its backend (exit code 13), so scripts can tell it from a clean release.
export function abandonLeft(reply: unknown): boolean {
  return (reply as Partial<AbandonReply> | null)?.outcome === "left";
}

export function abandonBody(reason: string | undefined, idempotencyKey: string): { reason?: string; idempotencyKey: string } {
  return reason === undefined || reason === "" ? { idempotencyKey } : { reason, idempotencyKey };
}

// The reply's message already names what happened (killed / left on X / already abandoned) and, for left, the cause and the action.
export function renderAbandon(reply: unknown): string {
  const r = reply as Partial<AbandonReply> | null;
  if (r === null || typeof r !== "object" || typeof r.message !== "string" || typeof r.outcome !== "string" || !OUTCOMES.includes(r.outcome)) {
    throw new Error(
      "the daemon's abandon reply has an unexpected shape, so its outcome is unknown; check `pomtree show <agent>` for the agent's state, and update pomtree or pomtreed if their versions differ",
    );
  }
  return r.message;
}
