# shellcheck shell=bash
# Container engine CLI for the live drivers. Source this file; it sets ENGINE (docker or podman) and defines image_id.
# One source of truth: the daemon's own selector POMTREED_SANDBOX_BACKEND (unset means docker), read as `${NAME-}` like the other operator overrides.
# `auto` and unknown values are refused: a driver must know which CLI to snapshot and leak-grep, and `auto` only resolves inside pomtreed.
ENGINE="${POMTREED_SANDBOX_BACKEND-}"; ENGINE="${ENGINE:-docker}"
case "$ENGINE" in
  docker | podman) ;;
  *) echo "POMTREED_SANDBOX_BACKEND=$ENGINE is not supported by the live scripts; set it to docker or podman (auto cannot tell them which CLI to use), or unset it for docker" >&2; exit 2 ;;
esac
# image_id <image>: the local image id as sha256:<hex>. Podman prints bare hex where Docker prints the prefix; fails when the image is absent.
image_id() {
  local id; id="$("$ENGINE" image inspect --format '{{.Id}}' "$1" 2>/dev/null | tr -d '\r\n')"
  case "$id" in
    sha256:????????????????????????????????????????????????????????????????) ;;
    ????????????????????????????????????????????????????????????????) [ "$ENGINE" = podman ] && id="sha256:$id" ;;
  esac
  [ -n "$id" ] || { echo "image $1 is not present locally in $ENGINE; build it (scripts/live/README.md) and rerun" >&2; return 1; }
  printf '%s\n' "$id"
}
# volume_label_format <key>: the `volume ls --format` template that prints one label's value. Docker takes `{{.Label "<key>"}}`; Podman 5.7.0 refuses `.Label` on a volume
# listing (exit 125, "can't evaluate field Label in type *types.VolumeListReport") and takes `{{index .Labels "<key>"}}`. `ps` takes `.Label` on both engines.
# packages/sandbox-docker's engine dialect makes the same per-engine choice for the adapter.
volume_label_format() {
  if [ "$ENGINE" = podman ]; then printf '{{index .Labels "%s"}}\n' "$1"; else printf '{{.Label "%s"}}\n' "$1"; fi
}
