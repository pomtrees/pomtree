// Pure env/config parsing for the pomtreed entrypoint: no fs, sockets or process state, so it is unit-testable.
// Every parser fails fast with a message naming the variable (a typo must never silently open a gate).
import { isAbsolute } from "node:path";
import type { ChannelRegistry } from "./channels.ts";
import { StatePolicy } from "./state-policy.ts";

type Env = Record<string, string | undefined>;

export interface ListenSpec {
  host: string;
  port: number;
}

/** Strict `host:port` (`[::1]:8787` for IPv6; port 0 = ephemeral). "off" yields null where allowed. */
export function parseListen(name: string, raw: string, opts: { allowOff?: boolean } = {}): ListenSpec | null {
  if (opts.allowOff && raw === "off") return null;
  const bad = (why: string) => new Error(`invalid ${name}=${JSON.stringify(raw)}: ${why} (expected host:port, e.g. 127.0.0.1:8787 or [::1]:8787)`);
  let host: string;
  let portStr: string;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]:");
    if (end < 0) throw bad("malformed IPv6 bracket form");
    host = raw.slice(1, end);
    portStr = raw.slice(end + 2);
    if (!host.includes(":")) throw bad("bracketed host is not IPv6");
  } else {
    const i = raw.lastIndexOf(":");
    if (i < 0) throw bad("missing :port");
    host = raw.slice(0, i);
    portStr = raw.slice(i + 1);
    if (host.includes(":")) throw bad("IPv6 hosts need brackets");
  }
  if (host === "") throw bad("empty host");
  if (!/^\d{1,5}$/.test(portStr) || Number(portStr) > 65535) throw bad("port must be 0-65535");
  return { host, port: Number(portStr) };
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === "::ffff:127.0.0.1";
}

/** `isLoopbackHost` for a host as `planAgentListen` keeps it: an IPv6 literal may still carry its brackets ("[::1]"). */
export function isLoopbackListenHost(host: string): boolean {
  return isLoopbackHost(host.replace(/^\[(.*)\]$/, "$1"));
}

/** Refuse a non-loopback bind of an operator-grade listener unless explicitly allowed. */
export function assertLoopbackOrAllowed(name: string, spec: ListenSpec, allowNonLoopback: boolean): void {
  if (isLoopbackHost(spec.host) || allowNonLoopback) return;
  throw new Error(
    `${name} binds non-loopback ${spec.host}: the listener is plain HTTP; set POMTREED_LISTEN_ALLOW_NONLOOPBACK=1 to accept this (put TLS/auth in front)`,
  );
}

export interface StateDirFacts {
  isDirectory: boolean;
  uid: number;
  mode: number;
}

/** Throws unless the state dir is a directory owned by `uid`; returns true when its mode must be tightened to 0700. */
export function checkStateDir(path: string, facts: StateDirFacts, uid: number | undefined): { chmod: boolean } {
  if (!isAbsolute(path)) throw new Error(`state dir ${path} must resolve to an absolute path`);
  if (!facts.isDirectory) throw new Error(`state dir ${path} is not a directory`);
  if (uid !== undefined && facts.uid !== uid) throw new Error(`state dir ${path} is owned by uid ${facts.uid}, not the running uid ${uid}; refusing to start`);
  return { chmod: (facts.mode & 0o777) !== 0o700 };
}

/** Short stable hash for idempotency keys (a crash reason can embed a whole stack). */
export function shortHash(s: string, hash: (s: string) => string): string {
  return hash(s).slice(0, 16);
}

// TODO(operability): add structured logging, metrics and backup rotation. Current behavior: stamp() only prefixes plain text.
// Startup and crash lines are plain console.error text, many without a timestamp; there is no level or JSON-line form.
/** ISO-timestamped log line for startup/shutdown/crash messages. */
export function stamp(msg: string, now: Date = new Date()): string {
  return `${now.toISOString()} ${msg}`;
}

// TODO(ui-default-off): refuse or redirect when the ui channel has no listener. Current behavior: it only warns at startup.
// With no UI listener, asks and approvals can be answered only over the unix socket (pomtree CLI); otherwise they time out.
/** The startup warning when approvals/asks go to the UI channel but no UI listener exists, else null. */
export function uiChannelWarning(channels: ChannelRegistry, uiListen: string): string | null {
  if (!channels.get("ui")?.outbound || uiListen !== "off") return null;
  return "pomtreed: WARNING: escalation channel `ui` is configured but POMTREED_UI_LISTEN is off: no operator UI is listening, so asks/approvals can only be answered over the unix socket (pomtree CLI) or they time out. Set POMTREED_UI_LISTEN=127.0.0.1:8787 or another channel";
}

/** The publish content scan (publish-pin.ts) is on unless POMTREED_PUBLISH_SCAN is exactly "0". */
// TODO(config-registry): only the e2e drift test (config-registry-drift.test.ts) still calls this env-map reader; pomtreed resolves
// publish.scan through daemon-config.ts. Delete it with that drift row.
export function publishScanEnabled(env: Env): boolean {
  return env.POMTREED_PUBLISH_SCAN !== "0";
}

/** The startup warning when the publish content scan (publish.scan) is disabled, else null. */
export function publishScanWarning(enabled: boolean): string | null {
  if (enabled) return null;
  return "pomtreed: WARNING: publish.scan=false (POMTREED_PUBLISH_SCAN) disables the publish content scan (credentials, commit messages and CI-file additions are no longer checked before a publish)";
}

/** The state grants and limits (POMTREED_STATE_GRANTS, POMTREED_STATE_LIMITS); malformed input throws, so the daemon refuses to start. */
// TODO(config-registry): only the e2e state-limits drift test still calls this env-map reader; pomtreed builds its StatePolicy from
// the resolved state.grants/state.limits in daemon-config.ts. Delete it when that test moves to the registry.
export function statePolicyFromEnv(env: Env): StatePolicy {
  return new StatePolicy(env.POMTREED_STATE_GRANTS, env.POMTREED_STATE_LIMITS);
}
