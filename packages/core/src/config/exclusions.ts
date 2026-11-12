// The env names under our prefixes (POMTREED_, POMTREE_, PTREE_) that are deliberately NOT registry parameters, each with why.
// One list: e2e/src/config-registry-drift.test.ts checks that every name in source is a live registry name or
// covered here, and a resolver caller passes `configEnvIgnore()` so these names are not refused as unknown. Pure.
// The POMTREED_EXT_ family is not excluded: its names belong to the loaded extensions' manifests (extend.ts) and are refused unless declared.

export type EnvExclusionReason =
  | "runtime-injected" // set by pomtreed into an agent container (or by the image itself) at run time; never an operator input
  | "test-seam" // a test, demo or CI gate
  | "not-a-parameter" // access control or fixed policy that a generic override must not loosen
  | "owned-elsewhere" // another process's own config (the messaging adapter), not the daemon's or the client's
  | "identifier"; // a TypeScript identifier that matches the pattern, not an env var

export interface EnvExclusion {
  readonly name: string;
  readonly prefix?: true; // `name` is a family prefix (PTREE_E2E_), not an exact name
  readonly reason: EnvExclusionReason;
  readonly why: string;
}

export const CONFIG_ENV_EXCLUSIONS: readonly EnvExclusion[] = [
  { name: "POMTREE_TOKEN", reason: "runtime-injected", why: "agent or operator credential; pomtreed issues it per container (lifecycle.ts)" },
  {
    name: "POMTREE_TOKEN_FILE",
    reason: "runtime-injected",
    // TODO(docker-env-token): pomtreed does not yet inject the token file.
    why: "planned secret-mount path for POMTREE_TOKEN; not injected yet, so the token is passed as an environment variable and is visible in docker inspect",
  },
  {
    name: "PTREE_CAPTURE_JOB",
    reason: "runtime-injected",
    why: "the per-job capture spec the pomtreed capture broker issues for the capture worker; not operator config",
  },
  { name: "POMTREE_API", reason: "runtime-injected", why: "the agent endpoint URL pomtreed injects into a container" },
  {
    name: "POMTREE_SOCKET",
    reason: "runtime-injected",
    why: "the socket pomtreed injects into a container (POMTREE_API's unix alternative); the same name is the operator's client override, kept as one connection contract",
  },
  { name: "POMTREE_AGENT_ID", reason: "runtime-injected", why: "the container's agent id" },
  { name: "POMTREE_AGENT_GENERATION", reason: "runtime-injected", why: "the container's agent generation (fencing)" },
  { name: "POMTREE_AGENT_DEADLINE_AT", reason: "runtime-injected", why: "the container's session deadline" },
  { name: "POMTREE_BASE_COMMIT", reason: "runtime-injected", why: "the commit the agent's clone was cut from" },
  { name: "PTREE_BROWSER", reason: "runtime-injected", why: "per-template browser mode pomtreed injects (daemon-util.ts browserEnv)" },
  { name: "PTREE_BROWSER_MAX_STEPS", reason: "runtime-injected", why: "per-template browser step limit pomtreed injects" },
  { name: "PTREE_BROWSER_MAX_MS", reason: "runtime-injected", why: "per-template browser time limit pomtreed injects" },
  { name: "PTREE_BROWSER_PROFILE", reason: "runtime-injected", why: "per-template browser profile pomtreed injects (absent = capture-only)" },
  {
    name: "PTREE_BROWSER_USER_AGENT",
    reason: "runtime-injected",
    why: "the resolved workflow.fetch.userAgent pomtreed injects into a browser worker (a non-secret operator identity string, not a registry key delivered to containers)",
  },
  { name: "PTREE_CONFIG_JSON", reason: "runtime-injected", why: "the resolved container subset pomtreed injects (core config/container.ts)" },
  { name: "PTREE_EVENTS_SINK", reason: "runtime-injected", why: "in-image events sink path (agent-image pomtree-events)" },
  { name: "POMTREE_REVISION_FILE", reason: "test-seam", why: "the pomtree revision file path, overridden by tests" },
  { name: "PTREE_DOCKER_TESTS", reason: "test-seam", why: "gates Docker test suites" },
  { name: "PTREE_LIVE_PROVIDERS", reason: "test-seam", why: "opt-in list of provider ids for live provider tests (read by the e2e live gate only)" },
  { name: "PTREE_LIVE_MAX_MICROS", reason: "test-seam", why: "spend cap, in millionths of a dollar, for live provider tests (read by the e2e live gate only)" },
  { name: "POMTREE_TEST_TIMEOUT_SCALE", reason: "test-seam", why: "multiplier (>= 1) for test deadlines in the shared timing helpers; CI and the gate set 3" },
  { name: "PTREE_AGENT_TEST_", prefix: true, reason: "test-seam", why: "sandbox-docker test image gates" },
  { name: "PTREE_TEST_", prefix: true, reason: "test-seam", why: "test capture gates" },
  { name: "PTREE_E2E_", prefix: true, reason: "test-seam", why: "e2e image and live-model gates" },
  { name: "POMTREED_DEMO_", prefix: true, reason: "test-seam", why: "e2e demo knobs" },
  { name: "POMTREED_LIVE", reason: "test-seam", why: "the e2e demos' spend gate" },
  { name: "POMTREED_MESSAGING_SENDERS", reason: "not-a-parameter", why: "inbound sender allowlist (access control, configured by its owner)" },
  { name: "POMTREED_MESSAGING_TOKEN", reason: "owned-elsewhere", why: "messaging-discord adapter config (path to its daemon token)" },
  { name: "POMTREED_URL", reason: "owned-elsewhere", why: "messaging-discord adapter config (the daemon URL it calls)" },
  { name: "POMTREED_KINDS", reason: "identifier", why: "core journal-kind table" },
  { name: "POMTREED_KIND_PREFIX", reason: "identifier", why: "core journal-kind prefix" },
];

// Whether `name` is covered by an exclusion (exactly, or by a family prefix).
export const isExcludedEnv = (name: string): EnvExclusion | undefined =>
  CONFIG_ENV_EXCLUSIONS.find((e) => (e.prefix ? name.startsWith(e.name) : name === e.name));

// The resolver's ignore lists for the excluded names.
export const configEnvIgnore = (): { ignoreEnv: string[]; ignoreEnvPrefixes: string[] } => ({
  ignoreEnv: CONFIG_ENV_EXCLUSIONS.filter((e) => !e.prefix).map((e) => e.name),
  ignoreEnvPrefixes: CONFIG_ENV_EXCLUSIONS.filter((e) => e.prefix).map((e) => e.name),
});
