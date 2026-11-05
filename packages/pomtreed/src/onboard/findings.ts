// Pure evaluation of the preflight observations into findings. Every non-ok finding names the onboarding step that fixes it
// (steps.ts is the one source of fix text); needsRoot and network come from that step.
import { evaluateGitVersion } from "@pomtree/workspace-git";
import { revisionMismatch } from "../revision.ts";
import { EGRESS_PROXY_PATH, type Observations } from "./probes.ts";
import { COREPACK_ENABLE, COREPACK_INSTALL, COREPACK_UNBUNDLED_FROM, type OnboardingStep, type StepCommand, type StepId, stepById } from "./steps.ts";

export type Severity = "ok" | "info" | "warn" | "error";

export interface Finding {
  id: string; // stable, dotted
  severity: Severity;
  message: string;
  step?: StepId;
  needsRoot: boolean;
  network: boolean;
}

export interface Fix {
  step: StepId;
  title: string;
  commands: StepCommand[];
}

/** `>=N[.M[.P]]` only; null for any other form. */
export function parseMinRange(range: string): number[] | null {
  const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

const atLeast = (have: number[], need: number[]): boolean => {
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) !== (need[i] ?? 0)) return (have[i] ?? 0) > (need[i] ?? 0);
  }
  return true;
};

// The one wording source of the image findings (the dynamic parts are arguments), so the wording can be swapped in one place.
export const IMAGE_MESSAGES = {
  missing: (label: string) => `${label} is not present: an agent start would fail when the sandbox starts its containers`,
  noEgressProxy: (label: string) =>
    `${label} was built before the egress proxy existed (it lacks ${EGRESS_PROXY_PATH}), so the egress sidecar exits at once and every agent start fails`,
  proxyUnknown: (label: string) =>
    `could not check whether ${label} carries the egress proxy (the docker run probe gave no clear answer: it timed out, could not start, the image has no node, or node crashed); rebuild it if agent starts fail`,
  stale: (label: string, built: string, checkout: string) =>
    `${label} was built from ${built}, checkout is ${checkout}: the baked pomtree CLI may skew from the daemon, and a start would run the old build`,
  unlabelled: (label: string) => `${label} carries no revision label, so skew with the checkout cannot be ruled out; rebuild it with the build step`,
  checkoutUnknown: (label: string, built: string) => `${label} was built from ${built}; the checkout's revision is unknown, so skew cannot be checked`,
  daemonDown: "skipped: docker daemon not reachable",
  revisionSkipped: "skipped: image not present",
  proxySkipped: "skipped: image not present or docker daemon not reachable",
  egressDefaulted: " (egress image defaulted to the agent image; pass --egress-image to check the configured one)",
} as const;

export function evaluateObservations(o: Observations, steps: readonly OnboardingStep[]): Finding[] {
  const findings: Finding[] = [];
  const add = (id: string, severity: Severity, message: string, step?: StepId, flags?: Pick<Finding, "needsRoot" | "network">): void => {
    const s = step === undefined ? undefined : stepById(steps, step);
    findings.push({
      id,
      severity,
      message,
      ...(step !== undefined && { step }),
      ...(flags ?? { needsRoot: s?.needsRoot ?? false, network: s?.network ?? false }),
    });
  };
  const { host } = o;
  const { facts } = host;

  // node
  const need = parseMinRange(facts.nodeRange);
  const have = /^v?(\d+)\.(\d+)\.(\d+)/.exec(host.nodeVersion)?.slice(1).map(Number);
  if (need === null)
    add(
      "node.version",
      "warn",
      `node ${host.nodeVersion}: cannot evaluate engines.node "${facts.nodeRange}" (only ">=N[.M[.P]]" is understood)`,
      "install-node",
    );
  else if (have === undefined) add("node.version", "warn", `node version "${host.nodeVersion}" could not be parsed; need ${facts.nodeRange}`, "install-node");
  else if (atLeast(have, need)) add("node.version", "ok", `node ${host.nodeVersion} satisfies ${facts.nodeRange}`);
  else add("node.version", "error", `node ${host.nodeVersion} does not satisfy ${facts.nodeRange}`, "install-node");

  // git
  if (o.git === null) add("git.version", "error", "git is not on PATH", "install-git");
  else {
    const g = evaluateGitVersion(o.git);
    if (g.warning !== null) add("git.version", "error", g.warning, "install-git");
    else add("git.version", "ok", `git ${g.version} (need >= ${facts.minGit})`);
  }

  // pnpm
  if (o.corepack === null) {
    // the case comes from the detected node major; the commands and their flags come from the step (steps.ts)
    const major = have?.[0];
    const sudo = " (may need sudo: show it to the user, never run it as an agent)";
    if (major !== undefined && major >= COREPACK_UNBUNDLED_FROM)
      add(
        "pnpm.corepack",
        "warn",
        `corepack is not on PATH, and node ${host.nodeVersion} does not bundle it (Node.js ${COREPACK_UNBUNDLED_FROM}+ dropped it): run \`${COREPACK_INSTALL.run}\` (needs network${sudo}), then \`${COREPACK_ENABLE.run}\``,
        "enable-pnpm",
        { needsRoot: true, network: true },
      );
    else if (major !== undefined)
      add(
        "pnpm.corepack",
        "warn",
        `corepack is not on PATH, though node ${host.nodeVersion} bundles it (a broken install, or node's bin directory is not on PATH): fix that, then run \`${COREPACK_ENABLE.run}\`${sudo}`,
        "enable-pnpm",
        { needsRoot: true, network: false },
      );
    else
      add(
        "pnpm.corepack",
        "warn",
        `corepack is not on PATH, and the node version "${host.nodeVersion}" could not be parsed to tell whether it bundles it (before Node.js ${COREPACK_UNBUNDLED_FROM} it does); see the enable-pnpm step`,
        "enable-pnpm",
      );
  } else add("pnpm.corepack", "ok", `corepack ${o.corepack}`);
  if (o.pnpmUnresolved)
    add(
      "pnpm.version",
      "warn",
      `pnpm is on PATH but gave no version without the network: the pinned pnpm ${facts.pnpmVersion} is likely not downloaded yet, and preflight never downloads it. The first pnpm command in the checkout downloads it (needs network; ask the user first)`,
      "enable-pnpm",
    );
  else if (o.pnpm === null) add("pnpm.version", "error", `pnpm is not on PATH; the checkout pins pnpm ${facts.pnpmVersion}`, "enable-pnpm");
  else if (o.pnpm !== facts.pnpmVersion) add("pnpm.version", "warn", `pnpm ${o.pnpm} differs from the pinned ${facts.pnpmVersion}`, "enable-pnpm");
  else add("pnpm.version", "ok", `pnpm ${o.pnpm}`);

  // container runtimes: Docker is the validated runtime
  if (o.docker.version === null) add("docker.cli", "error", "docker is not on PATH; Docker is the required runtime", "install-docker");
  else {
    add("docker.cli", "ok", o.docker.version);
    if (!o.docker.daemon) add("docker.daemon", "error", "the docker daemon does not answer (docker info failed)", "start-docker");
    else add("docker.daemon", "ok", "the docker daemon answers");
    if (!o.docker.buildx) add("docker.buildx", "error", "docker buildx is missing (the agent image build needs it)", "install-docker");
    else add("docker.buildx", "ok", "docker buildx is available");
  }
  if (o.podman !== null) add("podman.runtime", "info", `${o.podman} found; Podman is not validated as a runtime for pomtree`);

  // the images the sandbox starts: a missing one, or an egress image without the proxy, fails the agent start, so it blocks;
  // a revision that differs from the checkout or is unlabelled only warns
  // egressProxy comes from the boot check's probe and verdict (image-check.ts, via probes.ts): absent blocks, unknown only warns
  for (const role of ["agent", "egress"] as const) {
    const img = o.images[role];
    const note = role === "egress" && o.images.egressDefaulted ? IMAGE_MESSAGES.egressDefaulted : "";
    const label = `${role === "agent" ? "agent" : "egress proxy"} image ${img.ref}`;
    const id = `image.${role}`;
    if (img.state === "skipped") {
      add(`${id}.present`, "info", IMAGE_MESSAGES.daemonDown);
      if (role === "egress") add(`${id}.proxy`, "info", IMAGE_MESSAGES.proxySkipped);
      add(`${id}.revision`, "info", IMAGE_MESSAGES.daemonDown);
    } else if (img.state === "missing") {
      add(`${id}.present`, "error", `${IMAGE_MESSAGES.missing(label)}${note}`, "build-image");
      if (role === "egress") add(`${id}.proxy`, "info", IMAGE_MESSAGES.proxySkipped);
      add(`${id}.revision`, "info", IMAGE_MESSAGES.revisionSkipped);
    } else {
      add(`${id}.present`, "ok", `${label} is present${note}`);
      if (role === "egress") {
        if (img.egressProxy === "absent") add(`${id}.proxy`, "error", `${IMAGE_MESSAGES.noEgressProxy(label)}${note}`, "build-image");
        else if (img.egressProxy === "present") add(`${id}.proxy`, "ok", `${label} carries the egress proxy${note}`);
        else add(`${id}.proxy`, "warn", `${IMAGE_MESSAGES.proxyUnknown(label)}${note}`, "build-image");
      }
      if (img.revision === undefined) add(`${id}.revision`, "warn", `${IMAGE_MESSAGES.unlabelled(label)}${note}`, "build-image");
      else if (o.checkoutRevision === undefined) add(`${id}.revision`, "info", `${IMAGE_MESSAGES.checkoutUnknown(label, img.revision)}${note}`);
      else if (revisionMismatch(o.checkoutRevision, img.revision))
        add(`${id}.revision`, "warn", `${IMAGE_MESSAGES.stale(label, img.revision, o.checkoutRevision)}${note}`, "build-image");
      else add(`${id}.revision`, "ok", `${label} was built from ${img.revision}, the checkout's revision${note}`);
    }
  }

  // state dir visible to docker
  const sv = o.stateVisible;
  if (sv.state === "skipped") add("state.visible", "info", `skipped: ${sv.why}`);
  else if (sv.state === "fail")
    add(
      "state.visible",
      "error",
      `docker cannot see the state dir ${host.stateDir} (${sv.why}); on Docker Desktop add it under Settings > Resources > File sharing, or use a path under $HOME`,
      "state-dir",
    );
  else if (sv.state === "unknown")
    add(
      "state.visible",
      "warn",
      `could not check whether docker can bind-mount the state dir ${host.stateDir} (${sv.why}); re-run preflight, a cold first docker run can be slow`,
      "state-dir",
    );
  else add("state.visible", "ok", `docker can bind-mount ${host.stateDir}`);

  // firewall
  if (o.ufw === "active")
    add("firewall.ufw", "warn", "ufw is active; if pomtree doctor reports the agent api unreachable, allow container-to-host traffic", "firewall");

  // the target repo
  if (o.repo === "unset") add("repo.commit", "info", "skipped: no target repository given; pass --repo <dir> to check it");
  else if (o.repo === "refused") add("repo.commit", "error", o.repoRefusal ?? `${host.repoDir} cannot be the target repository`);
  else if (o.repo === "skipped") add("repo.commit", "info", "skipped: git is not available");
  else if (o.repo === "not-git") add("repo.commit", "error", `${host.repoDir} is not a git repository`, "target-repo");
  else if (o.repo === "no-commit") add("repo.commit", "error", `${host.repoDir} has no commit; agents clone from HEAD`, "target-repo");
  else add("repo.commit", "ok", `${host.repoDir} has a HEAD commit`);

  // the key file: stat only, never opened
  if (o.keyFile !== undefined) {
    const { path, stat } = o.keyFile;
    if (stat === null) add("keyfile.mode", "error", `key file ${path} does not exist`, "key-file");
    else if (stat.isDirectory) add("keyfile.mode", "error", `${path} is a directory, not a key file`, "key-file");
    else if ((stat.mode & 0o077) !== 0)
      add("keyfile.mode", "error", `key file ${path} is readable by group or other (mode ${(stat.mode & 0o777).toString(8)}); chmod 600 it`, "key-file");
    else if (host.uid !== null && stat.uid !== host.uid)
      add("keyfile.mode", "error", `key file ${path} is owned by uid ${stat.uid}, not you (uid ${host.uid})`, "key-file");
    else add("keyfile.mode", "ok", `key file ${path} is mode ${(stat.mode & 0o777).toString(8)} and yours`);
  }
  return findings;
}

export const hasError = (findings: readonly Finding[]): boolean => findings.some((f) => f.severity === "error");

/** The fix a non-ok finding points at (steps.ts text), or undefined for ok/info findings and findings without a step. */
export function fixOf(f: Finding, steps: readonly OnboardingStep[]): Fix | undefined {
  if (f.step === undefined || f.severity === "ok" || f.severity === "info") return undefined;
  const s = stepById(steps, f.step);
  return { step: s.id, title: s.title, commands: s.commands };
}
