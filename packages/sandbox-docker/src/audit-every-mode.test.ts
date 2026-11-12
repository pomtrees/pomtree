import test from "node:test";
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSpec } from "@pomtree/core";
import {
  DiskEgressAudit,
  FileEgressAuditWriter,
  auditChainGenesis,
  auditChainHolds,
  prepareEgressSpool,
  validateProxyConfig,
  validateRecord,
  type DenyReason,
  type EgressAuditRecord,
  type EgressProxyConfig,
} from "./audit.ts";
import { createSidecarProxies } from "./proxy.ts";
import { NetSandbox } from "./test-network.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

const SANDBOX = "sb-every-mode";
const identity = { sandbox: SANDBOX, agent: "worker", host: "host-1", generation: 4 };

function get(port: number, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: target, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end();
  });
}

// One denial through the real sidecar wiring, read back by the reader pomtreed consumes.
async function denyTwice(config: EgressProxyConfig, target: string): Promise<EgressAuditRecord[]> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-audit-every-mode-")));
  const { logDir } = prepareEgressSpool(root, SANDBOX, config);
  const writer = new FileEgressAuditWriter(logDir, identity);
  const proxies = createSidecarProxies(config, new Set(), writer, {
    resolve: async () => ["8.8.8.8"],
    connect: () => {
      throw Error("must not dial");
    },
  });
  const server: Server = proxies.main.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal(await get(port, target), 403);
    assert.equal(await get(port, target), 403);
    return await new DiskEgressAudit({ root }).read(SANDBOX, 0);
  } finally {
    for (const { control, server: s } of [proxies.main, proxies.browser]) {
      control.close();
      s.closeAllConnections();
      s.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
}

// The same assertions for every mode: the row shape and chain are identical, only the reason differs.
function assertDeniedRows(rows: EgressAuditRecord[], reason: DenyReason): void {
  const admissions = rows.filter((r) => r.phase === "admission");
  assert.equal(admissions.length, 2);
  assert.deepEqual(
    rows.map((r) => r.sequence),
    rows.map((_, i) => i + 1),
    "contiguous from 1",
  );
  let previous = auditChainGenesis(SANDBOX);
  rows.forEach((r, i) => {
    assert.ok(auditChainHolds(previous, r), `chain holds at row ${i + 1}`);
    assert.doesNotThrow(() => validateRecord(r, identity, i + 1));
    assert.notEqual(r.chain, previous, "head advances");
    previous = r.chain;
  });
  for (const r of admissions) {
    assert.equal(r.outcome, "denied");
    assert.equal(r.denyReason, reason);
  }
}

const base = { allow: [], relay: [], identity };
const modes: { name: string; config: EgressProxyConfig; target: string; reason: DenyReason }[] = [
  { name: "allowlist", config: { ...base, allow: ["allowed.test:443"] }, target: "http://other.test/", reason: "not-allowlisted" },
  { name: "relay-only", config: { ...base }, target: "http://other.test/", reason: "not-allowlisted" },
  { name: "audited-public", config: { ...base, auditedPublic: true }, target: "http://169.254.169.254/", reason: "hard-class" },
];
for (const m of modes)
  test(`${m.name}: a denied connection is spooled, chain-hashed and readable by the reader pomtreed consumes`, async () => {
    assertDeniedRows(await denyTwice(m.config, m.target), m.reason);
  });

test("a writer without auditedPublic records but never opens public egress (negative)", async () => {
  const rows = await denyTwice({ ...base, allow: ["allowed.test:443"] }, "http://public.test/");
  assert.ok(rows.every((r) => r.outcome !== "allowed"));
  assert.equal(rows.filter((r) => r.phase === "admission" && r.denyReason === "not-allowlisted").length, 2);
});

test("validateProxyConfig: auditedPublic must be exactly true and requires an identity", () => {
  assert.equal(validateProxyConfig({ ...base, auditedPublic: true }).auditedPublic, true);
  assert.equal(validateProxyConfig({ ...base }).auditedPublic, undefined);
  assert.throws(() => validateProxyConfig({ allow: [], relay: [], auditedPublic: true }), /auditedPublic requires an identity/);
  assert.throws(() => validateProxyConfig({ ...base, auditedPublic: "yes" }), /auditedPublic must be true or absent/);
  assert.throws(() => validateProxyConfig({ ...base, auditedPublic: false }), /auditedPublic must be true or absent/);
});

// startEgress / start() with a fake exec.
const skipRoot = { skip: process.getuid?.() === 0 && "audit spool requires an unprivileged host uid" };
const attributed = (attribution = { host: "host-1", generation: 4 }): SandboxSpec =>
  ({
    host: "host-test",
    generation: 0,
    agent: "a",
    image: "i",
    env: {},
    mounts: [wsMount("/w")],
    egress: { allow: [], attribution },
  }) as unknown as SandboxSpec;
const plain: SandboxSpec = { host: "host-test", generation: 0, agent: "a", image: "i", env: {}, mounts: [wsMount("/w")], egress: { allow: [] } };

function sandbox(root: string, calls: string[][], workspace = join(root, "work"), existing = false) {
  mkdirSync(workspace, { recursive: true });
  return new NetSandbox({
    mounts: stubMounts(() => workspace),
    egressAuditRoot: join(root, "audit"),
    exec: async (a) => {
      calls.push(a);
      if (a[0] === "inspect" && a.includes("-f")) {
        if (existing) return "true 0 false none";
        throw Error("No such object");
      }
      return "0";
    },
  });
}
const proxyRun = (calls: string[][]) => calls.find((a) => a[0] === "run" && a.some((x) => x.startsWith("pomtree-egress-proxy-")))!;

test("default mode with attribution and an audit root prepares a spool: identity on disk, no auditedPublic, spool mounts in argv", skipRoot, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-audit-default-")));
  try {
    const calls: string[][] = [];
    const h = await sandbox(root, calls).start(attributed(), "default-attributed");
    const config = JSON.parse(readFileSync(join(root, "audit", h.id, "config", "config.json"), "utf8"));
    assert.deepEqual(config.identity, { sandbox: h.id, agent: "a", host: "host-1", generation: 4 });
    assert.equal("auditedPublic" in config, false);
    const argv = proxyRun(calls).join(" ");
    assert.match(argv, /target=\/etc\/pomtree-egress,readonly/);
    assert.match(argv, /target=\/var\/log\/pomtree-egress/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default mode without attribution gets no spool and an inline config", skipRoot, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-audit-unattributed-")));
  try {
    const calls: string[][] = [];
    await sandbox(root, calls).start(plain, "default-plain");
    assert.equal(existsSync(join(root, "audit")) ? readdirSync(join(root, "audit")).length : 0, 0);
    const argv = proxyRun(calls).join(" ");
    assert.doesNotMatch(argv, /pomtree-egress,readonly/);
    assert.match(argv, /EGRESS_CONFIG_JSON=/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default-mode re-adoption with mismatched attribution throws; a matching one succeeds", skipRoot, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-audit-readopt-")));
  try {
    const h = await sandbox(root, []).start(attributed(), "readopt");
    const again = sandbox(root, [], undefined, true);
    assert.equal((await again.start(attributed(), "readopt")).id, h.id);
    await assert.rejects(again.start(attributed({ host: "host-2", generation: 4 }), "readopt"), /attribution mismatch on re-adoption/);
    await assert.rejects(again.start(attributed({ host: "host-1", generation: 5 }), "readopt"), /attribution mismatch on re-adoption/);
    // A spool written for the default mode must not be re-adopted as audited-public.
    const publicSpec = { ...plain, egress: { allow: [], auditedPublic: { host: "host-1", generation: 4 } } } as SandboxSpec;
    await assert.rejects(again.start(publicSpec, "readopt"), /attribution mismatch on re-adoption/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default mode with a spool rejects a worker mount overlapping the audit root before any Docker side effect", skipRoot, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-audit-overlap-")));
  try {
    const calls: string[][] = [];
    await assert.rejects(sandbox(root, calls, root).start(attributed(), "overlap"), /overlaps private egress audit root/);
    assert.deepEqual(
      calls.filter((a) => a[0] !== "inspect"),
      [],
    );
    assert.equal(existsSync(join(root, "audit")) ? readdirSync(join(root, "audit")).length : 0, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-adopting an attributed sandbox whose spool is missing fails closed with a cause and an action", skipRoot, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-audit-nospool-")));
  try {
    const existing = sandbox(root, [], undefined, true);
    await assert.rejects(existing.start(attributed(), "no-spool"), /egress audit spool missing for re-adopted sandbox .*stop and reap it \(pomtree kill\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
