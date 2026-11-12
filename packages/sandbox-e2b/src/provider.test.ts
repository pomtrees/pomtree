import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  admitBackend,
  type BackendNeeds,
  checkPortVersion,
  parseSandboxManifest,
  SANDBOX_PORT_VERSION,
  type SandboxBackendDeps,
  type SandboxBackendProvider,
  SandboxCapabilityError,
  validateBackendId,
  validateDeclaration,
} from "@pomtree/core";
import { API_KEY_FILE_ENV } from "./api.ts";
import { checkBaseUrl, e2bProvider, timeoutSeconds } from "./provider.ts";
import { E2B_DECLARATION, E2BSandbox } from "./sandbox.ts";

const manifestText = () => readFileSync(new URL("../manifest.json", import.meta.url), "utf8");

// Deps whose every outbound member fails the test: create() must build the adapter without a request or a credential read.
const deps = (config: Record<string, unknown> = {}): SandboxBackendDeps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async () => {
      calls.push("fetch");
      throw new Error("no fetch");
    }) as typeof fetch,
    request: Object.assign(
      async () => {
        calls.push("request");
        throw new Error("no request");
      },
      {
        openWebSocket: (): WebSocket => {
          calls.push("ws");
          throw new Error("no websocket");
        },
      },
    ),
    credential: async (name: string) => {
      calls.push(`credential:${name}`);
      return "k";
    },
    log: () => {},
    now: () => 0,
    config,
  };
};

test("the provider carries the current port version, the reserved built-in id and a valid declaration", () => {
  assert.equal(e2bProvider.id, "e2b");
  assert.equal(e2bProvider.portVersion, SANDBOX_PORT_VERSION);
  assert.doesNotThrow(() => checkPortVersion(e2bProvider.id, e2bProvider.portVersion));
  assert.throws(() => validateBackendId(e2bProvider.id), /reserved/);
  assert.equal(e2bProvider.declaration, E2B_DECLARATION);
  assert.equal(E2B_DECLARATION.backend, "e2b");
  assert.deepEqual(validateDeclaration(E2B_DECLARATION), []);
  assert.equal(E2B_DECLARATION.idempotency, "tag-lookup");
  assert.equal(E2B_DECLARATION.tagging, "metadata");
  const registry: SandboxBackendProvider[] = [e2bProvider];
  assert.equal(registry.length, 1);
});

test("the declaration claims only what the docs show: list.byTag; everything else is false", () => {
  const claimed = Object.entries(E2B_DECLARATION.capabilities)
    .filter(([, v]) => v)
    .map(([k]) => k);
  assert.deepEqual(claimed, ["list.byTag"]);
});

test("admission refuses the backend today: no daemon route, no enforced limits and no image path (honest declaration, not a usable backend yet)", () => {
  const needs: BackendNeeds = { egress: false, daemonReach: true, terminal: false, workspace: "staged", secrets: { agentToken: false, envAllowed: false } };
  const r = admitBackend(E2B_DECLARATION, null, needs);
  assert.equal(r.ok, false);
  const caps = r.ok ? [] : r.refusals.map((x) => x.capability);
  assert.ok(caps.includes("connect"), "no daemon route: connect, reach.outbound and mounts.host are all undeclared");
  assert.ok(caps.includes("resources.limits"));
  assert.ok(caps.includes("image.ociPull"));
});

test("manifest.json parses and matches the provider's params and credentials", () => {
  const parsed = parseSandboxManifest("@pomtree/sandbox-e2b", JSON.parse(manifestText()));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
  assert.equal(parsed.backends.length, 1);
  const decl = parsed.backends[0];
  assert.equal(decl?.id, "e2b");
  assert.deepEqual(decl?.params, e2bProvider.params);
  assert.deepEqual(decl?.credentials, ["apiKey"]);
  assert.deepEqual(e2bProvider.credentials, ["apiKey"]);
  assert.equal(API_KEY_FILE_ENV, "POMTREED_SANDBOX_E2B_APIKEY_FILE", "the name the README and the generated config docs give");
  assert.deepEqual(
    e2bProvider.params.map((p) => [p.key, p.kind, p.default]),
    [
      ["baseUrl", "string", "https://api.e2b.dev"],
      ["template", "string", ""],
    ],
  );
});

test("a manifest declaring the API key as a config key, or with an unknown field, is refused", () => {
  const m = JSON.parse(manifestText());
  m.sandboxBackends[0].secret = true;
  assert.equal(parseSandboxManifest("@pomtree/sandbox-e2b", m).ok, false);
});

test("create builds the adapter without a request or a credential read", () => {
  const d = deps({ "sandbox.e2b.baseUrl": "https://api.e2b.dev", "sandbox.e2b.leaseMs": 600_000 });
  const s = e2bProvider.create(d);
  assert.ok(s instanceof E2BSandbox);
  assert.deepEqual(s.declaration, E2B_DECLARATION);
  assert.deepEqual(d.calls, []);
});

test("create refuses a plain-http base URL off the machine, naming the action", () => {
  assert.throws(() => e2bProvider.create(deps({ "sandbox.e2b.baseUrl": "http://api.e2b.dev" })), /clear text; use an https: URL/);
  assert.throws(() => checkBaseUrl("not a url"), /is not a URL/);
  assert.equal(checkBaseUrl("http://127.0.0.1:9"), "http://127.0.0.1:9");
});

test("the create timeout is the lease in whole seconds, capped at E2B's one-hour lifetime", () => {
  assert.equal(timeoutSeconds({}), 900);
  assert.equal(timeoutSeconds({ "sandbox.e2b.leaseMs": 1500 }), 2);
  assert.equal(timeoutSeconds({ "sandbox.e2b.leaseMs": 86_400_000 }), 3600);
  assert.throws(() => timeoutSeconds({ "sandbox.e2b.leaseMs": 10 }), /1000 ms or more/);
});

test("imageIdentity throws SandboxCapabilityError (no image.digestAttest), so the daemon resolves identity elsewhere", async () => {
  const s = e2bProvider.create(deps());
  await assert.rejects(
    () => s.imageIdentity("base"),
    (e: unknown) => e instanceof SandboxCapabilityError && e.capability === "image.digestAttest",
  );
});

test("start refuses what it cannot honour before creating anything, each with an action", async () => {
  const d = deps();
  const s = e2bProvider.create(d);
  const base = { agent: "a", image: "base", env: {}, mounts: [] };
  for (const [extra, re] of [
    [{ cmd: ["sh"] }, /cannot run spec.cmd.*start command/],
    [{ egress: { allow: [] } }, /does not enforce an egress allowlist/],
    [{ runtime: { ociRuntime: "runsc" } }, /no selectable runtime/],
    [{ mounts: [{ kind: "bind", hostPath: "/x", containerPath: "/y" }] }, /cannot bind-mount/],
    [{ image: "registry.example/agent@sha256:00" }, /not a template id; set sandbox.e2b.template/],
    [{ labels: { "pomtree.x": "1" } }, /reserved/],
  ] as const) {
    await assert.rejects(() => s.start({ ...base, ...extra } as never, "k"), re);
  }
  assert.deepEqual(d.calls, [], "a refused start makes no request");
  await assert.rejects(() => s.resultWork("x", { maxBytes: 1 }), /cannot collect the work.*envd/);
});
