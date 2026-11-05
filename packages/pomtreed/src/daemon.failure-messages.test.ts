import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessEvent } from "@pomtree/core";
import { DOCKER_GROUP_ACTION, deadlineAction, EXIT_CAUSE_WORDING, IMAGE_REBUILD_ACTION, SandboxStartError } from "@pomtree/core";
import { classifyStartError, egressProbeFailure } from "@pomtree/sandbox-docker";
import { providerExhaustedMessage, providerStopMessage, startFailure, timedOutMessage } from "./daemon/lifecycle.ts";
import { get, kinds, setup, spawnSpec, until } from "./test-setup.ts";
import { DEADLINE_KIND } from "./watchdog.ts";

const errors = async (t: ReturnType<typeof setup>, id: string) =>
  (await t.journal.read({ agent: id })).flatMap((e) => (e.payload.kind === "error" ? [(e.payload as { message: string }).message] : []));

const providerRun = async (ev: HarnessEvent) => {
  const t = setup(async (c) => {
    c.emit(ev);
    await until(async () => (await t.daemon.get(c.agent))?.state !== "running", 1500).catch(() => {});
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  return { t, id: a.id };
};

test("providerStopMessage and providerExhaustedMessage: cause and action, clipped provider text", () => {
  const auth = providerStopMessage("auth", "401 bad key");
  assert.match(
    auth,
    /^provider auth: the model provider rejected the API key \(401 bad key\); check the key file named by POMTREED_MODEL_UPSTREAM_KEY_FILE, then respawn the agent$/,
  );
  assert.ok(providerStopMessage("auth", "x".repeat(5000)).length < 500, "the provider message is clipped");
  assert.doesNotMatch(providerStopMessage("funding"), /POMTREED_MODEL_UPSTREAM_KEY_FILE/); // negative control
  assert.equal(
    providerExhaustedMessage(3, "outage", "503"),
    "provider retries exhausted: 3 attempts failed (last: outage: 503); check the provider's status and POMTREED_MODEL_BASE_URL, then respawn the agent",
  );
});

test("an auth provider_error journals an operator error entry naming the key file; an outage does not", async () => {
  const auth = await providerRun({ kind: "provider_error", code: "auth", message: "bad key", retryable: false });
  assert.ok((await errors(auth.t, auth.id)).some((m) => /^provider auth: .*\(bad key\).*POMTREED_MODEL_UPSTREAM_KEY_FILE.*respawn/.test(m)));
  const outage = await providerRun({ kind: "provider_error", code: "outage", message: "503", retryable: true });
  assert.ok(!(await errors(outage.t, outage.id)).some((m) => /^provider (auth|retries exhausted):/.test(m)));
});

test("retries exhausted journals an error entry with the attempt count and last error; below the cap it does not", async () => {
  let aId = "";
  const t = setup(
    async (c) => {
      aId = c.agent;
      c.emit({ kind: "provider_error", code: "outage", message: "down", retryable: true } as never);
    },
    { limits: { providerBackoffMs: 5, maxProviderBackoffMs: 20, maxProviderRetries: 0 }, random: () => 0.5 },
  );
  await t.spawn();
  await until(async () => aId !== "" && kinds(await t.journal.read({ agent: aId })).includes("exited:failed"));
  assert.ok(
    (await errors(t, aId)).some((m) =>
      /^provider retries exhausted: \d+ attempts failed \(last: outage: down\); check the provider's status and POMTREED_MODEL_BASE_URL, then respawn/.test(m),
    ),
  );
  await t.orchestrator.idle();
  const below = await providerRun({ kind: "provider_error", code: "outage", message: "503", retryable: true });
  assert.ok(!(await errors(below.t, below.id)).some((m) => /retries exhausted/.test(m)), "default cap: the first outage backs off, not exhausted");
});

test("timedOutMessage names respawn with --deadline; pomtree extend is only the live-agent preventive option", () => {
  for (const s of ["running", "yielded"]) {
    const m = timedOutMessage("a-1", s, undefined);
    assert.match(
      m,
      /respawn it with a longer `--deadline` \(an operator can extend a live agent with `pomtree extend a-1 --deadline DURATION` before it fires\)$/,
    );
    assert.doesNotMatch(m, /give it more time/);
  }
  assert.equal(
    timedOutMessage("a-1", "running", 0),
    `timed out: its session deadline passed at 1970-01-01T00:00:00.000Z; ${deadlineAction("a-1")}`,
    "one term (session deadline) and the one core action sentence",
  );
  assert.match(timedOutMessage("a-1", "yielded", undefined), /^timed out: its session deadline passed while it was parked on a wait; .*`pomtree extend a-1/);
  for (const s of ["running", "yielded"]) assert.doesNotMatch(timedOutMessage("a-1", s, 0), /wall-clock/);
});

test("startFailure: a message that already names its action gets no second one; a bare docker message gets the cause's action", () => {
  const perm = startFailure(
    classifyStartError(new Error("docker run failed: permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock")),
  )!;
  assert.equal(perm.cause, "sandbox_unavailable");
  assert.ok(perm.message.endsWith(`; ${DOCKER_GROUP_ACTION}`), perm.message);
  assert.equal(perm.message.split(DOCKER_GROUP_ACTION).length, 2, "the docker-group action appears once");
  assert.ok(!perm.message.includes(EXIT_CAUSE_WORDING.sandbox_unavailable), "no contradictory 'start Docker' action");
  assert.equal(perm.engineDown, true, "a permission error holds admission like an unreachable engine (see startFailure)");
  const egress = startFailure(egressProbeFailure('{"Status":"exited","Running":false,"ExitCode":1}', "boom\n", "probe"))!;
  assert.ok(egress.message.includes(IMAGE_REBUILD_ACTION) && !egress.message.includes(EXIT_CAUSE_WORDING.start_failed), egress.message);
  // negative controls: raw docker text keeps the cause's action
  const down = startFailure(new SandboxStartError("endpoint_unreachable", "Cannot connect to the Docker daemon", true))!;
  assert.ok(down.message.endsWith(`; ${EXIT_CAUSE_WORDING.sandbox_unavailable}`));
  const unknown = startFailure(new SandboxStartError("unknown", "docker run failed: no space left", false))!;
  assert.ok(unknown.message.endsWith(`; ${EXIT_CAUSE_WORDING.start_failed}`));
});

test("a running agent's timed_out exit journals which deadline fired and the action; a clean run journals none", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  const root = await t.daemon.root();
  const a = await t.daemon.spawn(root.id, { name: "w", task: "t", idempotencyKey: "k", deadlineMs: 30 });
  await until(async () => (await get(t, a.id)).state === "running");
  clock += 30_000;
  await until(async () => ["exited", "reaped"].includes((await get(t, a.id)).state));
  assert.equal((await get(t, a.id)).exit, "timed_out");
  const msgs = (await errors(t, a.id)).filter((m) => m.startsWith("timed out:"));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0]!, /^timed out: its session deadline passed at .*`pomtree extend /);
  await t.orchestrator.idle();

  const ok = setup(async () => {});
  const b = await ok.spawn();
  await ok.orchestrator.idle();
  assert.ok(!(await errors(ok, b.id)).some((m) => m.startsWith("timed out:")));
});

test("a yielded agent past its deadline journals the session-deadline reason once, via reconcile; before the deadline it journals none", async () => {
  let clock = 10_000;
  const t = setup(async () => {}, { now: () => clock });
  const root = await t.daemon.root();
  const r = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "y",
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: "y",
  });
  const run = await t.daemon.deps.registry.transition(r.id, r.generation, "running", { idempotencyKey: "y-run" });
  await t.daemon.deps.checkpoints.write(
    {
      agent: run.id,
      generation: run.generation,
      host: "h1",
      sessionRef: await t.fakes.sessions.put(new TextEncoder().encode(`{"a":1}\n`)),
      workspace: `ws-${run.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 500,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    "y-cp",
  );
  const a = await t.daemon.deps.registry.transition(run.id, run.generation, "yielded", { idempotencyKey: "y-y" });
  await t.journal.append({ agent: a.id, host: "h1", generation: a.generation, payload: { kind: DEADLINE_KIND, at: 20_000 }, idempotencyKey: "dl" });
  await t.daemon.reconcile();
  assert.equal((await get(t, a.id)).state, "yielded", "not past the deadline yet");
  assert.deepEqual(
    (await errors(t, a.id)).filter((m) => m.startsWith("timed out:")),
    [],
  );
  clock = 30_000;
  await t.daemon.reconcile();
  assert.equal((await get(t, a.id)).exit, "timed_out");
  const msgs = (await errors(t, a.id)).filter((m) => m.startsWith("timed out:"));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0]!, /session deadline passed at 1970-01-01T00:00:20\.000Z while it was parked on a wait; .*`pomtree extend /);
  assert.equal((await errors(t, a.id)).length, 1, "finish is the single place: reconcile adds no second error entry");
});
