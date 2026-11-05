import type { AllowlistProfile, EgressPolicy } from "./types.ts";

// The closed paged-reader rule for the `analyst` and `specialist` allowlist profiles, one definition for every path that can produce a
// spec: template-dir refuses a stored template with it, and pomtreed refuses a spawn (and a start or resume) whose template or persisted spec
// breaks it, so a template built in code cannot bypass the file check. Their one profile extension is all they load (the profile adds it;
// a template cannot list it), and their only network path is the node relay. `registry` stays allowed because it is today's relay-only
// egress (with the empty env manifest it grants only the agent API and the model proxy) and `none` grants no relay, so the model is
// unreachable (TODO(model-egress)); `allowlist` and `audited-public` reach other hosts and are refused. Registry egress also opens the
// env manifest's package-registry hosts, so these profiles carry no env: a template's `env` and a spec's `envManifestHash` must be absent
// (null for the hash), and pomtreed builds their sandbox egress from the empty manifest. Absent egress is acceptable: a stored template
// normalizes it to `none` and a resolved spec to `registry`. Returns the refusal reason (the rule and its fix, without the template name,
// which the caller prefixes), or undefined when acceptable. Any other profile, or none, is not this rule's concern.
export function allowlistTemplateProblem(t: {
  readonly allowlist?: AllowlistProfile;
  readonly extensions?: readonly string[];
  readonly egress?: EgressPolicy;
  readonly env?: unknown;
  readonly envManifestHash?: string | null;
}): string | undefined {
  if (t.allowlist !== "analyst" && t.allowlist !== "specialist") return undefined;
  const extensions = t.extensions ?? [];
  if (extensions.length > 0)
    return `allowlist ${t.allowlist} loads only its own profile extension: remove extensions ${JSON.stringify(extensions)} from the template`;
  const kind = t.egress?.kind;
  if (kind !== undefined && kind !== "none" && kind !== "registry")
    return `allowlist ${t.allowlist} has no network beyond the node relay: egress.kind must be none or registry, not ${kind}; set egress to {"kind":"registry"}`;
  if (t.env !== undefined || (t.envManifestHash !== undefined && t.envManifestHash !== null))
    return `allowlist ${t.allowlist} has no network beyond the node relay, and an env manifest opens its package-registry hosts: remove env from the template`;
  return undefined;
}
