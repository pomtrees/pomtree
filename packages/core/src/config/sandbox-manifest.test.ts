import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_SANDBOX_BACKEND_IDS,
  CONFIG_REGISTRY,
  ConfigRegistryError,
  STANDARD_SANDBOX_KEYS,
  composeRegistry,
  configJsonSchema,
  contributedBackends,
  describeConfig,
  extendRegistry,
  parseSandboxManifest,
  resolveConfig,
  reviewedBackendsReason,
  sandboxCredentialEnv,
  secretFileEnv,
} from "../index.ts";
import type { ConfigRegistry, ExtParamDecl, SandboxBackendConfigDecl } from "../index.ts";

const SOCKET: ExtParamDecl = { key: "socket", kind: "string", doc: "The engine socket.", default: "" } as ExtParamDecl;
const DOCKER: SandboxBackendConfigDecl = { id: "docker", owner: "@pomtree/sandbox-docker", builtin: true, params: [SOCKET] };
const PODMAN: SandboxBackendConfigDecl = { id: "podman", owner: "@pomtree/sandbox-docker", builtin: true, params: [SOCKET] };
const TOYBOX: SandboxBackendConfigDecl = {
  id: "toybox",
  owner: "toybox",
  builtin: false,
  params: [{ key: "baseUrl", kind: "string", doc: "Endpoint.", default: "" } as ExtParamDecl],
  credentials: ["apiKey"],
};
const compose = (...backends: SandboxBackendConfigDecl[]): ConfigRegistry => composeRegistry(CONFIG_REGISTRY, { sandboxBackends: backends });
const refused = (...backends: SandboxBackendConfigDecl[]): string => {
  try {
    compose(...backends);
  } catch (e) {
    assert.ok(e instanceof ConfigRegistryError);
    return e.errors.join("\n");
  }
  return assert.fail("expected the composition to be refused");
};
const resolve = (registry: ConfigRegistry, env: Record<string, string> = {}, set: string[] = []) => resolveConfig(registry, { env, set });

test("sandbox.backend defaults to docker and its core key accepts any well-formed id", () => {
  const r = resolve(CONFIG_REGISTRY);
  assert.ok(r.ok);
  assert.equal(r.values["sandbox.backend"], "docker");
  assert.ok(resolve(CONFIG_REGISTRY, { POMTREED_SANDBOX_BACKEND: "toybox" }).ok, "a provider's id is unknown to the core table, so only its shape is checked");
  const bad = resolve(CONFIG_REGISTRY, { POMTREED_SANDBOX_BACKEND: "Not An Id" });
  assert.ok(!bad.ok);
});

test("a composed registry refuses an unknown backend id (even one that looks built in) and lists the allowed ids", () => {
  const registry = compose(DOCKER, TOYBOX);
  for (const id of ["dokcer", "docker2", "lambda"]) {
    const r = resolve(registry, { POMTREED_SANDBOX_BACKEND: id });
    assert.ok(!r.ok, id);
    const text = r.errors.join("\n");
    for (const known of ["auto", ...BUILTIN_SANDBOX_BACKEND_IDS]) assert.ok(text.includes(known), `${id}: lists ${known}`);
    assert.match(text, /toybox \(extension toybox\)/);
    assert.match(text, /install the extension that provides/);
  }
  const near = resolve(registry, { POMTREED_SANDBOX_BACKEND: "dokcer" });
  assert.ok(!near.ok && near.errors.join().includes("did you mean docker"));
});

test("a composed registry accepts auto, every built-in id and a contributed id", () => {
  const registry = compose(DOCKER, TOYBOX);
  for (const id of ["auto", ...BUILTIN_SANDBOX_BACKEND_IDS, "toybox"]) assert.ok(resolve(registry, { POMTREED_SANDBOX_BACKEND: id }).ok, id);
});

test("extendRegistry (extensions only) also closes sandbox.backend to the built-ins", () => {
  const registry = extendRegistry(CONFIG_REGISTRY, []);
  assert.ok(resolve(registry, { POMTREED_SANDBOX_BACKEND: "podman" }).ok);
  assert.ok(!resolve(registry, { POMTREED_SANDBOX_BACKEND: "toybox" }).ok);
});

test("a manifest's keys compose under sandbox.<id>.* with derived env names; docker and podman declare socket the same way", () => {
  const registry = compose(DOCKER, PODMAN);
  assert.equal(registry.envOf.get("sandbox.docker.socket"), "POMTREED_SANDBOX_DOCKER_SOCKET");
  assert.equal(registry.envOf.get("sandbox.podman.socket"), "POMTREED_SANDBOX_PODMAN_SOCKET");
  const r = resolve(registry, { POMTREED_SANDBOX_PODMAN_SOCKET: "/run/podman/podman.sock" });
  assert.ok(r.ok);
  assert.equal(r.values["sandbox.podman.socket" as never], "/run/podman/podman.sock");
  assert.equal(r.origins["sandbox.podman.socket" as never], "env:POMTREED_SANDBOX_PODMAN_SOCKET");
  assert.equal(resolve(registry).ok && (resolve(registry) as { values: Record<string, unknown> }).values["sandbox.docker.socket"], "");
  assert.equal(registry.byPath.get("sandbox.socket")?.default, "/run/pomtreed.sock", "sandbox.socket (the in-container daemon path) is unchanged");
});

test("the standard cost and capacity keys exist for every backend with the same names and kinds", () => {
  const registry = compose(DOCKER, TOYBOX);
  for (const id of ["docker", "toybox"]) {
    for (const k of STANDARD_SANDBOX_KEYS) {
      const p = registry.byPath.get(`sandbox.${id}.${k.key}`);
      assert.ok(p, `${id}.${k.key}`);
      assert.equal(p.kind, k.kind);
      assert.equal(p.scope, "operator");
    }
  }
  assert.equal(registry.byPath.get("sandbox.toybox.rate.cpuHourMicros")?.kind, "micros");
  assert.equal(registry.byPath.get("sandbox.toybox.leaseMs")?.default, 900_000);
  assert.equal(registry.byPath.get("sandbox.maxDayMicros")?.kind, "micros");
  const r = resolve(registry, {}, ["sandbox.toybox.rate.asOf=2026-11-11", "sandbox.toybox.maxSandboxes=90"]);
  assert.ok(r.ok);
  const bad = resolve(registry, {}, ["sandbox.toybox.rate.asOf=yesterday"]);
  assert.ok(!bad.ok && /YYYY-MM-DD/.test(bad.errors.join()));
  assert.ok(!resolve(registry, {}, ["sandbox.toybox.rate.asOf=2026-02-31"]).ok, "an impossible date is refused");
});

test("only a built-in may change the standard defaults; a manifest may not redeclare a standard key", () => {
  const tuned = compose({ ...DOCKER, defaults: { leaseMs: 60_000 } });
  assert.equal(tuned.byPath.get("sandbox.docker.leaseMs")?.default, 60_000);
  assert.match(refused({ ...TOYBOX, defaults: { leaseMs: 1 } }), /only a built-in backend may change the standard key defaults/);
  assert.match(refused({ ...DOCKER, defaults: { nope: 1 } }), /not a standard key/);
  assert.match(
    refused({ ...TOYBOX, params: [{ key: "maxSandboxes", kind: "count", doc: "x", default: 1 } as ExtParamDecl] }),
    /standard key declared for every backend/,
  );
  assert.match(
    refused({ ...TOYBOX, params: [{ key: "rate", kind: "count", doc: "x", default: 1 } as ExtParamDecl] }),
    /standard key declared for every backend/,
  );
  assert.match(refused({ ...TOYBOX, params: [{ key: "a.b", kind: "count", doc: "x", default: 1 } as ExtParamDecl] }), /flat lowerCamel/);
});

test("backend ids: reserved and malformed ids are refused; duplicate ids name both owners; segments may not collide", () => {
  assert.match(refused({ ...TOYBOX, id: "docker" }), /reserved/);
  assert.match(refused({ ...TOYBOX, id: "auto" }), /reserved/);
  assert.match(refused({ ...TOYBOX, id: "Bad_Id" }), /invalid/);
  assert.match(refused({ ...DOCKER, id: "toybox" }), /not a built-in id/);
  const dup = refused(TOYBOX, { ...TOYBOX, owner: "other-ext" });
  assert.match(dup, /provided by both extension toybox and extension other-ext/);
  assert.match(refused({ ...TOYBOX, id: "a-1" }, { ...TOYBOX, id: "a1", owner: "x" }), /collides with backend a-1/);
  assert.match(refused({ ...TOYBOX, id: "socket" }), /collides with the core key sandbox.socket/);
  assert.match(refused({ ...TOYBOX, id: "max-day-micros" }), /collides with the core key/);
});

test("a contributed backend's keys cannot reference another extension's or backend's keys; core keys are allowed", () => {
  const ok = compose({
    ...TOYBOX,
    params: [
      { key: "capBytes", kind: "bytes", doc: "Cap.", default: 1, relations: [{ op: "lte", key: "report.maxBytes" }] } as ExtParamDecl,
      { key: "capLowBytes", kind: "bytes", doc: "Cap.", default: 1, ceiling: "capBytes" } as ExtParamDecl,
    ],
  });
  assert.ok(ok.byPath.has("sandbox.toybox.capLowBytes"));
  assert.match(
    refused(DOCKER, {
      ...TOYBOX,
      params: [{ key: "capBytes", kind: "bytes", doc: "Cap.", default: 1, ceiling: "sandbox.docker.rate.minBilledMs" } as ExtParamDecl],
    }),
    /not referenceable/,
  );
  assert.match(
    refused({ ...TOYBOX, params: [{ key: "capBytes", kind: "bytes", doc: "Cap.", default: 1, ceiling: "ext.other.x" } as ExtParamDecl] }),
    /not referenceable/,
  );
});

test("a typo in a composed backend's key is refused with the composed backends named", () => {
  const registry = compose(DOCKER, TOYBOX);
  const r = resolve(registry, {}, ["sandbox.toybx.baseUrl=http://x"]);
  assert.ok(!r.ok);
  assert.match(r.errors.join(), /no composed sandbox backend owns sandbox\.toybx\./);
  assert.match(r.errors.join(), /docker, toybox/);
  const k = resolve(registry, {}, ["sandbox.toybox.baseUrll=http://x"]);
  assert.ok(!k.ok && /did you mean sandbox\.toybox\.baseUrl/.test(k.errors.join()));
});

test("a backend credential owns only its _FILE env name; a value in the bare name is refused", () => {
  const registry = compose(TOYBOX);
  const bare = sandboxCredentialEnv("toybox", "apiKey");
  assert.equal(bare, "POMTREED_SANDBOX_TOYBOX_APIKEY");
  assert.ok(registry.envNames.has(secretFileEnv(bare)));
  assert.equal(registry.credentialEnv.get(secretFileEnv(bare)), "sandbox backend toybox credential apiKey");
  assert.ok(resolve(registry, { [secretFileEnv(bare)]: "/etc/pomtree/toybox.key" }).ok, "the _FILE name is recognized, not refused as unknown");
  const r = resolve(registry, { [bare]: "plant-me" });
  assert.ok(!r.ok && /unknown env/.test(r.errors.join()));
  assert.ok(!r.errors.join().includes("plant-me"), "the refused value is not echoed");
});

test("a backend credential whose _FILE name equals a key's env name is refused; an invalid credential name is refused", () => {
  const clash = { ...TOYBOX, credentials: ["a"], params: [{ key: "aFile", kind: "string", doc: "x", default: "" } as ExtParamDecl] };
  assert.match(refused(clash), /env name POMTREED_SANDBOX_TOYBOX_A_FILE is claimed by both/);
  assert.match(refused({ ...TOYBOX, credentials: ["a b"] }), /not a valid name/);
});

test("describeConfig shows a backend credential as REDACTED with its file path and never the secret bytes", () => {
  const registry = compose(TOYBOX);
  const planted = "sk-planted-secret-4f7a9c";
  const fileEnv = secretFileEnv(sandboxCredentialEnv("toybox", "apiKey"));
  const env = { [fileEnv]: "/etc/pomtree/toybox.key", POMTREED_MODEL_UPSTREAM_KEY_FILE: "/run/secrets/upstream" };
  const r = resolveConfig(registry, { env, readFile: () => planted, fileMode: () => 0o600 });
  assert.ok(r.ok);
  const rows = describeConfig(registry, r, { env });
  const dump = JSON.stringify(rows);
  // The sensitive core key was really read (its value is `planted`), so the dump check can fail for a mutant that prints values.
  assert.ok(!dump.includes(planted), "no secret byte in the dump");
  const cred = rows.find((x) => x.kind === "credential");
  assert.equal(cred?.value, "<redacted> (file: /etc/pomtree/toybox.key)");
  assert.equal(rows.find((x) => x.path === "model.upstreamKey")?.value, "<redacted>");
  assert.equal(r.values["model.upstreamKey"], planted, "the resolved value itself is intact; only the dump masks it");
  assert.ok(!describeConfig(registry, r).some((x) => x.kind === "credential"), "without the env there is no credential row");
});

test("sandbox.reviewedBackends accepts <id>=sha256:<hex> and refuses malformed, built-in, duplicate and non-lowercase entries", () => {
  const hex = "a".repeat(64);
  assert.equal(reviewedBackendsReason([`toybox=sha256:${hex}`, `my-box=sha256:${hex}`]), null);
  assert.equal(reviewedBackendsReason([]), null);
  for (const entry of [
    "toybox",
    `=sha256:${hex}`,
    `toybox=sha256:${"a".repeat(63)}`,
    `toybox=sha256:${"A".repeat(64)}`,
    `toybox=md5:${hex}`,
    `toybox=${hex}`,
    `Toy Box=sha256:${hex}`,
  ]) {
    assert.notEqual(reviewedBackendsReason([entry]), null, entry);
  }
  assert.match(reviewedBackendsReason([`docker=sha256:${hex}`]) ?? "", /reserved.*never pinned/s);
  assert.match(reviewedBackendsReason([`toybox=sha256:${hex}`, `toybox=sha256:${"b".repeat(64)}`]) ?? "", /pinned twice/);
  const r = resolve(CONFIG_REGISTRY, { POMTREED_SANDBOX_REVIEWED_BACKENDS: "toybox=sha256:nothex" });
  assert.ok(!r.ok && /sandbox\.reviewedBackends/.test(r.errors.join()) && /write <id>=sha256:<64 lowercase hex>/.test(r.errors.join()));
  const good = resolve(CONFIG_REGISTRY, { POMTREED_SANDBOX_REVIEWED_BACKENDS: `toybox=sha256:${hex}` });
  assert.ok(good.ok);
  assert.deepEqual(good.values["sandbox.reviewedBackends"], [`toybox=sha256:${hex}`]);
});

test("sandbox.secretsInEnv defaults to false and is a bool", () => {
  const r = resolve(CONFIG_REGISTRY);
  assert.ok(r.ok);
  assert.equal(r.values["sandbox.secretsInEnv"], false);
  const on = resolve(CONFIG_REGISTRY, { POMTREED_SANDBOX_SECRETS_IN_ENV: "true" });
  assert.ok(on.ok && on.values["sandbox.secretsInEnv"] === true);
  assert.ok(!resolve(CONFIG_REGISTRY, { POMTREED_SANDBOX_SECRETS_IN_ENV: "yes" }).ok);
});

test("the schema lists the built-in backend ids yet accepts a provider's id, and leaves sandbox.<id> open only without composed backends", () => {
  const schema = configJsonSchema(CONFIG_REGISTRY) as {
    properties: { sandbox: { additionalProperties: unknown; properties: { backend: { anyOf: { enum?: string[]; pattern?: string }[] } } } };
  };
  const backend = schema.properties.sandbox.properties.backend;
  assert.deepEqual(backend.anyOf[0]?.enum, ["auto", ...BUILTIN_SANDBOX_BACKEND_IDS]);
  assert.match("toybox", new RegExp(backend.anyOf[1]?.pattern ?? "(?!)"));
  assert.notEqual(schema.properties.sandbox.additionalProperties, false);
  const composed = configJsonSchema(compose(DOCKER)) as { properties: { sandbox: { additionalProperties: unknown; properties: Record<string, unknown> } } };
  assert.equal(composed.properties.sandbox.additionalProperties, false);
  assert.ok("docker" in composed.properties.sandbox.properties);
});

test("parseSandboxManifest: shape errors name the package; a valid manifest yields built-in declarations", () => {
  const ok = parseSandboxManifest("@pomtree/sandbox-docker", {
    sandboxBackends: [
      { id: "docker", params: [SOCKET] },
      { id: "podman", params: [SOCKET], credentials: [] },
    ],
  });
  assert.ok(ok.ok && ok.backends.length === 2 && ok.backends.every((b) => b.builtin));
  for (const raw of [
    null,
    {},
    { sandboxBackends: {} },
    { sandboxBackends: [{}] },
    { sandboxBackends: [], extra: 1 },
    { sandboxBackends: [{ id: "x", params: [{ key: "k" }] }] },
    { sandboxBackends: [{ id: "x", credentials: [1] }] },
  ]) {
    const r = parseSandboxManifest("@pomtree/sandbox-x", raw);
    assert.ok(!r.ok && r.errors.every((e) => e.includes("@pomtree/sandbox-x")), JSON.stringify(raw));
  }
});

test("contributedBackends maps an extension's sandbox provides entries and ignores nothing else", () => {
  const out = contributedBackends("toybox", [{ kind: "sandbox", id: "toybox", params: TOYBOX.params, credentials: ["apiKey"] }]);
  assert.deepEqual(out, [{ id: "toybox", owner: "toybox", builtin: false, params: TOYBOX.params, credentials: ["apiKey"] }]);
  assert.deepEqual(contributedBackends("x", undefined), []);
});

test("the standard keys' defaults are the fail-closed ones: spend ceilings 0, no ceiling on sandbox count, 15-minute lease", () => {
  const r = resolve(compose(TOYBOX));
  assert.ok(r.ok);
  const v = r.values as unknown as Record<string, unknown>;
  assert.equal(v["sandbox.toybox.maxDayMicros"], 0);
  assert.equal(v["sandbox.maxDayMicros"], 0);
  assert.equal(v["sandbox.toybox.maxSandboxes"], 0);
  assert.equal(v["sandbox.toybox.leaseMs"], 15 * 60_000);
});

test("describeConfig never echoes a credential variable's value unless it is an absolute path (a pasted secret is not printed)", () => {
  const registry = compose(TOYBOX);
  const fileEnv = secretFileEnv(sandboxCredentialEnv("toybox", "apiKey"));
  const pasted = "sk-pasted-secret-9d2e51";
  const env = { [fileEnv]: pasted };
  const r = resolveConfig(registry, { env });
  assert.ok(r.ok, "core does not read backend credential files, so resolution accepts the name");
  const dump = JSON.stringify(describeConfig(registry, r, { env }));
  assert.ok(!dump.includes(pasted), "the pasted value is absent from the dump");
  assert.match(dump, /file: <not an absolute path>/);
  const abs = describeConfig(registry, r, { env: { [fileEnv]: "/etc/pomtree/toybox.key" } }).find((x) => x.kind === "credential");
  assert.equal(abs?.value, "<redacted> (file: /etc/pomtree/toybox.key)");
});

test("a relative or pasted <ENV>_FILE value is refused without echoing it", () => {
  const pasted = "sk-pasted-secret-9d2e51";
  const r = resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_MODEL_UPSTREAM_KEY_FILE: pasted }, readFile: () => "x" });
  assert.ok(!r.ok);
  assert.ok(!r.errors.join().includes(pasted));
  assert.match(r.errors.join(), /expected an absolute path/);
});

test("a built-in manifest may set standard-key defaults; unknown keys and wrongly typed or out-of-range values are refused at parse", () => {
  const ok = parseSandboxManifest("@pomtree/sandbox-docker", {
    sandboxBackends: [{ id: "docker", params: [], defaults: { leaseMs: 60_000, region: "local", "rate.asOf": "2026-01-02" } }],
  });
  assert.ok(ok.ok);
  assert.deepEqual(ok.backends[0]?.defaults, { leaseMs: 60_000, region: "local", "rate.asOf": "2026-01-02" });
  assert.equal(compose(...(ok.backends as SandboxBackendConfigDecl[])).byPath.get("sandbox.docker.leaseMs")?.default, 60_000);
  for (const defaults of [
    { nope: 1 },
    { leaseMs: "60" },
    { leaseMs: 0 },
    { leaseMs: -1 },
    { leaseMs: 1.5 },
    { region: 3 },
    { "rate.asOf": "yesterday" },
    [],
    "x",
  ]) {
    const r = parseSandboxManifest("@pomtree/sandbox-docker", { sandboxBackends: [{ id: "docker", params: [], defaults }] });
    assert.ok(!r.ok && r.errors.every((e) => e.includes("@pomtree/sandbox-docker")), JSON.stringify(defaults));
  }
});

test("credential-like param names are refused: declare a credential instead", () => {
  for (const key of ["token", "apiKey", "secret", "password", "key", "authToken", "clientSecret"]) {
    assert.match(
      refused({ ...TOYBOX, params: [{ key, kind: "string", doc: "x", default: "" } as ExtParamDecl] }),
      /looks like a credential.*declare it in credentials/s,
      key,
    );
  }
  assert.ok(compose({ ...TOYBOX, params: [{ key: "maxTokens", kind: "count", doc: "x", default: 1 } as ExtParamDecl] }));
});

test("an env-name collision involving a backend credential names the cause and the action", () => {
  const clash = { ...TOYBOX, credentials: ["a"], params: [{ key: "aFile", kind: "string", doc: "x", default: "" } as ExtParamDecl] };
  assert.match(refused(clash), /rename the credential, the key or the backend id/);
});
