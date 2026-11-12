import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIG_REGISTRY,
  DEFAULT_FETCH_USER_AGENT,
  REDACTED,
  userAgentReason,
  configEnvIgnore,
  defineRegistry,
  describeConfig,
  resolveConfig,
} from "../index.ts";
import type { ResolveInput, ResolveResult } from "../index.ts";

const base = { doc: "d", scope: "operator", consumers: ["x"] } as const;
const R = defineRegistry([
  { ...base, path: "report.limits.maxBytes", kind: "bytes", default: 100, min: 1, max: 1000 },
  { ...base, path: "report.limits.itemBytes", kind: "bytes", default: 10, min: 1, relations: [{ op: "lte", key: "report.limits.maxBytes" }] },
  { ...base, path: "report.limits.poolMicros", kind: "micros", default: 500 },
  { ...base, path: "report.limits.runMicros", kind: "micros", default: 50, scope: "run", ceiling: "report.limits.poolMicros" },
  { ...base, path: "report.limits.waitMs", kind: "ms", default: 0 },
  { ...base, path: "report.mix.share", kind: "ratio", default: 0.5 },
  { ...base, path: "report.mix.enabled", kind: "bool", default: false },
  { ...base, path: "report.mix.mode", kind: "enum", values: ["fast", "safe"], default: "safe" },
  { ...base, path: "report.mix.hosts", kind: "list", default: [] },
  { ...base, path: "report.mix.dir", kind: "path", default: "" },
  { ...base, path: "report.mix.label", kind: "string", default: "none" },
  { ...base, path: "report.docker.host", kind: "string", default: "", env: "DOCKER_HOST" },
  { ...base, path: "model.apiKey", kind: "string", default: "", sensitive: true },
]);
const SECRET = "sk-very-secret-value";
const HINT = "; remove it, or use a name listed in docs/configuration.md";

const ok = (input: ResolveInput) => {
  const r = resolveConfig(R, input);
  assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  return r;
};
const errs = (input: ResolveInput): string[] => {
  const r: ResolveResult<typeof R.params> = resolveConfig(R, input);
  assert.ok(!r.ok, "expected a refusal");
  return r.errors;
};

test("defaults resolve with origin default", () => {
  const r = ok({ env: {} });
  assert.equal(r.values["report.limits.maxBytes"], 100);
  assert.equal(r.values["report.mix.mode"], "safe");
  assert.deepEqual(r.values["report.mix.hosts"], []);
  assert.ok(Object.values(r.origins).every((o) => o === "default"));
});

test("precedence: default < file < env < --set, with origins", () => {
  const file = { report: { limits: { maxBytes: 200, itemBytes: 20 } } };
  const env = { POMTREED_REPORT_LIMITS_MAX_BYTES: "300", POMTREED_REPORT_LIMITS_POOL_MICROS: "600" };
  const r = ok({ file, env, set: ["report.limits.maxBytes=400", "report.limits.maxBytes=401"] });
  assert.equal(r.values["report.limits.maxBytes"], 401, "set wins, last set wins");
  assert.equal(r.origins["report.limits.maxBytes"], "set");
  assert.equal(r.values["report.limits.itemBytes"], 20);
  assert.equal(r.origins["report.limits.itemBytes"], "file");
  assert.equal(r.values["report.limits.poolMicros"], 600);
  assert.equal(r.origins["report.limits.poolMicros"], "env:POMTREED_REPORT_LIMITS_POOL_MICROS");
  assert.equal(r.origins["report.limits.waitMs"], "default");
  const fileOverEnv = ok({ file, env: {} });
  assert.equal(fileOverEnv.values["report.limits.maxBytes"], 200);
  const envOverFile = ok({ file, env });
  assert.equal(envOverFile.values["report.limits.maxBytes"], 300);
});

test("each kind parses from text and JSON", () => {
  const r = ok({
    env: {
      POMTREED_REPORT_MIX_SHARE: "0.25",
      POMTREED_REPORT_MIX_ENABLED: "1",
      POMTREED_REPORT_MIX_MODE: "fast",
      POMTREED_REPORT_MIX_HOSTS: "a.example,b.example",
      POMTREED_REPORT_MIX_DIR: "/srv/x",
      POMTREED_REPORT_MIX_LABEL: "",
      DOCKER_HOST: "unix:///run/docker.sock",
    },
  });
  assert.equal(r.values["report.mix.share"], 0.25);
  assert.equal(r.values["report.mix.enabled"], true);
  assert.equal(r.values["report.mix.mode"], "fast");
  assert.deepEqual(r.values["report.mix.hosts"], ["a.example", "b.example"]);
  assert.equal(r.values["report.mix.dir"], "/srv/x");
  assert.equal(r.values["report.mix.label"], "");
  assert.equal(r.values["report.docker.host"], "unix:///run/docker.sock");
  assert.equal(r.origins["report.docker.host"], "env:DOCKER_HOST", "an explicit env name");
  const f = ok({ env: {}, file: { $schema: "./config.schema.json", report: { mix: { share: 1, enabled: true, hosts: ["h"], mode: "fast", dir: "/d" } } } });
  assert.deepEqual([f.values["report.mix.share"], f.values["report.mix.enabled"], f.values["report.mix.hosts"]], [1, true, ["h"]]);
  assert.equal(ok({ env: { POMTREED_REPORT_MIX_ENABLED: "false" } }).values["report.mix.enabled"], false);
  assert.equal(ok({ env: { POMTREED_REPORT_MIX_HOSTS: "" } }).values["report.mix.hosts"].length, 0);
});

test("strict integer parsing rejects empty, signs, fractions, exponents, leading zeros, junk and unsafe values", () => {
  for (const raw of ["", " 5", "5 ", "+5", "-5", "5.0", "1e3", "0x10", "05", "5k", "NaN", "Infinity", "9007199254740993"]) {
    assert.deepEqual(errs({ env: { POMTREED_REPORT_LIMITS_WAIT_MS: raw } }), [
      `report.limits.waitMs=${JSON.stringify(raw)} (env:POMTREED_REPORT_LIMITS_WAIT_MS): expected a non-negative integer of milliseconds`,
    ]);
  }
  assert.equal(ok({ env: { POMTREED_REPORT_LIMITS_WAIT_MS: "0" } }).values["report.limits.waitMs"], 0, "0 is allowed without a min");
});

test("every per-value rejection names the key, the value as written, its origin and why", () => {
  assert.deepEqual(errs({ env: { POMTREED_REPORT_LIMITS_MAX_BYTES: "0" } }), [
    'report.limits.maxBytes="0" (env:POMTREED_REPORT_LIMITS_MAX_BYTES): is below its minimum 1',
  ]);
  assert.deepEqual(errs({ env: {}, set: ["report.limits.maxBytes=1001"] }), ['report.limits.maxBytes="1001" (set): is above its maximum 1000']);
  assert.deepEqual(errs({ env: {}, file: { report: { limits: { maxBytes: 1.5 } } } }), [
    "report.limits.maxBytes=1.5 (file): expected a non-negative integer of bytes",
  ]);
  assert.deepEqual(errs({ env: {}, file: { report: { limits: { maxBytes: "100" } } } }), [
    'report.limits.maxBytes="100" (file): expected a non-negative integer of bytes',
  ]);
  assert.deepEqual(errs({ env: { POMTREED_REPORT_LIMITS_POOL_MICROS: "1.5" } }), [
    'report.limits.poolMicros="1.5" (env:POMTREED_REPORT_LIMITS_POOL_MICROS): expected a non-negative integer of micro-dollars',
  ]);
  assert.deepEqual(errs({ env: { POMTREED_REPORT_MIX_SHARE: "1.5" } }), ['report.mix.share="1.5" (env:POMTREED_REPORT_MIX_SHARE): expected a number in 0..1']);
  assert.deepEqual(errs({ env: { POMTREED_REPORT_MIX_SHARE: ".5" } }), [
    'report.mix.share=".5" (env:POMTREED_REPORT_MIX_SHARE): expected a decimal number in 0..1',
  ]);
  assert.deepEqual(errs({ env: {}, file: { report: { mix: { share: "0.5" } } } }), ['report.mix.share="0.5" (file): expected a number in 0..1']);
  assert.deepEqual(errs({ env: { POMTREED_REPORT_MIX_ENABLED: "yes" } }), [
    'report.mix.enabled="yes" (env:POMTREED_REPORT_MIX_ENABLED): expected true, false, 1 or 0',
  ]);
  assert.deepEqual(errs({ env: {}, file: { report: { mix: { enabled: 1 } } } }), ["report.mix.enabled=1 (file): expected a boolean"]);
  assert.deepEqual(errs({ env: { POMTREED_REPORT_MIX_MODE: "Fast" } }), ['report.mix.mode="Fast" (env:POMTREED_REPORT_MIX_MODE): expected one of fast, safe']);
  assert.deepEqual(errs({ env: { POMTREED_REPORT_MIX_HOSTS: "a,,b" } }), [
    'report.mix.hosts="a,,b" (env:POMTREED_REPORT_MIX_HOSTS): expected a list of non-empty strings',
  ]);
  assert.deepEqual(errs({ env: {}, file: { report: { mix: { hosts: "a" } } } }), ['report.mix.hosts="a" (file): expected a list of non-empty strings']);
  assert.deepEqual(errs({ env: { POMTREED_REPORT_MIX_DIR: "rel/dir" } }), [
    'report.mix.dir="rel/dir" (env:POMTREED_REPORT_MIX_DIR): expected an absolute path',
  ]);
  assert.deepEqual(errs({ env: {}, file: { report: { mix: { label: 5 } } } }), ["report.mix.label=5 (file): expected a string"]);
});

test("the file: unknown keys with a hint, non-objects, and $schema", () => {
  assert.deepEqual(errs({ env: {}, file: { report: { limits: { maxByte: 5 } } } }), [
    "config file: unknown key report.limits.maxByte (did you mean report.limits.maxBytes?)",
  ]);
  assert.deepEqual(errs({ env: {}, file: { nonsense: {} } }), ["config file: unknown key nonsense"]);
  assert.deepEqual(errs({ env: {}, file: { report: 5 } }), ["config file: report must be an object"]);
  assert.deepEqual(errs({ env: {}, file: [] }), ["config file: must be a JSON object"]);
  assert.deepEqual(errs({ env: {}, file: { $schema: 1 } }), ["config file: $schema must be a string"]);
  assert.deepEqual(errs({ env: {}, file: { report: { $schema: "x" } } }), ["config file: unknown key report.$schema"]);
});

test("unknown env names under a registered prefix are refused with a hint; ignoreEnv, POMTREED_CONFIG and other prefixes pass", () => {
  assert.deepEqual(errs({ env: { POMTREED_REPORT_LIMIT_MAX_BYTES: "5" } }), [
    `unknown env POMTREED_REPORT_LIMIT_MAX_BYTES (did you mean POMTREED_REPORT_LIMITS_MAX_BYTES?)${HINT}`,
  ]);
  assert.deepEqual(errs({ env: { POMTREE_ANYTHING: "1" } }), [`unknown env POMTREE_ANYTHING${HINT}`]);
  assert.deepEqual(errs({ env: { POMTREED_REPORT_LIMITS_MAX_BYTES_FILE: "/x" } }), [
    `unknown env POMTREED_REPORT_LIMITS_MAX_BYTES_FILE (did you mean POMTREED_REPORT_LIMITS_MAX_BYTES?)${HINT}`,
  ]);
  ok({ env: { POMTREE_TOKEN: "t", POMTREED_CONFIG: "/etc/p.json", PTREE_X: "1", HOME: "/h", POMTREED_UNSET: undefined }, ignoreEnv: ["POMTREE_TOKEN"] });
});

test("an old env name is refused like any unknown name: the cause and the action, before any ignore list is consulted, with no hint when nothing is close", () => {
  const r = resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_MAX_DEPTH: "1", POMTREE_DEBUG: "1", POMTREED_MODEL_KEY: "sk-must-not-echo" } });
  assert.deepEqual(r.ok ? [] : r.errors, [
    `unknown env POMTREED_MAX_DEPTH${HINT}`,
    `unknown env POMTREE_DEBUG${HINT}`,
    `unknown env POMTREED_MODEL_KEY${HINT}`,
  ]);
  assert.ok(!JSON.stringify(r).includes("sk-must-not-echo"));
  // The live name of an unchanged key resolves as before.
  const live = resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_REPORT_MAX_BYTES: "1048576" } });
  assert.ok(live.ok && live.values["report.maxBytes"] === 1048576);
  // A near miss of a live name still gets the did-you-mean hint.
  const typo = resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_REPORT_MAX_BYTE: "1" } });
  assert.deepEqual(typo.ok ? [] : typo.errors, [`unknown env POMTREED_REPORT_MAX_BYTE (did you mean POMTREED_REPORT_MAX_BYTES?)${HINT}`]);
});

test("ignoreEnvPrefixes skips a name family owned elsewhere; exact and prefix exclusions come from configEnvIgnore()", () => {
  ok({ env: { POMTREED_EXT_GITHUB_TOKEN: "t" }, ignoreEnvPrefixes: ["POMTREED_EXT_"] });
  assert.match(
    errs({ env: { POMTREED_EXT_GITHUB_TOKEN: "t" } })[0] as string,
    /^unknown env POMTREED_EXT_GITHUB_TOKEN: it names no loaded extension \(loaded: none\)/,
  );
  const r = resolveConfig(CONFIG_REGISTRY, { env: { POMTREE_TOKEN: "t", POMTREED_DEMO_MODEL: "m" }, ...configEnvIgnore() });
  assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  // The POMTREED_EXT_ family is no longer excluded: an extension's names belong to its manifest, so an undeclared one is refused.
  const ext = resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_EXT_X_Y: "v" }, ...configEnvIgnore() });
  assert.ok(!ext.ok);
});

test("skipUnknownEnv skips the unknown name refusals (the first of two passes) but not value errors", () => {
  assert.ok(!resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_REPORT_MAX_BYTE: "1" } }).ok);
  assert.ok(resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_REPORT_MAX_BYTE: "1", POMTREED_MAX_CONTAINERS: "4" }, skipUnknownEnv: true }).ok);
  const bad = resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_REPORT_MAX_BYTES: "x" }, skipUnknownEnv: true });
  assert.ok(!bad.ok);
});

test("json kind: env text is parsed as JSON, the file carries the value itself, and the key's check delegates validation", () => {
  const J = defineRegistry([
    { ...base, path: "state.limits", kind: "json", default: {}, check: (v: unknown) => (Array.isArray(v) ? "must be an object" : null) },
  ]);
  const env = resolveConfig(J, { env: { POMTREED_STATE_LIMITS: '{"default":{"maxDocs":5}}' } });
  assert.ok(env.ok && JSON.stringify(env.values["state.limits"]) === '{"default":{"maxDocs":5}}');
  const file = resolveConfig(J, { env: {}, file: { state: { limits: { owners: {} } } } });
  assert.ok(file.ok && JSON.stringify(file.values["state.limits"]) === '{"owners":{}}');
  const bad = (input: ResolveInput) => {
    const r = resolveConfig(J, input);
    return r.ok ? [] : r.errors;
  };
  assert.deepEqual(bad({ env: { POMTREED_STATE_LIMITS: "{" } }), ['state.limits="{" (env:POMTREED_STATE_LIMITS): expected JSON']);
  assert.deepEqual(bad({ env: { POMTREED_STATE_LIMITS: "5" } }), ['state.limits="5" (env:POMTREED_STATE_LIMITS): expected a JSON object or array']);
  assert.deepEqual(bad({ env: { POMTREED_STATE_LIMITS: "[]" } }), ['state.limits="[]" (env:POMTREED_STATE_LIMITS): must be an object']);
  assert.deepEqual(bad({ env: {}, file: { state: { limits: "x" } } }), ['state.limits="x" (file): expected a JSON object or array']);
});

test("the shipped state.limits delegates to core parseStateLimits; string and list checks refuse bad values", () => {
  assert.ok(resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_STATE_LIMITS: '{"default":{"maxDocs":10}}' } }).ok);
  const r = resolveConfig(CONFIG_REGISTRY, {
    env: { POMTREED_STATE_LIMITS: '{"nope":1}', POMTREED_CAPACITY_MAX_SESSIONS: "0", POMTREED_CHAT_APPROVAL: "spawn,merge" },
  });
  assert.deepEqual(r.ok ? [] : r.errors, [
    'state.limits="{\\"nope\\":1}" (env:POMTREED_STATE_LIMITS): POMTREED_STATE_LIMITS: unknown key nope',
    'capacity.maxSessions="0" (env:POMTREED_CAPACITY_MAX_SESSIONS): expected "auto" or a positive integer',
    'chat.approval="spawn,merge" (env:POMTREED_CHAT_APPROVAL): unknown route merge: expected spawn, cancel',
  ]);
  assert.ok(resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_CAPACITY_MAX_SESSIONS: "12" } }).ok);
});

test("--set: malformed entries and unknown keys", () => {
  assert.deepEqual(errs({ env: {}, set: ["report.limits.maxBytes"] }), ["--set report.limits.maxBytes: expected key=value"]);
  assert.deepEqual(errs({ env: {}, set: ["=5"] }), ["--set entry has no key"]);
  assert.deepEqual(errs({ env: {}, set: ["report.limits.maxbytes=5"] }), ["--set: unknown key report.limits.maxbytes (did you mean report.limits.maxBytes?)"]);
  assert.equal(ok({ env: {}, set: ["report.mix.label=a=b"] }).values["report.mix.label"], "a=b", "split on the first =");
});

test("a ceiling is refused, never clamped, naming both keys and origins", () => {
  assert.deepEqual(errs({ env: { POMTREED_REPORT_LIMITS_RUN_MICROS: "501" } }), [
    "report.limits.runMicros=501 (env:POMTREED_REPORT_LIMITS_RUN_MICROS) exceeds its ceiling report.limits.poolMicros=500 (default); refused, not clamped",
  ]);
  assert.deepEqual(errs({ env: {}, set: ["report.limits.poolMicros=10"] }), [
    "report.limits.runMicros=50 (default) exceeds its ceiling report.limits.poolMicros=10 (set); refused, not clamped",
  ]);
  assert.equal(ok({ env: { POMTREED_REPORT_LIMITS_RUN_MICROS: "500" } }).values["report.limits.runMicros"], 500, "equal to the ceiling is allowed");
});

test("a violated relation names both keys and both origins", () => {
  assert.deepEqual(errs({ env: { POMTREED_REPORT_LIMITS_ITEM_BYTES: "60" }, file: { report: { limits: { maxBytes: 50 } } } }), [
    "report.limits.itemBytes=60 (env:POMTREED_REPORT_LIMITS_ITEM_BYTES) must be <= report.limits.maxBytes=50 (file)",
  ]);
  // A relation is not checked against a value that already failed to parse (one error, not a cascade).
  assert.deepEqual(errs({ env: { POMTREED_REPORT_LIMITS_MAX_BYTES: "x", POMTREED_REPORT_LIMITS_ITEM_BYTES: "60" } }), [
    'report.limits.maxBytes="x" (env:POMTREED_REPORT_LIMITS_MAX_BYTES): expected a non-negative integer of bytes',
  ]);
});

test("errors are collected across sources, not first-fail", () => {
  assert.deepEqual(errs({ env: { POMTREED_REPORT_MIX_MODE: "x", POMTREED_TYPO: "1" }, file: { report: { nope: 1 } }, set: ["bad"] }), [
    "config file: unknown key report.nope",
    'report.mix.mode="x" (env:POMTREED_REPORT_MIX_MODE): expected one of fast, safe',
    `unknown env POMTREED_TYPO${HINT}`,
    "--set bad: expected key=value",
  ]);
});

test("a sensitive key resolves only from <ENV>_FILE through the injected reader", () => {
  const reads: string[] = [];
  const readFile = (p: string) => {
    reads.push(p);
    return `${SECRET}\n`;
  };
  const r = ok({ env: { POMTREED_MODEL_API_KEY_FILE: "/run/secrets/key" }, readFile });
  assert.deepEqual(reads, ["/run/secrets/key"]);
  assert.equal(r.values["model.apiKey"], SECRET, "one trailing newline is stripped");
  assert.equal(r.origins["model.apiKey"], "file-secret:POMTREED_MODEL_API_KEY_FILE");
  assert.equal(ok({ env: {} }).values["model.apiKey"], "");
});

test("a sensitive key is refused via the file, the env and --set, and its value never appears in an error", () => {
  const all = [
    ...errs({ env: {}, file: { model: { apiKey: SECRET } } }),
    ...errs({ env: { POMTREED_MODEL_API_KEY: SECRET } }),
    ...errs({ env: {}, set: [`model.apiKey=${SECRET}`] }),
  ];
  assert.deepEqual(all, [
    "config file: model.apiKey is sensitive and may not be set in the file; set POMTREED_MODEL_API_KEY_FILE to a file holding it",
    "POMTREED_MODEL_API_KEY may not carry the sensitive model.apiKey; set POMTREED_MODEL_API_KEY_FILE to a file holding it",
    "--set may not carry the sensitive model.apiKey; set POMTREED_MODEL_API_KEY_FILE to a file holding it",
  ]);
  for (const e of all) assert.ok(!e.includes(SECRET));
});

test("<ENV>_FILE failures: relative path, no reader, read error, empty file", () => {
  assert.deepEqual(errs({ env: { POMTREED_MODEL_API_KEY_FILE: "key.txt" }, readFile: () => SECRET }), [
    "POMTREED_MODEL_API_KEY_FILE: expected an absolute path (the value is not shown)",
  ]);
  assert.deepEqual(errs({ env: { POMTREED_MODEL_API_KEY_FILE: "/k" } }), ["POMTREED_MODEL_API_KEY_FILE: set, but no file reader was supplied"]);
  const enoent = () => {
    throw new Error("ENOENT: no such file or directory, open '/k'");
  };
  assert.deepEqual(errs({ env: { POMTREED_MODEL_API_KEY_FILE: "/k" }, readFile: enoent }), [
    "POMTREED_MODEL_API_KEY_FILE: cannot read /k: ENOENT: no such file or directory, open '/k'",
  ]);
  assert.deepEqual(errs({ env: { POMTREED_MODEL_API_KEY_FILE: "/k" }, readFile: () => "\n" }), ["POMTREED_MODEL_API_KEY_FILE: /k is empty"]);
});

test("describeConfig masks sensitive values, keeps origins, and filters to changed rows", () => {
  const r = ok({ env: { POMTREED_MODEL_API_KEY_FILE: "/run/secrets/key", POMTREED_REPORT_LIMITS_RUN_MICROS: "70" }, readFile: () => SECRET });
  const rows = describeConfig(R, r);
  assert.equal(rows.length, R.params.length);
  assert.ok(!JSON.stringify(rows).includes(SECRET));
  assert.deepEqual(
    rows.find((x) => x.path === "model.apiKey"),
    {
      path: "model.apiKey",
      value: REDACTED,
      origin: "file-secret:POMTREED_MODEL_API_KEY_FILE",
      default: "",
      kind: "string",
      scope: "operator",
      env: "POMTREED_MODEL_API_KEY",
    },
  );
  assert.deepEqual(describeConfig(R, r, { changedOnly: true }), [
    {
      path: "report.limits.runMicros",
      value: 70,
      origin: "env:POMTREED_REPORT_LIMITS_RUN_MICROS",
      default: 50,
      kind: "micros",
      scope: "run",
      env: "POMTREED_REPORT_LIMITS_RUN_MICROS",
      ceiling: "report.limits.poolMicros",
    },
    {
      path: "model.apiKey",
      value: REDACTED,
      origin: "file-secret:POMTREED_MODEL_API_KEY_FILE",
      default: "",
      kind: "string",
      scope: "operator",
      env: "POMTREED_MODEL_API_KEY",
    },
  ]);
  assert.equal(describeConfig(R, ok({ env: {} })).find((x) => x.path === "model.apiKey")?.value, "", "an unset secret has nothing to mask");
});

test("skipSecretFiles: a <ENV>_FILE name is recognized but never read, and the key keeps its empty default", () => {
  const reads: string[] = [];
  const readFile = (p: string) => {
    reads.push(p);
    return "sk-should-not-be-read";
  };
  const r = resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_MODEL_UPSTREAM_KEY_FILE: "/run/secrets/k" }, readFile, skipSecretFiles: true });
  assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  assert.equal(r.values["model.upstreamKey"], "");
  assert.equal(r.origins["model.upstreamKey"], "default");
  assert.deepEqual(reads, []);
  // Even a relative path (refused when read) is skipped, and a plain-env secret is still refused.
  assert.ok(resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_MODEL_UPSTREAM_KEY_FILE: "rel" }, skipSecretFiles: true }).ok);
  const plain = resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_MODEL_UPSTREAM_KEY: "sk" }, skipSecretFiles: true });
  assert.ok(!plain.ok);
  // Negative variant: without the option the same env reads the file.
  const read = resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_MODEL_UPSTREAM_KEY_FILE: "/run/secrets/k" }, readFile });
  assert.ok(read.ok);
  assert.deepEqual(reads, ["/run/secrets/k"]);
});

test("a secret file with group/other permission bits is refused before it is read; 0600 and an absent fileMode are accepted", () => {
  const reads: string[] = [];
  const readFile = (p: string) => {
    reads.push(p);
    return SECRET;
  };
  const env = { POMTREED_MODEL_API_KEY_FILE: "/k" };
  for (const mode of [0o100644, 0o100640, 0o100604]) {
    assert.deepEqual(errs({ env, readFile, fileMode: () => mode }), ["POMTREED_MODEL_API_KEY_FILE: /k is readable by group/other; run chmod 600 /k"]);
  }
  assert.deepEqual(reads, []);
  assert.equal(ok({ env, readFile, fileMode: () => 0o100600 }).values["model.apiKey"], SECRET);
  assert.equal(ok({ env, readFile }).values["model.apiKey"], SECRET);
});

test("workflow.fetch.userAgent: default is the product token; blank means the default; a contact is optional; control bytes, CR/LF, non-ASCII, >256, edge spaces and no leading product token are refused", () => {
  const ua = (v: string) => resolveConfig(CONFIG_REGISTRY, { env: {}, set: [`workflow.fetch.userAgent=${v}`] });
  const def = resolveConfig(CONFIG_REGISTRY, { env: {} });
  assert.ok(def.ok);
  assert.equal(def.values["workflow.fetch.userAgent"], "pomtree");
  assert.equal(DEFAULT_FETCH_USER_AGENT, "pomtree");
  // Blank from any layer resolves to the default, with the supplying layer as origin; non-blank passes through.
  const blank = ua("");
  assert.ok(blank.ok);
  assert.equal(blank.values["workflow.fetch.userAgent"], "pomtree");
  assert.equal(blank.origins["workflow.fetch.userAgent"], "set");
  const blankEnv = resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_WORKFLOW_FETCH_USER_AGENT: "" } });
  assert.ok(blankEnv.ok);
  assert.equal(blankEnv.values["workflow.fetch.userAgent"], "pomtree");
  assert.equal(blankEnv.origins["workflow.fetch.userAgent"], "env:POMTREED_WORKFLOW_FETCH_USER_AGENT");
  const blankFile = resolveConfig(CONFIG_REGISTRY, { env: {}, file: { workflow: { fetch: { userAgent: "" } } } });
  assert.ok(blankFile.ok);
  assert.equal(blankFile.values["workflow.fetch.userAgent"], "pomtree");
  assert.equal(blankFile.origins["workflow.fetch.userAgent"], "file");
  for (const v of [
    "pomtree-example",
    "pomtree/1.0",
    "pomtree-example ops@example.org",
    "pomtree/1.0 (+https://example.org/bot)",
    "Acme Research Inc. admin@acme.example",
    "pomtree X-Evil: 1",
  ]) {
    const r = ua(v);
    assert.ok(r.ok, v);
    assert.equal(r.values["workflow.fetch.userAgent"], v);
  }
  const long = "a".repeat(256);
  assert.ok(ua(long).ok, "256 characters is the limit");
  const why = (v: string): string => {
    const r = ua(v);
    assert.ok(!r.ok, `expected a refusal for ${JSON.stringify(v)}`);
    return r.errors.join("\n");
  };
  assert.match(why("app\x01x"), /printable ASCII/);
  assert.match(why("app\tx"), /printable ASCII/);
  assert.match(why("app\x7fx"), /printable ASCII/);
  assert.match(why("pomtree\r\nX-Evil: 1"), /printable ASCII.*CR, LF.*Set it to a product token such as "pomtree"/);
  assert.match(why("app\nx"), /printable ASCII/);
  assert.match(why("appé ops@example.org"), /non-ASCII/);
  assert.match(why("a".repeat(257)), /is 257 characters; a User-Agent is at most 256.*Set it to a product token/);
  assert.match(why("ops@example.org"), /must start with a product token.*Set it to a product token/);
  assert.match(why("(bot)"), /must start with a product token/);
  assert.match(why("/1.0 x"), /must start with a product token/);
  assert.match(userAgentReason("") ?? "", /is empty.*Set it to a product token/, "the check refuses a blank that reaches it unresolved");
  assert.match(why(" app"), /leading or trailing whitespace/);
  assert.match(why("app "), /leading or trailing whitespace/);
  for (const v of [" app", "app ", "/1.0 x", "(bot)"]) assert.doesNotMatch(why(v), /contact address/);
  // The env spelling is validated the same way.
  const env = resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_WORKFLOW_FETCH_USER_AGENT: "x\ry" } });
  assert.ok(!env.ok && /workflow\.fetch\.userAgent=.*POMTREED_WORKFLOW_FETCH_USER_AGENT.*printable ASCII/.test(env.errors.join("\n")));
});
