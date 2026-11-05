// The egress sidecar's image is the operator's pinned enforcer, verified against the local image store before the first
// sidecar start (never pulled); without one the worker's own image is used, visibly. Also: the relay byte cap reaches the
// sidecar's config on both config paths.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxStartError, SandboxUnavailableError } from "@pomtree/core";
import { pinnedImageDigest, type Exec } from "./docker.ts";
import { NetSandbox } from "./test-network.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

const HEX = "a".repeat(64);
const PINNED = `registry.example:5000/pomtree/agent:dev@sha256:${HEX}`;
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const spec = { agent: "a", image: "worker-image", env: {}, mounts: [wsMount("/w")], egress: { allow: [{ host: "pypi.org" }] } };

// Fake exec: no existing container; `image inspect` answers from `images` (ref -> stdout), or fails like docker for a miss.
function fakeExec(calls: string[][], images: Record<string, string>): Exec {
  return async (args) => {
    calls.push(args);
    if (args[0] === "inspect") throw new Error("No such object");
    if (args[0] === "image" && args[1] === "inspect") {
      const ref = args[args.length - 1]!;
      if (!(ref in images)) throw new Error(`docker image failed: Error: No such image: ${ref}`);
      return images[ref]!;
    }
    return "";
  };
}
const sidecarRun = (calls: string[][]) => calls.find((c) => c[0] === "run" && String(c[3]).startsWith("pomtree-egress-proxy-"));
const inspects = (calls: string[][]) => calls.filter((c) => c[0] === "image" && c[1] === "inspect").length;

test("pinnedImageDigest: name[:tag]@sha256 and a bare image id are pinned; tags, short or uppercase digests are not", () => {
  assert.deepEqual(pinnedImageDigest(PINNED), { digest: `sha256:${HEX}`, imageId: false });
  assert.deepEqual(pinnedImageDigest(`agent@sha256:${HEX}`), { digest: `sha256:${HEX}`, imageId: false });
  assert.deepEqual(pinnedImageDigest(IMAGE_ID), { digest: IMAGE_ID, imageId: true });
  for (const ref of ["pomtree/agent:dev", "agent@sha256:abc", `agent@sha256:${"A".repeat(64)}`, `agent@sha512:${HEX}`, `@sha256:${HEX}`, ""])
    assert.equal(pinnedImageDigest(ref), undefined, ref);
});

test("the constructor refuses an egressProxyImage that is not digest-pinned, naming the option and the fix", () => {
  assert.throws(
    () => new NetSandbox({ mounts: stubMounts(), egressProxyImage: "pomtree/agent:dev" }),
    /^Error: egressProxyImage "pomtree\/agent:dev" is not digest-pinned: set it to name\[:tag\]@sha256:<64 hex> or a local image id sha256:<64 hex>$/,
  );
  new NetSandbox({ mounts: stubMounts(), egressProxyImage: PINNED });
  new NetSandbox({ mounts: stubMounts(), egressProxyImage: IMAGE_ID });
});

test("a pinned repo digest is verified once per instance, then the sidecar runs that exact ref", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({
    mounts: stubMounts(),
    egressProxyImage: PINNED,
    exec: fakeExec(calls, { [PINNED]: JSON.stringify([`registry.example:5000/pomtree/agent@sha256:${HEX}`]) }),
  });
  await sb.start(spec, "k-pinned-1");
  const inspect = calls.find((c) => c[0] === "image")!;
  assert.deepEqual(inspect, ["image", "inspect", "--format", "{{json .RepoDigests}}", PINNED]);
  assert.ok(calls.indexOf(inspect) < calls.findIndex((c) => c[0] === "volume" && c[1] === "create"), "verified before anything per-sandbox exists");
  assert.equal(sidecarRun(calls)!.at(-2), PINNED);
  await sb.start(spec, "k-pinned-2");
  assert.equal(inspects(calls), 1, "verification is cached per instance");
  assert.ok(!calls.some((c) => c[0] === "pull"), "never pulls");
});

test("a local image id is verified against .Id", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({ mounts: stubMounts(), egressProxyImage: IMAGE_ID, exec: fakeExec(calls, { [IMAGE_ID]: IMAGE_ID }) });
  await sb.start(spec, "k-image-id");
  assert.deepEqual(
    calls.find((c) => c[0] === "image"),
    ["image", "inspect", "--format", "{{.Id}}", IMAGE_ID],
  );
  assert.equal(sidecarRun(calls)!.at(-2), IMAGE_ID);
});

test("a missing pinned image fails the start as image_unavailable with the cause and action; nothing is created", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({ mounts: stubMounts(), egressProxyImage: PINNED, exec: fakeExec(calls, {}) });
  await assert.rejects(
    sb.start(spec, "k-missing"),
    (e: unknown) =>
      e instanceof SandboxStartError &&
      e.kind === "image_unavailable" &&
      !e.retryable &&
      e.message.includes(`egressProxyImage ${PINNED} is not present on the daemon host`) &&
      e.message.includes("No such image") &&
      e.message.includes("load that exact image there first"),
  );
  assert.ok(!calls.some((c) => c[0] === "run" || (c[0] === "volume" && c[1] === "create")));
  assert.ok(!calls.some((c) => c[0] === "pull"));
});

test("a ref whose local repo digests do not carry the pinned digest is egress_start_failed; nothing runs; a retry re-verifies", async () => {
  const calls: string[][] = [];
  const other = `registry.example:5000/pomtree/agent@sha256:${"c".repeat(64)}`;
  for (const answer of [JSON.stringify([other]), "[]", "null", "not json"]) {
    const sb = new NetSandbox({ mounts: stubMounts(), egressProxyImage: PINNED, exec: fakeExec(calls, { [PINNED]: answer }) });
    await assert.rejects(
      sb.start(spec, "k-mismatch"),
      (e: unknown) =>
        e instanceof SandboxStartError &&
        e.kind === "egress_start_failed" &&
        e.message.startsWith(`egress proxy start failed: egressProxyImage ${PINNED} resolves to a local image whose repo digests`) &&
        e.message.includes(`do not match sha256:${HEX}`) &&
        e.message.endsWith("load the exact digest-pinned image on the daemon host"),
      answer,
    );
    const before = inspects(calls);
    await assert.rejects(sb.start(spec, "k-mismatch"));
    assert.equal(inspects(calls), before + 1, "a failed verification is not cached");
  }
  assert.ok(!calls.some((c) => c[0] === "run"));
});

test("Docker down during verification stays endpoint_unreachable (retryable)", async () => {
  const sb = new NetSandbox({
    mounts: stubMounts(),
    egressProxyImage: PINNED,
    exec: async (args) => {
      if (args[0] === "inspect") throw new Error("No such object");
      if (args[0] === "image") throw new SandboxUnavailableError();
      return "";
    },
  });
  await assert.rejects(sb.start(spec, "k-down"), (e: unknown) => e instanceof SandboxStartError && e.kind === "endpoint_unreachable" && e.retryable);
});

test("without egressProxyImage the sidecar falls back to spec.image and warns once per instance, naming the fix", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const calls: string[][] = [];
  const sb = new NetSandbox({ mounts: stubMounts(), exec: fakeExec(calls, {}) });
  await sb.start(spec, "k-fallback-1");
  await sb.start(spec, "k-fallback-2");
  assert.equal(sidecarRun(calls)!.at(-2), "worker-image");
  assert.equal(inspects(calls), 0);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(warn.mock.calls[0]!.arguments, [
    "egress proxy sidecar falls back to the worker image (spec.image); set egressProxyImage to a digest-pinned image",
  ]);
  await new NetSandbox({ mounts: stubMounts(), exec: fakeExec([], {}) }).start(spec, "k-fallback-3");
  assert.equal(warn.mock.callCount(), 2, "once per instance");
});

test("egressRelayMaxBytes must be a positive integer", () => {
  for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10" as unknown as number])
    assert.throws(
      () => new NetSandbox({ mounts: stubMounts(), egressRelayMaxBytes: v }),
      /^Error: egressRelayMaxBytes .* must be a positive integer byte count$/,
      String(v),
    );
});

test("egressRelayMaxBytes reaches the inline sidecar config as limits.relayMaxBytes; unset leaves no limits", async (t) => {
  t.mock.method(console, "warn", () => {});
  const config = async (relayMaxBytes?: number) => {
    const calls: string[][] = [];
    await new NetSandbox({ mounts: stubMounts(), exec: fakeExec(calls, {}), ...(relayMaxBytes ? { egressRelayMaxBytes: relayMaxBytes } : {}) }).start(
      spec,
      "k-cap",
    );
    const env = sidecarRun(calls)!.find((a) => a.startsWith("EGRESS_CONFIG_JSON="))!;
    return JSON.parse(env.slice("EGRESS_CONFIG_JSON=".length)) as Record<string, unknown>;
  };
  assert.deepEqual((await config(1_048_576)).limits, { relayMaxBytes: 1_048_576 });
  assert.equal("limits" in (await config()), false);
});

test("egressRelayMaxBytes reaches the audited-public spool config", {
  skip: process.getuid?.() === 0 && "public spool requires an unprivileged host uid",
}, async (t) => {
  t.mock.method(console, "warn", () => {});
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-relay-cap-")));
  mkdirSync(join(root, "work"));
  try {
    const calls: string[][] = [];
    const sb = new NetSandbox({
      mounts: stubMounts(() => join(root, "work")),
      egressAuditRoot: join(root, "audit"),
      egressRelayMaxBytes: 4096,
      hostAddresses: () => [],
      exec: fakeExec(calls, {}),
    });
    const h = await sb.start({ ...spec, egress: { allow: [], relay: [], auditedPublic: { host: "captured-host", generation: 1 } } }, "k-cap-public");
    assert.ok(!sidecarRun(calls)!.some((a) => a.startsWith("EGRESS_CONFIG_JSON=")), "spool path, not inline");
    const written = JSON.parse(readFileSync(join(root, "audit", h.id, "config", "config.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(written.limits, { relayMaxBytes: 4096 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
