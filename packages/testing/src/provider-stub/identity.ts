import assert from "node:assert/strict";

// Fetch-identity check for hosted adapters: every request an adapter or the kit makes to a provider must carry the project's configured User-Agent
// (`workflow.fetch.userAgent`, default `pomtree`). The stub's generic recorder keeps header NAMES only so credentials cannot leak, so this collector
// is fed through the stub's `observeUserAgent` option and keeps the user-agent VALUE and nothing else from the headers.

export interface SeenUserAgent {
  readonly method: string;
  readonly path: string;
  readonly upgrade: boolean;
  readonly userAgent: string | undefined;
}

export interface IdentityCollector {
  /** Pass as `ProviderStub.start({ observeUserAgent: collector.observe })`. */
  readonly observe: (seen: SeenUserAgent) => void;
  /** Every request seen so far (plain and websocket upgrade), in order. */
  seen(): readonly SeenUserAgent[];
}

export function identityCollector(): IdentityCollector {
  const log: SeenUserAgent[] = [];
  return {
    observe: (s) => {
      log.push({ method: s.method, path: s.path, upgrade: s.upgrade, userAgent: s.userAgent });
    },
    seen: () => log,
  };
}

/**
 * Fails when no request was observed (a check over nothing proves nothing), or when any request lacks the exact `expected` User-Agent. The message
 * names the offender count and each offender's method and path, never any header value.
 */
export function assertAllRequestsCarry(collector: IdentityCollector, expected: string): void {
  const all = collector.seen();
  assert.notEqual(
    all.length,
    0,
    "the provider stub observed no requests, so the fetch identity was not checked; make sure the stub was started with observeUserAgent: collector.observe and that the adapter under test sent at least one request",
  );
  const bad = all.filter((s) => s.userAgent !== expected);
  assert.equal(
    bad.length,
    0,
    `${bad.length} of ${all.length} request(s) did not carry the configured User-Agent (workflow.fetch.userAgent): ${bad.map((s) => `${s.upgrade ? "UPGRADE" : s.method} ${s.path}`).join("; ")}; send every provider request through the kit's createRequest, or stamp the configured User-Agent`,
  );
}
