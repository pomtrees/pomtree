// Egress orphan reclaim scope: the boot-time egress orphan sweep removes only sidecars and socket volumes stamped with this
// daemon's owner (store_id, not a newer daemon_epoch) whose sandbox is gone and whose start is not in flight. All of it runs over
// one fake Docker engine shared by two DockerSandbox instances (two daemons on one host); no Docker daemon is contacted.
import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxOwner } from "@pomtree/core";
import type { Exec } from "./docker.ts";
import { egressProxyName, egressSocketVolumeName } from "./egress.ts";
import { NetSandbox } from "./test-network.ts";
import { PODMAN_PROFILE } from "./engine-profile.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

const egressSpec = { host: "host-test", generation: 0, agent: "ag", image: "i", env: {}, mounts: [wsMount("/w")], egress: { allow: [{ host: "pypi.org" }] } };

// One host's Docker state: containers and volumes by name with their labels. `ps`/`volume ls` honour `--filter label=k=v` and
// render `{{.Label "k"}}` formats, so the adapter's own queries decide what it sees. `gate` holds a sidecar's readiness probe
// (the `docker exec` in startEgress) open, which keeps that start in flight. Like Docker, a container records the named volumes it
// mounts and `volume rm` refuses a volume any existing container (running or exited) mounts; `stop`/`kill`/`exit` mark a container
// exited, which readState's inspect line and `wait` report. Removing a missing container or volume fails as Docker's does, and
// `refuse(command, message)` makes one exact command fail with a daemon error.
function fakeEngine() {
  const containers = new Map<string, Record<string, string>>();
  const volumes = new Map<string, Record<string, string>>();
  const mounts = new Map<string, string[]>();
  const exited = new Map<string, number>();
  const removed: string[] = [];
  const refused = new Map<string, string>();
  let gate: Promise<void> | undefined;
  const volumesOf = (args: string[]) =>
    args.flatMap((a, i) => (a === "--mount" && args[i + 1]!.startsWith("type=volume,") ? [/source=([^,]+)/.exec(args[i + 1]!)![1]!] : []));
  const exit = (nm: string, code: number) => {
    if (!containers.has(nm)) throw new Error(`Error response from daemon: No such container: ${nm}`);
    if (!exited.has(nm)) exited.set(nm, code);
  };
  const labelsOf = (args: string[]) => {
    const labels: Record<string, string> = {};
    args.forEach((a, i) => {
      if (a === "--label") {
        const [k, ...v] = args[i + 1]!.split("=");
        labels[k!] = v.join("=");
      }
    });
    return labels;
  };
  const query = (pool: Map<string, Record<string, string>>, args: string[]) => {
    const filters = args.flatMap((a, i) => (a === "--filter" && args[i + 1]!.startsWith("label=") ? [args[i + 1]!.slice(6)] : []));
    const fmt = args[args.indexOf("--format") + 1];
    const rows: string[] = [];
    for (const [nm, labels] of pool) {
      if (!filters.every((f) => labels[f.split("=")[0]!] === f.split("=").slice(1).join("="))) continue;
      rows.push(args.includes("-aq") ? nm : fmt!.replace(/\{\{\.Label "([^"]+)"\}\}/g, (_, k: string) => labels[k] ?? ""));
    }
    return rows.join("\n");
  };
  const exec: Exec = async (args) => {
    const refusal = refused.get(args.join(" "));
    if (refusal !== undefined) throw new Error(`Error response from daemon: ${refusal}`);
    if (args[0] === "inspect") {
      const labels = containers.get(args.at(-1)!);
      if (!labels) throw new Error("No such object");
      // list() reads id, agent, label map and image; readState reads the state line.
      const code = exited.get(args.at(-1)!);
      return args[1] === "--format"
        ? `${labels["pomtree.sandbox"]}\t${labels["pomtree.agent"]}\t${JSON.stringify(labels)}\t`
        : `${code === undefined} ${code ?? 0} false none`;
    }
    if (args[0] === "ps") return query(containers, args);
    if (args[0] === "volume" && args[1] === "ls") return query(volumes, args);
    if (args[0] === "volume" && args[1] === "create") volumes.set(args.at(-1)!, labelsOf(args));
    if (args[0] === "volume" && args[1] === "rm") {
      const users = [...mounts].filter(([, vs]) => vs.includes(args[2]!)).map(([c]) => c);
      if (users.length) throw new Error(`Error response from daemon: remove ${args[2]}: volume is in use - [${users.join(", ")}]`);
      if (!volumes.delete(args[2]!)) throw new Error(`Error response from daemon: get ${args[2]}: no such volume`);
      removed.push(args[2]!);
    }
    if (args[0] === "run") {
      const nm = args[args.indexOf("--name") + 1]!;
      containers.set(nm, labelsOf(args));
      mounts.set(nm, volumesOf(args));
    }
    if (args[0] === "rm") {
      if (!containers.delete(args.at(-1)!)) throw new Error(`Error response from daemon: No such container: ${args.at(-1)}`);
      mounts.delete(args.at(-1)!);
      exited.delete(args.at(-1)!);
      removed.push(args.at(-1)!);
    }
    if (args[0] === "stop" || args[0] === "kill") exit(args.at(-1)!, args[0] === "kill" ? 137 : 143);
    if (args[0] === "wait") {
      if (!containers.has(args.at(-1)!)) throw new Error(`Error response from daemon: No such container: ${args.at(-1)}`);
      return String(exited.get(args.at(-1)!) ?? 0);
    }
    if (args[0] === "exec" && gate) await gate;
    return "";
  };
  return {
    exec,
    containers,
    volumes,
    removed,
    exit,
    refuse(command: string[], message: string) {
      refused.set(command.join(" "), message);
    },
    hold() {
      let release!: () => void;
      gate = new Promise((r) => {
        release = r;
      });
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

const daemon = (engine: ReturnType<typeof fakeEngine>, warn?: (message: string) => void) =>
  new NetSandbox({ mounts: stubMounts(), exec: engine.exec, ...(warn ? { warn } : {}) });
const ownerLabels = (storeId: string, epoch: string) => ({ store_id: storeId, daemon_epoch: epoch });
const own = (storeId: string, epoch: string): SandboxOwner => ({ host: "host-1", storeId, epoch: Number(epoch) });

// A sidecar + socket volume left behind with no worker container, as a crash between startEgress and `docker run` leaves them.
function strand(engine: ReturnType<typeof fakeEngine>, id: string, labels: Record<string, string>) {
  engine.containers.set(egressProxyName(id), { "pomtree.sandbox": id, "pomtree.egress": "1", ...labels });
  engine.volumes.set(egressSocketVolumeName(id), { "pomtree.sandbox": id, "pomtree.egress": "1", ...labels });
}

test("egress reclaim: sidecar and socket volume carry the spawning daemon's store_id and daemon_epoch", async () => {
  const engine = fakeEngine();
  const h = await daemon(engine).start({ ...egressSpec, labels: ownerLabels("s-A", "100") }, "k-stamp");
  assert.equal(engine.containers.get(egressProxyName(h.id))?.store_id, "s-A");
  assert.equal(engine.containers.get(egressProxyName(h.id))?.daemon_epoch, "100");
  assert.deepEqual(
    { store_id: engine.volumes.get(egressSocketVolumeName(h.id))?.store_id, daemon_epoch: engine.volumes.get(egressSocketVolumeName(h.id))?.daemon_epoch },
    ownerLabels("s-A", "100"),
  );
});

test("egress reclaim: a booting daemon leaves another daemon's in-flight sidecar and socket volume", async () => {
  const engine = fakeEngine();
  const release = engine.hold();
  const a = daemon(engine);
  const starting = a.start({ ...egressSpec, labels: ownerLabels("s-A", "100") }, "k-inflight-foreign");
  // Wait until A's sidecar exists and its readiness probe is held: no worker container exists yet.
  while (![...engine.containers.keys()].some((n) => n.startsWith("pomtree-egress-proxy-"))) await new Promise((r) => setImmediate(r));
  assert.deepEqual(await daemon(engine).reclaim(own("s-B", "200")), []);
  assert.deepEqual(engine.removed, []);
  release();
  const h = await starting;
  assert.ok(engine.containers.has(egressProxyName(h.id)) && engine.volumes.has(egressSocketVolumeName(h.id)));
});

test("egress reclaim: reclaim removes our own orphan (same store, older epoch) and returns its id", async () => {
  const engine = fakeEngine();
  strand(engine, "sb-orphan", ownerLabels("s-A", "50"));
  assert.deepEqual(await daemon(engine).reclaim(own("s-A", "100")), ["sb-orphan"]);
  assert.deepEqual(engine.removed.sort(), [egressProxyName("sb-orphan"), egressSocketVolumeName("sb-orphan")].sort());
});

test("egress reclaim: reclaim leaves a foreign store's stranded sidecar", async () => {
  const engine = fakeEngine();
  strand(engine, "sb-foreign", ownerLabels("s-B", "50"));
  assert.deepEqual(await daemon(engine).reclaim(own("s-A", "100")), []);
  assert.deepEqual(engine.removed, []);
});

test("egress reclaim: reclaim leaves a newer epoch's sidecar on our own store (a newer daemon owns it)", async () => {
  const engine = fakeEngine();
  strand(engine, "sb-newer", ownerLabels("s-A", "200"));
  assert.deepEqual(await daemon(engine).reclaim(own("s-A", "100")), []);
  assert.deepEqual(engine.removed, []);
});

test("egress reclaim: reclaim leaves an in-flight start of this same instance", async () => {
  const engine = fakeEngine();
  const release = engine.hold();
  const a = daemon(engine);
  const starting = a.start({ ...egressSpec, labels: ownerLabels("s-A", "100") }, "k-inflight-own");
  while (![...engine.containers.keys()].some((n) => n.startsWith("pomtree-egress-proxy-"))) await new Promise((r) => setImmediate(r));
  assert.deepEqual(await a.reclaim(own("s-A", "100")), []);
  release();
  await starting;
  assert.deepEqual(engine.removed, []);
});

test("egress reclaim: reclaim leaves an unlabeled sidecar (pre-owner-label or not pomtreed's): it is not ours", async () => {
  const engine = fakeEngine();
  strand(engine, "sb-unlabeled", {});
  strand(engine, "sb-epoch-only", { daemon_epoch: "50" });
  assert.deepEqual(await daemon(engine).reclaim(own("s-A", "100")), []);
  assert.deepEqual(engine.removed, []);
});

test("egress reclaim: the owner passed to reclaim decides what is reclaimed", async () => {
  const engine = fakeEngine();
  strand(engine, "sb-orphan", ownerLabels("s-A", "50"));
  // Negative: an owner of another store finds nothing.
  assert.deepEqual(await daemon(engine).reclaim(own("s-B", "100")), []);
  assert.deepEqual(engine.removed, []);
  assert.deepEqual(await daemon(engine).reclaim(own("s-A", "100")), ["sb-orphan"]);
  assert.deepEqual(engine.removed.sort(), [egressProxyName("sb-orphan"), egressSocketVolumeName("sb-orphan")].sort());
});

test("egress reclaim: negative control: our orphan beside a live sandbox and foreign leftovers, only the orphan goes", async () => {
  const engine = fakeEngine();
  strand(engine, "sb-orphan", ownerLabels("s-A", "50"));
  strand(engine, "sb-live", ownerLabels("s-A", "50"));
  engine.containers.set("pomtree-sb-live", { pomtree: "1", "pomtree.sandbox": "sb-live", "pomtree.agent": "ag", ...ownerLabels("s-A", "50") });
  strand(engine, "sb-foreign", ownerLabels("s-B", "50"));
  strand(engine, "sb-unlabeled", {});
  assert.deepEqual(await daemon(engine).reclaim(own("s-A", "100")), ["sb-orphan"]);
  assert.deepEqual(engine.removed.sort(), [egressProxyName("sb-orphan"), egressSocketVolumeName("sb-orphan")].sort());
  assert.ok(engine.containers.has(egressProxyName("sb-live")) && engine.containers.has(egressProxyName("sb-foreign")));
});

// ---- REC-8: egress resources across a daemon restart (the sidecar and socket volume a previous epoch created) ----
// Each case ends with no container and no volume left; the fake refuses `volume rm` while any container mounts the volume.

const worker = (id: string) => `pomtree-${id}`;
const startUnder = (engine: ReturnType<typeof fakeEngine>, storeId: string, epoch: string, key: string) =>
  daemon(engine).start({ ...egressSpec, labels: ownerLabels(storeId, epoch) }, key);
const assertNothingLeft = (engine: ReturnType<typeof fakeEngine>) =>
  assert.deepEqual({ containers: [...engine.containers.keys()], volumes: [...engine.volumes.keys()] }, { containers: [], volumes: [] });

test("egress reclaim: negative control: the fake refuses to remove a socket volume a live worker still mounts", async () => {
  const engine = fakeEngine();
  const h = await startUnder(engine, "s-A", "100", "k-ctl");
  await engine.exec(["rm", "-f", egressProxyName(h.id)]);
  await assert.rejects(engine.exec(["volume", "rm", egressSocketVolumeName(h.id)]), /volume is in use - \[pomtree-/);
  assert.ok(engine.volumes.has(egressSocketVolumeName(h.id)));
});

test("egress reclaim: an agent adopted across a restart keeps its old-epoch sidecar until it ends, then its stop removes all of it", async () => {
  const engine = fakeEngine();
  const h = await startUnder(engine, "s-A", "100", "k-adopt");
  const b = daemon(engine);
  assert.deepEqual(await b.reclaim(own("s-A", "200")), [], "the adopted agent still runs: its sidecar and volume are in use, not orphans");
  assert.ok(engine.containers.has(egressProxyName(h.id)) && engine.volumes.has(egressSocketVolumeName(h.id)));
  await b.attach(h.id, "ag");
  engine.exit(worker(h.id), 0);
  await b.stop(h.id, 1000, `test-stop:${h.id}`);
  assertNothingLeft(engine);
});

test("egress reclaim: an adopted agent's settle stop racing a result-window stop and a kill still removes the old-epoch volume", async () => {
  const engine = fakeEngine();
  const h = await startUnder(engine, "s-A", "100", "k-race");
  const b = daemon(engine);
  await b.reclaim(own("s-A", "200"));
  await b.attach(h.id, "ag");
  engine.exit(worker(h.id), 0);
  await Promise.allSettled([b.stop(h.id, 1000, `test-stop-a:${h.id}`), b.stop(h.id, 1000, `test-stop-b:${h.id}`), b.kill(h.id, `test-kill:${h.id}`)]);
  assertNothingLeft(engine);
});

test("egress reclaim: an agent that exited before the restart (container not yet removed) is left by the sweep and removed by its stop", async () => {
  const engine = fakeEngine();
  const h = await startUnder(engine, "s-A", "100", "k-exited");
  engine.exit(worker(h.id), 0);
  const b = daemon(engine);
  assert.deepEqual(await b.reclaim(own("s-A", "200")), [], "an exited worker is still listed (ps -a); reconcile stops it, the sweep does not");
  await b.stop(h.id, 1000, `test-stop:${h.id}`); // reconcileSandboxes' stop of a same-host container whose record is not running
  assertNothingLeft(engine);
});

test("egress reclaim: a socket volume whose sidecar is gone (its volume rm failed, or no sidecar ever ran) is reclaimed at the next boot", async () => {
  const engine = fakeEngine();
  engine.volumes.set(egressSocketVolumeName("sb-vol"), { "pomtree.sandbox": "sb-vol", "pomtree.egress": "1", ...ownerLabels("s-A", "100") });
  assert.deepEqual(await daemon(engine).reclaim(own("s-A", "200")), ["sb-vol"]);
  assertNothingLeft(engine);
});

test("egress reclaim: a daemon that died mid-start (sidecar up, no worker) leaves an orphan the next boot reclaims", async () => {
  const engine = fakeEngine();
  engine.hold(); // never released: the starting daemon is gone
  void startUnder(engine, "s-A", "100", "k-died").catch(() => {});
  while (![...engine.containers.keys()].some((n) => n.startsWith("pomtree-egress-proxy-"))) await new Promise((r) => setImmediate(r));
  assert.equal((await daemon(engine).reclaim(own("s-A", "200"))).length, 1);
  assertNothingLeft(engine);
});

test("egress reclaim: a worker removed outside pomtreed leaves its old-epoch sidecar and volume, and the next boot reclaims both", async () => {
  const engine = fakeEngine();
  const h = await startUnder(engine, "s-A", "100", "k-external");
  await engine.exec(["rm", "-f", worker(h.id)]);
  assert.deepEqual(await daemon(engine).reclaim(own("s-A", "200")), [h.id]);
  assertNothingLeft(engine);
});

// ---- Egress cleanup failures reach the operator (cause and action), and never abort the rest of the cleanup ----

const adoptAndExit = async (engine: ReturnType<typeof fakeEngine>, key: string, warnings: string[]) => {
  const h = await startUnder(engine, "s-A", "100", key);
  const b = daemon(engine, (m) => warnings.push(m));
  await b.attach(h.id, "ag");
  engine.exit(worker(h.id), 0);
  return { id: h.id, b };
};

test("egress cleanup: a refused socket volume removal is one warning naming the volume, the error and the action; the sidecar still goes", async () => {
  const engine = fakeEngine();
  const warnings: string[] = [];
  const { id, b } = await adoptAndExit(engine, "k-warn-vol", warnings);
  const volume = egressSocketVolumeName(id);
  engine.refuse(["volume", "rm", volume], "device or resource busy");
  await b.stop(id, 1000, `test-stop:${id}`);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.ok(warnings[0]!.includes(`egress socket volume ${volume} could not be removed`), warnings[0]);
  assert.ok(warnings[0]!.includes("device or resource busy"), warnings[0]);
  assert.ok(warnings[0]!.endsWith(`the next boot's sweep reclaims it, or run docker volume rm ${volume}`), warnings[0]);
  assert.deepEqual([...engine.containers.keys()], [], "the worker and the sidecar are removed despite the volume failure");
  assert.deepEqual([...engine.volumes.keys()], [volume]);
});

test("egress cleanup: a refused sidecar removal is reported the same way, and the volume removal is still attempted", async () => {
  const engine = fakeEngine();
  const warnings: string[] = [];
  const { id, b } = await adoptAndExit(engine, "k-warn-proxy", warnings);
  const proxy = egressProxyName(id);
  engine.refuse(["rm", "-f", proxy], "removal of container is already in progress");
  await b.stop(id, 1000, `test-stop:${id}`);
  assert.equal(warnings.length, 2, JSON.stringify(warnings));
  assert.ok(warnings[0]!.includes(`egress sidecar ${proxy} could not be removed`), warnings[0]);
  assert.ok(warnings[0]!.includes("removal of container is already in progress"), warnings[0]);
  assert.ok(warnings[0]!.endsWith(`the next boot's sweep reclaims it, or run docker rm -f ${proxy}`), warnings[0]);
  // The volume removal ran after the sidecar failure: the sidecar still mounts it, so Docker refused it too.
  assert.match(warnings[1]!, new RegExp(`egress socket volume ${egressSocketVolumeName(id)} could not be removed \\(.*volume is in use`));
  assert.ok(!engine.containers.has(worker(id)));
});

test("negative: a clean egress cleanup, a repeated one and a volume-only orphan's reclaim warn nothing", async () => {
  const engine = fakeEngine();
  const warnings: string[] = [];
  const { id, b } = await adoptAndExit(engine, "k-warn-none", warnings);
  await b.stop(id, 1000, `test-stop:${id}`);
  await b.stop(id, 1000, `test-stop-again:${id}`); // already gone: "No such container" and "no such volume" are not failures
  engine.volumes.set(egressSocketVolumeName("sb-vol"), { "pomtree.sandbox": "sb-vol", "pomtree.egress": "1", ...ownerLabels("s-A", "100") });
  assert.deepEqual(await b.reclaim(own("s-A", "200")), ["sb-vol"]);
  assert.deepEqual(warnings, []);
  assertNothingLeft(engine);
});

// ---- A removal already in progress (a second killer hit the same sandbox) is success, not a failed kill ----

for (const verb of ["kill", "stop"] as const) {
  test(`removal race: ${verb} resolves when Docker reports the worker's removal already in progress, and the egress cleanup still runs`, async () => {
    const engine = fakeEngine();
    const warnings: string[] = [];
    const h = await startUnder(engine, "s-A", "100", `k-race-${verb}`);
    const b = daemon(engine, (m) => warnings.push(m));
    await b.attach(h.id, "ag");
    engine.refuse(["rm", "-f", worker(h.id)], `removal of container ${worker(h.id)} is already in progress`);
    await (verb === "kill" ? b.kill(h.id, `test-kill:${h.id}`) : b.stop(h.id, 1000, `test-stop:${h.id}`));
    assert.ok(!engine.containers.has(egressProxyName(h.id)), "the sidecar is reclaimed after the tolerated race");
    // The fake keeps the refused worker, which still mounts the volume, so only the volume warning is expected (the real remover frees it).
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0]!, /egress socket volume .* could not be removed/);
  });
}

test("negative: a worker removal refused for any other reason (device busy) still rejects kill and stop, naming the cause", async () => {
  const engine = fakeEngine();
  const h = await startUnder(engine, "s-A", "100", "k-race-busy");
  const b = daemon(engine);
  await b.attach(h.id, "ag");
  engine.refuse(["rm", "-f", worker(h.id)], `driver "overlay2" failed to remove root filesystem: device or resource busy`);
  await assert.rejects(b.kill(h.id, `test-kill:${h.id}`), /device or resource busy/);
  await assert.rejects(b.stop(h.id, 1000, `test-stop:${h.id}`), /device or resource busy/);
});

// Podman's `volume ls` rows have no .Label method (captured on Podman 5.7.0, fixtures/engine/podman/volume-ls-format.json): the
// template fails when a volume matches and only the .Labels map renders. `ps -a` accepts .Label on both engines.
function podmanVolumeLs(engine: ReturnType<typeof fakeEngine>): Exec {
  return async (args, env) => {
    if (args[0] !== "volume" || args[1] !== "ls") return engine.exec(args, env);
    const fmt = args[args.indexOf("--format") + 1]!;
    const filters = args.flatMap((a, i) => (a === "--filter" ? [args[i + 1]!.slice(6)] : []));
    const rows = [...engine.volumes.values()].filter((l) => filters.every((f) => l[f.split("=")[0]!] === f.split("=").slice(1).join("=")));
    if (rows.length && fmt.includes("{{.Label"))
      throw new Error(
        'podman volume failed: Error: template: ls:1:13: executing "ls" at <.Label>: can\'t evaluate field Label in type *types.VolumeListReport',
      );
    return rows.map((l) => fmt.replace(/\{\{index \.Labels "([^"]+)"\}\}/g, (_, k: string) => l[k] ?? "")).join("\n");
  };
}

test("egress reclaim: on Podman the volume listing uses the .Labels template and still reclaims our orphan", async () => {
  const engine = fakeEngine();
  strand(engine, "sb-orphan", ownerLabels("s-A", "50"));
  strand(engine, "sb-foreign", ownerLabels("s-B", "50"));
  const podman = new NetSandbox({ mounts: stubMounts(), exec: podmanVolumeLs(engine), profile: PODMAN_PROFILE });
  assert.deepEqual(await podman.reclaim(own("s-A", "100")), ["sb-orphan"]);
});

test("egress reclaim: on Docker the volume listing keeps the .Label template", async () => {
  const engine = fakeEngine();
  strand(engine, "sb-orphan", ownerLabels("s-A", "50"));
  const seen: string[] = [];
  const exec: Exec = async (args, env) => {
    if (args[0] === "volume" && args[1] === "ls") seen.push(args[args.indexOf("--format") + 1]!);
    return engine.exec(args, env);
  };
  assert.deepEqual(await new NetSandbox({ mounts: stubMounts(), exec }).reclaim(own("s-A", "100")), ["sb-orphan"]);
  assert.deepEqual(seen, ['{{.Label "pomtree.sandbox"}}\t{{.Label "store_id"}}\t{{.Label "daemon_epoch"}}']);
});
