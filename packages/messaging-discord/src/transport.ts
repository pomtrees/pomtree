import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

export interface HttpReply {
  status: number;
  headers: Record<string, string>; // lowercased header names
  body: unknown;
}

export interface HttpCall {
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

// A minimal JSON-over-HTTP(S) client; the sole I/O boundary for the real pomtreed and Discord
// clients. Uses node:http/https (matching pomtree's client) rather than the global fetch, which
// is not part of this repo's lib/type surface.
export function httpJson(url: URL, call: HttpCall): Promise<HttpReply> {
  const https = url.protocol === "https:";
  const req: (o: RequestOptions, cb: (res: IncomingMessage) => void) => ClientRequest = https ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (https ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: call.method,
        headers: call.body === undefined ? call.headers : { "content-type": "application/json", ...call.headers },
      },
      (res) => {
        res.setEncoding("utf8");
        let s = "";
        res.on("data", (d: string) => (s += d));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
          }
          try {
            resolve({ status: res.statusCode ?? 0, headers, body: s ? (JSON.parse(s) as unknown) : null });
          } catch {
            reject(new Error("invalid JSON response"));
          }
        });
      },
    );
    r.on("error", (e) => reject(e));
    if (call.body !== undefined) r.write(JSON.stringify(call.body));
    r.end();
  });
}
