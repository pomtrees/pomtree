// Scrubber for recorded fixtures and captured logs: REJECTS planted secrets, tokens and machine-specific paths. Pure:
// text in, findings out. A finding names the path, line, rule and action and never echoes the matched value, so a real
// leak is not copied into a log.
//
// The rule classes mirror packages/e2e/src/fixture-scrub-rules.ts, which owns the repository fixture scan; they are
// mirrored here, not imported, because packages do not import across that boundary. Keep the two in step when a class is
// added there.

export interface Finding {
  path: string;
  line: number;
  rule: string;
  action: string;
}

interface Rule {
  id: string;
  hit: (line: string, placeholders: ReadonlySet<string>) => boolean;
  action: string;
}

// A value that is visibly a stand-in rather than a credential: <TOKEN>, {{token}}, REDACTED, ****, xxx, ${VAR}.
const PLACEHOLDER = /^(?:<[^>]*>|\{\{[^}]*\}\}|\[?REDACTED\]?|\*{3,}|x{3,}|PLACEHOLDER\w*|\$\{?[A-Z_]+\}?)$/i;
const isPlaceholder = (value: string, declared: ReadonlySet<string>) => PLACEHOLDER.test(value) || declared.has(value);

export const PROVIDER_PREFIXES: readonly string[] = [
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
const PREFIX_RE = new RegExp(`(?<![A-Za-z0-9_-])(?:${PROVIDER_PREFIXES.map(escapeRe).join("|")})[A-Za-z0-9_-]{8,}`);

// Any `<NAME>_TOKEN` or `<NAME>_TOKEN_FILE` assignment (the repository scan names its one variable; the kit sees every adapter's).
const TOKEN_ENV_RE = /\b[A-Z][A-Z0-9_]*_TOKEN(?:_FILE)?["']?\s*[:=]\s*["']?([^"'\s,}]+)/;
const BEARER_RE = /\bBearer\s+["']?([^"'\s,}]+)/i;
const AUTH_HEADER_RE = /\b(?:authorization|x-api-key)["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic)\s+)?([^"'\s,}]+)/i;
const ACCOUNT_RE = /\b(?:account_?id|organi[sz]ation_?id|org_?id)["']?\s*[:=]\s*["']?([^"'\s,}]+)/i;
const SECRET_ASSIGN_RE = /(?:password|passwd|secret)\w*["']?\s*[:=]\s*["']?([^"'\s,}]{8,})/i;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const BLOB_RE = /(?<![A-Za-z0-9+/_.-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_-])/g;
const HASH_CONTEXT = /sha(?:1|256|512)|digest|checksum|integrity|etag|hash/i;
const ABS_PATH_RE = /(?<![A-Za-z0-9_.~-])(?:\/Users\/|\/home\/|\/root\/|\/var\/folders\/|\/private\/|~\/)[^\s"']|(?<![A-Za-z0-9])[A-Za-z]:\\/;

function looksLikeKey(c: string): boolean {
  if (/^[0-9]+$/.test(c) || /^[0-9a-fA-F]+$/.test(c)) return true;
  if (!/[A-Za-z]/.test(c) || !/\d/.test(c)) return false;
  if (!/[-_]/.test(c)) return true;
  const wordLike = (seg: string) => /^(?:[A-Za-z][a-z]{2,}|[A-Z]{2,}|\d{1,4})$/.test(seg);
  return /[A-Z]/.test(c) && /[a-z]/.test(c) && !c.split(/[-_/]/).some(wordLike);
}

function hasKeyBlob(line: string, declared: ReadonlySet<string>): boolean {
  return [...line.matchAll(BLOB_RE)].some((m) => {
    const run = m[0];
    const candidates = run.split("/").length > 2 ? run.split("/") : [run];
    return candidates.some((c) => c.length >= 32 && looksLikeKey(c) && !isPlaceholder(c, declared) && !isPlaceholder(run, declared));
  });
}

function capturedNotPlaceholder(re: RegExp) {
  return (line: string, declared: ReadonlySet<string>) => {
    const m = re.exec(line);
    return m !== null && m[1] !== undefined && !isPlaceholder(m[1], declared);
  };
}

// Order matters: the first rule a line breaks is the one reported.
export const RULES: readonly Rule[] = [
  {
    id: "private-key-block",
    hit: (line) => PEM_RE.test(line),
    action: "remove the PEM private key from the fixture and re-record through the scrubbing recorder, then revoke the key",
  },
  {
    id: "token-env",
    hit: capturedNotPlaceholder(TOKEN_ENV_RE),
    action: "replace the value with a placeholder such as <TOKEN>; fixtures never hold a real token or token-file path",
  },
  {
    id: "provider-key-prefix",
    hit: (line) => PREFIX_RE.test(line),
    action: "replace the key with a placeholder such as <PROVIDER_KEY> in the recorder's scrub step and re-record, then rotate the key if it was real",
  },
  {
    id: "bearer-token",
    hit: capturedNotPlaceholder(BEARER_RE),
    action: "replace the bearer token with <BEARER_TOKEN> in the recorder's scrub step and re-record, then rotate the token if it was real",
  },
  {
    id: "auth-header",
    hit: capturedNotPlaceholder(AUTH_HEADER_RE),
    action: "replace the Authorization or x-api-key value with <REDACTED> in the recorder's scrub step and re-record",
  },
  {
    id: "account-id",
    hit: capturedNotPlaceholder(ACCOUNT_RE),
    action: "replace the account or organization id with a placeholder and list it under `placeholders` in the fixture header",
  },
  {
    id: "secret-assignment",
    hit: capturedNotPlaceholder(SECRET_ASSIGN_RE),
    action: "replace the password or secret value with <REDACTED> in the recorder's scrub step and re-record, then rotate the secret if it was real",
  },
  {
    id: "high-entropy",
    hit: (line, declared) => !HASH_CONTEXT.test(line) && hasKeyBlob(line.replace(UUID_RE, " "), declared),
    action:
      "replace the 32+ character string with a placeholder, label it as a hash (sha256, digest, etag) if it is one, or list a long opaque id in the header `placeholders` to allow it",
  },
  {
    id: "absolute-path",
    hit: (line) => ABS_PATH_RE.test(line),
    action: "replace the machine-specific path with a container path such as /workspace or a <PATH> placeholder",
  },
];

// Placeholders a fixture declares: any line that is a JSON object with a `placeholders` array of strings.
export function declaredPlaceholders(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("{") || !line.includes("placeholders")) continue;
    try {
      const v = (JSON.parse(line) as { placeholders?: unknown }).placeholders;
      if (Array.isArray(v)) for (const p of v) if (typeof p === "string") out.add(p);
    } catch {
      // not a header line
    }
  }
  return out;
}

export function scanText(path: string, text: string): Finding[] {
  const declared = declaredPlaceholders(text);
  const findings: Finding[] = [];
  text.split("\n").forEach((line, i) => {
    const rule = RULES.find((r) => r.hit(line, declared));
    if (rule) findings.push({ path, line: i + 1, rule: rule.id, action: rule.action });
  });
  return findings;
}

export function formatFinding(f: Finding): string {
  return `${f.path}:${f.line} [${f.rule}] ${f.action}`;
}

// Throws when the text holds a planted secret. The message lists each finding (path, line, rule, action), never a value.
export function assertScrubbed(path: string, text: string): void {
  const findings = scanText(path, text);
  if (findings.length === 0) return;
  throw new Error(`${path} is not scrubbed (${findings.length} finding(s)):\n${findings.map(formatFinding).join("\n")}`);
}
