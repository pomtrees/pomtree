// Test-only transport for ctx.workflow.fetch: routes named hosts to a loopback fixture server so a headless run of a real
// workflow on a real pomtreed needs no network. Off by default and refused unless the daemon runs in test mode: `test.fetchHosts`
// (POMTREED_TEST_FETCH_HOSTS) is accepted only together with `test.mode` (POMTREED_TEST_MODE), daemon-config.ts refuses it otherwise,
// and main.ts prints a WARNING line at start while it is on. It never widens what a workflow may fetch: the URL policy, the
// capability's host allowlist, the request budget, the body cap and the redirect rules all run unchanged in webFetchOnce. Only
// the last step changes for a mapped host: DNS answers TEST_FETCH_ADDRESS (so the SSRF check passes), and the request goes over
// plain http to 127.0.0.1:<port> with the original Host header. The target is always loopback: an operator names a port, never
// an address, so the seam cannot be pointed at another machine. Unmapped hosts use the production transport. Pure apart from
// the transport it wraps.
import { lookup } from "node:dns/promises";
import { testFetchHostsReason } from "@pomtree/core";
import type { FetchFn } from "./ext-gateway.ts";
import { defaultFetch } from "./ext-gateway.ts";

// What DNS answers for a mapped host: an address that passes the SSRF block list (TEST-NET and the private ranges do not), so the
// rest of the policy runs as in production. It is only a token: the transport drops the pin and never dials it.
export const TEST_FETCH_ADDRESS = "100.128.0.1";

export function parseTestFetchHosts(v: unknown): ReadonlyMap<string, number> {
  const reason = testFetchHostsReason(v);
  if (reason) throw new Error(`test.fetchHosts ${reason}`);
  return new Map(Object.entries(v as Record<string, number>));
}

// The refusal and the start-time line, one place for both wordings.
export const testFetchRefusal = (envMode: string): string =>
  `test.fetchHosts is a test-only seam that routes workflow fetches to a loopback fixture; it is refused unless test.mode is true (${envMode}=true). Unset it in production`;
export const testFetchWarning = (hosts: ReadonlyMap<string, number>): string =>
  `pomtreed: WARNING: TEST MODE: workflow fetch for ${[...hosts].map(([h, p]) => `${h} -> 127.0.0.1:${p}`).join(", ")} goes to a loopback fixture, not the network (test.fetchHosts). Never run this in production`;

export interface TestFetchSeam {
  fetch: FetchFn;
  resolveDns: (h: string) => Promise<{ address: string; family: number }[]>;
}

export function testFetchSeam(
  hosts: ReadonlyMap<string, number>,
  base: { fetch?: FetchFn; resolveDns?: TestFetchSeam["resolveDns"] } = {}, // the production transport, for unmapped hosts
): TestFetchSeam {
  const real = base.fetch ?? defaultFetch;
  const resolve = base.resolveDns ?? ((h: string) => lookup(h, { all: true }));
  const port = (host: string) => hosts.get(host.toLowerCase());
  return {
    resolveDns: async (h) => (port(h) !== undefined ? [{ address: TEST_FETCH_ADDRESS, family: 4 }] : resolve(h)),
    fetch: (url, init) => {
      const u = new URL(url);
      const p = port(u.hostname);
      if (p === undefined) return real(url, init);
      const { pin: _pin, ...rest } = init; // the pin names TEST_FETCH_ADDRESS, which must never be dialled
      return real(`http://127.0.0.1:${p}${u.pathname}${u.search}`, { ...rest, headers: { ...(init.headers ?? {}), host: u.host } });
    },
  };
}
