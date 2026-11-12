import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetSandbox } from "./test-network.ts";
import { DiskEgressAudit, FileEgressAuditWriter, type EgressProxyConfig } from "./audit.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

const spec = {
  agent: "worker",
  image: "pinned-agent-image",
  env: {},
  mounts: [wsMount("/w")],
  egress: { allow: [], relay: [{ host: "host.docker.internal", port: 9876 }], auditedPublic: { host: "captured-host", generation: 3 } },
};
test("audited-public requires an explicit visible spool; no Docker or worker without it", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (a) => {
      calls.push(a);
      if (a[0] === "inspect") throw Error("No such object");
      return "";
    },
  });
  await assert.rejects(sb.start(spec, "no-spool"), /egressAuditRoot/);
  assert.equal(
    calls.some((a) => a[0] === "run"),
    false,
  );
});
test("enabled public wiring: immutable RO manifest, proxy-only RW audit, network-none worker RO socket, cleanup retains late attribution", {
  skip: process.getuid?.() === 0 && "public spool intentionally requires unprivileged host uid",
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-public-docker-")));
  const calls: string[][] = [];
  mkdirSync(join(root, "work"));
  const auditRoot = join(root, "audit");
  const sb = new NetSandbox({
    mounts: stubMounts(() => join(root, "work")),
    egressAuditRoot: auditRoot,
    exec: async (a) => {
      calls.push(a);
      if (a[0] === "inspect") throw Error("No such object");
      return "0";
    },
  });
  try {
    const handle = await sb.start(spec, "public-actual-enabled");
    const dir = join(auditRoot, handle.id);
    const config = JSON.parse(readFileSync(join(dir, "config", "config.json"), "utf8")) as EgressProxyConfig;
    assert.deepEqual(config.identity, { agent: "worker", host: "captured-host", generation: 3, sandbox: handle.id });
    assert.deepEqual(config.relay, ["host.docker.internal:9876"]);
    const proxy = calls.find((a) => a[0] === "run" && a[3] === `pomtree-egress-proxy-${handle.id}`)!;
    const worker = calls.find((a) => a[0] === "run" && a[3] === `pomtree-${handle.id}`)!;
    assert.ok(proxy.includes(`type=bind,source=${dir}/config,target=/etc/pomtree-egress,readonly`));
    assert.ok(proxy.includes(`type=bind,source=${dir}/log,target=/var/log/pomtree-egress`));
    assert.ok(proxy.includes(`${process.getuid?.()}:1000`));
    assert.equal(proxy[proxy.indexOf("--entrypoint") + 1], "node");
    assert.ok(proxy.includes("EGRESS_SOCKET=/run/pomtree-egress/proxy.sock"));
    assert.equal(
      proxy.some((a) => a.includes("proxy.ts:ro")),
      false,
      "no host-source mount",
    );
    assert.equal(worker[worker.indexOf("--network") + 1], "none");
    assert.ok(worker.includes(`type=volume,source=pomtree-egress-socket-${handle.id},target=/run/pomtree-egress,readonly`));
    assert.equal(
      worker.some((a) => a.includes(auditRoot)),
      false,
      "worker never mounts audit or manifest",
    );
    const rejoin = new NetSandbox({ mounts: stubMounts(), egressAuditRoot: auditRoot, exec: async () => "true 0 false none" });
    assert.equal((await rejoin.start(spec, "public-actual-enabled")).id, handle.id);
    await assert.rejects(
      rejoin.start({ ...spec, egress: { ...spec.egress, auditedPublic: { host: "captured-host", generation: 4 } } }, "public-actual-enabled"),
      /attribution mismatch/,
    );
    const writer = new FileEgressAuditWriter(join(dir, "log"), config.identity!);
    writer.append({ connection: "captured", transport: "connect", authority: "public.test:443", phase: "admission", outcome: "allowed", peer: "8.8.8.8" });
    await sb.kill(handle.id, `test-kill:${handle.id}`);
    writer.append({ connection: "captured", transport: "connect", authority: "public.test:443", phase: "outcome", outcome: "cancelled" });
    const disk = new DiskEgressAudit({ root: auditRoot });
    assert.deepEqual(
      (await disk.read(handle.id, 0)).map((r) => r.generation),
      [3, 3],
    );
    assert.ok(calls.some((a) => a[0] === "volume" && a[1] === "rm" && a[2] === `pomtree-egress-socket-${handle.id}`));
    assert.ok(calls.some((a) => a[0] === "stop" && a[3] === `pomtree-egress-proxy-${handle.id}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a pre-existing non-confined worker cannot be re-adopted or granted public access", async () => {
  const sb = new NetSandbox({ mounts: stubMounts(), exec: async () => "true 0 false bridge" });
  await assert.rejects(sb.start(spec, "old-network"), /network-none/);
  await assert.rejects(sb.attach("old-network", "worker"), /network-none/);
});

test("failed UDS readiness fails closed before worker creation and tears down only exact owned resources", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    exec: async (a) => {
      calls.push(a);
      if (a[0] === "inspect") throw Error("No such object");
      if (a[0] === "exec") throw Error("socket mapping unsupported");
      return "";
    },
  });
  await assert.rejects(sb.start({ ...spec, egress: { allow: [] } }, "bad-platform"), /socket mapping unsupported/);
  assert.equal(calls.filter((a) => a[0] === "run").length, 1, "only sidecar attempted, never worker");
  assert.ok(calls.some((a) => a[0] === "rm" && a[1] === "-f" && a[2]?.startsWith("pomtree-egress-proxy-")));
  assert.ok(calls.some((a) => a[0] === "volume" && a[1] === "rm" && a[2]?.startsWith("pomtree-egress-socket-")));
});

function absentSandbox(root: string, auditRoot: string, calls: string[][] = []) {
  mkdirSync(join(root, "work"), { recursive: true });
  return new NetSandbox({
    mounts: stubMounts(() => join(root, "work")),
    egressAuditRoot: auditRoot,
    exec: async (a) => {
      calls.push(a);
      if (a[0] === "inspect") throw Error("No such object");
      return "0";
    },
  });
}
test("restarting an absent sandbox id succeeds: the immutable config holds no host NIC addresses; a real config change still fails closed", {
  skip: process.getuid?.() === 0 && "public spool intentionally requires unprivileged host uid",
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-public-restart-")));
  const auditRoot = join(root, "audit");
  try {
    const first = await absentSandbox(root, auditRoot).start(spec, "restart-key");
    const stored = JSON.parse(readFileSync(join(auditRoot, first.id, "config", "config.json"), "utf8")) as Record<string, unknown>;
    assert.equal("hostAddresses" in stored, false, "NIC/VPN/DHCP-dependent values must not be immutable");
    // Same sandbox id, container gone (crash/reap): start again with the same intent.
    assert.equal((await absentSandbox(root, auditRoot).start(spec, "restart-key")).id, first.id);
    await assert.rejects(
      absentSandbox(root, auditRoot).start({ ...spec, egress: { ...spec.egress, relay: [{ host: "host.docker.internal", port: 1 }] } }, "restart-key"),
      /immutable egress config mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a leftover proxy or socket volume from a crashed start is reclaimed before the proxy is created", {
  skip: process.getuid?.() === 0 && "public spool intentionally requires unprivileged host uid",
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-public-leftover-")));
  const calls: string[][] = [];
  try {
    const h = await absentSandbox(root, join(root, "audit"), calls).start(spec, "leftover-key");
    const at = (p: (a: string[]) => boolean) => calls.findIndex(p);
    const rmProxy = at((a) => a[0] === "rm" && a[1] === "-f" && a[2] === `pomtree-egress-proxy-${h.id}`);
    const rmVolume = at((a) => a[0] === "volume" && a[1] === "rm" && a[2] === `pomtree-egress-socket-${h.id}`);
    const create = at((a) => a[0] === "volume" && a[1] === "create");
    const runProxy = at((a) => a[0] === "run" && a[3] === `pomtree-egress-proxy-${h.id}`);
    assert.ok(
      rmProxy !== -1 && rmVolume !== -1 && rmProxy < rmVolume && rmVolume < create && create < runProxy,
      JSON.stringify([rmProxy, rmVolume, create, runProxy]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a worker mount overlapping the audit root is rejected before any spool, volume or proxy exists", {
  skip: process.getuid?.() === 0 && "public spool intentionally requires unprivileged host uid",
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-public-overlap-")));
  const auditRoot = join(root, "audit");
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(() => root), // the audit root's parent: contains the spool
    egressAuditRoot: auditRoot,
    exec: async (a) => {
      calls.push(a);
      if (a[0] === "inspect") throw Error("No such object");
      return "0";
    },
  });
  try {
    await assert.rejects(sb.start(spec, "overlap-key"), /overlaps private egress audit root/);
    assert.equal(existsSync(auditRoot) ? readdirSync(auditRoot).length : 0, 0, "no spool left counting against the cap");
    assert.deepEqual(
      calls.filter((a) => a[0] !== "inspect"),
      [],
      "no Docker side effects before the overlap check",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
