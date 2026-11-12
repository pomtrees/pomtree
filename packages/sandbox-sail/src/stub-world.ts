// Test support: the Sail adapter wired to the shared loopback provider stub (@pomtree/testing), with the fetch identity collector and
// a log recorder. Offline: the stub listens on 127.0.0.1 and the token is a planted placeholder, never a real key.

import { fileURLToPath } from "node:url";
import type { SandboxRequestOptions, SandboxRequester, SandboxResponse } from "@pomtree/core";
import { createRequest } from "@pomtree/sandbox-kit";
import { type Fixture, type IdentityCollector, ProviderStub, type ProviderStubOptions, identityCollector, loadFixture } from "@pomtree/testing";
import { SailSandbox, type SailOptions } from "./sail.ts";

export const TEST_USER_AGENT = "pomtree-sail-test";
// A planted credential: tests assert it never reaches an error, a log line or a create body.
export const PLANTED_TOKEN = "planted-sail-token-0123456789";
export const TEST_HOST = "host-a";
export const TEST_IMAGE = `registry.example/agent@sha256:${"a".repeat(64)}`;

// How the stub models the documented collection: `sailbox_id` ids, the inferred `{ "sailboxes": [...] }` list envelope, and the
// Idempotency-Key header required on create.
export const SAIL_RESOURCE: NonNullable<ProviderStubOptions["resources"]>[number] = {
  collection: "/v1/sailboxes",
  idField: "sailbox_id",
  idPrefix: "sbx",
  idempotencyHeader: "idempotency-key",
  requireKey: true,
  listField: "sailboxes",
};

export const fixturePath = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
export const fixture = (name: string): Fixture => loadFixture(fixturePath(name));

export interface StubWorld {
  stub: ProviderStub;
  sandbox: SailSandbox;
  ids: IdentityCollector;
  logs: { event: string; fields: Record<string, unknown> }[];
  // The stamped request function the adapter uses (for test-side calls such as a provider-side delete).
  request: SandboxRequester;
  close(): Promise<void>;
}

export interface StubWorldOptions {
  fixture?: Fixture;
  resources?: boolean;
  // Wraps the adapter's request function (a test seam for faults the stub cannot script).
  wrap?: (inner: SandboxRequester) => (url: string, init: SandboxRequestOptions) => Promise<SandboxResponse>;
  sail?: Partial<SailOptions>;
}

export async function stubWorld(o: StubWorldOptions = {}): Promise<StubWorld> {
  const ids = identityCollector();
  const stub = await ProviderStub.start({
    ...(o.fixture && { fixture: o.fixture }),
    ...(o.resources !== false && { resources: [SAIL_RESOURCE] }),
    requireHeaderNames: ["authorization"],
    observeUserAgent: ids.observe,
  });
  const inner = createRequest({ userAgent: TEST_USER_AGENT, timeoutMs: 5000 });
  const request: SandboxRequester = o.wrap ? Object.assign(o.wrap(inner), { openWebSocket: inner.openWebSocket }) : inner;
  const logs: StubWorld["logs"] = [];
  const sandbox = new SailSandbox({
    baseUrl: `${stub.baseUrl}/v1`,
    request,
    credential: async (name) => {
      if (name !== "apiToken") throw new Error(`the sail adapter asked for undeclared credential ${name}`);
      return PLANTED_TOKEN;
    },
    log: (event, fields) => logs.push({ event, fields }),
    now: Date.now,
    pollMs: 5,
    probe: { probes: 2, intervalMs: 0 },
    retry: { sleep: async () => {}, baseDelayMs: 0 },
    ...o.sail,
  });
  return { stub, sandbox, ids, logs, request: inner, close: () => stub.close() };
}
