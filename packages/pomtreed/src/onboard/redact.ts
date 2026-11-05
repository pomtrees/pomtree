// Redaction for the `pomtreed init` dry-run diff: an existing planned file is user content and may hold a secret (an inline key in
// pomtreed.env, an "upstreamKey" in pomtreed.json, an `Environment=` line in a unit), so both sides are redacted before they are diffed. Pure.
import { CONFIG_REGISTRY, isSensitive } from "@pomtree/core";

export const REDACTED = "<redacted>";

const SENSITIVE = CONFIG_REGISTRY.params.filter(isSensitive);
const SENSITIVE_ENV = new Set(SENSITIVE.map((p) => CONFIG_REGISTRY.envOf.get(p.path) as string));
const SENSITIVE_JSON_KEYS = new Set(SENSITIVE.map((p) => p.path.split(".").at(-1) as string));
// Names the registry does not own are judged by their words: a credential under another tool's name (OPENROUTER_API_KEY) is
// still a credential. A `_FILE` name holds a path, not the secret.
const SECRET_WORD = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/;
const SECRET_JSON_WORD = /(?:key|token|secret|password|passwd|credentials?)$/i;

function sensitiveEnvName(name: string): boolean {
  if (CONFIG_REGISTRY.envNames.has(name)) return SENSITIVE_ENV.has(name);
  return !name.endsWith("_FILE") && SECRET_WORD.test(name);
}

function sensitiveJsonKey(key: string): boolean {
  return SENSITIVE_JSON_KEYS.has(key) || SECRET_JSON_WORD.test(key);
}

// `NAME=value`, `export NAME=value`, and a unit's `Environment=NAME=value` / `Environment="NAME=value"`.
const ENV_LINE = /^(\s*(?:export\s+|Environment=["']?)?)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
// A JSON member `"key": value` where value is a string (escapes included) or a scalar run up to a delimiter; the fallback run
// (an optional quote, then no quote, brace or bracket) also covers an unterminated string in a file that is not valid JSON, and
// never swallows a nested object or array, whose own members are matched in turn.
const JSON_MEMBER = /("((?:[^"\\]|\\.)*)"\s*:\s*)("(?:[^"\\]|\\.)*"|"?[^,{}[\]\s"]+)/g;

/** The text with the value of every sensitive env line and JSON member replaced by REDACTED; everything else is kept byte for byte. */
export function redactSecrets(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const m = ENV_LINE.exec(line);
      if (m !== null && sensitiveEnvName(m[2] as string)) return `${m[1]}${m[2]}=${REDACTED}`;
      return line.replace(JSON_MEMBER, (all, head: string, key: string) => (sensitiveJsonKey(key) ? `${head}"${REDACTED}"` : all));
    })
    .join("\n");
}
