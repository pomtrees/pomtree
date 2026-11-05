import assert from "node:assert/strict";
import test from "node:test";
import type { EnvManifest } from "@pomtree/agent-image";
import { emptyManifest } from "@pomtree/agent-image";
import { egressPolicy } from "./egress.ts";

const manifest = (ecosystems: EnvManifest["ecosystems"]): EnvManifest => ({ ecosystems });
const registry = { kind: "registry" } as const;

test("registry hosts for the ecosystems in use, always port 443", () => {
  const p = egressPolicy({
    policy: registry,
    manifest: manifest({ npm: { specs: ["left-pad@1.3.0"] }, pip: { specs: ["requests==2.31.0"] } }),
  });
  assert.deepEqual(p.allow, [
    { host: "files.pythonhosted.org", port: 443 },
    { host: "pypi.org", port: 443 },
    { host: "registry.npmjs.org", port: 443 },
  ]);
});

test("daemon channel added as host.docker.internal:<port> when TCP", () => {
  const p = egressPolicy({ policy: registry, manifest: emptyManifest(), agentApiUrl: "http://host.docker.internal:4321" });
  assert.deepEqual(p.allow, [{ host: "host.docker.internal", port: 4321 }]);
});

test("non-TCP agentApiUrl contributes nothing", () => {
  const p = egressPolicy({ policy: registry, manifest: emptyManifest(), agentApiUrl: "file:///run/pomtreed.sock" });
  assert.deepEqual(p.allow, []);
});

test("model base URL host:port (https defaults to 443)", () => {
  const p = egressPolicy({ policy: registry, manifest: emptyManifest(), modelBaseUrl: "https://api.example.com/v1" });
  assert.deepEqual(p.allow, [{ host: "api.example.com", port: 443 }]);
});

test("model base URL honors a custom port", () => {
  const p = egressPolicy({ policy: registry, manifest: emptyManifest(), modelBaseUrl: "http://api.example.com:8443/v1" });
  assert.deepEqual(p.allow, [{ host: "api.example.com", port: 8443 }]);
});

test("dedupes by host:port across registry, daemon, and model", () => {
  const p = egressPolicy({
    policy: registry,
    manifest: manifest({ npm: { specs: ["left-pad@1.3.0"] } }),
    agentApiUrl: "http://host.docker.internal:443",
    modelBaseUrl: "https://registry.npmjs.org",
  });
  assert.deepEqual(p.allow, [
    { host: "host.docker.internal", port: 443 },
    { host: "registry.npmjs.org", port: 443 },
  ]);
});

test("registry composes relay + registries + model proxy (the default egress stack)", () => {
  const p = egressPolicy({
    policy: registry,
    manifest: manifest({ npm: { specs: ["left-pad@1.3.0"] }, pip: { specs: ["requests==2.31.0"] } }),
    agentApiUrl: "http://host.docker.internal:4321",
    modelBaseUrl: "http://host.docker.internal:9000/v1",
  });
  assert.deepEqual(p.allow, [
    { host: "files.pythonhosted.org", port: 443 },
    { host: "host.docker.internal", port: 4321 },
    { host: "host.docker.internal", port: 9000 },
    { host: "pypi.org", port: 443 },
    { host: "registry.npmjs.org", port: 443 },
  ]);
});

test("none resolves to an empty allowlist even with relay URLs", () => {
  assert.deepEqual(
    egressPolicy({
      policy: { kind: "none" },
      manifest: manifest({ npm: { specs: ["left-pad@1.3.0"] } }),
      agentApiUrl: "http://host.docker.internal:4321",
      modelBaseUrl: "https://api.example.com/v1",
    }),
    { allow: [] },
  );
});

test("allowlist is exact apart from required node relay endpoints", () => {
  assert.deepEqual(
    egressPolicy({
      policy: { kind: "allowlist", hosts: ["api.example.com"] },
      manifest: manifest({ npm: { specs: ["left-pad@1.3.0"] } }),
      modelBaseUrl: "http://model-relay.internal:8080/v1",
    }).allow,
    [
      { host: "api.example.com", port: 443 },
      { host: "model-relay.internal", port: 8080 },
    ],
  );
});

test("registry with no manifest targets stays closed except the explicit relay", () => {
  assert.deepEqual(
    egressPolicy({
      policy: registry,
      manifest: emptyManifest(),
      modelBaseUrl: "http://model-relay.internal:8080/v1",
    }).allow,
    [{ host: "model-relay.internal", port: 8080 }],
  );
});

test("no implicit provider API host: the model is reached through the proxy only, whatever the controller's model URL", () => {
  // The policy takes no provider input, so nothing but the proxy URL and the relay can add a model host.
  assert.deepEqual(egressPolicy({ policy: registry, manifest: emptyManifest(), modelBaseUrl: "http://host.docker.internal:9000/v1" }).allow, [
    { host: "host.docker.internal", port: 9000 },
  ]);
  assert.deepEqual(egressPolicy({ policy: registry, manifest: emptyManifest() }).allow, []);
});

test("none stays empty even with a model proxy URL, and an explicit allowlist keeps exactly its operator hosts", () => {
  assert.deepEqual(egressPolicy({ policy: { kind: "none" }, manifest: emptyManifest(), modelBaseUrl: "http://host.docker.internal:9000/v1" }).allow, []);
  assert.deepEqual(
    egressPolicy({ policy: { kind: "allowlist", hosts: ["api.example.com"] }, manifest: emptyManifest(), modelBaseUrl: "http://m.internal:9000/v1" }).allow,
    [
      { host: "api.example.com", port: 443 },
      { host: "m.internal", port: 9000 },
    ],
  );
});

test("an explicit operator allowlist may name a raw provider host, which survives; no other provider host is added implicitly", () => {
  const p = egressPolicy({
    policy: { kind: "allowlist", hosts: ["api.openai.com", "ordinary.example.com"] },
    manifest: emptyManifest(),
    agentApiUrl: "http://host.docker.internal:4321",
    modelBaseUrl: "http://host.docker.internal:9000/v1",
  });
  assert.deepEqual(p.allow, [
    { host: "api.openai.com", port: 443 },
    { host: "host.docker.internal", port: 4321 },
    { host: "host.docker.internal", port: 9000 },
    { host: "ordinary.example.com", port: 443 },
  ]);
});

test("unknown and malformed allowlist policies fail closed", () => {
  assert.deepEqual(
    egressPolicy({
      policy: { kind: "allow" } as never,
      manifest: manifest({ npm: { specs: ["left-pad@1.3.0"] } }),
      modelBaseUrl: "http://model-relay.internal:8080/v1",
    }).allow,
    [],
  );
  assert.throws(
    () => egressPolicy({ policy: { kind: "allowlist", hosts: ["api.example.com/path"] }, manifest: emptyManifest() }),
    /invalid egress allowlist host/,
  );
});
