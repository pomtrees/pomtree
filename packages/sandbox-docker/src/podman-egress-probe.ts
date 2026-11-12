// Whether the connected Podman can run the egress sidecar path (see PODMAN_SIDECAR_NETWORK in args.ts). The answer comes from the
// engine's own `podman info`, so it holds when the CLI reaches a remote or machine engine through CONTAINER_HOST; running `pasta` on
// the daemon host would describe the wrong machine. Supported means all of: rootless, Podman >= 5.3, the pasta network backend, and a
// pasta build with --map-host-loopback. Anything unreadable or unrecognised is unsupported (fail closed).
//
// The daemon runs this once at boot (probeLocalBackend in pomtreed) and narrows PODMAN_DECLARATION with the result: a backend's readiness probe may
// only withhold capabilities it declares true (checkProbe in @pomtree/core), which Podman does for both egress capabilities.
import type { ProbeResult } from "@pomtree/core";
import type { LocalEngine } from "./local-engine.ts";

// Podman 5.3 is the first release that uses pasta's --map-guest-addr by default for host.containers.internal (Podman RELEASE_NOTES,
// 5.3.0). Observed live on Podman 5.7.0: /etc/hosts maps both host.containers.internal and host.docker.internal to 169.254.1.2.
// The 5.3 floor for host.docker.internal rests on that observation, not on the release notes.
export const PODMAN_EGRESS_MIN_MAJOR = 5;
export const PODMAN_EGRESS_MIN_MINOR = 3;
// First pasta (passt) release the probe accepts, as YYYYMMDD: --map-host-loopback arrived in passt commit e813a4df, first released as
// 2024_08_21.1d6142f (Debian 0.0~git20240821.1d6142f-1).
export const PASTA_MIN_BUILD = 20240821;

export const podmanEgressInfoArgs = (): string[] => ["info", "--format", "json"];

export type PodmanEgressSupport = { supported: true } | { supported: false; cause: string; action: string };

const ACTION = "use rootless Podman >= 5.3 with the pasta network backend and passt build 2024_08_21 or newer (it provides --map-host-loopback), or use Docker";
const no = (cause: string): PodmanEgressSupport => ({ supported: false, cause, action: ACTION });

// passt build id as YYYYMMDD from the release form `pasta 2024_09_06.6b38f07` or the Debian snapshot form `0.0~git20260120.386b5f5`.
export function pastaBuildDate(versionText: string): number | undefined {
  const m = /(\d{4})_(\d{2})_(\d{2})/.exec(versionText) ?? /git(\d{4})(\d{2})(\d{2})/.exec(versionText);
  if (!m) return undefined;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? Number(`${m[1]}${m[2]}${m[3]}`) : undefined;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

// Judge `podman info --format json` output.
export function checkPodmanEgress(infoJson: string): PodmanEgressSupport {
  let info: Record<string, unknown> | undefined;
  try {
    info = obj(JSON.parse(infoJson));
  } catch {
    info = undefined;
  }
  if (!info) return no("`podman info --format json` did not return a JSON object, so the egress setup cannot be checked");
  const host = obj(info.host);
  const version = obj(info.version)?.Version;
  if (!host || typeof version !== "string") return no("`podman info` carries no host or version section, so the egress setup cannot be checked");
  const mm = /^(\d+)\.(\d+)(?:\.\d+)?(-.*)?$/.exec(version);
  const major = Number(mm?.[1]);
  const minor = Number(mm?.[2]);
  // A pre-release of the floor release itself (5.3.0-dev, -rc1) may predate the change that floor relies on: refuse it (fail closed).
  const preFloor = major === PODMAN_EGRESS_MIN_MAJOR && minor === PODMAN_EGRESS_MIN_MINOR && !!mm?.[3];
  if (!mm || preFloor || !(major > PODMAN_EGRESS_MIN_MAJOR || (major === PODMAN_EGRESS_MIN_MAJOR && minor >= PODMAN_EGRESS_MIN_MINOR)))
    return no(
      `Podman ${version} is older than ${PODMAN_EGRESS_MIN_MAJOR}.${PODMAN_EGRESS_MIN_MINOR} (or its version is unreadable), which does not map host.docker.internal to the pasta host-loopback address`,
    );
  if (obj(host.security)?.rootless !== true) return no("rootful Podman is not supported for egress (the sidecar relies on rootless user namespaces and pasta)");
  if (host.rootlessNetworkCmd !== "pasta")
    return no(
      `the rootless network backend is ${JSON.stringify(host.rootlessNetworkCmd ?? "unreported")}, not pasta (slirp4netns is not supported for egress)`,
    );
  const text = obj(host.pasta)?.version;
  const build = typeof text === "string" ? pastaBuildDate(text) : undefined;
  if (build === undefined) return no("the pasta version is not reported or not recognised, so --map-host-loopback support cannot be confirmed");
  if (build < PASTA_MIN_BUILD) return no(`pasta build ${build} predates ${PASTA_MIN_BUILD} and lacks --map-host-loopback`);
  return { supported: true };
}

// The readiness-probe result for a support verdict: unsupported withholds both egress capabilities (a narrowing, not a readiness problem).
export function podmanEgressProbeResult(s: PodmanEgressSupport): ProbeResult {
  return { withheld: s.supported ? [] : ["egress.denyAll", "egress.allowHost"], problems: [], account: null };
}

// Reads the engine and judges it. A failing `podman info` is unsupported with the CLI's own error in the cause.
export async function probePodmanEgress(engine: Pick<LocalEngine, "output">): Promise<{ support: PodmanEgressSupport; result: ProbeResult }> {
  let support: PodmanEgressSupport;
  try {
    support = checkPodmanEgress(await engine.output(podmanEgressInfoArgs(), { timeoutMs: 5000 }));
  } catch (err) {
    support = no(`podman info failed (${err instanceof Error ? err.message : String(err)}), so the egress setup cannot be checked`);
  }
  return { support, result: podmanEgressProbeResult(support) };
}
