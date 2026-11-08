import type { ExtensionHost, JournalEntry } from "@pomtree/core";
import { parseUiCommand, UI_COMMAND_KIND, UI_COMMAND_PATH, UI_COMMAND_TTL_MS, UI_STREAM_PATH } from "@pomtree/observe";
import type { UiCommand } from "@pomtree/observe";

// Driving the operator web UI from a session (POST /v1/ui/command, GET /live/ui). A command is a journal entry of
// extension kind ext.observe.ui_command, so it is durable, auditable and idempotent; the stream is a view of the journal
// starting at its tail. Logic lives in the pure helpers; registerUiDrive is the thin I/O shell.

const MAX_KEY = 128;
const MAX_BODY_BYTES = 4096;
const COMMAND_PAYLOAD_KIND = `ext.observe.${UI_COMMAND_KIND}`;

// The tail seq of a journal using only read({from, limit: 1}), which yields the first row at seq >= from. A row exists at
// n iff n <= tail, so double n until it no longer exists, then bisect; pruning gaps do not matter. Null when empty.
export async function findJournalTail(read: (o: { from: number; limit: number }) => Promise<readonly { seq: number }[]>): Promise<number | null> {
  const exists = async (n: number) => (await read({ from: n, limit: 1 })).length > 0;
  if (!(await exists(0))) return null;
  let lo = 0; // exists(lo)
  let hi = 1;
  while (await exists(hi)) {
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// Commands are ephemeral in meaning: judged on the daemon clock that stamped the entry (browser skew cannot matter).
export const isFreshCommand = (now: number, ts: number): boolean => now - ts <= UI_COMMAND_TTL_MS;

export type DriveBody = { ok: true; key: string; command: UiCommand } | { ok: false; error: string };

export function parseDriveBody(body: unknown): DriveBody {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { ok: false, error: 'body must be a JSON object {"idempotencyKey": "<string>", "command": {...}}; send that shape' };
  const { idempotencyKey: key, command } = body as { idempotencyKey?: unknown; command?: unknown };
  if (typeof key !== "string" || key.trim() === "")
    return { ok: false, error: "idempotencyKey is missing or blank; send a non-blank string (the CLI generates one) so a retry journals once" };
  if (key.length > MAX_KEY) return { ok: false, error: `idempotencyKey is ${key.length} characters, over the ${MAX_KEY} limit; use a shorter key` };
  const parsed = parseUiCommand(command);
  return parsed.ok ? { ok: true, key, command: parsed.command } : { ok: false, error: parsed.error };
}

export type DriveFrame = { frame: Record<string, unknown> } | { skip: "stale" | "invalid"; message: string };

// The frame for a stored command entry, or why it is skipped.
export function commandFrame(entry: JournalEntry, now: number): DriveFrame {
  if (!isFreshCommand(now, entry.ts)) return { skip: "stale", message: `command ${entry.seq} is older than ${UI_COMMAND_TTL_MS} ms` };
  const parsed = parseUiCommand((entry.payload as { command?: unknown }).command);
  if (!parsed.ok) return { skip: "invalid", message: `stored command ${entry.seq} is invalid: ${parsed.error}` };
  return { frame: { type: "command", seq: entry.seq, ts: entry.ts, command: parsed.command } };
}

const sse = (seq: number, frame: Record<string, unknown>) => `id: ${seq}\ndata: ${JSON.stringify(frame)}\n\n`;

export function registerUiDrive(h: ExtensionHost): void {
  // Open /live/ui connections on this daemon process: transport bookkeeping (like the server's SSE counter), not domain state.
  // TODO(ui-command-ack): `tabs` counts connected streams at accept time; it is not an acknowledgement that a tab applied the command (a tab may reject it and shows its own notice). Today there is no ack route.
  // TODO(ui-command-target): every command is broadcast to all connected tabs; there is no per-tab session id to address one tab.
  let tabs = 0;
  h.journalKind({
    kind: UI_COMMAND_KIND,
    validate: (data) => {
      const p = parseUiCommand((data as { command?: unknown }).command);
      return p.ok ? true : p.error;
    },
  });

  h.route({
    method: "POST",
    path: UI_COMMAND_PATH,
    scope: { kind: "operator" },
    maxBodyBytes: MAX_BODY_BYTES,
    handler: async (req) => {
      const b = parseDriveBody(req.body);
      if (!b.ok) return { status: 400, body: { error: b.error } };
      // TODO(ui-command-retention): UI commands are an extension journal kind, so retention does not prune them (only JOURNAL_PRUNABLE_KINDS are); they accumulate under the root agent. There is no per-operator rate limit on this route, and a resume with an old Last-Event-ID scans every row since that id.
      const entry = await h.deps.record(null, UI_COMMAND_KIND, { command: b.command }, `ui-command:${b.key}`);
      // record() returns the original entry for a repeated key: the same command is a replay, a different one is a mistake.
      const stored = (entry.payload as { command?: unknown }).command;
      if (JSON.stringify(stored) !== JSON.stringify(b.command))
        return {
          status: 409,
          body: {
            error: `idempotency key ${b.key} was already used for a different command (seq ${entry.seq}); use a new --key, or omit it to get a fresh one`,
          },
        };
      return { status: 200, body: { seq: entry.seq, tabs } };
    },
  });

  h.stream({
    method: "GET",
    path: UI_STREAM_PATH,
    scope: { kind: "operator" },
    handler: async (req, conn) => {
      const raw = req.query.get("lastEventId");
      const last = Number(raw);
      const resume = raw !== null && Number.isSafeInteger(last) && last >= 0;
      let closed = false;
      let sub: { close(): void } | null = null;
      tabs++;
      conn.onClose(() => {
        if (closed) return;
        closed = true;
        tabs--;
        sub?.close();
      });
      conn.write(": connected\n\n");
      try {
        // A fresh tab starts after the tail so it never replays old commands; a reconnect resumes after its last id.
        const tail = resume ? null : await findJournalTail((o) => h.deps.journal.read(o));
        const from = resume ? last + 1 : (tail ?? 0) + 1;
        if (closed) return;
        // Priming frame (id only, no data): the page dispatches nothing but its lastEventId becomes the tail, so a reconnect
        // during a gap resumes after it instead of starting fresh and losing commands posted meanwhile.
        if (!resume) conn.write(`id: ${tail ?? 0}\n\n`);
        const s = h.deps.journal.subscribe({ from });
        sub = s;
        void (async () => {
          const warned = new Set<string>();
          for await (const e of s) {
            const p = e.payload;
            if (p.kind === COMMAND_PAYLOAD_KIND) {
              const f = commandFrame(e, h.deps.now());
              if ("frame" in f) conn.write(sse(e.seq, f.frame));
              else if (f.skip === "invalid") h.log(`live ui: ${f.message}`);
            } else if (p.kind === "spawned") {
              if (!isFreshCommand(h.deps.now(), e.ts)) continue;
              let rec: Awaited<ReturnType<typeof h.deps.getAgent>>;
              try {
                rec = await h.deps.getAgent(e.agent);
              } catch (err) {
                h.log(`live ui: agent lookup for spawned ${e.agent} failed, frame skipped: ${String(err)}`);
                continue;
              }
              if (!rec || rec.parent === null) {
                if (!warned.has(e.agent)) h.log(`live ui: spawned agent ${e.agent} has no record or no parent; not framed`);
                warned.add(e.agent);
                continue;
              }
              conn.write(sse(e.seq, { type: "spawned", seq: e.seq, agent: e.agent, parent: rec.parent }));
            }
          }
        })().catch((err) => {
          // End the connection so EventSource reconnects (and the tab gauge falls) instead of leaving a dead open stream.
          h.log(`live ui stream failed, closing so the tab reconnects: ${String(err)}`);
          conn.end();
        });
      } catch (err) {
        h.log(`live ui stream failed, closing so the tab reconnects: ${String(err)}`);
        conn.end();
      }
    },
  });
}
