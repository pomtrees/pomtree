// Boot refusals for dangerous silent defaults (TODO(safety-defaults)). Pure: the caller (main.ts) resolves the config and the facts
// (the planned agent listener, the detected docker bridge gateway, whether a merge check runner is wired) and prints every
// message at once, so the operator fixes everything in one pass. One explicit key per decision: there is no "acknowledge" key and
// no warning stands in for a refusal. Modeled on messagingSendersError (channels.ts).

import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { AgentListenPlan } from "./agent-net.ts";
import { isLoopbackHost } from "./config.ts";
import { type DaemonConfig, envName } from "./daemon-config.ts";

export interface SafetyBootFacts {
  /** Whether this build wires a merge CheckRunner (main.ts wires none). */
  checkRunnerWired: boolean;
  /** The agent listener plan (planAgentListen); only an `explicit` plan can violate. */
  agentListen: AgentListenPlan;
  /** The detected docker bridge gateway; undefined = not detected. */
  bridgeGateway: string | undefined;
  /** The directories pomtreed loads code and config from, as realpaths (realpathLoose); "" = skip. */
  loadDirs: { templates: string; extensions: string };
  /** Every host path an agent container can write, as realpaths (realpathLoose); `key` is the config key that places it. */
  agentWritable: { key: string; path: string }[];
}

/** Realpath of the nearest existing ancestor plus the not-yet-existing tail, so a symlinked ancestor of a dir that does not exist yet still resolves. */
export function realpathLoose(path: string): string {
  const tail: string[] = [];
  let cur = path;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return path;
      tail.push(basename(cur));
      cur = up;
    }
  }
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
};

/** Startup warning for `agent.untemplatedEgress=none`, or "" when fine. Not a refusal: a template that sets its own egress is unaffected. TODO(untemplated-egress-none-relay): under none an untemplated agent has no network (NetworkMode none) while its model and API address is host.docker.internal, so it fails with `Connection error.`; routing the model proxy and agent endpoint through the egress relay would make none work. */
export function untemplatedEgressNoneWarning(value: string): string {
  if (value !== "none") return "";
  const env = envName("agent.untemplatedEgress");
  return `pomtreed: WARNING: agent.untemplatedEgress is none: a spawn that names no template (such as pomtree spawn --task ...) has no network, so it cannot reach the model proxy and fails with "Connection error." while its budget drains. Set ${env}=registry (the model proxy and package registries only), or make sure every spawn names a template that sets its own egress`;
}

type SafetyConfig = Pick<
  DaemonConfig,
  "agent.egressProxyImage" | "agent.untemplatedEgress" | "extensions.approval" | "merge.check" | "listen.allowNonloopback"
>;

/** Every boot-refusal message, in a fixed order; empty = safe to start. */
export function safetyBootErrors(cfg: SafetyConfig, facts: SafetyBootFacts): string[] {
  const errors: string[] = [];
  if (cfg["agent.egressProxyImage"] === "")
    errors.push(
      `pomtreed: refusing to start: agent.egressProxyImage is not set: every container spawn runs an egress-proxy sidecar, and without a pinned image the sidecar would run the worker's own image, so a template's author would choose its egress enforcer. Set ${envName("agent.egressProxyImage")} to a digest-pinned image (name[:tag]@sha256:<64 hex>, or the local image id that docker image inspect --format '{{.Id}}' <agent image> prints; see agent.egressProxyImage in docs/configuration.md)`,
    );
  if (cfg["agent.untemplatedEgress"] === "") {
    const env = envName("agent.untemplatedEgress");
    errors.push(
      `pomtreed: refusing to start: agent.untemplatedEgress is not set: a spawn that names no template runs the built-in code template, and its network reach is the operator's choice. Set ${env}=none (no network beyond the daemon relay) or ${env}=registry (the package registries only)`,
    );
  }
  if (cfg["extensions.approval"].trim() === "") {
    const env = envName("extensions.approval");
    errors.push(
      `pomtreed: refusing to start: extensions.approval is not set: it decides which extensions' gated actions wait for a human approval. Set ${env}=all (every gated action waits for approval on an escalation channel), ${env}=none (no approvals), or a comma list of extension names`,
    );
  }
  if (facts.agentListen.mode === "explicit" && !cfg["listen.allowNonloopback"]) {
    // planAgentListen keeps the brackets of an IPv6 literal ("[::1]:0"); the loopback check wants the bare address.
    const host = facts.agentListen.host.replace(/^\[(.*)\]$/, "$1");
    if (!isLoopbackHost(host) && host !== facts.bridgeGateway)
      errors.push(
        `pomtreed: refusing to start: agent.listen binds ${host}, which is neither loopback nor the docker bridge gateway (${facts.bridgeGateway ?? "not detected"}): the agent listener is plain HTTP guarded only by agent tokens. Set ${envName("agent.listen")} to a loopback or bridge-gateway address (or leave it unset), or set ${envName("listen.allowNonloopback")}=1 to accept this`,
      );
  }
  if (cfg["merge.check"].trim() !== "" && !facts.checkRunnerWired)
    errors.push(
      `pomtreed: refusing to start: merge.check is set but this build wires no merge check runner, so every merge would fail closed with check_unavailable. Unset ${envName("merge.check")} (merges then run with no check) until a check runner is available`,
    );
  for (const [key, dir] of [
    ["templates.dir", facts.loadDirs.templates],
    ["extensions.dir", facts.loadDirs.extensions],
  ] as const) {
    if (dir === "") continue;
    // Any overlap in either direction: the dir inside a writable path, equal to it, or containing it (so it also contains what is beneath).
    const hit = facts.agentWritable.find((w) => w.path !== "" && (inside(dir, w.path) || inside(w.path, dir)));
    if (hit)
      errors.push(
        `pomtreed: refusing to start: ${key} (${dir}) overlaps ${hit.path}, which agent containers can write (placed by ${hit.key}): an agent could change what pomtreed later loads from ${key}. Set ${envName(key)} to a directory that neither contains, equals nor lies inside any agent-writable path (the default <state.dir>/${key === "templates.dir" ? "templates" : "extensions"} is safe), or move ${hit.key}`,
      );
  }
  return errors;
}
