import { request } from "node:http";

export interface SockResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

// One HTTP request over a unix socket, resolving with the status, headers and whole body. `payload` is sent as the request body.
export function sockRequest(
  socketPath: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; payload?: string | Buffer } = {},
): Promise<SockResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: opts.method, headers: opts.headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(opts.payload);
  });
}

// The Authorization header for a bearer token; no header at all for no token.
export const bearer = (token?: string): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
