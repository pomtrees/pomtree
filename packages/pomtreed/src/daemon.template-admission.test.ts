// Template admission against the selected sandbox backend's declaration: a template whose egress isolation or gVisor runtime the backend
// does not declare is refused at spawn and again at start, with nothing started, instead of running with the weaker mode.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpawnSpec, Template } from "@pomtree/core";
import { DOCKER_DECLARATION, PODMAN_DECLARATION, PODMAN_PROFILE, podmanEgressInfoArgs, scriptedLocalEngine } from "@pomtree/sandbox-docker";
import { LifecycleError } from "./lifecycle.ts";
import { admitAtBoot, admitTemplateSpec, type BootProbe, bootNeeds, probeLocalBackend } from "./sandbox-backends.ts";
import { setup } from "./test-setup.ts";

const boot = bootNeeds({ origin: "builtin", localEngine: true }, false);
const admitOn =
  (declaration: typeof DOCKER_DECLARATION, probe: BootProbe | null = null) =>
  (spec: SpawnSpec) =>
    admitTemplateSpec(declaration, boot, spec, probe);
// The boot probe of a rootless Podman 5 with pasta, and of one the probe cannot accept (slirp4netns), both from scripted `podman info` answers.
const podmanInfo = (rootlessNetworkCmd: string) =>
  JSON.stringify({
    version: { Version: "5.7.0" },
    host: { security: { rootless: true }, rootlessNetworkCmd, pasta: { version: "pasta 0.0~git20260120.386b5f5-1" } },
  });
const probed = async (rootlessNetworkCmd: string) =>
  probeLocalBackend(
    PODMAN_DECLARATION,
    scriptedLocalEngine({ profile: PODMAN_PROFILE, answers: { [podmanEgressInfoArgs().join(" ")]: { stdout: podmanInfo(rootlessNetworkCmd) } } }),
  );
const withTemplates = (over: Record<string, Template>, admitSpec: (spec: SpawnSpec) => string[]) => {
  const t = setup(async () => {}, { mayUseTemplate: () => true, admitSpec });
  for (const [k, v] of Object.entries(over)) t.fakes.hooks.raw.templates.templates.set(k, v);
  return t;
};
const templates: Record<string, Template> = {
  reg: { id: "reg", egress: { kind: "registry" } },
  hosts: { id: "hosts", egress: { kind: "allowlist", hosts: ["a.example"] } },
  pub: { id: "pub", egress: { kind: "audited-public" } },
  quiet: { id: "quiet", egress: { kind: "none" } },
  gv: { id: "gv", egress: { kind: "none" }, runtime: { ociRuntime: "runsc" } },
};
const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  assert.ok(e instanceof LifecycleError, `expected a LifecycleError, got ${String(e)}`);
  assert.equal(e.status, 422);
  assert.equal(e.extra?.code, "template_error");
  return e.message;
};
const spawn = async (t: ReturnType<typeof setup>, key: string, template?: string) =>
  t.daemon.spawn((await t.daemon.root()).id, { name: "x", task: "y", idempotencyKey: key, ...(template !== undefined && { template }) });

test("an unsupported Podman (slirp4netns) refuses a template that sets egress, naming the template, the backend, the probe's cause and the action; nothing is started", async () => {
  const probe = await probed("slirp4netns");
  assert.ok(probe?.egressWithheld);
  const t = withTemplates(templates, admitOn(PODMAN_DECLARATION, probe));
  for (const [i, name] of ["reg", "hosts", "pub"].entries()) {
    const m = await refusal(spawn(t, `k${i}`, name));
    assert.equal(
      m,
      `spawn refused: template ${name} cannot run on sandbox backend podman: backend podman cannot enforce a default-deny egress allowlist (egress.allowHost withheld by the backend's readiness probe; egress.denyAll with connect is not available either); the boot probe found ${probe.egressWithheld.cause}; ${probe.egressWithheld.action}, or use a backend that enforces egress, or remove egress from the templates`,
    );
  }
  await t.orchestrator.idle();
  assert.equal(t.fakes.sandbox.started.length, 0);
});

test("a supported rootless Podman admits the egress templates and an untemplated registry spawn; the gVisor runtime block is still refused", async () => {
  const probe = await probed("pasta");
  assert.equal(probe?.egressWithheld, undefined);
  const t = withTemplates(templates, admitOn(PODMAN_DECLARATION, probe));
  for (const [i, name] of ["reg", "hosts", "pub"].entries()) assert.ok((await spawn(t, `k${i}`, name)).id);
  assert.ok((await spawn(t, "kc")).id, "untemplated spawn (egress registry) admitted");
  const m = await refusal(spawn(t, "kg", "gv"));
  assert.match(
    m,
    /^spawn refused: template gv cannot run on sandbox backend podman: a template asks for gVisor isolation but backend podman does not provide it .*isolation\.gvisor not declared.*remove the runtime block from the template$/,
  );
  await t.orchestrator.idle();
});

test("an unsupported Podman also refuses an untemplated registry spawn", async () => {
  const t = withTemplates(templates, admitOn(PODMAN_DECLARATION, await probed("slirp4netns")));
  assert.match(await refusal(spawn(t, "k1")), /^spawn refused: template code cannot run on sandbox backend podman: .*egress.*slirp4netns/);
  assert.equal(t.fakes.sandbox.started.length, 0);
});

test("a podman whose `podman info` fails withholds egress (fail closed); docker has no boot probe", async () => {
  const down = await probeLocalBackend(PODMAN_DECLARATION, scriptedLocalEngine({ profile: PODMAN_PROFILE }));
  assert.match(down?.egressWithheld?.cause ?? "", /podman info failed/);
  assert.deepEqual(down?.result.withheld, ["egress.denyAll", "egress.allowHost"]);
  assert.equal(await probeLocalBackend(DOCKER_DECLARATION, scriptedLocalEngine()), null);
});

test("negative control: docker admits the same egress templates and the gVisor template", async () => {
  const t = withTemplates(templates, admitOn(DOCKER_DECLARATION));
  for (const [i, name] of ["reg", "hosts", "pub", "gv"].entries()) assert.ok((await spawn(t, `k${i}`, name)).id);
  await t.orchestrator.idle();
});

test("negative control: an unsupported Podman still admits a template without egress or runtime needs", async () => {
  const t = withTemplates(templates, admitOn(PODMAN_DECLARATION, await probed("slirp4netns")));
  assert.ok((await spawn(t, "k1", "quiet")).id);
  await t.orchestrator.idle();
  assert.equal(t.fakes.sandbox.started.length, 1);
});

test("start re-admits the persisted spec: a backend that no longer honours it ends the agent without a sandbox", async () => {
  let calls = 0;
  const strict = admitOn(PODMAN_DECLARATION, await probed("slirp4netns"));
  const t = withTemplates(templates, (spec) => (++calls === 1 ? [] : strict(spec)));
  const a = await spawn(t, "k1", "reg");
  await t.orchestrator.idle();
  assert.ok(calls >= 2, "the start path asked the admission again");
  assert.equal(t.fakes.sandbox.started.length, 0);
  const rec = await t.daemon.get(a.id);
  assert.equal(rec?.exit, "failed");
  assert.match(JSON.stringify(await t.daemon.deps.journal.read({ agent: a.id })), /refusing to start/);
});

test("fail closed without a probe: Podman admission that omits the boot probe withholds egress with a cause and an action; docker and egress none are unaffected", () => {
  const reg: Pick<SpawnSpec, "egress" | "runtime" | "template"> = { egress: { kind: "registry" }, template: "reg" };
  const refused = admitTemplateSpec(PODMAN_DECLARATION, boot, reg);
  assert.equal(refused.length, 1);
  assert.match(
    refused[0]!,
    /^template reg cannot run on sandbox backend podman: .*the boot probe found the Podman egress probe did not run.*; restart the daemon so the boot probe runs, or /,
  );
  const atBoot = admitAtBoot(PODMAN_DECLARATION, { ...boot, egress: true });
  assert.equal(atBoot.length, 1);
  assert.match(atBoot[0]!, /restart the daemon so the boot probe runs/);
  assert.deepEqual(admitTemplateSpec(PODMAN_DECLARATION, boot, { egress: { kind: "none" } }), [], "egress none still runs");
  assert.deepEqual(admitTemplateSpec(DOCKER_DECLARATION, boot, reg), [], "docker needs no probe");
});
