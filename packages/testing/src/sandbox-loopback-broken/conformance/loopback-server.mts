// An offline stand-in for the invented loopback sandbox API (wire.mts lists its routes): a node:http server on 127.0.0.1 that keeps
// sandboxes in memory and runs no process. A real backend would point at its provider's documented API instead; this server exists so
// `pnpm conformance:sandbox` can run the backend end to end with no network, no account and no cost.
//
// It also gives conformance.mts what the port cannot: it records the User-Agent of every request (the `requests` hook) and can be told
// to lose the reply to the next create (`unknownOutcome`) or to take a sandbox away (`preempt`).
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

interface Sandbox {
  name: string;
  agent: string;
  image: string;
  state: "running" | "exited" | "preempted";
  exitCode: number | null;
  labels: Record<string, string>;
  host: string;
  generation: number;
  fingerprint: string;
  logs: string[];
  ended: Promise<void>;
  end: () => void;
}

export interface LoopbackServer {
  url: string; // http://127.0.0.1:<port>
  userAgents(): (string | undefined)[]; // one entry per request received, in order
  armUnknownOutcome(applied: boolean): void; // the next create is applied (or not) and its reply is lost
  preempt(name: string): void;
  close(): Promise<void>;
}

const record = (s: Sandbox) => ({
  name: s.name,
  agent: s.agent,
  image: s.image,
  state: s.state,
  exitCode: s.exitCode,
  labels: s.labels,
  host: s.host,
  generation: s.generation,
  fingerprint: s.fingerprint,
});

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

// `token` is the credential the server expects as `Authorization: Bearer <token>`; anything else is answered 401.
export async function startLoopbackServer(opts: { token: string }): Promise<LoopbackServer> {
  const sandboxes = new Map<string, Sandbox>();
  const agents: (string | undefined)[] = [];
  let unknownOutcome: { applied: boolean } | undefined;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const finish = (s: Sandbox, state: Sandbox["state"], exitCode: number | null) => {
    if (s.state !== "running") return;
    s.state = state;
    s.exitCode = exitCode;
    s.logs.push(`loopback sandbox ${s.name} ${state}${exitCode === null ? "" : ` with exit code ${exitCode}`}`);
    s.end();
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    agents.push(req.headers["user-agent"]);
    if (req.headers.authorization !== `Bearer ${opts.token}`) return send(res, 401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["v1", "sandboxes", name?, verb?]
    if (parts[0] !== "v1") return send(res, 404, { error: "no such route" });

    if (parts[1] === "health" && req.method === "GET") return send(res, 200, { ok: true, account: "loopback-account" });
    if (parts[1] === "images" && parts[2] !== undefined && req.method === "GET") {
      return send(res, 200, { digest: `sha256:${createHash("sha256").update(parts[2]).digest("hex")}` });
    }
    if (parts[1] !== "sandboxes") return send(res, 404, { error: "no such route" });

    if (parts[2] === undefined && req.method === "POST") {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8")) as {
        name: string;
        agent: string;
        image: string;
        labels: Record<string, string>;
        host: string;
        generation: number;
      };
      const lose = unknownOutcome;
      unknownOutcome = undefined;
      const existing = sandboxes.get(body.name);
      if (existing !== undefined) return send(res, 409, { error: "name taken", sandbox: record(existing) });
      if (lose === undefined || lose.applied) {
        let end = () => {};
        const ended = new Promise<void>((r) => {
          end = r;
        });
        const s: Sandbox = {
          name: body.name,
          agent: body.agent,
          image: body.image,
          state: "running",
          exitCode: null,
          labels: body.labels,
          host: body.host,
          generation: body.generation,
          fingerprint: createHash("sha256").update(raw).digest("hex"),
          logs: [`loopback sandbox ${body.name} started from ${body.image}`],
          ended,
          end,
        };
        sandboxes.set(s.name, s);
        if (lose === undefined) return send(res, 201, record(s));
      }
      req.socket.destroy(); // the reply is lost: the client cannot tell whether the create took effect
      return;
    }
    if (parts[2] === undefined && req.method === "GET") {
      const store = url.searchParams.get("storeId");
      const maxEpoch = url.searchParams.get("maxEpoch");
      const owned = (s: Sandbox) =>
        (store === null || s.labels.store_id === undefined || s.labels.store_id === store) &&
        (maxEpoch === null || s.labels.daemon_epoch === undefined || Number(s.labels.daemon_epoch) <= Number(maxEpoch));
      return send(res, 200, { sandboxes: [...sandboxes.values()].filter(owned).map(record) });
    }

    const s = sandboxes.get(parts[2] ?? "");
    if (s === undefined) return send(res, 404, { error: "no such sandbox" });
    const verb = parts[3];
    if (verb === undefined && req.method === "GET") return send(res, 200, record(s));
    if (verb === "wait" && req.method === "GET") {
      const ms = Math.min(Number(url.searchParams.get("timeoutMs") ?? 0) || 0, 30_000);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([s.ended, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
      clearTimeout(timer);
      return send(res, 200, record(s));
    }
    if (verb === "logs" && req.method === "GET") {
      const from = Number(url.searchParams.get("from") ?? 0) || 0;
      return send(res, 200, { lines: s.logs.slice(from), next: s.logs.length, running: s.state === "running" });
    }
    if (verb === "stop" && req.method === "POST") {
      finish(s, "exited", 143);
      return send(res, 200, record(s));
    }
    if (verb === "kill" && req.method === "POST") {
      finish(s, "exited", 137);
      return send(res, 200, record(s));
    }
    return send(res, 404, { error: "no such route" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    userAgents: () => [...agents],
    armUnknownOutcome: (applied) => {
      unknownOutcome = { applied };
    },
    preempt: (name) => {
      const s = sandboxes.get(name);
      if (s !== undefined) finish(s, "preempted", null);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sandboxes.values()) s.end(); // release pending long polls
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
