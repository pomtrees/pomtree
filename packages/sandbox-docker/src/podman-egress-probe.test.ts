import test from "node:test";
import assert from "node:assert/strict";
import { admitBackend, type BackendNeeds } from "@pomtree/core";
import { PODMAN_PROFILE } from "./engine-profile.ts";
import { scriptedLocalEngine } from "./local-engine-fake.ts";
import { PODMAN_DECLARATION } from "./provider.ts";
import { checkPodmanEgress, pastaBuildDate, podmanEgressInfoArgs, podmanEgressProbeResult, probePodmanEgress } from "./podman-egress-probe.ts";

const GOOD = {
  version: { Version: "5.7.0" },
  host: { security: { rootless: true }, rootlessNetworkCmd: "pasta", pasta: { version: "pasta 0.0~git20260120.386b5f5-1\nCopyright Red Hat\n" } },
};
const info = (patch: (i: typeof GOOD) => unknown) => JSON.stringify(patch(structuredClone(GOOD)));
const set = (f: (i: typeof GOOD) => void) => info((i) => (f(i), i));

test("pastaBuildDate reads the release and the Debian snapshot forms and nothing else", () => {
  assert.equal(pastaBuildDate("pasta 2024_09_06.6b38f07"), 20240906);
  assert.equal(pastaBuildDate("pasta 0.0~git20260120.386b5f5-1"), 20260120);
  assert.equal(pastaBuildDate("pasta"), undefined);
  for (const bad of [
    "pasta 20241399",
    "pasta 0.0~git20241399.abc",
    "pasta 2024_13_01.abc",
    "pasta 2024_00_10.abc",
    "pasta 2024_08_00.abc",
    "pasta 2024_08_32.abc",
  ])
    assert.equal(pastaBuildDate(bad), undefined, bad);
});

test("a rootless Podman 5 with a recent pasta is supported", () => {
  assert.deepEqual(checkPodmanEgress(JSON.stringify(GOOD)), { supported: true });
  assert.deepEqual(podmanEgressProbeResult({ supported: true }).withheld, []);
});

test("the minimum boundaries are accepted: Podman 5.3.0 and pasta 2024_08_21", () => {
  assert.deepEqual(checkPodmanEgress(set((i) => (i.version.Version = "5.3.0"))), { supported: true });
  assert.deepEqual(checkPodmanEgress(set((i) => (i.version.Version = "6.0.0"))), { supported: true });
  assert.deepEqual(checkPodmanEgress(set((i) => (i.version.Version = "5.10.0"))), { supported: true }); // a lexical compare would refuse it
  assert.deepEqual(checkPodmanEgress(set((i) => (i.version.Version = "5.3"))), { supported: true });
  assert.deepEqual(checkPodmanEgress(set((i) => (i.version.Version = "5.4.0-dev"))), { supported: true });
  assert.deepEqual(checkPodmanEgress(set((i) => (i.host.pasta.version = "pasta 2024_08_21.1d6142f"))), { supported: true });
  assert.deepEqual(checkPodmanEgress(set((i) => (i.host.pasta.version = "pasta 0.0~git20240821.1d6142f-1"))), { supported: true });
});

test("each unsupported setup is refused with a cause and an action", () => {
  const cases: [string, string, RegExp][] = [
    ["podman 4.9", set((i) => (i.version.Version = "4.9.3")), /older than 5\.3/],
    ["podman 5.2.x", set((i) => (i.version.Version = "5.2.5")), /older than 5\.3/],
    ["5.3.0-dev (pre-release of the floor)", set((i) => (i.version.Version = "5.3.0-dev")), /older than 5\.3/],
    ["null podman version", set((i) => ((i.version as { Version: unknown }).Version = null)), /no host or version/],
    ["rootless missing", set((i) => delete (i.host.security as Record<string, unknown>).rootless), /rootful/],
    ["invalid pasta date", set((i) => (i.host.pasta.version = "pasta 20241399")), /not reported or not recognised/],
    ["invalid pasta snapshot month", set((i) => (i.host.pasta.version = "pasta 0.0~git20241399.abc")), /not reported or not recognised/],
    ["unparseable podman version", set((i) => (i.version.Version = "dev")), /unreadable/],
    ["pasta 20240820", set((i) => (i.host.pasta.version = "pasta 2024_08_20.abcdef0")), /predates 20240821/],
    ["rootful", set((i) => (i.host.security.rootless = false)), /rootful/],
    ["slirp4netns", set((i) => (i.host.rootlessNetworkCmd = "slirp4netns")), /not pasta/],
    ["no network field", set((i) => delete (i.host as Record<string, unknown>).rootlessNetworkCmd), /unreported/],
    ["old pasta", set((i) => (i.host.pasta.version = "pasta 2023_06_01.abcdef")), /predates/],
    ["unrecognised pasta", set((i) => (i.host.pasta.version = "pasta dev")), /not reported or not recognised/],
    ["no pasta section", set((i) => delete (i.host as Record<string, unknown>).pasta), /not reported or not recognised/],
    ["not json", "podman: error", /JSON object/],
    ["no host", JSON.stringify({ version: { Version: "5.7.0" } }), /no host or version/],
  ];
  for (const [name, text, cause] of cases) {
    const r = checkPodmanEgress(text);
    assert.equal(r.supported, false, name);
    if (r.supported) continue;
    assert.match(r.cause, cause, name);
    assert.match(r.action, /rootless Podman >= 5\.3 with the pasta network backend/, name);
    assert.deepEqual(podmanEgressProbeResult(r).withheld, ["egress.denyAll", "egress.allowHost"], name);
  }
});

test("probePodmanEgress asks the engine for `info --format json`; a failing engine is unsupported with the CLI error", async () => {
  const ok = scriptedLocalEngine({ profile: PODMAN_PROFILE, answers: { [podmanEgressInfoArgs().join(" ")]: { stdout: JSON.stringify(GOOD) } } });
  assert.equal((await probePodmanEgress(ok)).support.supported, true);
  assert.deepEqual(
    ok.calls.map((c) => c.args),
    [["info", "--format", "json"]],
  );
  const down = scriptedLocalEngine({ profile: PODMAN_PROFILE });
  const r = await probePodmanEgress(down);
  assert.equal(r.support.supported, false);
  assert.match(r.support.supported ? "" : r.support.cause, /podman info failed/);
  assert.deepEqual(r.result.withheld, ["egress.denyAll", "egress.allowHost"]);
});

test("the withheld set takes effect in boot admission once Podman declares the capabilities, and a template needing egress is refused", () => {
  const declared = { ...PODMAN_DECLARATION, capabilities: { ...PODMAN_DECLARATION.capabilities, "egress.denyAll": true, "egress.allowHost": true } };
  const unsupported = podmanEgressProbeResult(checkPodmanEgress(set((i) => (i.host.rootlessNetworkCmd = "slirp4netns"))));
  const needs: BackendNeeds = { egress: true, daemonReach: true, terminal: false, workspace: "mount", secrets: { agentToken: false, envAllowed: false } };
  const refused = admitBackend(declared, unsupported, needs);
  assert.equal(refused.ok, false);
  assert.ok(JSON.stringify(refused).includes("withheld by the backend's readiness probe"));
  assert.equal(admitBackend(declared, podmanEgressProbeResult({ supported: true }), needs).ok, true);
});
