// Pi extension 'pomtree-events': appends every extension-API event as one JSON line to a sink file so the
// daemon can read structured events while the human-facing surface is an interactive TUI on a TTY. Always loaded.
// Every call is wrapped: a failed write or a changed Pi API can never crash or stall the session.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SINK_PATH, SINK_EVENTS, sinkLine } from "./events.ts";

// Beside the session file (the bind-mounted dir), so the host reads it without a new mount.
const SINK_PATH = process.env.PTREE_EVENTS_SINK || DEFAULT_SINK_PATH;

export default function (pi: ExtensionAPI) {
  try {
    try {
      mkdirSync(dirname(SINK_PATH), { recursive: true });
      writeFileSync(SINK_PATH, ""); // one process = one run: a resumed session must not replay the previous run's records
    } catch {
      /* surfaced by the reader seeing no records */
    }
    for (const type of SINK_EVENTS) {
      try {
        // TODO(keepopen): pi stays open after agent_settled (also after an Esc abort); this extension only records the settled line and never calls ctx.shutdown(). The daemon reads a user-aborted settle (`aborted` on the line) as `waiting` (container kept); any other settle without a result is a passive settle the daemon nudges (TODO(no-passive-settle)); yield-from-TUI is still undefined.
        (pi as any).on(type, async (event: unknown) => {
          const line = sinkLine(event);
          if (line === undefined) return;
          try {
            appendFileSync(SINK_PATH, line);
          } catch {
            /* never throw into Pi */
          }
        });
      } catch {
        /* an event name this Pi does not know stays unsubscribed */
      }
    }
  } catch {
    // best-effort: a changed Pi API leaves the extension inert (the harness then reports no result)
  }
}
