// Strips credentials from provider responses, error text and log fields before they are shown or thrown. Pure: text in,
// text out. Adapters pass configured credential values as `secrets`; the shape-based rules catch what was not configured
// (a token a provider echoes from another request, a key in a pasted header).

export const REDACTED = "[REDACTED]";

// Known provider key prefixes. Mirrors PROVIDER_PREFIXES in packages/e2e/src/fixture-scrub-rules.ts (not imported:
// packages do not import across this boundary).
const PROVIDER_PREFIXES = [
  "sk-ant-",
  "sk-proj-",
  "sk-or-",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "glpat-",
  "AKIA",
  "ASIA",
  "AIza",
  "xoxb-",
  "xoxp-",
  "xapp-",
  "hf_",
  "pplx-",
  "e2b_",
  "rk_live_",
  "sk_live_",
];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PREFIX_RE = new RegExp(`(?<![A-Za-z0-9_-])(?:${PROVIDER_PREFIXES.map(escapeRe).join("|")})[A-Za-z0-9_-]{8,}`, "g");
const BEARER_RE = /\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]+/gi;
// `Authorization: x`, `"x-api-key": "x"`, `authorization=x`; the value runs to the end of the quoted string or the line.
// `Authorization: x`, `"x-api-key": "x"`; the value runs to the closing quote or the end of the line (a comma is part of it).
const AUTH_HEADER_RE = /(\b(?:proxy-)?authorization|\bx-api-key)(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\s)[^"'\r\n]+/gi;
// Fields whose name says they hold a credential, in JSON (`"name":"v"`) and assignment (`name=v`, `name: v`) forms. The name
// may carry any prefix or suffix (`openai_api_key`, `x-auth-token`). At least as strong as the scrubber's token-env and
// secret-assignment rules in scrub.ts.
const SENSITIVE_FIELD_RE =
  /([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[-_ ]?key|private[-_ ]?key|credential)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}"']+)/gi;
// Telegram-style bot token inside a URL path: bot<digits>:<secret>.
const BOT_TOKEN_RE = /\bbot\d{6,}:[A-Za-z0-9_-]{20,}/g;
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

// Shortest configured value that is replaced as a literal; shorter strings would mangle ordinary text.
const MIN_SECRET_LENGTH = 4;

export interface RedactOptions {
  // Credential values the adapter holds (read per use). Replaced wherever they appear, plus their URL-encoded form.
  secrets?: readonly (string | undefined)[];
}

export function redact(text: string, opts: RedactOptions = {}): string {
  let out = text;
  // Longest first, so a secret that contains another is replaced whole.
  const literals = (opts.secrets ?? [])
    .filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH)
    .flatMap((s) => [s, encodeURIComponent(s)])
    .sort((a, b) => b.length - a.length);
  for (const s of literals) out = out.split(s).join(REDACTED);
  out = out.replace(PEM_RE, REDACTED);
  out = out.replace(AUTH_HEADER_RE, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  out = out.replace(BEARER_RE, (_m, scheme: string, ws: string) => `${scheme}${ws}${REDACTED}`);
  out = out.replace(SENSITIVE_FIELD_RE, (_m, name: string, sep: string, value: string) => {
    const q = value[0] === '"' || value[0] === "'" ? value[0] : "";
    return `${name}${sep}${q}${REDACTED}${q}`;
  });
  out = out.replace(BOT_TOKEN_RE, `bot${REDACTED}`);
  out = out.replace(PREFIX_RE, REDACTED);
  return out;
}

// Header names whose values never appear in logs or errors.
const SENSITIVE_HEADERS = /^(?:(?:proxy-)?authorization|x-api-key|cookie|set-cookie|.*token.*|.*secret.*|.*api-?key.*)$/i;

export function redactHeaders(headers: Readonly<Record<string, string>>, opts: RedactOptions = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SENSITIVE_HEADERS.test(k) ? REDACTED : redact(v, opts);
  return out;
}

// Deepest cause chain appended to a message.
const MAX_CAUSE_DEPTH = 5;

// A new Error with the same name and a redacted message. The cause chain (cycle-safe, depth-capped) is appended as redacted
// text, so operators keep the cause without any secret; the original is not attached as `cause`.
export function redactError(err: unknown, opts: RedactOptions = {}): Error {
  const message = err instanceof Error ? err.message : String(err);
  const parts = [redact(message, opts)];
  const seen = new Set<unknown>([err]);
  let cur: unknown = err instanceof Error ? err.cause : undefined;
  while (cur !== undefined && cur !== null && !seen.has(cur) && parts.length <= MAX_CAUSE_DEPTH) {
    seen.add(cur);
    parts.push(`cause: ${redact(cur instanceof Error ? cur.message : String(cur), opts)}`);
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  const safe = new Error(parts.join("; "));
  safe.name = err instanceof Error ? err.name : "Error";
  return safe;
}

// A URL without userinfo or query string (both may carry credentials), for messages and logs.
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return redact(u.toString());
  } catch {
    // Unparseable: strip userinfo (`//user:pass@`), query and fragment textually.
    const noQuery = url.split(/[?#]/)[0] ?? "";
    return redact(noQuery.replace(/^([A-Za-z][A-Za-z0-9+.-]*:)?\/\/[^/@\s]*@/, (_m, scheme: string | undefined) => `${scheme ?? ""}//`));
  }
}
