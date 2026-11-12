import { SANDBOX_TAGS } from "@pomtree/core";
import { LABEL } from "./args.ts";
import type { EngineProfile } from "./engine-profile.ts";

// How each local engine words the failures and outputs the adapter acts on, as one table per engine. Pure: no I/O. The two
// patterns the profile already owns (daemonUnreachable, alreadyInUse) are read from the profile, never copied here. Fixtures in
// fixtures/engine/<engine>/ pin every class (engine-dialect.test.ts), each marked `captured` or `inferred` in its header.
// The CLI prefixes a failure with `<binary> <verb> failed:` and the engine prints an `Error` line; classes match on the engine's
// own wording, so the prefix is irrelevant.

export type EngineErrorClass =
  | "socketPermission"
  | "daemonUnreachable"
  | "nameInUse"
  | "containerGone"
  | "removalRace"
  | "mountRace"
  | "noSuchVolume"
  | "noSuchNetwork"
  | "networkExists"
  | "imageUnavailable"
  | "pullFailed";

// Classes whose pattern is the engine's own table below (all but the two the profile carries).
type TableClass = Exclude<EngineErrorClass, "daemonUnreachable" | "nameInUse">;

// Docker CLI diagnostics that classify a `start` failure. A missing manifest / nonexistent image is permanent; a transient registry
// or network failure (pull interrupted, DNS/TLS/timeout, registry rate limit) may succeed on retry.
const DOCKER_IMAGE_UNAVAILABLE =
  /manifest for .* not found|manifest unknown|no such image|pull access denied|repository .* not found|not found: manifest|image .* not found/i;
const PULL_FAILED =
  /error pulling image|pull .* failed|dial tcp|tls handshake|i\/o timeout|timeout|toomanyrequests|rate limit|connection reset|no route to host|no such host|temporary failure|get https?:\/\//i;

const DOCKER: Record<TableClass, RegExp> = {
  // The docker CLI's refusal when the user cannot open the daemon socket (older and newer wordings). Waiting never grants access.
  socketPermission: /permission denied while trying to connect to the docker (daemon socket|api)/i,
  containerGone: /no such container|no such object|is not running/i,
  // `rm` while another remover already holds the container. Deliberately not containerGone: readState and wait must not read an
  // in-progress removal as an absent container.
  removalRace: /removal of container \S+ is already in progress/i,
  mountRace: /bind source path does not exist/i,
  noSuchVolume: /no such volume/i,
  noSuchNetwork: /no such network|network \S+ not found/i,
  networkExists: /already exists/i,
  imageUnavailable: DOCKER_IMAGE_UNAVAILABLE,
  pullFailed: PULL_FAILED,
};

const PODMAN: Record<TableClass, RegExp> = {
  // Podman has no daemon: a socket the user cannot open fails the dial itself.
  socketPermission: /dial unix [^\n]*connect: permission denied/i,
  containerGone: /no such container|no such object|no container with name or id|is in state \w+: container state improper|is not running/i,
  removalRace: /removal of container \S+ is already in progress|container \S+ (?:is already being removed|has already been removed)/i,
  mountRace: /statfs [^\n]+: no such file or directory|bind source path does not exist/i,
  noSuchVolume: /no such volume|no volume with name \S+ found/i,
  noSuchNetwork: /network not found|unable to find network with name or id|no such network/i,
  networkExists: /network already exists|network name \S+ already used/i,
  imageUnavailable: new RegExp(`${DOCKER_IMAGE_UNAVAILABLE.source}|image not known|requested access to the resource is denied`, "i"),
  pullFailed: PULL_FAILED,
};

const TABLES: Record<EngineProfile["id"], Record<TableClass, RegExp>> = { docker: DOCKER, podman: PODMAN };

// Evaluation order for classifyEngineError: a permission refusal is checked before reachability because Podman words both as
// "Cannot connect to Podman ... connect: permission denied".
const ORDER: readonly EngineErrorClass[] = [
  "socketPermission",
  "daemonUnreachable",
  "nameInUse",
  "removalRace",
  "containerGone",
  "mountRace",
  "noSuchVolume",
  "noSuchNetwork",
  "networkExists",
  "imageUnavailable",
  "pullFailed",
];

export function isEngineError(profile: EngineProfile, cls: EngineErrorClass, message: string): boolean {
  if (cls === "nameInUse") return profile.errors.alreadyInUse.test(message);
  // Podman words a permission refusal as "Cannot connect to Podman ... permission denied", which its unreachable pattern also
  // matches, so permission wins there. Docker keeps its original single-pattern classification.
  if (cls === "daemonUnreachable")
    return profile.errors.daemonUnreachable.test(message) && !(profile.id === "podman" && TABLES.podman.socketPermission.test(message));
  return TABLES[profile.id][cls].test(message);
}

// The first class (in ORDER) the message belongs to, or undefined. The adapter asks about one class at a time through isEngineError;
// this is the table-wide view the fixtures use to prove a line lands in exactly the class it is filed under.
export function classifyEngineError(profile: EngineProfile, message: string): EngineErrorClass | undefined {
  return ORDER.find((cls) => isEngineError(profile, cls, message));
}

// The id an engine prints for an image, as the canonical `sha256:<64 hex>`, or undefined when the output is not an image id.
// Docker prints `sha256:<hex>` (on the containerd store it is the index or manifest digest, not the config digest). Podman prints
// the bare 64 hex of the config digest (P9, verified on Podman 6.2.0), so it is prefixed; Docker never prints a bare id.
export function normalizeImageId(profile: EngineProfile, raw: string): string | undefined {
  const id = raw.trim();
  if (/^sha256:[0-9a-f]{64}$/.test(id)) return id;
  return profile.id === "podman" && /^[0-9a-f]{64}$/.test(id) ? `sha256:${id}` : undefined;
}

export interface NetworkInspectView {
  driver: unknown;
  internal: unknown;
  options: Record<string, unknown> | null | undefined;
  labels: Record<string, unknown> | null | undefined;
}

// `network inspect --format {{json .}}` as one engine words it. Docker: one object with Driver, Internal, Options, Labels. Podman:
// lowercase driver, internal, options, labels, and `network inspect` may wrap the object in a one-element array. Returns the
// reason the output cannot be read, or the normalized fields.
export function networkInspectView(profile: EngineProfile, inspected: string): NetworkInspectView | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspected);
  } catch {
    return `${profile.binary} network inspect output is not JSON`;
  }
  const n = profile.id === "podman" && Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  if (!n || typeof n !== "object" || Array.isArray(n)) return `${profile.binary} network inspect output is not an object`;
  const o = n as Record<string, unknown>;
  const pick = (docker: string, podman: string): unknown => (profile.id === "podman" ? o[podman] : o[docker]);
  return {
    driver: pick("Driver", "driver"),
    internal: pick("Internal", "internal"),
    options: pick("Options", "options") as NetworkInspectView["options"],
    labels: pick("Labels", "labels") as NetworkInspectView["labels"],
  };
}

// Labels a sandbox container must carry to be adoptable by this adapter: the host and generation tags the contract stamps on every
// hosted resource (SANDBOX_TAGS). A container with the pomtree marker but without them predates that rule.
export const REQUIRED_SANDBOX_TAGS: readonly string[] = [SANDBOX_TAGS.host, SANDBOX_TAGS.generation];

export interface LabelledContainer {
  // The id the engine itself reports for the container (`ps -aq`), never a label value.
  engineId: string;
  // The container's full raw label map.
  labels: Readonly<Record<string, string>>;
}

// Engine ids of containers that carry the pomtree marker label but lack a required tag. There is no compatibility reader: the caller refuses.
export function findLegacyContainers(containers: readonly LabelledContainer[]): string[] {
  return containers
    .filter((c) => c.labels[LABEL] === "1" && REQUIRED_SANDBOX_TAGS.some((tag) => c.labels[tag] === undefined || c.labels[tag] === ""))
    .map((c) => c.engineId);
}

const LEGACY_LISTED = 3;
// What an engine container id looks like (short 12 or full 64 hex). Anything else is never put into a command line.
const ENGINE_ID = /^[0-9a-f]{12,64}$/;
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// The refusal naming cause and action for the active engine. Pomtree never removes these containers itself. Only engine ids of the
// expected shape are embedded, quoted; at most LEGACY_LISTED are spelled out, so the text stays inside the daemon's message budget.
export function legacyContainerRefusal(profile: EngineProfile, engineIds: readonly string[]): string {
  const valid = engineIds.filter((id) => ENGINE_ID.test(id));
  const shown = valid.slice(0, LEGACY_LISTED).map(shellQuote);
  const hidden = engineIds.length - shown.length;
  const list = `${profile.binary} ps -a --filter label=${LABEL}=1`;
  const more = hidden > 0 ? ` (${hidden} more are not listed; list them with \`${list}\`)` : "";
  const action = shown.length
    ? `run \`${profile.binary} rm -f ${shown.join(" ")}\`${hidden > 0 ? " (then restart pomtreed to see the rest)" : ""}`
    : `find them with \`${list}\` and remove each with \`${profile.binary} rm -f <container id>\``;
  const n = engineIds.length;
  return (
    `${n} container${n === 1 ? "" : "s"} on the ${profile.id} engine predate${n === 1 ? "s" : ""} the ${REQUIRED_SANDBOX_TAGS.join(" and ")} labels this pomtreed stamps, ` +
    `so pomtreed cannot adopt, list or reclaim them safely${shown.length ? `: ${shown.join(", ")}` : ""}${more}. ` +
    `Pomtree never removes them itself: once you have checked they hold nothing you need, ${action} and start pomtreed again.`
  );
}
