import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { attachProxy } from "./proxy.ts";
import type { EgressAuditEvent } from "./audit.ts";

// Plain-HTTP forms that audited-public mode must refuse before any DNS lookup or upstream dial.
const REFUSED_TARGETS = [
  { name: "origin-form request line", path: "/path" },
  { name: "ftp scheme, absolute form", path: "ftp://public.test/file" },
  { name: "file scheme, absolute form", path: "file:///etc/passwd" },
  { name: "credentialed http URL", path: "http://user:pw@public.test/" },
];

function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

test("audited-public HTTP refuses origin-form, non-http schemes and credentialed URLs with no lookup, dial or allowed record", async () => {
  const events: EgressAuditEvent[] = [];
  let lookups = 0;
  let dials = 0;
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    auditedPublic: {
      append: (e) => {
        events.push(e);
      },
    },
    resolve: async () => {
      lookups++;
      return ["8.8.8.8"];
    },
    connect: () => {
      dials++;
      throw Error("must not dial");
    },
    request: (() => {
      dials++;
      throw Error("must not dial");
    }) as typeof request,
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as AddressInfo).port;
  try {
    for (const target of REFUSED_TARGETS) {
      const res = await rawGet(port, target.path);
      assert.equal(res.status, 400, target.name);
      assert.doesNotMatch(res.body, /8\.8\.8\.8/, target.name);
    }
    assert.equal(lookups, 0);
    assert.equal(dials, 0);
    assert.equal(
      events.some((e) => e.outcome === "allowed"),
      false,
    );
    // Each refusal is a denied admission with no outcome record of its own: the request never reached admission.
    // The audit must not persist the credential or the URL path of a refused target.
    assert.doesNotMatch(JSON.stringify(events), /user|pw|passwd|etc/);
    assert.equal(events.filter((e) => e.phase === "admission" && e.outcome === "denied").length, REFUSED_TARGETS.length);
  } finally {
    control.close();
    proxy.close();
  }
});
