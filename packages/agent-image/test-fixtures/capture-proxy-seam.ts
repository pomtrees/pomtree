// Test-only preload (NODE_OPTIONS=--import) for a derived copy of the egress sidecar image. The REAL proxy.ts still runs, with its real
// admission, classification, audit and forwarding; only name resolution and the final dial are redirected so the fake `.test` hosts
// reach capture-site.ts on the sidecar's own loopback. A `.test` name resolves to a public-class address (which passes the proxy's
// private-range denial) and a dial to that address goes to 127.0.0.1. Every other name resolves and dials as before.
import dns from "node:dns";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { startCaptureSite } from "./capture-site.ts";

const FAKE_PUBLIC_IP = "93.184.216.34";

const lookup = dns.promises.lookup.bind(dns.promises);
// biome-ignore lint/suspicious/noExplicitAny: lookup's overloads are not worth restating for a test seam
(dns.promises as any).lookup = async (host: string, opts?: any) => (host.endsWith(".test") ? [{ address: FAKE_PUBLIC_IP, family: 4 }] : lookup(host, opts));

const connect = net.connect;
// biome-ignore lint/suspicious/noExplicitAny: net.connect's overloads are not worth restating for a test seam
(net as any).connect = (...args: any[]) =>
  connect(...((typeof args[0] === "number" && args[1] === FAKE_PUBLIC_IP ? [args[0], "127.0.0.1", ...args.slice(2)] : args) as [number]));

const request = http.request;
// biome-ignore lint/suspicious/noExplicitAny: http.request's overloads are not worth restating for a test seam
(http as any).request = (...args: any[]) => {
  const o = args[0];
  if (o && typeof o === "object" && !(o instanceof URL) && o.host === FAKE_PUBLIC_IP) args[0] = { ...o, host: "127.0.0.1" };
  return (request as (...a: unknown[]) => http.ClientRequest)(...args);
};
syncBuiltinESMExports();

// Only the sidecar's proxy process: the readiness probe is another `node -e` that inherits this NODE_OPTIONS and must not start a second site.
if (process.argv[1]?.endsWith("/egress/proxy.ts")) await startCaptureSite();
