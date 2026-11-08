import { request } from "node:http";

export interface Call {
  method: string;
  path: string;
  body?: unknown; // JSON body, or a Uint8Array (e.g. Buffer) sent raw as application/octet-stream
  raw?: boolean; // return the response body as a Buffer instead of JSON-parsing it
  timeoutMs?: number; // overrides the transport default; 0 disables (calls that block by design)
}
export interface Reply {
  status: number;
  body: any;
}
export type Transport = (c: Call) => Promise<Reply>;

export class TransportError extends Error {}

export const DEFAULT_TIMEOUT_MS = 15_000;

// pomtree talks only to the daemon's API (it never opens the database or files itself); this is the sole I/O boundary.
export function socketTransport(socketPath: string, token: string, defaultTimeoutMs = DEFAULT_TIMEOUT_MS): Transport {
  return transport({ socketPath }, socketPath, token, defaultTimeoutMs);
}

// Same transport over TCP for sandboxes that cannot mount the unix socket (POMTREE_API, e.g. http://host.docker.internal:PORT).
export function httpTransport(apiUrl: string, token: string, defaultTimeoutMs = DEFAULT_TIMEOUT_MS): Transport {
  const u = new URL(apiUrl);
  if (u.protocol !== "http:") throw new TransportError(`POMTREE_API must be an http:// URL, got ${apiUrl}`);
  return transport({ host: u.hostname, port: Number(u.port || 80) }, u.origin, token, defaultTimeoutMs);
}

function transport(target: { socketPath: string } | { host: string; port: number }, label: string, token: string, defaultTimeoutMs: number): Transport {
  return (c) =>
    new Promise((resolve, reject) => {
      const binary = c.body instanceof Uint8Array;
      const payload = c.body === undefined ? undefined : binary ? c.body : JSON.stringify(c.body);
      const raw = c.raw === true;
      const timeoutMs = c.timeoutMs ?? defaultTimeoutMs;
      let done = false;
      const fail = (why: string) => {
        if (done) return;
        done = true;
        reject(new TransportError(`cannot reach pomtreed at ${label}: ${why}`));
      };
      const req = request(
        {
          ...target,
          path: c.path,
          method: c.method,
          headers: {
            authorization: `Bearer ${token}`,
            // pomtreed refuses any POST under /v1/ui/ without this header (CSRF guard for UI write routes, server.ts), Bearer callers included.
            ...(c.method === "POST" && c.path.startsWith("/v1/ui/") ? { "x-pomtree-ui": "1" } : {}),
            ...(payload === undefined ? {} : { "content-type": binary ? "application/octet-stream" : "application/json" }),
          },
        },
        (res) => {
          if (raw) {
            const chunks: Buffer[] = [];
            res.on("data", (d: Buffer) => chunks.push(d));
            res.on("error", (e) => fail(e.message));
            res.on("aborted", () => fail("connection closed mid-response"));
            res.on("close", () => {
              if (!res.complete) fail("connection closed before the response finished");
            });
            res.on("end", () => {
              if (done) return;
              done = true;
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
            });
            return;
          }
          res.setEncoding("utf8"); // decode across chunk boundaries so multibyte text survives
          let s = "";
          res.on("data", (d: string) => (s += d));
          res.on("error", (e) => fail(e.message));
          res.on("aborted", () => fail("connection closed mid-response"));
          res.on("close", () => {
            if (!res.complete) fail("connection closed before the response finished");
          });
          res.on("end", () => {
            if (done) return;
            done = true;
            try {
              resolve({ status: res.statusCode ?? 0, body: s ? JSON.parse(s) : null });
            } catch {
              reject(new TransportError("daemon sent invalid JSON"));
            }
          });
        },
      );
      req.on("error", (e) => fail(e.message));
      if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response within ${timeoutMs}ms`)));
      req.end(payload);
    });
}
