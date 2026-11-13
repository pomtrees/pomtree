import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentId, MessagingChannel } from "@pomtree/core";

export type Principal =
  | { scope: "operator" }
  | { scope: "agent"; agent: AgentId; generation: number; expiry: number }
  | { scope: "host"; channel: MessagingChannel }
  | { scope: "ext"; name: string };

// The clock expiry is judged by, in epoch ms. Every function that reads time takes one as its last parameter so tests control it; callers with
// a daemon pass its clock (`daemon.now()`), and the default is the wall clock.
export type Now = () => number;
const wallClock: Now = () => Number(new Date());

const mac = (secret: string, subject: string) => createHmac("sha256", secret).update(subject).digest("hex");

// Extension names appear in `ext.<name>.<hmac>` tokens, so they must be token-safe: lowercase,
// start with a letter or digit, and contain no `.`, `/`, `..`, whitespace or control characters.
const EXT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function assertExtName(name: string): void {
  if (!EXT_NAME_RE.test(name)) {
    throw new Error(`invalid extension name ${JSON.stringify(name)}: only lowercase letters, digits, "-" and "_" are allowed, starting with a letter or digit`);
  }
}

// Channel names appear in `ht.<channel>.<hmac>` tokens and in `messaging.<channel>.token` file names, so
// they must be token-safe: no `.` (the token separator), `/`, `\`, `..`, whitespace or control characters.
export const CHANNEL_RE = /^[A-Za-z0-9_-]+$/;

function assertChannel(channel: string): void {
  if (!CHANNEL_RE.test(channel)) {
    throw new Error(`invalid messaging channel ${JSON.stringify(channel)}: only letters, digits, "-" and "_" are allowed`);
  }
}

// The default lifetime of an agent credential. A stale container (an earlier generation after a
// kill_resume) must lose access when its token expires even if the generation fence is bypassed,
// so tokens are issued with a bounded TTL. Deploys can override via POMTREED_AGENT_TOKEN_TTL_MS.
export const AGENT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// Tokens are derived from the secret, so the daemon holds no token table (token validity is recomputed from the secret, never stored).
// The host token is `ht.<channel>.<hmac(secret, "channel:"+channel)>`; the channel is validated so it
// cannot contain the token separator or path-like characters.
// Agent tokens bind the generation (fences a resumed agent's old run) and an absolute expiry, so the
// token is `ag.<agent>.<generation>.<expiry>.<hmac(secret, "agent:<agent>:<generation>:<expiry>")>`.
export function issueToken(secret: string, p: Principal): string {
  if (p.scope === "operator") return `op.${mac(secret, "operator")}`;
  if (p.scope === "agent") return `ag.${p.agent}.${p.generation}.${p.expiry}.${mac(secret, `agent:${p.agent}:${p.generation}:${p.expiry}`)}`;
  if (p.scope === "ext") {
    assertExtName(p.name);
    return `ext.${p.name}.${mac(secret, `extension:${p.name}`)}`;
  }
  assertChannel(p.channel);
  return `ht.${p.channel}.${mac(secret, `channel:${p.channel}`)}`;
}

export function verifyToken(secret: string, token: string, now: Now = wallClock): Principal | null {
  const parts = token.split(".");
  let principal: Principal;
  if (parts.length === 2 && parts[0] === "op") principal = { scope: "operator" };
  else if (parts.length === 5 && parts[0] === "ag" && parts[1] && parts[2] && parts[3] && /^\d+$/.test(parts[2]) && /^\d+$/.test(parts[3])) {
    const generation = Number(parts[2]);
    const expiry = Number(parts[3]);
    if (!Number.isInteger(generation) || generation < 0 || !Number.isFinite(expiry) || expiry <= now()) return null;
    principal = { scope: "agent", agent: parts[1], generation, expiry };
  } else if (parts.length === 3 && parts[0] === "ht" && parts[1] && CHANNEL_RE.test(parts[1])) principal = { scope: "host", channel: parts[1] };
  else if (parts.length === 3 && parts[0] === "ext" && parts[1] && EXT_NAME_RE.test(parts[1])) principal = { scope: "ext", name: parts[1] };
  else return null;
  const a = Buffer.from(issueToken(secret, principal));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b) ? principal : null;
}

// Why a presented token did not verify, for the 401 body's `code` (never its text: nothing from the token is echoed). `expired`
// is only ever an agent token this daemon issued (its MAC checks) whose expiry has passed; anything else is `invalid`.
export function tokenProblem(secret: string, token: string, now: Now = wallClock): "invalid" | "expired" {
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "ag" || !parts[1] || !/^\d+$/.test(parts[2] ?? "") || !/^\d+$/.test(parts[3] ?? "")) return "invalid";
  const p: Principal = { scope: "agent", agent: parts[1], generation: Number(parts[2]), expiry: Number(parts[3]) };
  const a = Buffer.from(issueToken(secret, p));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b) && p.expiry <= now() ? "expired" : "invalid";
}

// Browser UI session cookie: `pomtreed_ui=<expiry>.<hmac(secret, "ui:"+expiry)>`. The expiry is the
// absolute epoch ms the cookie stops being valid; the HMAC binds it to the daemon's secret so the
// daemon holds no session table. Expiry is checked on verify, so a stolen cookie decays on
// its own rather than living forever.
export function issueUiCookie(secret: string, ttlMs: number, now: Now = wallClock): string {
  const expiry = now() + ttlMs;
  return `pomtreed_ui=${expiry}.${mac(secret, `ui:${expiry}`)}`;
}

// Accepts either the full Cookie header (`pomtreed_ui=...; other=...`) or the bare `pomtreed_ui=...` value.
export function verifyUiCookie(secret: string, cookie: string, now: Now = wallClock): boolean {
  if (!cookie) return false;
  let value: string | undefined;
  for (const part of cookie.split(";")) {
    const p = part.trim();
    if (p.startsWith("pomtreed_ui=")) {
      value = p.slice("pomtreed_ui=".length);
      break;
    }
  }
  if (value === undefined) return false;
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return false;
  const expiryStr = value.slice(0, dot);
  const got = value.slice(dot + 1);
  if (!/^\d+$/.test(expiryStr)) return false;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < now()) return false;
  const a = Buffer.from(mac(secret, `ui:${expiryStr}`));
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}
