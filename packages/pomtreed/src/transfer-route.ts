import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CONFIG_DEFAULTS, StaleGenerationError } from "@pomtree/core";
import type { IngestFailCode } from "@pomtree/core";
import type { Principal } from "./auth.ts";
import type { Daemon } from "./daemon.ts";
import { IDEMPOTENCY_QUERY_KEY_REQUIRED } from "./error-codes.ts";
import { LifecycleError } from "./lifecycle.ts";

// `pomtree push` / `pomtree pull`: the one place raw bytes cross the API (a git bundle). Streaming, so they sit beside the
// JSON router rather than in it. All git logic is behind the Workspace port; this module only authorizes, maps errors and
// moves bytes: push streams the request into Workspace.ingest, pull streams Workspace.serve into the response.

const STATUS: Record<IngestFailCode, number> = {
  too_large: 413,
  bad_bundle: 422,
  prerequisite: 422,
  bad_ref: 422,
  unsafe_path: 422,
  symlink: 422,
  submodule: 422,
  git_version: 503,
  non_fast_forward: 409,
  unknown: 500,
};

export function matchTransfer(method: string, pathname: string): { verb: "push" | "pull"; id: string } | null {
  const m = /^\/v1\/agents\/([^/]+)\/(push|pull)$/.exec(pathname);
  if (!m) return null;
  if ((m[2] === "push" && method === "POST") || (m[2] === "pull" && method === "GET")) return { verb: m[2], id: m[1]! };
  return null;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Agent credentials only: the token's generation is fenced against the registry (stale -> 409) inside the daemon call.
export async function handleTransfer(
  daemon: Daemon,
  principal: Principal,
  t: { verb: "push" | "pull"; id: string },
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (principal.scope !== "agent") return reply(res, 403, { error: "agent scope required" });
    const id = t.id === "self" ? principal.agent : t.id;
    if (id !== principal.agent) return reply(res, 403, { error: "an agent may push and pull only through its own credential" });
    if (t.verb === "push") {
      const key = url.searchParams.get("key");
      if (!key) return reply(res, 400, { error: IDEMPOTENCY_QUERY_KEY_REQUIRED });
      const max = daemon.deps.pushMaxBytes ?? CONFIG_DEFAULTS["push.maxBytes"];
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > max) {
        req.resume();
        return reply(res, 413, { error: `bundle exceeds ${max} bytes`, code: "too_large" });
      }
      // A for-await over `req` that ends early destroys the socket and drops our 413. Iterate by hand and never call return();
      // after the ingest, drain what is left (the cap bounds nothing here, so discard) and answer with Connection: close.
      const it = req[Symbol.asyncIterator]();
      const body: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => it.next() as Promise<IteratorResult<Uint8Array>> }) };
      const out = await daemon.push(id, principal.generation, key, body, max, { force: url.searchParams.get("force") === "1" });
      req.resume();
      if (!out.ok) res.setHeader("connection", "close");
      if (out.ok) return reply(res, 200, { ok: true, refs: out.refs });
      return reply(res, STATUS[out.code] ?? 422, { error: out.message, code: out.code });
    }
    const from = url.searchParams.get("from") ?? undefined;
    const bundle = await daemon.pull(id, principal.generation, from === "self" ? id : from);
    res.writeHead(200, { "content-type": "application/octet-stream" });
    for await (const chunk of bundle) {
      if (res.destroyed) return;
      if (!res.write(chunk)) await once(res, "drain");
    }
    res.end();
  } catch (e) {
    if (res.headersSent) return void res.destroy(); // mid-stream failure: the truncated body is the signal
    if (e instanceof LifecycleError) return reply(res, e.status, { error: e.message, ...e.extra });
    if (e instanceof StaleGenerationError) return reply(res, 409, { error: e.message });
    console.error(`pomtreed: transfer ${t.verb} failed: ${e instanceof Error ? e.message : String(e)}`);
    reply(res, 500, { error: "internal error" });
  }
}
