import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxSpec } from "@pomtree/core";
import { readFileSync } from "node:fs";
import {
  buildRunArgs,
  chromiumSeccompProfile,
  CODE_DOCKER_SHAPE,
  DEFAULT_PIDS_LIMIT,
  DISK_QUOTA_UNSUPPORTED,
  parseDockerShape,
  runEnv,
  stopTimeoutSeconds,
} from "./args.ts";
import { DOCKER_PROFILE } from "./engine-profile.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

const spec: SandboxSpec = {
  agent: "ag1",
  image: "alpine@sha256:abc",
  env: { A: "1" },
  mounts: [wsMount("/work")],
  cmd: ["echo", "hi"],
};

// Mirrors DockerSandbox.start: resolve every spec mount through the provider, then build argv.
async function build(s: SandboxSpec, opts: { pidsLimit?: number } = {}): Promise<string[]> {
  const provider = stubMounts("/h");
  const mounts = await Promise.all(s.mounts.map((m) => provider.resolve(s.agent, m)));
  return buildRunArgs("i", s, { ...opts, mounts });
}

test("hardened defaults and labels", async () => {
  const a = await build(spec);
  for (const f of ["--cap-drop=ALL", "no-new-privileges", "pomtree=1", "pomtree.sandbox=i", "pomtree.agent=ag1", "1000:1000", "A"]) assert.ok(a.includes(f), f);
  assert.ok(a.includes("--init"));
  assert.ok(a.includes("--read-only") && a.includes("--tmpfs"));
  assert.ok(a.includes("--log-opt") && a.includes("max-size=10m") && a.includes("max-file=3"));
  assert.ok(a.includes("--memory") && a.includes("--memory-swap") && a.includes("--cpus") && a.includes("--stop-timeout"));
  // The workspace is a --mount (not -v) so a colon in a path cannot be misread as a separator.
  assert.ok(a.includes("type=bind,source=/h,target=/work"));
  assert.ok(!a.includes("/h:/work"));
  // `--` separates options from the image so an image beginning with `-` is not read as an option.
  assert.deepEqual(a.slice(-4), ["--", "alpine@sha256:abc", "echo", "hi"]);
});

const codeSpec: SandboxSpec = {
  agent: "ag1",
  image: "img@sha256:abc",
  env: { A: "1" },
  mounts: [
    wsMount("/work"),
    { kind: "session", agent: "ag1", containerPath: "/home/node/.pi/agent" },
    { kind: "bind", hostPath: "/ro", containerPath: "/ro", readOnly: true },
  ],
  cmd: ["pi"],
};

const codeHead = [
  "run",
  "-d",
  "--name",
  "pomtree-i",
  "--label",
  "pomtree=1",
  "--label",
  "pomtree.sandbox=i",
  "--label",
  "pomtree.agent=ag1",
  "--user",
  "1000:1000",
];
const codeBody = [
  "--cap-drop=ALL",
  "--security-opt",
  "no-new-privileges",
  "--init",
  "--pids-limit",
  "512",
  "--stop-timeout",
  "10",
  "--log-opt",
  "max-size=10m",
  "--log-opt",
  "max-file=3",
  "--memory",
  "2147483648",
  "--memory-swap",
  "2147483648",
  "--cpus",
  "2",
  "--read-only",
  "--tmpfs",
  "/tmp",
  "--tmpfs",
  "/home/node:rw,mode=1777",
  "--mount",
  "type=bind,source=/h,target=/work",
  "-w",
  "/work",
  "--mount",
  "type=bind,source=/host/session/ag1,target=/home/node/.pi/agent",
  "--mount",
  "type=bind,source=/ro,target=/ro,readonly",
  "-e",
  "A",
];

test("snapshot: code template argv without egress", async () => {
  assert.deepEqual(await build(codeSpec), [...codeHead, "--add-host", "host.docker.internal:host-gateway", ...codeBody, "--", "img@sha256:abc", "pi"]);
});

test("snapshot: code template argv with egress", async () => {
  const proxy = "http://127.0.0.1:3128";
  assert.deepEqual(await build({ ...codeSpec, egress: { allow: [{ host: "pypi.org" }] } }), [
    ...codeHead,
    "--network",
    "none",
    "--mount",
    "type=volume,source=pomtree-egress-socket-i,target=/run/pomtree-egress,readonly",
    ...codeBody,
    "-e",
    `HTTP_PROXY=${proxy}`,
    "-e",
    `HTTPS_PROXY=${proxy}`,
    "-e",
    `http_proxy=${proxy}`,
    "-e",
    `https_proxy=${proxy}`,
    "-e",
    "NODE_USE_ENV_PROXY=1",
    "-e",
    "NO_PROXY=localhost,127.0.0.1,::1",
    "-e",
    "no_proxy=localhost,127.0.0.1,::1",
    "--",
    "img@sha256:abc",
    "pi",
  ]);
});

test("pids limit defaults to 512 and is overridable", async () => {
  const a = await build(spec);
  assert.equal(a[a.indexOf("--pids-limit") + 1], String(DEFAULT_PIDS_LIMIT));
  assert.equal(DEFAULT_PIDS_LIMIT, 512);
  const over = await build(spec, { pidsLimit: 1234 });
  assert.equal(over[over.indexOf("--pids-limit") + 1], "1234");
});

test("explicit limits drive --memory/--memory-swap/--cpus; swap equals memory (no swap)", async () => {
  const a = await build({ ...spec, resources: { memoryBytes: 5, cpus: 1 } });
  assert.equal(a[a.indexOf("--memory") + 1], "5");
  assert.equal(a[a.indexOf("--memory-swap") + 1], "5");
  assert.equal(a[a.indexOf("--cpus") + 1], "1");
});

test("--shm-size appears only when resources.shmBytes is set", async () => {
  assert.ok(!(await build(spec)).some((x) => x.startsWith("--shm-size")));
  assert.ok(!(await build({ ...spec, resources: { cpus: 1 } })).some((x) => x.startsWith("--shm-size")));
  assert.ok((await build({ ...spec, resources: { shmBytes: 1048576 } })).includes("--shm-size=1048576"));
});

test("diskBytes fails closed because Docker rootfs limits cannot constrain writable bind mounts", async () => {
  await assert.rejects(build({ ...spec, resources: { diskBytes: 1 } }), new RegExp(DISK_QUOTA_UNSUPPORTED));
  // A read-only rootfs does not change this: the workspace remains a writable bind mount.
  await assert.rejects(build({ ...spec, resources: { diskBytes: 1 }, runtime: { readOnlyRootfs: true } }), new RegExp(DISK_QUOTA_UNSUPPORTED));
});

test("unrealized accelerators fail the start instead of being ignored", async () => {
  await assert.rejects(build({ ...spec, resources: { accelerators: ["gpu"] } }), /accelerators/);
});

test("stopTimeoutSeconds clamps the grace to at least one second", () => {
  assert.equal(stopTimeoutSeconds(0), 1);
  assert.equal(stopTimeoutSeconds(500), 1);
  assert.equal(stopTimeoutSeconds(1000), 1);
  assert.equal(stopTimeoutSeconds(1500), 2);
  assert.equal(stopTimeoutSeconds(10001), 11);
});

test("host.docker.internal resolves via host-gateway", async () => {
  const a = await build(spec);
  assert.equal(a[a.indexOf("--add-host") + 1], "host.docker.internal:host-gateway");
});

test("bind and session mounts use --mount (read-only supported); scratch resolves to --tmpfs with optional size", async () => {
  const a = await build({
    ...spec,
    mounts: [
      wsMount("/work"),
      { kind: "bind", hostPath: "/s.sock", containerPath: "/run/pomtree.sock" },
      { kind: "bind", hostPath: "/ro", containerPath: "/ro", readOnly: true },
      { kind: "session", agent: "ag1", containerPath: "/sess", readOnly: true },
      { kind: "scratch", containerPath: "/scratch" },
      { kind: "scratch", containerPath: "/big", sizeBytes: 1024 },
    ],
  });
  assert.ok(a.includes("type=bind,source=/s.sock,target=/run/pomtree.sock"));
  assert.ok(a.includes("type=bind,source=/ro,target=/ro,readonly"));
  assert.ok(a.includes("type=bind,source=/host/session/ag1,target=/sess,readonly"));
  assert.ok(a.some((x, i) => x === "/scratch" && a[i - 1] === "--tmpfs"));
  assert.ok(a.some((x, i) => x === "/big:size=1024" && a[i - 1] === "--tmpfs"));
});

test("exactly one workspace mount is required; errors name kind/path, not host paths", async () => {
  await assert.rejects(build({ ...spec, mounts: [] }), /exactly one workspace mount \(found 0\)/);
  await assert.rejects(build({ ...spec, mounts: [wsMount("/a"), wsMount("/b")] }), /found 2/);
  assert.throws(
    () => buildRunArgs("i", { ...spec, mounts: [wsMount("/w")] }, { mounts: [{ type: "tmpfs", containerPath: "/w" }] }),
    (e: Error) => /workspace mount at \/w must resolve to a bind/.test(e.message) && !e.message.includes("/secret"),
  );
});

test("an image starting with `-` is separated from options by `--`", async () => {
  const a = await build({ ...spec, image: "-weird/image" });
  assert.deepEqual(a.slice(-4), ["--", "-weird/image", "echo", "hi"]);
});

test("env values never appear in argv; they travel via the client environment", async () => {
  const s = { ...spec, env: { POMTREE_TOKEN: "s3cret-token", POMTREE_AGENT_ID: "a1" } };
  const a = await build(s);
  assert.ok(!a.some((x) => x.includes("s3cret-token") || x.includes("=a1")));
  assert.ok(a.some((x, i) => x === "POMTREE_TOKEN" && a[i - 1] === "-e"));
  assert.deepEqual(runEnv(s), { POMTREE_TOKEN: "s3cret-token", POMTREE_AGENT_ID: "a1" });
});

test("runEnv rejects invalid names and names that would alter the docker client", () => {
  assert.throws(() => runEnv({ ...spec, env: { "A=B": "x" } }), /invalid/);
  assert.throws(() => runEnv({ ...spec, env: { DOCKER_HOST: "tcp://evil" } }), /collides/);
  assert.throws(() => runEnv({ ...spec, env: { PATH: "/tmp" } }), /collides/);
});

test("egress drops host gateway and Docker networking, with read-only socket membership and local proxy env", async () => {
  const a = await build({ ...spec, egress: { allow: [{ host: "pypi.org" }] } });
  assert.ok(!a.includes("--add-host"));
  assert.equal(a[a.indexOf("--network") + 1], "none");
  assert.ok(a.includes("type=volume,source=pomtree-egress-socket-i,target=/run/pomtree-egress,readonly"));
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert.ok(a.includes(`${key}=http://127.0.0.1:3128`));
});

test("config dir mounts read-write under the home tmpfs, with a nested read-only settings file after it", async () => {
  const a = await build({
    ...spec,
    mounts: [
      wsMount("/work"),
      { kind: "bind", hostPath: "/s/pi", containerPath: "/home/node/.pi/agent" },
      { kind: "bind", hostPath: "/s/pi/settings.json", containerPath: "/home/node/.pi/agent/settings.json", readOnly: true },
    ],
  });
  assert.ok(a.includes("/home/node:rw,mode=1777"));
  const dir = a.indexOf("type=bind,source=/s/pi,target=/home/node/.pi/agent");
  const file = a.indexOf("type=bind,source=/s/pi/settings.json,target=/home/node/.pi/agent/settings.json,readonly");
  assert.ok(dir > 0 && file > dir);
});

test("parseDockerShape: undefined is the code shape; runtime overlays it; unknown keys and wrong types are rejected", () => {
  assert.deepEqual(parseDockerShape(undefined), CODE_DOCKER_SHAPE);
  const s = parseDockerShape({ init: false, tmpfs: ["/tmp"] });
  assert.equal(s.init, false);
  assert.deepEqual(s.tmpfs, ["/tmp"]);
  assert.equal(s.user, "1000:1000");
  assert.throws(() => parseDockerShape({ privileged: true }), /unknown docker runtime key: privileged/);
  assert.throws(() => parseDockerShape({ init: "yes" }), /invalid docker runtime value for init/);
  assert.throws(() => parseDockerShape({ pidsLimit: 0 }), /pidsLimit/);
  assert.throws(() => parseDockerShape({ tmpfs: [1] }), /tmpfs/);
});

test("spec.runtime changes the argv; a bad runtime key rejects the build", async () => {
  const a = await build({ ...spec, runtime: { tmpfs: [], init: false, addHostGateway: false } });
  assert.ok(a.includes("--read-only") && !a.includes("--tmpfs") && !a.includes("--init") && !a.includes("--add-host"));
  await assert.rejects(build({ ...spec, runtime: { bogus: 1 } }), /unknown docker runtime key: bogus/);
});

const securityOpts = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "--security-opt" ? [a] : []));

test("the Chromium seccomp profile is applied only to browser-capable workers, beside the unchanged hardening", async () => {
  const plain = await build(spec);
  assert.deepEqual(securityOpts(plain), ["no-new-privileges"]);
  assert.equal(
    plain.some((a) => a.includes("seccomp")),
    false,
  );
  for (const env of [{ PTREE_BROWSER: "0" }, { PTREE_BROWSER: "true" }, { OTHER: "1" }] as Record<string, string>[])
    assert.equal(
      (await build({ ...spec, env })).some((a) => a.includes("seccomp")),
      false,
      JSON.stringify(env),
    );
  const browser = await build({ ...spec, env: { PTREE_BROWSER: "1" } });
  assert.deepEqual(securityOpts(browser), ["no-new-privileges", `seccomp=${chromiumSeccompProfile()}`]);
  assert.ok(browser.includes("--cap-drop=ALL"));
  assert.equal(browser.includes("--privileged"), false);
  assert.equal(
    browser.some((a) => a.startsWith("--cap-add")),
    false,
  );
  assert.equal(
    browser.some((a) => a.includes("seccomp=unconfined")),
    false,
  );
  // Only the seccomp option differs from a worker whose env merely names the variable with another value.
  const off = await build({ ...spec, env: { PTREE_BROWSER: "0" } });
  const at = browser.findIndex((a) => a.startsWith("seccomp="));
  assert.deepEqual([...browser.slice(0, at - 1), ...browser.slice(at + 1)], off);
});

test("chromium.json is Docker's default profile plus exactly the narrow user-namespace additions", () => {
  const profile = JSON.parse(readFileSync(chromiumSeccompProfile(), "utf8")) as {
    defaultAction: string;
    syscalls: {
      names: string[];
      action: string;
      args?: { index: number; value: number; op: string }[];
      includes?: unknown;
      excludes?: unknown;
      errnoRet?: number;
    }[];
  };
  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
  const NS = { NEWNS: 0x20000, NEWCGROUP: 0x2000000, NEWUTS: 0x4000000, NEWIPC: 0x8000000, NEWUSER: 0x10000000, NEWPID: 0x20000000, NEWNET: 0x40000000 };
  const clone = profile.syscalls.find((r) => r.names.length === 1 && r.names[0] === "clone" && r.args?.[0]?.index === 0)!;
  const mask = clone.args![0]!.value;
  for (const f of ["NEWUSER", "NEWPID", "NEWNET"] as const) assert.equal(mask & NS[f], 0, `clone may pass ${f}`);
  for (const f of ["NEWNS", "NEWCGROUP", "NEWUTS", "NEWIPC"] as const) assert.equal(mask & NS[f], NS[f], `clone still denies ${f}`);
  const unshare = profile.syscalls.find((r) => r.names.join() === "unshare" && r.action === "SCMP_ACT_ALLOW")!;
  assert.equal(unshare.includes, undefined);
  assert.equal(unshare.args![0]!.op, "SCMP_CMP_MASKED_EQ");
  assert.equal((unshare.args![0]!.value & NS.NEWUSER) >>> 0, 0, "unshare may pass only CLONE_NEWUSER");
  assert.equal((unshare.args![0]!.value & 0xefffffff) >>> 0, 0xefffffff, "every other unshare flag stays denied");
  assert.ok(profile.syscalls.some((r) => r.names.join() === "chroot" && r.action === "SCMP_ACT_ALLOW" && !r.includes && !r.args));
  // No blanket allows: clone3 keeps the default ENOSYS, and setns, mount and pivot_root stay capability-gated.
  assert.ok(profile.syscalls.some((r) => r.names.join() === "clone3" && r.action === "SCMP_ACT_ERRNO" && r.errnoRet === 38));
  const ungated = profile.syscalls.filter((r) => r.action === "SCMP_ACT_ALLOW" && !r.includes && !r.args).flatMap((r) => r.names);
  for (const name of ["clone3", "setns", "mount", "pivot_root", "ptrace", "bpf", "keyctl"]) assert.equal(ungated.includes(name), false, name);
});

test("the docker engine profile renders the same argv as no profile (golden snapshots hold for both)", async () => {
  const provider = stubMounts("/h");
  for (const s of [codeSpec, { ...codeSpec, egress: { allow: [{ host: "pypi.org" }] } }]) {
    const mounts = await Promise.all(s.mounts.map((m) => provider.resolve(s.agent, m)));
    assert.deepEqual(buildRunArgs("i", s, { mounts }, DOCKER_PROFILE), buildRunArgs("i", s, { mounts }));
  }
});
