// Template admission against the selected sandbox backend's declaration: a template whose egress isolation or gVisor runtime the backend
// does not declare is refused at spawn and again at start, with nothing started, instead of running with the weaker mode.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpawnSpec, Template } from "@pomtree/core";
import { DOCKER_DECLARATION, PODMAN_DECLARATION } from "@pomtree/sandbox-docker";
import { LifecycleError } from "./lifecycle.ts";
import { admitTemplateSpec, bootNeeds } from "./sandbox-backends.ts";
import { setup } from "./test-setup.ts";

const boot = bootNeeds({ origin: "builtin", localEngine: true }, false);
const admitOn = (declaration: typeof DOCKER_DECLARATION) => (spec: SpawnSpec) => admitTemplateSpec(declaration, boot, spec);
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

test("podman refuses a template that sets egress, naming the template, the backend, the cause and the action; nothing is created or started", async () => {
  const t = withTemplates(templates, admitOn(PODMAN_DECLARATION));
  for (const [i, name] of ["reg", "hosts", "pub"].entries()) {
    const m = await refusal(spawn(t, `k${i}`, name));
    assert.equal(
      m,
      `spawn refused: template ${name} cannot run on sandbox backend podman: backend podman cannot enforce a default-deny egress allowlist (egress.allowHost not declared; egress.denyAll with connect is not available either); use a backend that enforces egress, or remove egress from the templates`,
    );
  }
  await t.orchestrator.idle();
  assert.equal(t.fakes.sandbox.started.length, 0);
});

test("podman refuses an untemplated spawn when agent.untemplatedEgress is registry, and a gVisor runtime block", async () => {
  const t = withTemplates(templates, admitOn(PODMAN_DECLARATION));
  assert.match(await refusal(spawn(t, "k1")), /^spawn refused: template code cannot run on sandbox backend podman: .*egress/);
  const m = await refusal(spawn(t, "k2", "gv"));
  assert.match(
    m,
    /^spawn refused: template gv cannot run on sandbox backend podman: a template asks for gVisor isolation but backend podman does not provide it .*isolation\.gvisor not declared.*remove the runtime block from the template$/,
  );
  assert.equal(t.fakes.sandbox.started.length, 0);
});

test("negative control: docker admits the same egress templates and the gVisor template", async () => {
  const t = withTemplates(templates, admitOn(DOCKER_DECLARATION));
  for (const [i, name] of ["reg", "hosts", "pub", "gv"].entries()) assert.ok((await spawn(t, `k${i}`, name)).id);
  await t.orchestrator.idle();
});

test("negative control: podman admits a template without egress or runtime needs", async () => {
  const t = withTemplates(templates, admitOn(PODMAN_DECLARATION));
  assert.ok((await spawn(t, "k1", "quiet")).id);
  await t.orchestrator.idle();
  assert.equal(t.fakes.sandbox.started.length, 1);
});

test("start re-admits the persisted spec: a backend that no longer honours it ends the agent without a sandbox", async () => {
  let calls = 0;
  const strict = admitOn(PODMAN_DECLARATION);
  const t = withTemplates(templates, (spec) => (++calls === 1 ? [] : strict(spec)));
  const a = await spawn(t, "k1", "reg");
  await t.orchestrator.idle();
  assert.ok(calls >= 2, "the start path asked the admission again");
  assert.equal(t.fakes.sandbox.started.length, 0);
  const rec = await t.daemon.get(a.id);
  assert.equal(rec?.exit, "failed");
  assert.match(JSON.stringify(await t.daemon.deps.journal.read({ agent: a.id })), /refusing to start/);
});
