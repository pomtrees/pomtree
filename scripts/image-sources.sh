# Sourced (not executed) by scripts/pomtree-up and scripts/live/gate-series.sh: what the agent image is built from, and whether an image's
# revision label still describes the current checkout. One definition so the two scripts cannot drift.
#
# IMGSRC is everything the image is built from: the Dockerfile's COPY set (agent-image, sandbox-docker's proxy sources,
# packages/pomtree, and packages/harness-pi/src/agent-guide.md), pomtree's one workspace dep (packages/core), and the two root
# files build.ts reads (tsconfig.base.json for the bundle compile, package.json for the version it bakes). Widen it if the
# build context widens (packages/e2e/src/image-sources.test.ts fails when a Dockerfile COPY source falls outside it).
# packages/observe is deliberately NOT here: pomtree does not depend on it, so it is not in the image.
IMGSRC="packages/agent-image packages/sandbox-docker packages/pomtree packages/core packages/harness-pi/src/agent-guide.md tsconfig.base.json package.json"

# image_label_current <repo-root> <label>: returns 0 when the label (a short or full sha) is HEAD, or an ancestor of HEAD with no
# change under IMGSRC between it and HEAD; non-zero otherwise (empty or unresolvable label, a commit not in this history, an image
# source changed). Prints nothing and never exits the shell.
image_label_current() {
  local repo="$1" lbl="$2" full head
  [ -n "$lbl" ] || return 1
  full="$(git -C "$repo" rev-parse --verify -q "$lbl^{commit}" 2>/dev/null)" || return 1
  head="$(git -C "$repo" rev-parse --verify -q HEAD 2>/dev/null)" || return 1
  [ "$full" = "$head" ] && return 0
  git -C "$repo" merge-base --is-ancestor "$full" "$head" 2>/dev/null || return 1
  # shellcheck disable=SC2086 # IMGSRC is a space-separated path list
  [ -z "$(git -C "$repo" diff --name-only "$full" "$head" -- $IMGSRC 2>/dev/null)" ]
}
