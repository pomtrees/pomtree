import { StaleGenerationError } from "@pomtree/core";
import type { AgentId, AgentRecord, Extension, ExtensionHost, ExtensionRequest, ExtensionResponse, Report, ReportId, ReportStore } from "@pomtree/core";
import { IDEMPOTENCY_QUERY_KEY_REQUIRED } from "../error-codes.ts";
import { LifecycleError } from "../lifecycle.ts";
import { inferMediaType, isAllowedMediaType, reportIdFor, sha256hex, slugifyReportName } from "../reports.ts";
import { principalOf } from "../route-match.ts";

// The built-in reports extension: owns the report store and the report routes (`pomtree report
// publish|list|show|rm`), with a generation-fenced store write (StaleGenerationError -> 409). The daemon
// holds the report store only to remove an agent's reports when it is reaped.

export interface ReportsExtensionOptions {
  store: ReportStore; // the DirReportStore (already a pomtreed dep), constructed by the host
  reportMaxBytes: number; // caps the raw publish body
}

// Map a thrown LifecycleError/StaleGenerationError to a response (400/403/404/409 with an `error` body).
function err(e: unknown): ExtensionResponse {
  if (e instanceof LifecycleError) return { status: e.status, body: { error: e.message, ...e.extra } };
  if (e instanceof StaleGenerationError) return { status: 409, body: { error: e.message } };
  return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
}

// Active types (script-capable) are served as attachments: base type compared case-insensitively, parameters ignored.
export function isActiveMediaType(mediaType: string): boolean {
  const base = mediaType.split(";")[0]!.trim().toLowerCase();
  return base === "text/html" || base === "image/svg+xml" || base === "application/xhtml+xml";
}

// Media types the render endpoint will serve inline: active documents (shown in a sandboxed iframe) and inert images.
export function isRenderableMediaType(mediaType: string): boolean {
  const base = mediaType.split(";")[0]!.trim().toLowerCase();
  return isActiveMediaType(base) || ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(base);
}

// The CSP on every inline-rendered report: sandbox (opaque origin, no script/forms/popups/top-nav) plus a
// policy that independently blocks script and all network, so a report can neither run code nor exfiltrate.
export const REPORT_RENDER_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export function createReportsExtension(opts: ReportsExtensionOptions): Extension & {
  publish(
    agent: AgentId,
    o: { name?: string; mediaType?: string; generation?: number; key: string; content: Uint8Array },
  ): Promise<{ report: Report; replayed: boolean }>;
} {
  let host: ExtensionHost | null = null;
  const store = opts.store;

  // The per-request target resolution: reads the principal the server/API injected into the request.
  // An operator addresses any id; an agent addresses itself and its own children.
  const resolveReqTarget = async (req: ExtensionRequest, allowChild: boolean): Promise<AgentId> => {
    const p = principalOf(req);
    const raw = req.params.id!;
    if (!p) throw new LifecycleError(401, "missing or invalid token");
    if (raw === "self") {
      if (p.scope !== "agent") throw new LifecycleError(400, "'self' needs an agent credential");
      return p.agent;
    }
    if (p.scope === "agent" && p.agent !== raw) {
      if (allowChild) {
        const c = await host!.deps.getAgent(raw);
        if (c && c.parent === p.agent) return raw;
      }
      throw new LifecycleError(403, allowChild ? "agents may only address themselves and their children" : "agents may only address themselves");
    }
    return raw;
  };

  // `pomtree report publish`: the agent posts raw bytes; the host is authoritative for the slug, media type,
  // size, and hash. Fenced on the sender's claimed generation (StaleGenerationError -> 409) and idempotent
  // by the deterministic report id. Journals `report_published` via deps.record (namespaced ext.reports.*).
  async function publish(
    agent: AgentId,
    o: { name?: string; mediaType?: string; generation?: number; key: string; content: Uint8Array },
  ): Promise<{ report: Report; replayed: boolean }> {
    const deps = host!.deps;
    const a = await deps.getAgent(agent);
    if (!a) throw new LifecycleError(404, `no such agent: ${agent}`);
    if (a.state !== "running") throw new LifecycleError(409, `agent is ${a.state}, not running`);
    if (o.generation === undefined) throw new LifecycleError(400, "generation is required");
    let slug: string;
    let mediaType: string;
    try {
      slug = slugifyReportName(o.name ?? "report");
      if (o.mediaType !== undefined && !isAllowedMediaType(o.mediaType, slug)) throw new Error(`unsupported media type: ${o.mediaType}`);
      mediaType = o.mediaType ?? inferMediaType(slug);
    } catch (e) {
      throw new LifecycleError(400, e instanceof Error ? e.message : String(e));
    }
    const sizeBytes = o.content.length;
    const sha256 = sha256hex(o.content);
    const id = reportIdFor(agent, slug, o.key);
    // Replay detection: a report is "replayed" when the id already exists before the write.
    const prior = await store.read(agent, id);
    const report = await store.write(
      {
        id,
        agent,
        generation: o.generation,
        host: a.host,
        name: slug,
        mediaType,
        sizeBytes,
        sha256,
        content: o.content,
      },
      `${agent}:${id}`,
    );
    // Always journal (keyed, so idempotent): a crash between the store write and this journal write must
    // not leave a published report that never appears in the journal; a replay converges on the same entry.
    await deps.record(agent, "report_published", { report: id, name: slug, sizeBytes }, `${agent}:${id}:published`);
    return { report, replayed: prior !== null };
  }

  const list = (agent: AgentId) => store.list(agent);

  const listAll = async (): Promise<{ report: Report; agent: AgentId }[]> => {
    const out: { report: Report; agent: AgentId }[] = [];
    for (const a of await host!.deps.listAgents()) {
      for (const report of await store.list(a.id)) out.push({ report, agent: a.id });
    }
    return out;
  };

  const read = (agent: AgentId, id: ReportId) => store.read(agent, id);
  const remove = (agent: AgentId, id: ReportId) => store.remove(agent, id);

  return {
    manifest: {
      name: "reports",
      entry: "builtin",
      store: { name: "reports" },
      capabilities: { routes: true, journalKinds: true },
      deps: ["registry", "record"],
    },
    init(h) {
      host = h;
      h.journalKind({
        kind: "report_published",
        validate: (d) => {
          if (typeof d !== "object" || d === null || Array.isArray(d)) return "report_published data must be an object";
          const o = d as Record<string, unknown>;
          if (typeof o.report !== "string") return "report_published.report must be a string";
          if (typeof o.name !== "string") return "report_published.name must be a string";
          if (typeof o.sizeBytes !== "number") return "report_published.sizeBytes must be a number";
          return true;
        },
      });

      // POST /v1/agents/self/reports — publish (agent only, raw body capped at reportMaxBytes).
      h.route({
        method: "POST",
        path: "/v1/agents/self/reports",
        scope: { kind: "agent", self: true },
        rawBody: true,
        maxBodyBytes: opts.reportMaxBytes,
        handler: async (req) => {
          try {
            const p = principalOf(req);
            if (!p || p.scope !== "agent") throw new LifecycleError(403, "agent scope required");
            if (!(req.body instanceof Uint8Array)) throw new LifecycleError(400, "report body must be raw bytes");
            const q = req.query;
            const key = q.get("key");
            if (!key) throw new LifecycleError(400, IDEMPOTENCY_QUERY_KEY_REQUIRED);
            const genRaw = q.get("generation");
            if (genRaw === null) throw new LifecycleError(400, "generation is required");
            const generation = Number(genRaw);
            if (!Number.isInteger(generation) || generation < 0) throw new LifecycleError(400, "generation must be a non-negative integer");
            const out = await publish(p.agent, {
              name: q.get("name") ?? undefined,
              mediaType: q.get("mediaType") ?? undefined,
              generation,
              key,
              content: req.body,
            });
            return { status: out.replayed ? 200 : 201, body: out };
          } catch (e) {
            return err(e);
          }
        },
      });

      // GET /v1/reports — every agent's reports flattened into { report, agent } rows (operator only).
      h.route({
        method: "GET",
        path: "/v1/reports",
        scope: { kind: "operator" },
        handler: async () => {
          try {
            return { status: 200, body: await listAll() };
          } catch (e) {
            return err(e);
          }
        },
      });

      // GET /v1/agents/:id/reports — list one agent's reports (operator, or agent self-child).
      const listHandler = async (req: ExtensionRequest): Promise<ExtensionResponse> => {
        try {
          return { status: 200, body: await list(await resolveReqTarget(req, true)) };
        } catch (e) {
          return err(e);
        }
      };
      h.route({ method: "GET", path: "/v1/agents/:id/reports", scope: { kind: "operator" }, handler: listHandler });
      h.route({ method: "GET", path: "/v1/agents/:id/reports", scope: { kind: "agent", allowChild: true }, handler: listHandler });

      // GET /v1/agents/:id/reports/:rid — read metadata, or the raw bytes with ?raw=1 (inert download).
      const readHandler = async (req: ExtensionRequest): Promise<ExtensionResponse> => {
        try {
          const target = await resolveReqTarget(req, true);
          const entry = await read(target, req.params.rid!);
          if (!entry) throw new LifecycleError(404, "no such report");
          if (req.query.get("raw") === "1") {
            // Raw downloads carry the agent-chosen media type; serve them inert so a hostile HTML/SVG
            // report cannot run script on the operator origin (nosniff + sandbox, and attachment for active types).
            const headers: Record<string, string> = {
              "x-content-type-options": "nosniff",
              "content-security-policy": "sandbox",
            };
            if (isActiveMediaType(entry.report.mediaType)) {
              headers["content-disposition"] = "attachment";
            }
            return { status: 200, body: entry.content, contentType: entry.report.mediaType, headers };
          }
          return { status: 200, body: entry.report };
        } catch (e) {
          return err(e);
        }
      };
      h.route({ method: "GET", path: "/v1/agents/:id/reports/:rid", scope: { kind: "operator" }, handler: readHandler });
      h.route({ method: "GET", path: "/v1/agents/:id/reports/:rid", scope: { kind: "agent", allowChild: true }, handler: readHandler });

      // GET /v1/agents/:id/reports/:rid/render — inline view for the UI's sandboxed iframe / <img> (operator only).
      // Never carries content-disposition; the locked CSP + nosniff + same-origin CORP make it inert even if
      // framed or opened directly. The attachment download stays on ?raw=1 above.
      h.route({
        method: "GET",
        path: "/v1/agents/:id/reports/:rid/render",
        scope: { kind: "operator" },
        handler: async (req) => {
          try {
            const target = await resolveReqTarget(req, true);
            const entry = await read(target, req.params.rid!);
            if (!entry) throw new LifecycleError(404, "no such report");
            if (!isRenderableMediaType(entry.report.mediaType)) throw new LifecycleError(415, "report type is download-only");
            if (entry.content.byteLength > opts.reportMaxBytes) throw new LifecycleError(413, "report too large to render");
            return {
              status: 200,
              body: entry.content,
              contentType: /^text\/html\s*$/i.test(entry.report.mediaType) ? "text/html; charset=utf-8" : entry.report.mediaType,
              headers: {
                "content-security-policy": REPORT_RENDER_CSP,
                "x-content-type-options": "nosniff",
                "referrer-policy": "no-referrer",
                "cross-origin-resource-policy": "same-origin",
                "cache-control": "no-store",
              },
            };
          } catch (e) {
            return err(e);
          }
        },
      });

      // DELETE /v1/agents/:id/reports/:rid — operator only.
      h.route({
        method: "DELETE",
        path: "/v1/agents/:id/reports/:rid",
        scope: { kind: "operator" },
        handler: async (req) => {
          try {
            const target = await resolveReqTarget(req, false);
            if (!(await remove(target, req.params.rid!))) throw new LifecycleError(404, "no such report");
            return { status: 200, body: { removed: req.params.rid } };
          } catch (e) {
            return err(e);
          }
        },
      });
    },
    publish,
  };
}
