// Env names are derived forward from a parameter path, never parsed back: `report.maxBytes` -> `POMTREED_REPORT_MAX_BYTES`.
// Pure: no env or fs access.

// The env prefix of each namespace (a path's first segment). The namespace segment stays in the name, so two namespaces
// sharing a prefix cannot collide. Every registered prefix is owned: an unregistered name under it is refused by the resolver.
//
// Naming rule: a namespace names the concern a key governs (reports, budget, session, ...), never the package that happens
// to host the code, so there is no `core.` or `daemon.` catch-all. Within a concern the path is chosen so the derived name
// equals the pre-registry env name whenever a natural concern path gives it (`report.maxBytes` -> POMTREED_REPORT_MAX_BYTES).
// Every concern maps to POMTREED_ except `client` (the pomtree CLI), which maps to POMTREE_.
// The root namespace `ext` holds extension-contributed keys (`ext.<segment>.<key>`, EXT_NAMESPACE): built-in keys may not use it
// (defineRegistry refuses them); only extendRegistry fills it, from the loaded extensions' manifests. Its names derive like any
// other: the path's segments, upper-snake, under the POMTREED_ prefix (`ext.hnDigest.maxCount` -> POMTREED plus EXT, HN, DIGEST, MAX, COUNT).
const CONCERNS = [
  "accessLog",
  "agent",
  "approval",
  "ask",
  "audit",
  "browser",
  "budget",
  "capacity",
  "capture",
  "chat",
  "cleanup",
  "cron",
  "drain",
  "envCache",
  "escalation",
  "extensions",
  "folder",
  "harness",
  "host",
  "idempotency",
  "journal",
  "listen",
  "merge",
  "messaging",
  "model",
  "otlp",
  "pi",
  "publish",
  "push",
  "readyz",
  "repo",
  "report",
  "sandbox",
  "search",
  "session",
  "socket",
  "state",
  "templates",
  "test",
  "ui",
  "wait",
  "watchdog",
  "webfetch",
  "workflow",
] as const;

export const CONFIG_ENV_PREFIXES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(CONCERNS.map((ns) => [ns, "POMTREED_"])),
  client: "POMTREE_",
  ext: "POMTREED_",
};

// The root namespace of extension-contributed keys, and the env family every one of their names (parameters and declared
// credentials alike) falls under: POMTREED_EXT_<NAME>_<KEY>.
export const EXT_NAMESPACE = "ext";
export const EXT_ENV_PREFIX = "POMTREED_EXT_";

// The path segment of an extension name: its camelCase (`hn-digest` -> `hnDigest`), or null when no valid segment results (a name
// starting with a digit). Two names may map to the same segment (`my-ext`, `my_ext`); extendRegistry refuses that for extensions
// that own config (declare params or credentials).
export function extensionSegment(name: string): string | null {
  const segment = name.replace(/[-_]+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return /^[a-z][a-zA-Z0-9]*$/.test(segment) ? segment : null;
}

const envPart = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9_]/g, "_");

// The env prefix of an extension's names, keys and credentials alike: POMTREED_EXT_<NAME>_, derived from its segment exactly as a key
// path is (`hn-digest` -> POMTREED_EXT_HN_DIGEST_; a digit stays with its hump, as in `a-1b` -> segment `a1b`). A name with no segment (which owns no config) falls back
// to its non-alphanumerics-as-`_` form.
export function extensionEnvPrefix(extension: string): string {
  const segment = extensionSegment(extension);
  return `${EXT_ENV_PREFIX}${segment === null ? envPart(extension) : camelHumps(segment).join("_").toUpperCase()}_`;
}

// The env name of a declared extension credential: POMTREED_EXT_<NAME>_<CRED> (non-alphanumerics become `_`).
export const extensionCredentialEnv = (extension: string, credential: string): string => `${extensionEnvPrefix(extension)}${envPart(credential)}`;

// The env var naming the JSON config file. Reserved: no parameter may derive it.
export const CONFIG_FILE_ENV = "POMTREED_CONFIG";

// A sensitive parameter is supplied only as a path to a file holding it, in `<ENV>_FILE`.
export const secretFileEnv = (name: string): string => `${name}_FILE`;

// The camelCase humps of one path segment. A hump starts at an uppercase letter that follows a lowercase letter or digit, and
// an uppercase run keeps its last letter for the next hump when a lowercase letter follows (`tlsCAFile` -> tls, CA, File).
// Digits stay with the hump they follow (`http2Port` -> http2, Port).
export function camelHumps(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(" ");
}

// The derived env name of a path, or null when its namespace has no registered prefix.
export function deriveEnvName(path: string, prefixes: Readonly<Record<string, string>> = CONFIG_ENV_PREFIXES): string | null {
  const segments = path.split(".");
  const prefix = Object.hasOwn(prefixes, segments[0] ?? "") ? prefixes[segments[0] as string] : undefined;
  if (prefix === undefined) return null;
  return prefix + segments.flatMap(camelHumps).join("_").toUpperCase();
}

// Levenshtein distance, for the did-you-mean hint on an unknown name.
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

// The env prefixes whose length the did-you-mean threshold ignores: shared by every name in a family, so counting it would loosen
// the threshold as a prefix grows. `PTREE_` is the project/test prefix (not a registry namespace). Longest first.
const HINT_PREFIXES = [...new Set([...Object.values(CONFIG_ENV_PREFIXES), "PTREE_"])].sort((a, b) => b.length - a.length);

// The nearest candidate within a third of the name's length (at least 2 edits), or null. Ties go to the first candidate. The
// length excludes a leading env prefix (POMTREED_, POMTREE_, PTREE_); the distance still compares full names.
export function nearestName(name: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  const prefix = HINT_PREFIXES.find((p) => name.startsWith(p)) ?? "";
  let bestD = Math.max(2, Math.floor((name.length - prefix.length) / 3)) + 1;
  for (const c of candidates) {
    const d = editDistance(name, c);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export const didYouMean = (name: string, candidates: Iterable<string>): string => {
  const near = nearestName(name, candidates);
  return near === null ? "" : ` (did you mean ${near}?)`;
};
