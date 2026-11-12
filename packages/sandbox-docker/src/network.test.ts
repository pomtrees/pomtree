import test from "node:test";
import assert from "node:assert/strict";
import { SandboxStartError } from "@pomtree/core";
import { DockerSandbox, type Exec } from "./docker.ts";
import {
  EGRESS_NETWORK,
  egressNetworkCreateArgs,
  egressNetworkProblems,
  EgressNetworkMismatchError,
  ensureEgressNetwork,
  removeEgressNetwork,
} from "./network.ts";
import { OK_EGRESS_NETWORK } from "./test-network.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

const NOT_FOUND = "docker network failed: Error response from daemon: network pomtree-egress not found";
const EXISTS = "docker network failed: Error response from daemon: network with name pomtree-egress already exists";
const ok = JSON.parse(OK_EGRESS_NETWORK) as Record<string, unknown>;
const variant = (patch: Record<string, unknown>) => JSON.stringify({ ...ok, ...patch });

// Scripted docker network fake: `state` is the inspect answer (undefined: missing); records every call.
function fakeNet(state: { inspect: string | undefined; createError?: string; afterCreate?: string | undefined }) {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "inspect") {
      if (state.inspect === undefined) throw new Error(NOT_FOUND);
      return state.inspect;
    }
    if (args[0] === "network" && args[1] === "create") {
      if (state.createError) {
        state.inspect = state.afterCreate;
        throw new Error(state.createError);
      }
      state.inspect = OK_EGRESS_NETWORK;
      return "netid";
    }
    if (args[0] === "network" && args[1] === "rm") return args[2]!;
    if (args[0] === "inspect") throw new Error("No such object");
    return "";
  };
  return { calls, exec };
}

test("create args: bridge driver, ICC off, egress marker and shared-role labels, stable name", () => {
  assert.deepEqual(egressNetworkCreateArgs(EGRESS_NETWORK), [
    "network",
    "create",
    "--driver",
    "bridge",
    "--opt",
    "com.docker.network.bridge.enable_icc=false",
    "--label",
    "pomtree.egress=1",
    "--label",
    "pomtree.egress.network=shared",
    "pomtree-egress",
  ]);
});

test("inspect decision: only an ours, non-internal bridge with ICC off is usable", () => {
  assert.deepEqual(egressNetworkProblems(OK_EGRESS_NETWORK), []);
  const bad: [string, string, RegExp][] = [
    ["icc on", variant({ Options: { "com.docker.network.bridge.enable_icc": "true" } }), /enable_icc is "true"/],
    ["icc unset", variant({ Options: {} }), /enable_icc is "unset"/],
    ["null options", variant({ Options: null }), /enable_icc/],
    ["internal", variant({ Internal: true }), /internal/],
    ["overlay", variant({ Driver: "overlay" }), /driver/],
    ["foreign labels", variant({ Labels: { other: "x" } }), /labels/],
    ["no labels", variant({ Labels: null }), /labels/],
    ["not json", "", /not JSON/],
    ["array", "[]", /not an object/],
  ];
  for (const [name, inspected, why] of bad) {
    const problems = egressNetworkProblems(inspected);
    assert.ok(problems.length > 0, name);
    assert.match(problems.join("; "), why, name);
  }
});

test("ensure: missing network is created once; existing correct network is reused without create", async () => {
  const missing = fakeNet({ inspect: undefined });
  assert.equal(await ensureEgressNetwork(missing.exec), "created");
  assert.deepEqual(
    missing.calls.map((c) => c[1]),
    ["inspect", "create"],
  );
  assert.equal(await ensureEgressNetwork(missing.exec), "existing");
  assert.equal(missing.calls.filter((c) => c[1] === "create").length, 1);
});

test("ensure race: a concurrent creator's 'already exists' re-inspects and accepts a correct network", async () => {
  const raced = fakeNet({ inspect: undefined, createError: EXISTS, afterCreate: OK_EGRESS_NETWORK });
  assert.equal(await ensureEgressNetwork(raced.exec), "existing");
  assert.deepEqual(
    raced.calls.map((c) => c[1]),
    ["inspect", "create", "inspect"],
  );
});

test("ensure race: the winner's network is still validated; a wrong one is a hard error", async () => {
  const raced = fakeNet({ inspect: undefined, createError: EXISTS, afterCreate: variant({ Options: {} }) });
  await assert.rejects(ensureEgressNetwork(raced.exec), EgressNetworkMismatchError);
});

test("ensure: two concurrent ensures in one process both succeed with one creation", async () => {
  // Models the engine: the first create wins, the second sees "already exists".
  let created = false;
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    await new Promise((r) => setImmediate(r));
    if (args[1] === "inspect") {
      if (!created) throw new Error(NOT_FOUND);
      return OK_EGRESS_NETWORK;
    }
    if (created) throw new Error(EXISTS);
    created = true;
    return "netid";
  };
  const results = await Promise.all([ensureEgressNetwork(exec), ensureEgressNetwork(exec)]);
  assert.deepEqual(results.sort(), ["created", "existing"]);
});

test("ensure: a same-named network with wrong options is a clearly worded error, never silently reused", async () => {
  const wrong = fakeNet({ inspect: variant({ Options: { "com.docker.network.bridge.enable_icc": "true" } }) });
  await assert.rejects(ensureEgressNetwork(wrong.exec), (e: Error) => {
    assert.ok(e instanceof EgressNetworkMismatchError);
    assert.match(e.message, /docker network pomtree-egress exists but is not a pomtree egress network/);
    assert.match(e.message, /enable_icc is "true"/);
    assert.match(e.message, /docker network rm pomtree-egress/);
    return true;
  });
  assert.ok(!wrong.calls.some((c) => c[1] === "create" || c[1] === "rm"), "neither recreated nor removed");
});

test("ensure: other create/inspect failures propagate unchanged", async () => {
  const createFails = fakeNet({ inspect: undefined, createError: "docker network failed: pool overlaps" });
  await assert.rejects(ensureEgressNetwork(createFails.exec), /pool overlaps/);
  await assert.rejects(
    ensureEgressNetwork(async () => {
      throw new Error("docker network failed: permission denied");
    }),
    /permission denied/,
  );
});

test("remove: explicit helper removes ours, refuses a foreign one, and reports an absent one", async () => {
  const ours = fakeNet({ inspect: OK_EGRESS_NETWORK });
  assert.equal(await removeEgressNetwork(ours.exec), true);
  assert.ok(ours.calls.some((c) => c[1] === "rm" && c[2] === EGRESS_NETWORK));
  const foreign = fakeNet({ inspect: variant({ Labels: {} }) });
  await assert.rejects(removeEgressNetwork(foreign.exec), EgressNetworkMismatchError);
  assert.ok(!foreign.calls.some((c) => c[1] === "rm"));
  assert.equal(await removeEgressNetwork(fakeNet({ inspect: undefined }).exec), false);
});

test("start: network is ensured before any per-sandbox resource; a wrong network fails the start with nothing created", async () => {
  const spec = { agent: "a", image: "i", env: {}, mounts: [wsMount("/w")] };
  const good = fakeNet({ inspect: undefined });
  const sb = new DockerSandbox({ mounts: stubMounts(), exec: good.exec, egressNetwork: EGRESS_NETWORK });
  const h = await sb.start(spec, "k-net-order");
  const at = (p: (c: string[]) => boolean) => good.calls.findIndex(p);
  const create = at((c) => c[0] === "network" && c[1] === "create");
  assert.ok(create !== -1 && create < at((c) => c[0] === "volume" && c[1] === "create"));
  const proxy = good.calls.find((c) => c[0] === "run" && c[3] === `pomtree-egress-proxy-${h.id}`)!;
  assert.equal(proxy[proxy.indexOf("--network") + 1], EGRESS_NETWORK);
  await sb.kill(h.id, `test-kill:${h.id}`);
  assert.equal(good.calls.filter((c) => c[0] === "network" && c[1] !== "inspect").length, 1, "kill never removes the shared network");

  const wrong = fakeNet({ inspect: variant({ Options: {} }) });
  const bad = new DockerSandbox({ mounts: stubMounts(), exec: wrong.exec });
  await assert.rejects(bad.start(spec, "k-net-wrong"), (e: Error) => e instanceof SandboxStartError && /not a pomtree egress network/.test(e.message));
  assert.ok(!wrong.calls.some((c) => c[0] === "run" || (c[0] === "volume" && c[1] === "create")), "no proxy, volume or worker");
});
