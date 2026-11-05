// Per-sandbox proxy (Node builtins only). Production listens ONLY on a private Unix socket;
// the network-none worker reaches it via a loopback byte bridge, never a Docker bridge/DNS path.
// Default-deny/allowlist and opt-in audited public policy share the same parser and pinned-IP dial.
// It speaks two explicit forward-proxy forms:
//
//   * CONNECT host:port — blind tunnel (the client speaks TLS inside it); 200 on connect.
//   * absolute-form request lines (`GET http://host:port/...`) — relayed upstream over http.
//
// Policy/attribution is immutable controller config, separate from the proxy-only durable log.
import { createServer, request as httpRequest } from "node:http";
import { lookup } from "node:dns/promises";
import { connect, isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync, statfsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  AUDIT_METHOD_OTHER,
  AUDIT_METHOD_RE,
  CoalescingEgressAuditWriter,
  FileEgressAuditWriter,
  MAX_PEERS,
  auditMethod,
  loadProxyConfig,
  validateProxyConfig,
  type DenyReason,
  type EgressAuditEvent,
  type EgressProxyConfig,
  type EgressAuditWriter,
  type ErrorClass,
  type LimitKind,
  type TrafficClass,
} from "./audit.ts";
import { EGRESS_BROWSER_SOCKET_NAME, EGRESS_SOCKET_DIR, EGRESS_SOCKET_NAME } from "./container-contract.gen.ts";

// Idle and upstream connect timeouts, in milliseconds. A proxy connection (CONNECT tunnel or
// absolute-form request) is torn down when either side has been idle this long, and an upstream
// that does not complete its TCP handshake in time is dropped. Both are injectable so tests can
// exercise them without waiting for the production defaults.
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
// Relay-class limits (exact controller relay endpoints: the daemon API and the model proxy). A relay connection has no absolute
// deadline: `pomtree ask --wait`, `logs -f`, SSE and model streams legitimately outlive any fixed bound. Its idle bound sits well above
// the daemon's longest silent response (inbox/ask/logs long-polls cap at 30 s, SSE heartbeats every 15 s), so only a dead peer trips it.
export const DEFAULT_RELAY_IDLE_TIMEOUT_MS = 300_000;
// The push.maxBytes default in @pomtree/core's config registry (one push body). proxy.ts ships into the image without core, so this
// is a copy; proxy-relay-class.test.ts asserts it equals CONFIG_DEFAULTS["push.maxBytes"]. The daemon passes the operator's live value
// through EgressProxyConfig.limits.relayMaxBytes, so this applies only when that field is absent.
export const DEFAULT_RELAY_MAX_BYTES = 256 * 1024 ** 2;
// Hard cumulative ceiling for one relay-class flow (tunnel), as a multiple of its per-exchange cap; see count() in flow().
export const RELAY_TUNNEL_CEILING_FACTOR = 8;
// Floor for that ceiling, so a small push.maxBytes (a small per-exchange cap) does not cut a long model stream on a reused tunnel.
export const RELAY_TUNNEL_CEILING_FLOOR_BYTES = 1024 ** 3;
export const relayTunnelCeiling = (maxBytes: number): number => Math.max(RELAY_TUNNEL_CEILING_FACTOR * maxBytes, RELAY_TUNNEL_CEILING_FLOOR_BYTES);
// A client connection that has not yet been admitted (no complete CONNECT or request head, or admission still pending) is dropped
// after this long without a byte. The listeners run with requestTimeout 0 and Node's headersTimeout only starts at the first byte,
// so without it a silent socket (or one that stalls mid-head) would hold one of the DEFAULT_MAX_CONNECTIONS slots forever. Once a
// request is admitted, its flow's class limits take over and this timer is cleared.
export const DEFAULT_UNADMITTED_IDLE_TIMEOUT_MS = 10_000;

export interface ProxyOptions {
  // Public-class idle bound (allowlisted and audited-public destinations); relay connections use relayIdleTimeoutMs.
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  relayIdleTimeoutMs?: number;
  relayMaxBytes?: number;
  // Test seam: overrides relayTunnelCeiling(relayMaxBytes), whose 1 GiB floor is impractical to push through in a test.
  relayTunnelCeilingBytes?: number;
  // Idle bound on a client connection until its request is admitted (DEFAULT_UNADMITTED_IDLE_TIMEOUT_MS).
  unadmittedIdleTimeoutMs?: number;
  // Test seams: override the upstream dial and request primitives. Defaults are the real
  // node:net connect and node:http request.
  connect?: (port: number, host: string) => Socket;
  request?: typeof httpRequest;
  // Name resolution seam (default: the system resolver, all addresses). The name is resolved ONCE per
  // request and every returned address is validated; the upstream is dialled by the validated IP, so
  // a second lookup (DNS rebinding) can never change where the connection goes.
  resolve?: (host: string) => Promise<string[]>;
  // Test-only: let loopback addresses through the deny set (unit tests dial 127.0.0.1 servers).
  unsafeAllowLoopback?: boolean;
  // Presence both enables public destinations and requires synchronous durable admission.
  auditedPublic?: EgressAuditWriter;
  audit?: EgressAuditWriter;
  relay?: Set<string>;
  // Required: an absent list used to default to empty and silently disabled host-owned address denial.
  hostAddresses: Set<string>;
  // Public-class absolute deadline and byte cap. Relay connections have no deadline and use relayMaxBytes.
  deadlineMs?: number;
  maxConnections?: number;
  maxConnectionBytes?: number;
  signal?: AbortSignal;
}

// The controller may explicitly grant this endpoint as a relay. The name itself confers no privilege;
// only an exact relay host/port may reach private/host-owned addresses (never hard-deny classes).
export const RELAY_HOSTNAME = "host.docker.internal";

type AddrClass = "public" | "private" | "hard";

function parseV4(ip: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : undefined;
}

function parseV6(ip: string): number[] | undefined {
  let s = ip.split("%")[0] ?? "";
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const v4 = parseV4(tail[1] ?? "");
    if (!v4) return undefined;
    const hex = (hi: number | undefined, lo: number | undefined) => (((hi ?? 0) << 8) | (lo ?? 0)).toString(16);
    s = `${s.slice(0, tail.index)}${hex(v4[0], v4[1])}:${hex(v4[2], v4[3])}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest].map((g) => Number.parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => !(g >= 0 && g <= 0xffff))) return undefined;
  return groups.flatMap((g) => [g >> 8, g & 255]);
}

function classifyV4(o: number[]): AddrClass {
  const [a = 0, b = 0, c = 0] = o;
  if (a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224) return "hard";
  if (
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24 IETF protocol, 192.0.2.0/24 TEST-NET-1
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  )
    return "hard";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
  return "public";
}

// Classify one resolved address. Unparseable input is "hard" (fail closed). IPv6 forms that embed an IPv4
// address (mapped ::ffff:a.b.c.d, v4-compatible ::a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16) take the
// class of the embedded IPv4 so the v6 spelling cannot dodge the v4 deny set.
export function classifyAddress(ip: string): AddrClass {
  if (ip.includes("%")) return "hard";
  const kind = isIP(ip);
  if (kind === 4) {
    const o = parseV4(ip);
    return o ? classifyV4(o) : "hard";
  }
  if (kind !== 6) return "hard";
  const b = parseV6(ip);
  if (!b) return "hard";
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 16) || (zeros(0, 15) && b[15] === 1)) return "hard"; // :: and ::1
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12)); // ::ffff:0:0/96
  if (zeros(0, 12)) return classifyV4(b.slice(12)); // v4-compatible ::/96
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return classifyV4(b.slice(12)); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6)); // 6to4
  if (b[0] === 0xff || (b[0] === 0xfe && ((b[1] ?? 0) & 0xc0) === 0x80)) return "hard"; // multicast, fe80::/10
  if (((b[0] ?? 0) & 0xfe) === 0xfc) return "private"; // fc00::/7 ULA
  if (b[0] === 0xfe && ((b[1] ?? 0) & 0xc0) === 0xc0) return "private"; // fec0::/10 site-local
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return "private"; // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "hard"; // documentation
  // Only global unicast is public. Reserved/non-global IPv6 is never a relay exception.
  if (((b[0] ?? 0) & 0xe0) !== 0x20 || (b[0] === 0x3f && b[1] === 0xff && (b[2] ?? 0) < 0x10)) return "hard";
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2] ?? 0) < 2) return "hard";
  return "public";
}

function addressKey(ip: string): string {
  const v4 = parseV4(ip);
  if (v4) return v4.join(".");
  const v6 = parseV6(ip);
  if (!v6) return ip;
  if (v6.slice(0, 10).every((n) => n === 0) && v6[10] === 255 && v6[11] === 255) return v6.slice(12).join(".");
  if (v6.slice(0, 12).every((n) => n === 0) || (v6[0] === 0 && v6[1] === 0x64 && v6[2] === 255 && v6[3] === 0x9b && v6.slice(4, 12).every((n) => n === 0)))
    return v6.slice(12).join(".");
  if (v6[0] === 0x20 && v6[1] === 2) return v6.slice(2, 6).join(".");
  return v6.join(":");
}

const defaultResolve = async (host: string): Promise<string[]> => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export type ResolveVerdict = { addrs: string[] } | { deny: DenyReason };

// Resolve `host` once and validate every address. Returns the validated address set (the first is dialled) or the
// reason to deny. One bad record poisons the whole answer (a private record among public ones is a rebinding/round-robin
// hazard). Only a controller-supplied exact relay endpoint is exempt from the private class. `hostAddresses` is
// required so a caller can never silently skip host-owned address denial.
export async function resolveVerdict(
  host: string,
  resolve: (h: string) => Promise<string[]>,
  hostAddresses: Set<string>,
  unsafeAllowLoopback = false,
  relay = false,
): Promise<ResolveVerdict> {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  const literal = isIP(bare) !== 0;
  const exemptPrivate = relay;
  let addrs: string[];
  try {
    addrs = literal ? [bare] : await resolve(bare);
  } catch {
    return { deny: "dns" };
  }
  if (addrs.length === 0) return { deny: "dns" };
  for (const a of addrs) {
    const c = classifyAddress(a);
    if ([...hostAddresses].some((owned) => addressKey(owned) === addressKey(a)) && !relay) return { deny: "private" };
    if (c === "public") continue;
    if (c === "private" && exemptPrivate) continue;
    if (unsafeAllowLoopback && (a === "::1" || a.startsWith("127."))) continue;
    return { deny: c === "private" ? "private" : "hard-class" };
  }
  return { addrs };
}

// Returns the address to dial, or undefined to deny.
export async function resolveAllowed(
  host: string,
  resolve: (h: string) => Promise<string[]>,
  hostAddresses: Set<string>,
  unsafeAllowLoopback = false,
  relay = false,
): Promise<string | undefined> {
  const v = await resolveVerdict(host, resolve, hostAddresses, unsafeAllowLoopback, relay);
  return "addrs" in v ? v.addrs[0] : undefined;
}

// Parses the daemon-supplied EGRESS_HOST_ADDRESSES (a JSON array of address strings); throws on anything else.
export function parseHostAddresses(raw: string | undefined): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "");
  } catch {
    throw new Error("EGRESS_HOST_ADDRESSES must be a JSON array of host addresses");
  }
  if (!Array.isArray(value) || value.length > 1024 || value.some((a) => typeof a !== "string" || a.length > 512))
    throw new Error("EGRESS_HOST_ADDRESSES must be a JSON array of at most 1024 address strings");
  return value;
}

// The allowlist as a set of `host:port` keys (host lowercased, port explicit).
export function parseAllow(csv: string): Set<string> {
  const allow = new Set<string>();
  for (const raw of csv.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const i = entry.lastIndexOf(":");
    const host = (i === -1 ? entry : entry.slice(0, i)).replace(/^\[|\]$/g, "").toLowerCase();
    const port = i === -1 ? 443 : Number(entry.slice(i + 1));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    allow.add(`${host}:${port}`);
  }
  return allow;
}

export function isAllowed(allow: Set<string>, host: string, port: number): boolean {
  return allow.has(`${host.replace(/^\[|\]$/g, "").toLowerCase()}:${port}`);
}

// CONNECT carries `host:port` (possibly `[v6]:port`); split it back apart.
export function splitHostPort(authority: string): { host: string; port: number } {
  const i = authority.lastIndexOf(":");
  const host = (i === -1 ? authority : authority.slice(0, i)).replace(/^\[|\]$/g, "");
  const port = i === -1 ? 443 : Number(authority.slice(i + 1));
  const validHost = host.length <= 253 && (isIP(host) !== 0 || /^[A-Za-z0-9.-]+$/.test(host));
  return { host: validHost ? host : "", port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0 };
}

function classifyError(err: NodeJS.ErrnoException | undefined, reached: boolean): ErrorClass {
  if (err?.code === "ETIMEDOUT") return "timeout";
  if (typeof err?.code === "string" && err.code.startsWith("HPE_")) return "protocol";
  return reached ? "reset" : "dial";
}

interface Admission {
  ip?: string;
  peers?: string[];
  deny?: DenyReason;
  admittedAt: string;
}
interface Outcome {
  denyReason?: DenyReason;
  limitKind?: LimitKind;
  errorClass?: ErrorClass;
}

const HOP_BY_HOP = new Set(["proxy-connection", "connection", "keep-alive", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function relayHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function deny(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { "content-length": String(Buffer.byteLength(message)) });
  res.end(message);
}

// One stderr line per denied connection/request: host and port only (never paths, headers, or secrets).
function logDenied(host: string, port: number): void {
  console.error(`egress denied ${host}:${port}`);
}

// A listener without an audit writer has no journal row for a tripped limit, so it says which one on stderr: class, kind and the
// host:port authority only (never paths, headers, or secrets).
function logLimit(trafficClass: TrafficClass, limitKind: LimitKind, authority: string): void {
  console.error(`egress limit ${trafficClass} ${limitKind} ${authority}`);
}

export const DEFAULT_DEADLINE_MS = 120_000;
export const DEFAULT_MAX_CONNECTIONS = 32;
export const DEFAULT_MAX_CONNECTION_BYTES = 16 * 1024 ** 2;

// CONNECT is opaque TCP: these records make no claim about HTTPS paths/status/content.
export function attachProxy(server: ReturnType<typeof createServer>, allow: Set<string>, opts: ProxyOptions): { close(): void } {
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const resolveFn = opts.resolve ?? defaultResolve;
  const audit = opts.auditedPublic ?? opts.audit;
  if (opts.auditedPublic && typeof opts.auditedPublic.append !== "function") throw new Error("public egress requires durable audit");
  if (!(opts.hostAddresses instanceof Set)) throw new Error("egress proxy requires hostAddresses");
  const active = new Set<() => void>();
  let closed = false;
  let resolving = 0;
  function close(): void {
    closed = true;
    for (const cancel of [...active]) cancel();
  }
  opts.signal?.addEventListener("abort", close, { once: true });
  if (opts.signal?.aborted) close();
  // The pre-admission idle bound (DEFAULT_UNADMITTED_IDLE_TIMEOUT_MS). net.Socket.setTimeout(ms, cb) adds `cb` once and
  // setTimeout(0, cb) removes it, so `admittedSocket` disarms exactly this listener and leaves any flow timer alone. Before a
  // request head arrives the socket is just destroyed (there is no flow to record); once a flow exists (admission pending), the
  // drop ends it as limit/idle so its outcome row says why. It covers a connection's first request only: a later request on a
  // keep-alive socket is bounded by Node's keepAliveTimeout and headersTimeout, and its admission by the class limits.
  const unadmittedIdleMs = opts.unadmittedIdleTimeoutMs ?? DEFAULT_UNADMITTED_IDLE_TIMEOUT_MS;
  const unadmitted = new WeakMap<Socket, { drop: () => void; onIdle?: () => void }>();
  server.on("connection", (socket: Socket) => {
    const entry: { drop: () => void; onIdle?: () => void } = { drop: () => (entry.onIdle ? entry.onIdle() : socket.destroy()) };
    unadmitted.set(socket, entry);
    socket.setTimeout(unadmittedIdleMs, entry.drop);
  });
  const pendingAdmission = (socket: Socket, onIdle: () => void) => {
    const entry = unadmitted.get(socket);
    if (entry) entry.onIdle = onIdle;
  };
  const admittedSocket = (socket: Socket) => {
    const entry = unadmitted.get(socket);
    if (!entry) return;
    unadmitted.delete(socket);
    socket.setTimeout(0, entry.drop);
  };
  function append(event: EgressAuditEvent): boolean {
    try {
      audit?.append(event);
      return true;
    } catch {
      close();
      return false;
    }
  }
  // The one class rule: an exact relay host:port is "relay"; everything else (allowlisted or audited-public) is "public".
  const trafficClass = (host: string, port: number): TrafficClass => (isAllowed(opts.relay ?? new Set(), host, port) ? "relay" : "public");
  // Per-class limits. `deadlineMs` undefined means no absolute deadline.
  const limits = (cls: TrafficClass) =>
    cls === "public"
      ? {
          deadlineMs: opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
          idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
          maxBytes: opts.maxConnectionBytes ?? DEFAULT_MAX_CONNECTION_BYTES,
        }
      : {
          deadlineMs: undefined,
          idleTimeoutMs: opts.relayIdleTimeoutMs ?? DEFAULT_RELAY_IDLE_TIMEOUT_MS,
          maxBytes: opts.relayMaxBytes ?? DEFAULT_RELAY_MAX_BYTES,
        };
  async function admit(host: string, port: number, event: EgressAuditEvent, live: () => boolean): Promise<Admission | undefined> {
    const relay = trafficClass(host, port) === "relay";
    const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
    const reservedName =
      bare === RELAY_HOSTNAME || bare === "localhost" || bare.endsWith(".localhost") || bare.endsWith(".local") || bare === "gateway.docker.internal";
    // TODO(egress-residual): public ports and the writable audit log remain open. Current behavior: with auditedPublic set, any
    // valid port 1..65535 to a public address is permitted; the audit-log half lives in audit.ts and the proxy mount.
    // TODO(egress): ports are not restricted to 80/443; SMTP/SSH-style tunnels to public IPs are allowed and audited
    // (the authority in every record carries the port). Current behavior: any valid port 1..65535 to a public address.
    const permitted = host && port > 0 && port <= 65535 && (relay || (!reservedName && (opts.auditedPublic || isAllowed(allow, host, port))));
    let verdict: ResolveVerdict = { deny: reservedName ? "reserved" : "not-allowlisted" };
    // lookup() cannot cancel its OS resolver work. Keep a separate reservation until it settles,
    // even if the client/deadline has gone away; otherwise stalled DNS could grow an unbounded queue.
    if (permitted) {
      if (resolving < (opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS)) {
        resolving++;
        try {
          verdict = await resolveVerdict(host, resolveFn, opts.hostAddresses, opts.unsafeAllowLoopback, relay);
        } finally {
          resolving--;
        }
      } else verdict = { deny: "resolver-limit" };
    }
    if (closed || !live()) return undefined;
    const admittedAt = new Date().toISOString();
    const adm: Admission =
      "addrs" in verdict ? { ip: verdict.addrs[0], peers: verdict.addrs.slice(0, MAX_PEERS), admittedAt } : { deny: verdict.deny, admittedAt };
    const row: EgressAuditEvent = { ...event, phase: "admission", admittedAt };
    if (!append(adm.ip ? { ...row, outcome: "allowed", peer: adm.ip, peers: adm.peers } : { ...row, outcome: "denied", denyReason: adm.deny }))
      return undefined;
    if (!adm.ip) logDenied(host, port);
    return adm;
  }
  function flow(base: EgressAuditEvent, cls: TrafficClass, destroy: () => void) {
    const limit = limits(cls);
    if (closed || active.size >= (opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS)) {
      if (!closed) {
        append({ ...base, phase: "admission", outcome: "limit", limitKind: "connections", trafficClass: cls });
        if (!audit) logLimit(cls, "connections", base.authority);
      }
      destroy();
      return undefined;
    }
    const started = Date.now();
    let ended = false;
    let bytesIn = 0;
    let bytesOut = 0;
    // Bytes charged against limit.maxBytes. Public: the whole flow. Relay: one exchange, below.
    let charged = 0;
    let lastDirection: "in" | "out" | undefined;
    let peer: string | undefined;
    let peers: string[] | undefined;
    let admittedAt: string | undefined;
    let status: number | undefined;
    const timers = new Set<NodeJS.Timeout>();
    const cancel = () => finish("cancelled");
    const finish = (outcome: EgressAuditEvent["outcome"], detail: Outcome = {}, teardown = true) => {
      if (ended) return;
      ended = true;
      active.delete(cancel);
      for (const timer of timers) clearTimeout(timer);
      append({
        ...base,
        phase: "outcome",
        outcome,
        durationMs: Date.now() - started,
        bytesIn,
        bytesOut,
        ...(peer ? { peer } : {}),
        ...(peers ? { peers } : {}),
        ...(admittedAt ? { admittedAt } : {}),
        ...(status ? { status } : {}),
        ...detail,
        ...(outcome === "limit" ? { trafficClass: cls } : {}),
      });
      if (outcome === "limit" && detail.limitKind && !audit) logLimit(cls, detail.limitKind, base.authority);
      if (teardown || closed) destroy();
    };
    active.add(cancel);
    const timeout = (ms: number, limitKind: LimitKind) => {
      const t = setTimeout(() => finish("limit", { limitKind }), ms);
      timers.add(t);
      return t;
    };
    if (limit.deadlineMs !== undefined) timeout(limit.deadlineMs, "deadline");
    return {
      finish,
      timeout,
      idleTimeoutMs: limit.idleTimeoutMs,
      clear: (t: NodeJS.Timeout) => {
        clearTimeout(t);
        timers.delete(t);
      },
      live: () => !ended && !closed,
      admitted: (adm: Admission) => {
        peer = adm.ip;
        peers = adm.peers;
        admittedAt = adm.admittedAt;
      },
      denied: (adm: Admission) => {
        admittedAt = adm.admittedAt;
      },
      status: (code: number) => {
        status = code;
      },
      count: (direction: "in" | "out", n: number) => {
        if (direction === "in") bytesIn += n;
        else bytesOut += n;
        // The relay cap bounds one request and its response (one push body), not a tunnel's lifetime: Node's fetch tunnels http://
        // relay targets over CONNECT and reuses the tunnel across requests, so a cumulative cap would cut a long-lived agent's
        // model or daemon traffic once its running total passed the cap. The tunnel is opaque bytes, so an exchange is delimited
        // without parsing HTTP: client bytes after upstream bytes start the next one (HTTP/1.1 without pipelining, which is what
        // Node's clients send). An absolute-form request is already its own flow. Bytes in the audit row stay the flow totals.
        // Upstream bytes mid-body (an early 4xx or interim response the client provokes) also start a new count, so the reset alone
        // would not bound a tunnel. A reset can no longer make the total unbounded: a cumulative ceiling of
        // RELAY_TUNNEL_CEILING_FACTOR x the cap cuts the flow with the same "bytes" limit. A multiple, because the tunnel is opaque
        // TLS so an exchange boundary cannot be detected without parsing, and a time window is more machinery for no stronger bound.
        // 8x leaves room (2 GiB at the 256 MiB default) for many legitimate exchanges on one reused keep-alive tunnel, and the
        // ceiling never drops below RELAY_TUNNEL_CEILING_FLOOR_BYTES, so a small push.maxBytes does not cut a long model stream.
        // Node's fetch reopens a cut tunnel on its next request. The relay endpoints also enforce their own per-request body limits.
        if (cls === "relay" && direction === "in" && lastDirection === "out") charged = 0;
        lastDirection = direction;
        charged += n;
        if (charged > limit.maxBytes || (cls === "relay" && bytesIn + bytesOut > (opts.relayTunnelCeilingBytes ?? relayTunnelCeiling(limit.maxBytes))))
          finish("limit", { limitKind: "bytes" });
      },
    };
  }
  server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
    const { host, port } = splitHostPort(req.url ?? "");
    const base: EgressAuditEvent = { connection: randomUUID(), phase: "admission", transport: "connect", authority: `${host}:${port}`, outcome: "allowed" };
    let upstream: Socket | undefined;
    const f = flow(base, trafficClass(host, port), () => {
      client.destroy();
      upstream?.destroy();
    });
    if (!f) return;
    pendingAdmission(client, () => f.finish("limit", { limitKind: "idle" }));
    let reached = false;
    client.on("error", (err) => f.finish("error", { errorClass: classifyError(err, true) }));
    client.on("close", () => f.finish("complete"));
    // A paused socket never observes EOF, and HTTP-server sockets never auto-close after EOF, so a client that hangs up
    // during admission would go unnoticed until the DNS answer arrives. Read while admission is pending, end the flow on
    // EOF, and hold any early bytes for the tunnel. The EOF hook is scoped to admission so tunnel half-close still works.
    const early: Buffer[] = [];
    const hold = (chunk: Buffer) => {
      early.push(chunk);
      f.count("in", chunk.length);
    };
    const gone = () => f.finish("complete");
    client.on("data", hold);
    client.on("end", gone);
    const adm = await admit(host, port, base, f.live);
    if (!f.live() || !adm) return;
    const ip = adm.ip;
    if (!ip || client.destroyed) {
      client.removeListener("data", hold);
      client.removeListener("end", gone);
      if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", () => client.destroy());
      f.denied(adm);
      f.finish("denied", { denyReason: adm.deny ?? "not-allowlisted" }, false);
      return;
    }
    f.admitted(adm);
    admittedSocket(client);
    const timer = f.timeout(connectTimeoutMs, "deadline");
    try {
      upstream = (opts.connect ?? connect)(port, ip);
    } catch {
      f.finish("error", { errorClass: "internal" });
      return;
    }
    upstream.once("connect", () => {
      reached = true;
      if (!f.live()) {
        upstream?.destroy();
        return;
      }
      f.clear(timer);
      if (!append({ ...base, phase: "outcome", outcome: "connected", peer: ip, peers: adm.peers, admittedAt: adm.admittedAt })) return;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.removeListener("data", hold);
      client.removeListener("end", gone);
      f.count("in", head.length);
      if (head.length && f.live()) upstream!.write(head);
      if (f.live()) for (const chunk of early) upstream?.write(chunk);
      client.setTimeout(f.idleTimeoutMs, () => f.finish("limit", { limitKind: "idle" }));
      upstream!.setTimeout(f.idleTimeoutMs, () => f.finish("limit", { limitKind: "idle" }));
      client.on("data", (chunk: Buffer) => f.count("in", chunk.length));
      upstream!.on("data", (chunk: Buffer) => f.count("out", chunk.length));
      client.pipe(upstream!);
      upstream!.pipe(client);
    });
    upstream.on("error", (err) => f.finish("error", { errorClass: classifyError(err, reached) }));
    upstream.on("close", () => f.finish("complete"));
  });
  server.on("request", async (req: IncomingMessage, res: ServerResponse) => {
    let target: URL | undefined;
    try {
      target = new URL(req.url ?? "");
    } catch {
      target = undefined;
    }
    if (target?.protocol !== "http:" || target.username || target.password) {
      // Refused before admission, but still a denied egress attempt: record the parseable host and port (default 0 when
      // the scheme has none), never the URL, path, or credentials.
      const host = target && target.hostname.length <= 253 ? target.hostname : "";
      const port = target?.port ? Number(target.port) : target?.protocol === "http:" ? 80 : 0;
      append({
        connection: randomUUID(),
        phase: "admission",
        transport: "http",
        authority: `${host}:${port}`,
        method: auditMethod(req.method),
        outcome: "denied",
        denyReason: "not-allowlisted",
        admittedAt: new Date().toISOString(),
      });
      deny(res, 400, target ? "only credential-free http absolute-form is supported\n" : "bad request\n");
      return;
    }
    // A method the audit cannot represent is refused before admission, DNS or any dial: fail closed rather than forward a request
    // whose audit row the spool reader or pomtreed would reject (which would wedge the spool).
    if (!AUDIT_METHOD_RE.test(req.method ?? "")) {
      append({
        connection: randomUUID(),
        phase: "admission",
        transport: "http",
        authority: `${target.hostname.length <= 253 ? target.hostname : ""}:${target.port ? Number(target.port) : 80}`,
        method: AUDIT_METHOD_OTHER,
        outcome: "denied",
        denyReason: "not-allowlisted",
        admittedAt: new Date().toISOString(),
      });
      deny(res, 405, "method not supported\n");
      return;
    }
    // Same host bound as splitHostPort (CONNECT): an oversized host is denied under an empty-host authority and
    // its origin URL is never recorded, so the audit line stays within what the spool reader accepts.
    const oversized = target.hostname.length > 253;
    const host = oversized ? "" : target.hostname;
    const port = target.port ? Number(target.port) : 80;
    const base: EgressAuditEvent = {
      connection: randomUUID(),
      phase: "admission",
      transport: "http",
      authority: `${host}:${port}`,
      method: req.method,
      ...(oversized ? {} : { url: `${target.origin}/[redacted]` }),
      outcome: "allowed",
    };
    let upstream: ReturnType<typeof httpRequest> | undefined;
    let response: IncomingMessage | undefined;
    const f = flow(base, trafficClass(host, port), () => {
      upstream?.destroy();
      response?.destroy();
      res.destroy();
      req.destroy();
    });
    if (!f) return;
    pendingAdmission(req.socket, () => f.finish("limit", { limitKind: "idle" }));
    let reached = false;
    req.on("error", (err) => f.finish("error", { errorClass: classifyError(err, true) }));
    req.on("aborted", () => f.finish("cancelled"));
    res.on("close", () => {
      if (!res.writableFinished) f.finish("cancelled");
    });
    const adm = await admit(host, port, base, f.live);
    if (!f.live() || !adm) return;
    const ip = adm.ip;
    if (!ip) {
      deny(res, 403, "egress denied\n");
      f.denied(adm);
      f.finish("denied", { denyReason: adm.deny ?? "not-allowlisted" }, false);
      return;
    }
    f.admitted(adm);
    admittedSocket(req.socket);
    const headers = relayHeaders(req.headers);
    headers.host = target.host;
    const timer = f.timeout(connectTimeoutMs, "deadline");
    try {
      upstream = (opts.request ?? httpRequest)(
        { host: ip, port, method: req.method, path: `${target.pathname}${target.search}`, headers, agent: false },
        (up) => {
          response = up;
          if (!f.live()) {
            up.destroy();
            return;
          }
          f.clear(timer);
          f.status(up.statusCode ?? 502);
          res.writeHead(up.statusCode ?? 502, relayHeaders(up.headers));
          up.setTimeout(f.idleTimeoutMs, () => f.finish("limit", { limitKind: "idle" }));
          up.on("data", (chunk: Buffer) => f.count("out", chunk.length));
          up.on("error", (err) => f.finish("error", { errorClass: classifyError(err, true) }));
          up.on("end", () => f.finish("complete", {}, false));
          up.pipe(res);
        },
      );
      upstream.setTimeout(f.idleTimeoutMs, () => f.finish("limit", { limitKind: "idle" }));
      upstream.on("error", (err) => f.finish("error", { errorClass: classifyError(err, reached) }));
      upstream.on("socket", (s: Socket) => {
        const onConnect = () => {
          reached = true;
          f.clear(timer);
        };
        if (s.connecting) s.once("connect", onConnect);
        else onConnect();
      });
      req.on("data", (chunk: Buffer) => f.count("in", chunk.length));
      req.pipe(upstream);
    } catch {
      f.finish("error", { errorClass: "internal" });
    }
  });
  return { close };
}

// Two listeners over one audit writer (it records rows in every mode and enables public destinations only under config.auditedPublic):
// the main one serves Pi, its tools and the relay authorities; the browser one (Chromium's --proxy-server) has an empty relay set, so page script can reach public destinations (audited) but never a relay endpoint, and
// only ever runs under public-class limits. requestTimeout is off: it is server-wide, so it would cut a long relayed upload or
// stream; each flow's own class limits (the public deadline, the relay idle bound) bound a request instead. headersTimeout stays.
export function createSidecarProxies(
  config: EgressProxyConfig,
  hostAddresses: Set<string>,
  audit: EgressAuditWriter | undefined,
  seams: Partial<ProxyOptions> = {},
) {
  const make = (relay: Set<string>, relayMaxBytes?: number) => {
    const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 0, headersTimeout: 10_000, connectionsCheckingInterval: 1000 });
    server.maxConnections = DEFAULT_MAX_CONNECTIONS;
    const control = attachProxy(server, parseAllow(config.allow.join(",")), {
      relay,
      hostAddresses,
      ...(relayMaxBytes !== undefined ? { relayMaxBytes } : {}),
      ...(audit ? (config.auditedPublic === true ? { auditedPublic: audit } : { audit }) : {}),
      ...seams,
    });
    return { server, control };
  };
  return { main: make(parseAllow(config.relay.join(",")), config.limits?.relayMaxBytes), browser: make(new Set<string>()) };
}

async function main(): Promise<void> {
  const config = process.env.EGRESS_CONFIG_JSON
    ? validateProxyConfig(JSON.parse(process.env.EGRESS_CONFIG_JSON))
    : loadProxyConfig(process.env.EGRESS_CONFIG ?? "/etc/pomtree-egress/config.json");
  // The daemon host's addresses arrive per start (they change with NIC/VPN/DHCP, so they are not in the immutable
  // config); this container's own interfaces are not the host's. Missing or malformed input fails closed.
  const owned = new Set([...(config.hostAddresses ?? []), ...parseHostAddresses(process.env.EGRESS_HOST_ADDRESSES)]);
  try {
    for (const ip of await defaultResolve(RELAY_HOSTNAME)) owned.add(ip);
  } catch {
    /* no host alias on this platform */
  }
  // Repeated identical denials fold into summary rows so a denial loop cannot exhaust the spool and close its own proxy.
  const audit = config.identity
    ? new CoalescingEgressAuditWriter(new FileEgressAuditWriter(process.env.EGRESS_LOG_DIR ?? "/var/log/pomtree-egress", config.identity), {
        onFailure: () => stop(),
      })
    : undefined;
  const proxies = createSidecarProxies(config, owned, audit);
  const stop = () => {
    try {
      audit?.flush();
    } catch {
      /* the inner writer has latched failed; the proxies close regardless */
    }
    for (const { control, server } of [proxies.main, proxies.browser]) {
      control.close();
      server.close();
      server.closeAllConnections();
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const socketPath = process.env.EGRESS_SOCKET ?? `${EGRESS_SOCKET_DIR}/${EGRESS_SOCKET_NAME}`;
  const dir = dirname(socketPath);
  const st = lstatSync(dir);
  if (
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    realpathSync(dir) !== dir ||
    st.uid !== process.getuid?.() ||
    st.gid !== 1000 ||
    (st.mode & 0o777) !== 0o770 ||
    statfsSync(dir).type !== 0x01021994
  )
    throw new Error("egress socket requires private uid-owned gid1000 mode0770 tmpfs volume; unsupported Docker filesystem/uid mapping");
  for (const [server, path] of [
    [proxies.main.server, socketPath],
    [proxies.browser.server, `${dir}/${EGRESS_BROWSER_SOCKET_NAME}`],
  ] as const) {
    if (existsSync(path)) {
      const socket = lstatSync(path);
      if (!socket.isSocket() || socket.uid !== st.uid || socket.gid !== 1000) throw new Error("unsafe stale egress socket");
      unlinkSync(path);
    }
    server.listen(path, () => {
      chmodSync(path, 0o660);
      const socket = lstatSync(path);
      if (socket.uid !== st.uid || socket.gid !== 1000 || (socket.mode & 0o777) !== 0o660) {
        stop();
        throw new Error("unsafe egress socket ownership");
      }
    });
  }
}
if (import.meta.main) await main();
