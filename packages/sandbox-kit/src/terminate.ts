// HTTP CONNECT terminator for reach-back. A connection arrives as a plain byte stream (a mux channel or a bridged local
// socket) carrying one CONNECT request. The terminator parses it, checks the target, audits the decision, and either refuses with a
// status line that names the cause or dials the target and relays bytes. Pure over injected ports: `allow`, `dial`, `audit`, `now`
// and `sleep` are supplied, so nothing here opens a socket or reads a clock.
//
// Order of decisions for a request: parse, built-in IP-literal deny, allow-list, audit of the allow decision, dial, 200 reply, relay.
// A refusal is always audited and answered with a status line; nothing is dialed before the allow decision is audited.
//
// Name resolution is NOT done here. The host the client names is checked as text (the allow-list sees the name, the built-in deny
// sees IP literals), and DNS happens inside the injected `dial`. So a name on the allow-list can still resolve to a loopback or
// link-local address (DNS rebinding, or an attacker-controlled record). The `dial` contract: resolve once, pin the resolved
// address, refuse loopback, link-local (169.254.0.0/16 including the cloud metadata address), unspecified and IPv4-mapped IPv6
// addresses (and, unless the adapter opted in, the private ranges below), and connect to the pinned address, not to the name. `assertDialRejectsPrivate` checks a dial against that contract.
//
// The built-in deny (`denyIpLiterals`, default on) refuses IP-literal targets in loopback, link-local, unspecified and IPv4-mapped
// or IPv4-compatible IPv6 ranges, in private-use ranges (RFC 1918 10/8, 172.16/12 and 192.168/16; CGNAT 100.64/10; IETF protocol
// assignments 192.0.0.0/24; benchmarking 198.18/15; multicast 224/4 and ff00::/8; reserved 240/4 with broadcast; IPv6 ULA fc00::/7;
// NAT64 64:ff9b::/96 and 64:ff9b:1::/48), and every non-canonical IPv4 spelling (decimal `2130706433`, hex `0x7f.1`, octal
// `0177.0.0.1`, short `127.1`), whatever the allow-list says. A non-canonical spelling is refused even when its address is
// allowed, so a private target can only be reached by its canonical spelling. The allow-list may still permit named hosts and
// ordinary public IP literals. An adapter that must reach private targets opts in with `allowPrivate`, a list of CIDRs: a literal
// inside one is exempt from the private-use ranges only, never from loopback, link-local, unspecified or IPv4-mapped refusal.
// IPv6 forms that embed an IPv4 address: 6to4 (2002::/16) and SIIT (::ffff:0:0/96) are refused when the embedded address is in a
// refused range; Teredo (2001:0::/32) is always refused.
//
// Time bounds, all through the injected `sleep`: a header-read deadline (a client that never completes the CONNECT line loses its
// slot), a dial timeout, an idle deadline on an established tunnel (no bytes either way; this also ends a half-open tunnel where
// one side closed and the other went silent) and an optional per-tunnel byte cap.
//
// The connection cap is an injected option with no default: the caller passes the one shared bridge cap
// (`BRIDGE_MAX_CONNECTIONS` in sandbox-docker's worker), so the cap has a single definition.

import { type ByteDuplex, relay } from "./worker-stream.ts";

export const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;
export const DEFAULT_HEADER_TIMEOUT_MS = 10_000;
export const DEFAULT_DIAL_TIMEOUT_MS = 10_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

// "tunnel-cut" is a second record for an established tunnel that the idle deadline or the byte cap ended.
export type ConnectOutcome = "allowed" | "refused" | "dial-failed" | "tunnel-cut";

export interface ConnectAudit {
  at: number;
  outcome: ConnectOutcome;
  // The HTTP status answered; 200 for an allowed tunnel (and for a later cut of it).
  status: number;
  // Absent when the request line did not parse far enough to name a target.
  host?: string;
  port?: number;
  // Why the request was refused or failed, or the tunnel cut; absent for an allowed tunnel.
  cause?: string;
  // Tunnels in progress when the decision was made, this one excluded.
  active: number;
}

export interface TerminatorOptions {
  // True only for targets on the allow-list. Receives the lower-case host (IPv6 without brackets) and the numeric port.
  // An exception is treated as a refusal.
  allow: (host: string, port: number) => boolean;
  // Most tunnels in progress at once; the next is refused with 503. Required: pass the shared bridge cap.
  maxConnections: number;
  maxHeaderBytes?: number;
  // Opens the upstream stream to an allowed target; a rejection is answered with 502, a timeout with 504. See the header for the
  // pinning contract.
  dial: (host: string, port: number) => Promise<ByteDuplex>;
  // Called once per decision, and once more when a tunnel is cut. The allow decision is audited before dial. If the sink throws,
  // both ends are closed and the error is rethrown from `handle`.
  audit: (record: ConnectAudit) => void;
  now: () => number;
  // Resolves after `ms` and rejects when `signal` aborts. Injected so deadlines need no real time in tests.
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  // Whole-header deadline from accept. Default 10 s.
  headerTimeoutMs?: number;
  dialTimeoutMs?: number;
  // No byte in either direction for this long ends the tunnel. Default 5 min.
  idleTimeoutMs?: number;
  // Total bytes relayed in both directions before the tunnel is cut. Default none.
  maxTunnelBytes?: number;
  // Default true; see the header.
  denyIpLiterals?: boolean;
  // CIDRs (IPv4 or IPv6, e.g. "10.0.0.0/8", "fd00::/8") whose private-use addresses the built-in deny lets through. Default none:
  // private targets are refused. Never overrides the loopback, link-local, unspecified and IPv4-mapped refusals. A malformed entry
  // throws at construction.
  allowPrivate?: readonly string[];
}

const CRLF2 = Buffer.from("\r\n\r\n");
const TARGET = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9._-]+)):(\d{1,5})$/;
const REASONS: Record<number, string> = {
  200: "Connection Established",
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  408: "Request Timeout",
  431: "Request Header Fields Too Large",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

function statusResponse(status: number, body: string): Buffer {
  const payload = Buffer.from(`${body}\n`);
  const extra = status === 405 ? "Allow: CONNECT\r\n" : "";
  return Buffer.concat([
    Buffer.from(
      `HTTP/1.1 ${status} ${REASONS[status] ?? "Error"}\r\n${extra}Content-Type: text/plain\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
    ),
    payload,
  ]);
}

// One IPv4 part in inet_aton spelling: hex, octal or decimal.
function parseIpv4Part(part: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]*$/.test(part)) return part === "0" ? 0 : Number.parseInt(part, 8);
  if (/^[1-9][0-9]*$/.test(part)) return Number(part);
  return null;
}

// inet_aton-style parse (1 to 4 parts, the last part fills the remaining bytes); null when `host` is not numeric that way.
function parseLooseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length > 4) return null;
  const nums = parts.map(parseIpv4Part);
  if (nums.some((n) => n === null || !Number.isFinite(n))) return null;
  const values = nums as number[];
  const last = values.pop() as number;
  if (values.some((v) => v > 255) || last >= 2 ** (8 * (4 - values.length))) return null;
  let out = last;
  values.forEach((v, i) => {
    out += v * 2 ** (8 * (3 - i));
  });
  return out;
}

function canonicalIpv4(host: string): boolean {
  return /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(host) && host.split(".").every((p) => Number(p) <= 255);
}

function ipv6Bytes(host: string): number[] | null {
  let text = host;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const v4 = tail[1] as string;
    if (!canonicalIpv4(v4)) return null;
    const p = v4.split(".").map(Number);
    text = `${text.slice(0, text.length - v4.length)}${(((p[0] as number) << 8) | (p[1] as number)).toString(16)}:${(((p[2] as number) << 8) | (p[3] as number)).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0] as string);
  const back = halves.length === 2 ? groups(halves[1] as string) : [];
  const fill = 8 - head.length - back.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...back];
  const out: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = Number.parseInt(g, 16);
    out.push(n >> 8, n & 255);
  }
  return out.length === 16 ? out : null;
}

interface Cidr {
  bytes: number[];
  bits: number;
}

// Parse "addr/bits" for an IPv4 (canonical) or IPv6 address; throws naming the entry and the fix.
function parseCidr(entry: string): Cidr {
  const fail = () =>
    new Error(`allowPrivate entry ${JSON.stringify(entry)} is not a CIDR; write an IPv4 or IPv6 address and prefix length such as "10.0.0.0/8" or "fd00::/8"`);
  const m = /^([^/]+)\/(\d{1,3})$/.exec(entry);
  if (!m) throw fail();
  const addr = m[1] as string;
  const bits = Number(m[2]);
  let bytes: number[] | null = null;
  if (addr.includes(":")) bytes = ipv6Bytes(addr);
  else if (canonicalIpv4(addr)) bytes = addr.split(".").map(Number);
  if (!bytes || bits > bytes.length * 8) throw fail();
  return { bytes, bits };
}

function inCidr(b: readonly number[], c: Cidr): boolean {
  if (b.length !== c.bytes.length) return false;
  for (let i = 0; i < c.bits; i++) {
    const mask = 0x80 >> (i % 8);
    if (((b[i >> 3] as number) & mask) !== ((c.bytes[i >> 3] as number) & mask)) return false;
  }
  return true;
}

const PRIVATE_V4: ReadonlyArray<readonly [string, string]> = [
  ["10.0.0.0/8", "a private (RFC 1918) address"],
  ["172.16.0.0/12", "a private (RFC 1918) address"],
  ["192.168.0.0/16", "a private (RFC 1918) address"],
  ["100.64.0.0/10", "a private carrier-grade NAT (CGNAT) address"],
  ["192.0.0.0/24", "a private IETF protocol-assignment address"],
  ["198.18.0.0/15", "a private benchmarking address"],
  ["224.0.0.0/4", "a multicast address"],
  ["240.0.0.0/4", "a reserved or broadcast address"],
];
const PRIVATE_V6: ReadonlyArray<readonly [string, string]> = [
  ["fc00::/7", "a private IPv6 unique-local (ULA) address"],
  ["64:ff9b::/96", "a private NAT64 address"],
  ["64:ff9b:1::/48", "a private NAT64 address"],
  ["ff00::/8", "a multicast address"],
];
const PRIVATE_CIDRS = {
  4: PRIVATE_V4.map(([c, why]) => ({ cidr: parseCidr(c), why })),
  6: PRIVATE_V6.map(([c, why]) => ({ cidr: parseCidr(c), why })),
};

function privateDenial(host: string, b: readonly number[], allowPrivate: readonly string[] | undefined): string | undefined {
  const hit = PRIVATE_CIDRS[b.length === 4 ? 4 : 6].find((r) => inCidr(b, r.cidr));
  if (!hit) return undefined;
  if (allowPrivate?.some((e) => inCidr(b, parseCidr(e)))) return undefined;
  return `${host} is ${hit.why}; to reach private targets list its CIDR in the adapter's allowPrivate option`;
}

// The reason an IP-literal host is refused by the built-in deny, or undefined when it is not such a literal or is acceptable.
// `allowPrivate` lists CIDRs exempt from the private-use ranges only.
// TODO(kit-terminator-site-local): IPv6 site-local fec0::/10 (deprecated, RFC 3879) is not in the default private deny; current behavior: such
// literals pass. See issue #710.
export function ipLiteralDenial(host: string, allowPrivate?: readonly string[]): string | undefined {
  if (host.includes(":")) {
    const b = ipv6Bytes(host);
    if (!b) return `${host} is a malformed IPv6 literal`;
    const zeros = (n: number) => b.slice(0, n).every((x) => x === 0);
    if (zeros(12)) return `${host} is the IPv6 unspecified, loopback or IPv4-compatible range`;
    if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return `${host} is an IPv4-mapped IPv6 address`;
    if (b[0] === 0xfe && ((b[1] as number) & 0xc0) === 0x80) return `${host} is an IPv6 link-local address`;
    // Teredo (2001:0::/32) is refused outright; 6to4 (2002::/16) and SIIT (::ffff:0:0/96) are refused when the IPv4 they embed is.
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return `${host} is a Teredo IPv6 address, which tunnels to an embedded IPv4`;
    const embedded =
      b[0] === 0x20 && b[1] === 0x02 ? b.slice(2, 6) : zeros(8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0 ? b.slice(12, 16) : undefined;
    if (embedded) {
      const inner = ipLiteralDenial(embedded.join("."), allowPrivate);
      if (inner) return `${host} embeds an IPv4 address (6to4 or SIIT): ${inner}`;
      return undefined;
    }
    return privateDenial(host, b, allowPrivate);
  }
  const n = parseLooseIpv4(host);
  if (n === null) return undefined;
  if (!canonicalIpv4(host)) return `${host} is a non-canonical IPv4 spelling (decimal, hex, octal or short form)`;
  const first = Math.floor(n / 2 ** 24);
  if (first === 127) return `${host} is a loopback address`;
  if (first === 0) return `${host} is an unspecified address`;
  if (first === 169 && Math.floor(n / 2 ** 16) % 256 === 254) return `${host} is a link-local address (includes the cloud metadata address)`;
  return privateDenial(host, host.split(".").map(Number), allowPrivate);
}

// Conformance check for a `dial` implementation: it must reject targets that are, or resolve to, loopback, link-local or
// unspecified addresses. A dial that connects is closed and reported with the host that got through.
export async function assertDialRejectsPrivate(
  dial: (host: string, port: number) => Promise<ByteDuplex>,
  hosts: readonly string[] = ["localhost", "127.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "0.0.0.0"],
): Promise<void> {
  for (const host of hosts) {
    let stream: ByteDuplex | undefined;
    try {
      stream = await dial(host, 80);
    } catch {
      continue;
    }
    stream.close();
    throw new Error(
      `dial connected to ${host}, which is loopback, link-local or unspecified; resolve the name once, pin the address, refuse private ranges, and connect to the pinned address`,
    );
  }
}

const EXPIRED = { expired: true } as const;

export class ConnectTerminator {
  #opts: TerminatorOptions;
  #maxHeader: number;
  #active = 0;

  constructor(opts: TerminatorOptions) {
    if (!Number.isInteger(opts.maxConnections) || opts.maxConnections < 1) {
      throw new Error(`maxConnections must be a positive integer, got ${opts.maxConnections}; pass the shared bridge cap`);
    }
    for (const entry of opts.allowPrivate ?? []) parseCidr(entry);
    this.#opts = opts;
    this.#maxHeader = opts.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  }

  get active(): number {
    return this.#active;
  }

  // Serves one connection until its tunnel ends. Never rejects for a refused request (the refusal is the answer and the audit
  // record); rejects when the relay or the audit sink fails, after both ends were closed.
  async handle(client: ByteDuplex): Promise<void> {
    if (this.#active >= this.#opts.maxConnections) {
      await this.#refuse(
        client,
        503,
        `the connection cap of ${this.#opts.maxConnections} tunnels is reached; retry after an open tunnel closes`,
        undefined,
        false,
      );
      return;
    }
    this.#active++;
    try {
      await this.#serve(client);
    } finally {
      this.#active--;
    }
  }

  async #refuse(client: ByteDuplex, status: number, cause: string, target?: { host: string; port: number }, counted = true): Promise<void> {
    const record: ConnectAudit = {
      at: this.#opts.now(),
      outcome: status === 502 || status === 504 ? "dial-failed" : "refused",
      status,
      cause,
      active: this.#active - (counted ? 1 : 0),
    };
    if (target) Object.assign(record, target);
    try {
      this.#opts.audit(record);
    } finally {
      try {
        await client.write(statusResponse(status, cause));
      } catch {
        // The client is already gone; the audit record above is the evidence.
      }
      client.close();
    }
  }

  // A deadline on the injected sleep; `expired` never settles once cancelled.
  #timer(ms: number): { expired: Promise<typeof EXPIRED>; cancel: () => void } {
    const ac = new AbortController();
    const expired = this.#opts.sleep(ms, ac.signal).then(
      () => EXPIRED,
      () => new Promise<never>(() => {}),
    );
    return { expired, cancel: () => ac.abort() };
  }

  // Reads up to the blank line that ends the header. Returns the header text and the bytes behind it, or undefined after answering
  // a refusal.
  async #readHeader(client: ByteDuplex, input: AsyncIterator<Uint8Array>): Promise<{ head: string; rest: Buffer } | undefined> {
    const deadline = this.#timer(this.#opts.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS);
    try {
      let buf: Buffer = Buffer.alloc(0);
      for (;;) {
        const end = buf.indexOf(CRLF2);
        if (end >= 0 ? end + CRLF2.length > this.#maxHeader : buf.length > this.#maxHeader) {
          await this.#refuse(client, 431, `the request header exceeds ${this.#maxHeader} bytes; send only a CONNECT line and short headers`);
          return undefined;
        }
        if (end >= 0) return { head: buf.subarray(0, end).toString("latin1"), rest: buf.subarray(end + CRLF2.length) };
        const pending = input.next();
        pending.catch(() => {});
        const r = await Promise.race([pending, deadline.expired]);
        if ("expired" in r) {
          const ms = this.#opts.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
          await this.#refuse(client, 408, `the CONNECT request was not complete within ${ms} ms; send the whole request line and headers promptly`);
          return undefined;
        }
        if (r.done) {
          await this.#refuse(client, 400, "the client closed before sending a complete CONNECT request; send CONNECT host:port HTTP/1.1 and a blank line");
          return undefined;
        }
        buf = Buffer.concat([buf, r.value]);
      }
    } finally {
      deadline.cancel();
    }
  }

  async #serve(client: ByteDuplex): Promise<void> {
    let upstream: ByteDuplex | undefined;
    try {
      await this.#serveInner(client, (u) => {
        upstream = u;
      });
    } catch (e) {
      // Whatever failed (the audit sink, the input stream, a write, the relay), neither end may be left open.
      for (const side of [client, upstream]) {
        if (!side) continue;
        try {
          if (side.reset) side.reset("tunnel setup failed");
          else side.close();
        } catch {
          // Already gone.
        }
      }
      throw e;
    }
  }

  async #serveInner(client: ByteDuplex, setUpstream: (u: ByteDuplex) => void): Promise<void> {
    const input = client.output()[Symbol.asyncIterator]();
    const header = await this.#readHeader(client, input);
    if (!header) return;
    const { head, rest } = header;
    const requestLine = head.split("\r\n", 1)[0] ?? "";
    const parts = requestLine.split(" ");
    if (parts.length !== 3 || !/^HTTP\/1\.[01]$/.test(parts[2] ?? "")) {
      await this.#refuse(client, 400, "malformed request line; send CONNECT host:port HTTP/1.1");
      return;
    }
    if (parts[0] !== "CONNECT") {
      const method = (parts[0] ?? "").slice(0, 16).replace(/[^\x20-\x7e]/g, "?");
      await this.#refuse(client, 405, `only CONNECT is supported here, got ${method}; use an HTTPS proxy client`);
      return;
    }
    const m = TARGET.exec(parts[1] ?? "");
    const port = m ? Number(m[3]) : 0;
    if (!m || port < 1 || port > 65535) {
      await this.#refuse(client, 400, "the CONNECT target must be host:port with a port from 1 to 65535");
      return;
    }
    const host = (m[1] ?? m[2] ?? "").toLowerCase().replace(/\.$/, "");
    const target = { host, port };
    if (this.#opts.denyIpLiterals !== false) {
      const denial = ipLiteralDenial(host, this.#opts.allowPrivate);
      if (denial) {
        await this.#refuse(
          client,
          403,
          `${denial}; the egress proxy does not tunnel to local or ambiguous addresses, use a hostname on the allow-list`,
          target,
        );
        return;
      }
    }
    let permitted = false;
    try {
      permitted = this.#opts.allow(host, port) === true;
    } catch {
      await this.#refuse(client, 403, `the allow-list check failed for ${host}:${port}, so the target is refused; fix the allow-list source`, target);
      return;
    }
    if (!permitted) {
      await this.#refuse(
        client,
        403,
        `${host}:${port} is not on the egress allow-list; add the destination to the agent's egress allow-list to use it`,
        target,
      );
      return;
    }
    // The allow decision is on record before anything is dialed.
    this.#opts.audit({ at: this.#opts.now(), outcome: "allowed", status: 200, host, port, active: this.#active - 1 });
    const upstream = await this.#dial(client, host, port);
    if (!upstream) return;
    setUpstream(upstream);
    await client.write(Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"));
    await this.#tunnel(client, upstream, input, rest, target);
  }

  async #dial(client: ByteDuplex, host: string, port: number): Promise<ByteDuplex | undefined> {
    const ms = this.#opts.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS;
    const deadline = this.#timer(ms);
    const dialing = Promise.resolve().then(() => this.#opts.dial(host, port));
    dialing.catch(() => {});
    try {
      const r = await Promise.race([dialing, deadline.expired]);
      if ("expired" in r) {
        // A dial that finishes after the deadline must not leak its stream.
        dialing.then(
          (late) => late.close(),
          () => {},
        );
        await this.#refuse(client, 504, `connecting to ${host}:${port} took longer than ${ms} ms; check the destination is up and retry`, { host, port });
        return undefined;
      }
      return r;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await this.#refuse(client, 502, `could not reach ${host}:${port} (${why}); check the destination is up and retry`, { host, port });
      return undefined;
    } finally {
      deadline.cancel();
    }
  }

  async #tunnel(
    client: ByteDuplex,
    upstream: ByteDuplex,
    clientInput: AsyncIterator<Uint8Array>,
    rest: Buffer,
    target: { host: string; port: number },
  ): Promise<void> {
    const idleMs = this.#opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const cap = this.#opts.maxTunnelBytes;
    const watch = new AbortController();
    let activity = 0;
    let bytes = 0;
    let cutCause: string | undefined;
    const cut = (cause: string) => {
      if (cutCause !== undefined) return;
      cutCause = cause;
      for (const side of [client, upstream]) {
        try {
          if (side.reset) side.reset(cause);
          else side.close();
        } catch {
          // Already gone.
        }
      }
    };
    const touch = (n: number) => {
      activity++;
      bytes += n;
      if (cap !== undefined && bytes > cap) cut(`the tunnel carried more than ${cap} bytes, the per-tunnel cap`);
    };
    const wrap = (d: ByteDuplex): ByteDuplex => {
      const w: ByteDuplex = {
        write: async (data) => {
          if (cutCause !== undefined) throw new Error(cutCause);
          touch(data.length);
          if (cutCause !== undefined) throw new Error(cutCause);
          await d.write(data);
        },
        output: () => d.output(),
        close: () => d.close(),
      };
      if (d.reset) w.reset = (r) => d.reset?.(r);
      return w;
    };
    const watchIterator = (it: AsyncIterator<Uint8Array>): AsyncIterator<Uint8Array> => ({
      next: async () => {
        const r = await it.next();
        if (!r.done) activity++;
        return r;
      },
    });
    void (async () => {
      for (;;) {
        const seen = activity;
        try {
          await this.#opts.sleep(idleMs, watch.signal);
        } catch {
          return;
        }
        if (activity === seen) {
          cut(`the tunnel carried no bytes for ${idleMs} ms, the idle limit`);
          return;
        }
      }
    })();
    const up = wrap(upstream);
    try {
      // Bytes the client sent behind the header (an eager TLS hello) belong to the tunnel.
      if (rest.length > 0) await up.write(rest);
      await relay(wrap(client), up, { aInput: watchIterator(clientInput) });
    } catch (e) {
      if (cutCause === undefined) throw e;
    } finally {
      watch.abort();
    }
    if (cutCause !== undefined) {
      this.#opts.audit({ at: this.#opts.now(), outcome: "tunnel-cut", status: 200, ...target, cause: cutCause, active: this.#active - 1 });
    }
  }
}

export function createConnectTerminator(opts: TerminatorOptions): ConnectTerminator {
  return new ConnectTerminator(opts);
}
