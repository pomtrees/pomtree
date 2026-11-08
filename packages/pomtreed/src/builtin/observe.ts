import type { AgentId, Extension, ExtensionDeps, ExtensionHost, Journal, WaitCondition } from "@pomtree/core";
import { buildTree, displayRows, encodeSseFrame, LiveStream, OtlpExporter, renderLivePage, renderReportsPage } from "@pomtree/observe";
import { registerUiDrive } from "./uiDrive.ts";
import type { OtlpExporterOptions, RunHandle } from "@pomtree/observe";

// The built-in observe extension: the operator-facing live view (GET /live, GET /live/events, GET /live/messages) and
// reports page (GET /reports), plus the OTLP trace exporter. The
// daemon knows nothing about SSE clients or OTLP; it only supplies journal/registry access and the
// wait snapshot through host.deps / the constructor options.

export interface ObserveExtensionOptions {
  otlp?: OtlpExporterOptions; // passed straight through; no endpoint means no exporter runs
  includeContent?: boolean; // prompt/tool text in the live tree (off by default)
  // Wait data for yielded agents, supplied by the daemon (daemon.liveWaits()). The live page can
  // render without it, so a missing accessor just yields an empty map.
  waits?: () => Promise<ReadonlyMap<AgentId, WaitCondition>>;
}

// OtlpExporter.run takes a full Journal but only ever calls subscribe(); the extension host exposes
// read+subscribe only (append goes through host.deps.record), so adapt it here.
const asJournal = (deps: ExtensionDeps): Journal => ({
  read: (o) => deps.journal.read(o),
  subscribe: (o) => deps.journal.subscribe(o),
  append: () => Promise.reject(new Error("extension journal is read-only; use deps.record")),
  pruneJournal: () => Promise.reject(new Error("extension journal is read-only")),
  spendFor: () => Promise.reject(new Error("extension journal is read-only")),
});

// TODO(ui-hardening): 'unsafe-inline' is needed until the shells' inline styles and scripts move to static files.
// Both shells inline their CSS and script and use only same-origin EventSource/fetch; the reports page also embeds
// same-origin /render output in an iframe or img. Neither page has a form.
const SHELL_CSP = (embeds: string) =>
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'${embeds}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const shellHeaders = (embeds = "") => ({
  "content-security-policy": SHELL_CSP(embeds),
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
});

export function createObserveExtension(opts: ObserveExtensionOptions = {}): Extension {
  let host: ExtensionHost | null = null;
  let otlpRun: RunHandle | null = null;
  return {
    manifest: { name: "observe", entry: "builtin", capabilities: { routes: true, journalKinds: true }, deps: ["registry", "journal", "record"] },
    init(h) {
      host = h;
      const waits = async (): Promise<ReadonlyMap<AgentId, WaitCondition>> => (opts.waits ? await opts.waits() : new Map<AgentId, WaitCondition>());

      h.route({
        method: "GET",
        path: "/live",
        scope: { kind: "public" },
        handler: () => ({
          status: 200,
          body: renderLivePage({ eventsPath: "/live/events" }),
          contentType: "text/html; charset=utf-8",
          headers: shellHeaders(),
        }),
      });

      h.stream({
        method: "GET",
        path: "/live/events",
        // Operator-only: the tree is sensitive, and the EventSource already
        // authenticates via the operator UI cookie; `public` would leak it to anyone on the UI port.
        scope: { kind: "operator" },
        handler: async (_req, conn) => {
          // One LiveStream per connection, rebuilt from the journal on connect; conn.onClose ends it.
          const stream = new LiveStream({ includeContent: opts.includeContent });
          const sub = h.deps.journal.subscribe({});
          conn.onClose(() => sub.close());
          conn.write(": connected\n\n");
          conn.write(encodeSseFrame(stream.frame(await h.deps.listAgents(), { now: h.deps.now(), waits: await waits() })));
          void (async () => {
            for await (const e of sub) {
              if (stream.apply(e)) {
                conn.write(encodeSseFrame(stream.frame(await h.deps.listAgents(), { now: h.deps.now(), waits: await waits() })));
              }
            }
          })().catch((err) => h.log(`live stream failed: ${String(err)}`));
        },
      });

      // The UI channel's push: one SSE frame per `message_sent` on channel `ui`, `id: <journal seq>`. Starts at `from` (or
      // after Last-Event-ID, which the server passes in as `lastEventId`, whichever is later), then follows the journal.
      h.stream({
        method: "GET",
        path: "/live/messages",
        scope: { kind: "operator" },
        handler: (req, conn) => {
          const num = (k: string): number => {
            const n = Number(req.query.get(k));
            return req.query.get(k) !== null && Number.isSafeInteger(n) && n >= 0 ? n : -1;
          };
          const from = Math.max(num("from"), num("lastEventId") + 1, 0);
          const sub = h.deps.journal.subscribe({ from });
          conn.onClose(() => sub.close());
          conn.write(": connected\n\n");
          void (async () => {
            for await (const e of sub) {
              const p = e.payload;
              if (p.kind !== "message_sent" || p.channel !== "ui") continue;
              const data = {
                seq: e.seq,
                agent: e.agent,
                channel: p.channel,
                purpose: p.purpose,
                subject: p.subject,
                ...(p.replyTo !== undefined && { replyTo: p.replyTo }),
                createdAt: e.ts,
              };
              conn.write(`id: ${e.seq}\ndata: ${JSON.stringify(data)}\n\n`);
            }
          })().catch((err) => h.log(`live messages stream failed: ${String(err)}`));
        },
      });

      registerUiDrive(h);

      h.route({
        method: "GET",
        path: "/reports",
        scope: { kind: "public" },
        handler: () => ({
          status: 200,
          body: renderReportsPage(),
          contentType: "text/html; charset=utf-8",
          headers: shellHeaders("; img-src 'self'; frame-src 'self'"),
        }),
      });

      // Operator-facing snapshot of the live tree: the same pre-formatted display rows the live view
      // streams, fetched as plain JSON so `pomtree top` can render them without importing observe.
      h.route({
        method: "GET",
        path: "/v1/tree",
        scope: { kind: "operator" },
        handler: async () => {
          const agents = await h.deps.listAgents();
          const entries = await h.deps.journal.read({});
          const rows = buildTree(agents, entries, { now: h.deps.now(), waits: await waits(), includeContent: opts.includeContent });
          return { status: 200, body: displayRows(rows) };
        },
      });
    },
    async start() {
      if (!opts.otlp?.endpoint || !host) return;
      const exporter = new OtlpExporter(opts.otlp);
      otlpRun = exporter.run(asJournal(host.deps));
      void otlpRun.catch((e) => host!.log(`otlp exporter failed: ${String(e)}`));
    },
    async stop() {
      const run = otlpRun;
      otlpRun = null;
      if (run) {
        run.close();
        await run.catch((e) => host?.log(`otlp exporter failed: ${String(e)}`));
      }
    },
  };
}
