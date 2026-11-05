import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

// One scripted answer. `status` defaults to 200, `body` to "". `delayMs` waits before answering; `hang` never answers (the socket
// stays open until close()); `reset` destroys the connection with a TCP RST before any response, as a crashed origin would.
export interface OriginResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  delayMs?: number;
  hang?: boolean;
  reset?: boolean;
}

export interface OriginRequest {
  host: string; // the Host header, lowercased, port dropped
  path: string; // path plus query, as sent
  method: string;
  headers: Record<string, string>; // lowercased names; repeated headers joined by ", "
  at: number;
}

// A route's answer: one response, a sequence consumed in order (the last one repeats), or a function of the request.
export type OriginRoute = OriginResponse | OriginResponse[] | ((req: OriginRequest) => OriginResponse);

// A loopback HTTP origin for broker tests, at 127.0.0.1 on an ephemeral port. It routes by the Host header and the path, so one
// server stands in for many hosts: pomtreed's testFetchSeam (test.fetchHosts) maps each real hostname to this port and sends the
// original Host. A route keyed by path plus query wins over one keyed by the bare path. Unrouted requests get 404 "no route".
// Every request is recorded in `requests` before it is answered (a hung or reset one too). close() destroys open sockets, so a
// hung route never keeps the test process alive.
export class FakeOrigin {
  readonly requests: OriginRequest[] = [];
  private routes = new Map<string, OriginRoute>();
  private hits = new Map<string, number>();
  private sockets = new Set<Socket>();
  private timers = new Set<NodeJS.Timeout>();
  private server: Server;
  private bound = 0;

  private constructor() {
    this.server = createServer((req, res) => this.answer(req, res));
    this.server.on("connection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
  }

  static async start(): Promise<FakeOrigin> {
    const o = new FakeOrigin();
    await new Promise<void>((resolve, reject) => {
      o.server.once("error", reject);
      o.server.listen(0, "127.0.0.1", () => resolve());
    });
    o.bound = (o.server.address() as AddressInfo).port;
    return o;
  }

  get port(): number {
    return this.bound;
  }

  // The map pomtreed's testFetchSeam takes (test.fetchHosts): each host to this origin's port.
  hostsMap(...hosts: string[]): Map<string, number> {
    return new Map(hosts.map((h) => [h.toLowerCase(), this.bound]));
  }

  route(host: string, path: string, answer: OriginRoute): this {
    this.routes.set(`${host.toLowerCase()} ${path}`, answer);
    return this;
  }

  // GET <host>/robots.txt: a body string answers 200 text/plain; a response scripts anything else (a 404, a 503, a hang).
  robots(host: string, answer: string | OriginRoute): this {
    return this.route(host, "/robots.txt", typeof answer === "string" ? { status: 200, headers: { "content-type": "text/plain" }, body: answer } : answer);
  }

  // archive.org /wayback/available: the closest snapshot of any URL is `snapshot` (null: none), in the API's JSON shape. Also routes
  // web.archive.org/robots.txt (allow all) unless a test routed it already.
  waybackAvailability(snapshot: { url: string; timestamp: string } | null, extra: Partial<OriginResponse> = {}): this {
    const body = JSON.stringify(
      snapshot === null
        ? { url: "", archived_snapshots: {} }
        : {
            url: snapshot.url,
            archived_snapshots: {
              closest: {
                status: "200",
                available: true,
                url: `http://web.archive.org/web/${snapshot.timestamp}/${snapshot.url}`,
                timestamp: snapshot.timestamp,
              },
            },
          },
    );
    if (!this.routes.has("web.archive.org /robots.txt")) this.robots("web.archive.org", "User-agent: *\nAllow: /\n");
    if (!this.routes.has("archive.org /robots.txt")) this.robots("archive.org", "User-agent: *\nAllow: /\n");
    return this.route("archive.org", "/wayback/available", { status: 200, headers: { "content-type": "application/json" }, body, ...extra });
  }

  // web.archive.org/web/<timestamp>id_/<url>: the raw snapshot.
  waybackSnapshot(timestamp: string, url: string, answer: string | OriginRoute): this {
    return this.route(
      "web.archive.org",
      `/web/${timestamp}id_/${url}`,
      typeof answer === "string" ? { status: 200, headers: { "content-type": "text/html" }, body: answer } : answer,
    );
  }

  requestsFor(host: string, path?: string): OriginRequest[] {
    const h = host.toLowerCase();
    return this.requests.filter((r) => r.host === h && (path === undefined || r.path === path || r.path.split("?", 1)[0] === path));
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private answer(req: IncomingMessage, res: ServerResponse): void {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
    const host = (headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    const path = req.url ?? "/";
    const r: OriginRequest = { host, path, method: req.method ?? "GET", headers, at: Date.now() };
    this.requests.push(r);
    req.resume();
    const exact = `${host} ${path}`;
    const bare = `${host} ${path.split("?", 1)[0]}`;
    const key = this.routes.has(exact) ? exact : bare;
    const route = this.routes.get(key);
    let resp: OriginResponse;
    if (route === undefined) resp = { status: 404, headers: { "content-type": "text/plain" }, body: "no route" };
    else if (typeof route === "function") resp = route(r);
    else if (Array.isArray(route)) {
      const n = this.hits.get(key) ?? 0;
      this.hits.set(key, n + 1);
      resp = route[Math.min(n, route.length - 1)] ?? { status: 500 };
    } else resp = route;
    const send = () => {
      if (resp.reset) {
        const s = req.socket as Socket & { resetAndDestroy?: () => void };
        if (typeof s.resetAndDestroy === "function") s.resetAndDestroy();
        else s.destroy();
        return;
      }
      if (resp.hang) return;
      const body = resp.body === undefined ? Buffer.alloc(0) : typeof resp.body === "string" ? Buffer.from(resp.body) : Buffer.from(resp.body);
      res.writeHead(resp.status ?? 200, { "content-length": String(body.length), ...(resp.headers ?? {}) });
      res.end(body);
    };
    if (resp.delayMs !== undefined && resp.delayMs > 0) {
      const t = setTimeout(() => {
        this.timers.delete(t);
        send();
      }, resp.delayMs);
      this.timers.add(t);
    } else send();
  }
}
