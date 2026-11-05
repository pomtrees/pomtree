import assert from "node:assert/strict";
import { test } from "node:test";
import { IMAGE_REBUILD_ACTION, type SandboxSpec } from "@pomtree/core";
import { buildEgressProxyArgs, EGRESS_PROXY_PATH } from "@pomtree/sandbox-docker";
import { checkEgressImage, imageCheckVerdict, probeArgs } from "./image-check.ts";
import type { ExecFn } from "./image-check.ts";

const run =
  (code: number | null, stderr = ""): ExecFn =>
  async () => ({ code, stderr });

test("imageCheckVerdict: absent proxy refuses with the exact text; present is ok; undetermined is unknown", () => {
  assert.deepEqual(imageCheckVerdict({ image: "img:1", revision: "abc1234", proxyPresent: false }), {
    refuse:
      "agent image img:1 (revision abc1234) has no egress proxy; every agent spawn would fail at sidecar start; rebuild the agent image from the current checkout (scripts/pomtree-up --rebuild), then restart pomtreed.",
  });
  assert.match((imageCheckVerdict({ image: "img:1", revision: undefined, proxyPresent: false }) as { refuse: string }).refuse, /\(revision unknown\)/);
  assert.deepEqual(imageCheckVerdict({ image: "img:1", revision: "abc", proxyPresent: true }), { ok: true });
  assert.ok("unknown" in imageCheckVerdict({ image: "img:1", revision: "abc", proxyPresent: undefined }));
});

test("the probe never pulls, runs with no network, no capabilities and a read-only root, and checks the exact proxy path", () => {
  assert.deepEqual(probeArgs("img:1"), [
    "run",
    "--rm",
    "--pull",
    "never",
    "--network",
    "none",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--entrypoint",
    "node",
    "img:1",
    "-e",
    "process.exit(require('node:fs').existsSync('/opt/pomtree/egress/proxy.ts')?0:3)",
  ]);
});

test("the boot probe checks the very path the egress sidecar runs (one EGRESS_PROXY_PATH, from sandbox-docker)", () => {
  const spec = { image: "i", env: {}, mounts: [], egress: { allow: [] } } as unknown as SandboxSpec;
  const sidecar = buildEgressProxyArgs("sb-1", spec, { network: "n", uid: 1000, image: "img:1", hostAddresses: [], config: {} } as never);
  assert.equal(sidecar.at(-1), EGRESS_PROXY_PATH);
  assert.ok(
    probeArgs("img:1")
      .at(-1)!
      .includes(`existsSync('${sidecar.at(-1)}')`),
  );
  assert.ok((imageCheckVerdict({ image: "i", revision: "r", proxyPresent: false }) as { refuse: string }).refuse.endsWith(`; ${IMAGE_REBUILD_ACTION}.`));
});

test("checkEgressImage: exit 3 refuses and exits 1 with the boot prefix; exit 0 passes quietly", async () => {
  const lines: string[] = [];
  let exited: number | undefined;
  const io = {
    log: (l: string) => lines.push(l),
    exit: ((c: number) => {
      exited = c;
    }) as never,
    revision: () => "abc1234",
  };
  const seen: string[][] = [];
  const v = await checkEgressImage("img:1", { ...io, exec: async (f, a) => (seen.push([f, ...a]), { code: 3, stderr: "" }) });
  assert.ok("refuse" in v);
  assert.equal(exited, 1);
  assert.match(
    lines[0]!,
    /^pomtreed: refusing to start: agent image img:1 \(revision abc1234\) has no egress proxy; .*\(scripts\/pomtree-up --rebuild\), then restart pomtreed\.$/,
  );
  assert.equal(seen[0]![0], "docker");
  lines.length = 0;
  exited = undefined;
  assert.deepEqual(await checkEgressImage("img:1", { ...io, exec: run(0) }), { ok: true });
  assert.deepEqual([lines, exited], [[], undefined]);
});

test("negative control: docker failures (missing image, unreachable daemon, timeout) are unknown, log one line, and never refuse", async () => {
  for (const r of [run(125, "Unable to find image"), run(1, "Cannot connect to the Docker daemon"), run(null, "timed out")]) {
    const lines: string[] = [];
    let exited: number | undefined;
    const v = await checkEgressImage("img:1", {
      exec: r,
      log: (l) => lines.push(l),
      exit: ((c: number) => {
        exited = c;
      }) as never,
      revision: () => undefined,
    });
    assert.ok("unknown" in v);
    assert.equal(exited, undefined);
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0]!, /refusing to start/);
  }
});
