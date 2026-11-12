import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  admitBackend,
  CONFIG_REGISTRY,
  checkPortVersion,
  composeRegistry,
  parseSandboxManifest,
  SANDBOX_PORT_VERSION,
  type Sandbox,
  type SandboxBackendDeps,
  validateBackendId,
  validateDeclaration,
} from "@pomtree/core";
import { sailProvider } from "./provider.ts";
import { SAIL_DECLARATION, SailSandbox } from "./sail.ts";

const manifest = () => JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

// Deps whose transport refuses every call: building the adapter must not make one.
const deps = (config: Record<string, unknown> = {}): SandboxBackendDeps => ({
  fetch: async () => {
    throw new Error("create() must not fetch");
  },
  request: Object.assign(
    async () => {
      throw new Error("create() must not make a request");
    },
    {
      openWebSocket: (): WebSocket => {
        throw new Error("create() must not open a WebSocket");
      },
    },
  ),
  credential: async () => {
    throw new Error("create() must not read the credential");
  },
  log: () => {},
  now: () => 0,
  config,
});

test("manifest.json parses, composes, and is the provider's params and credentials", () => {
  const parsed = parseSandboxManifest("@pomtree/sandbox-sail", manifest());
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
  assert.deepEqual(
    parsed.backends.map((b) => b.id),
    ["sail"],
  );
  const decl = parsed.backends[0];
  assert.deepEqual(decl?.params, sailProvider.params);
  assert.deepEqual(decl?.credentials, ["apiToken"]);
  assert.deepEqual(sailProvider.credentials, ["apiToken"]);
  // Composes as a built-in: sandbox.sail.baseUrl joins the registry, the standard keys come with it, and no key looks like a secret.
  const reg = composeRegistry(CONFIG_REGISTRY, { sandboxBackends: [{ ...decl!, owner: "@pomtree/sandbox-sail", builtin: true }] });
  assert.ok(reg.params.some((p) => p.path === "sandbox.sail.baseUrl"));
  assert.ok(reg.params.some((p) => p.path === "sandbox.sail.region"));
});

test("a manifest that declares the token as a config key is refused", () => {
  const m = manifest();
  m.sandboxBackends[0].params.push({ key: "apiToken", kind: "string", default: "", doc: "x" });
  const parsed = parseSandboxManifest("@pomtree/sandbox-sail", m);
  const reg = () => composeRegistry(CONFIG_REGISTRY, { sandboxBackends: parsed.ok ? parsed.backends.map((b) => ({ ...b, owner: "x", builtin: true })) : [] });
  assert.throws(reg, /looks like a credential/);
});

test("the provider is a valid built-in: port version, declaration, reserved id", () => {
  assert.equal(sailProvider.id, "sail");
  assert.equal(sailProvider.portVersion, SANDBOX_PORT_VERSION);
  checkPortVersion("sail", sailProvider.portVersion);
  assert.deepEqual(validateDeclaration(sailProvider.declaration), []);
  assert.equal(sailProvider.declaration.idempotency, "native-token");
  assert.equal(sailProvider.declaration.tagging, "name-encoded");
  // `sail` is a built-in id: an extension cannot claim it.
  assert.throws(() => validateBackendId("sail"), /reserved/);
});

test("create builds the adapter without a call and with the provider's declaration", () => {
  const s: Sandbox = sailProvider.create(deps({ "host.id": "host-a" }));
  assert.ok(s instanceof SailSandbox);
  assert.equal(s.declaration, SAIL_DECLARATION);
  assert.equal(typeof s.connect?.open, "function");
  const port: Sandbox = s;
  assert.equal(port.files, undefined);
  assert.equal(port.terminal, undefined);
});

test("create refuses a region, which Sailboxes does not document, and a malformed base URL", () => {
  assert.throws(() => sailProvider.create(deps({ "sandbox.sail.region": "us-east" })), /documents no regions.*unset sandbox\.sail\.region/);
  assert.throws(() => sailProvider.create(deps({ "sandbox.sail.baseUrl": "ftp://x" })), /not an https URL/);
});

// The declaration is deliberately narrow (README.md, "Declaration"), so boot admission refuses it today; this pins that the reason is
// the undocumented pids limit, not a missing route home.
test("admission refuses the narrow declaration for resource limits only", () => {
  const r = admitBackend(SAIL_DECLARATION, null, {
    egress: false,
    daemonReach: true,
    terminal: false,
    workspace: "staged",
    secrets: { agentToken: true, envAllowed: false },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.ok ? [] : r.refusals.map((x) => x.capability), ["resources.limits"]);
});
