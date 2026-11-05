import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiskEgressAudit, FileEgressAuditWriter, prepareEgressSpool } from "./audit.ts";
import { attachProxy } from "./proxy.ts";

function send(port: number, method: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "http://public.test/x", method, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a method the audit cannot represent (M-SEARCH) is refused before forwarding and audited under a normalized token", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-method-")));
  const identity = { sandbox: "sb", agent: "w", host: "h", generation: 1 };
  const { logDir } = prepareEgressSpool(root, "sb", { allow: [], relay: [], identity });
  const writer = new FileEgressAuditWriter(logDir, identity);
  let dials = 0;
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    auditedPublic: writer,
    resolve: async () => ["8.8.8.8"],
    request: (() => {
      dials++;
      throw Error("must not dial");
    }) as unknown as typeof request,
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  try {
    const port = (proxy.address() as AddressInfo).port;
    assert.equal(await send(port, "M-SEARCH"), 405);
    assert.equal(dials, 0);
    const rows = await new DiskEgressAudit({ root }).read("sb", 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, "denied");
    assert.equal(rows[0]!.method, "OTHER");
    // The proxy keeps working: the audit was not closed by the unrepresentable method.
    assert.equal(await send(port, "M-SEARCH"), 405);
  } finally {
    control.close();
    proxy.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the writer rejects a method the shared rule does not allow, so the reader and pomtreed never disagree", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-method-")));
  try {
    const identity = { sandbox: "sb", agent: "w", host: "h", generation: 1 };
    const { logDir } = prepareEgressSpool(root, "sb", { allow: [], relay: [], identity });
    const writer = new FileEgressAuditWriter(logDir, identity);
    assert.throws(
      () => writer.append({ connection: "c", phase: "admission", transport: "http", authority: "a.test:80", method: "M-SEARCH", outcome: "allowed" }),
      /invalid egress method/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
