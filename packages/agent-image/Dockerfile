# Agent sandbox image. Build context is the repo root (see scripts/build.ts).
# Two targets (IMAGE_TARGETS in src/image-labels.ts): `full` (the default, last stage) and `demo`, the slim image for the E1
# fake-model demo (docs/demo.md, 'The slim image'). Layer order is for the build cache: `system` (apt, Pi,
# runtime env) and the full-only browser and toolchain layers change rarely, so they come first; everything that changes per commit is
# staged in the scratch stages `app` and `app-browser` and copied in last, so a source change never rebuilds the apt layers.
# Base image index digest (linux/amd64 + linux/arm64), captured 2026-10-03.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS system

# git: agent workspaces; curl: shell probes and downloads; ripgrep + fd-find: tools pi would otherwise try to download at run time
# (sandbox egress blocks that); Debian ships fd as `fdfind`, so symlink it to the name pi looks for.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep fd-find \
 && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# One Node-hosted Pi target, pinned by scripts/build.ts. Browser/CDP runs under Node, not Bun.
ARG PI_VERSION
ARG PI_NPM_INTEGRITY
# The pinned Pi version, read back by parseImageInspect (src/image-labels.ts PI_VERSION_LABEL) so a run states it from the image.
LABEL org.pomtree.pi.version=$PI_VERSION
RUN test -n "$PI_VERSION" && test -n "$PI_NPM_INTEGRITY" \
 && cd /tmp && npm pack --silent "@earendil-works/pi-coding-agent@$PI_VERSION" \
 && node -e 'const c=require("crypto"),f=require("fs");const got="sha512-"+c.createHash("sha512").update(f.readFileSync(process.argv[1])).digest("base64");if(got!==process.argv[2])throw Error("Pi integrity mismatch")' \
      "/tmp/earendil-works-pi-coding-agent-$PI_VERSION.tgz" "$PI_NPM_INTEGRITY" \
 && npm install -g --ignore-scripts --no-audit --no-fund "/tmp/earendil-works-pi-coding-agent-$PI_VERSION.tgz" \
 && rm -f /tmp/earendil-works-pi-coding-agent-*.tgz

# Runtime config, set after the Pi install above (npm_config_prefix and npm_config_cache would redirect it). The final user is set per target.
# The workspace mount supplies /workspace; per-agent package prefixes live under /workspace/.env. The node image already has uid 1000 (user `node`).
ENTRYPOINT ["/usr/local/bin/pomtree-entrypoint"]
ENV HOME=/home/node \
    PI_CODING_AGENT_DIR=/home/node/.pi/agent \
    PI_SKIP_VERSION_CHECK=1 \
    npm_config_prefix=/workspace/.env/npm \
    npm_config_cache=/opt/pomtree/env-layer/npm \
    PIP_USER=1 \
    PYTHONUSERBASE=/workspace/.env/pip \
    PIP_CACHE_DIR=/opt/pomtree/env-layer/pip \
    CARGO_HOME=/workspace/.env/cargo \
    PATH=/workspace/.env/npm/bin:/workspace/.env/pip/bin:/workspace/.env/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Everything that changes per commit, staged here so the target stages copy it in after their slow layers.
FROM scratch AS app
# The agent owns a private full clone and runs git itself; the entrypoint sets its per-agent author identity (env only).
COPY --chmod=0755 packages/agent-image/bin/pomtree-entrypoint /usr/local/bin/pomtree-entrypoint

# Background-job wrapper used by the pomtree-jobs Pi extension (TODO(background-jobs)).
COPY --chmod=0755 packages/agent-image/bin/pomtree-job-run /usr/local/bin/pomtree-job-run

# Immutable packaged sidecar source; never bind-mounted from a host checkout.
# Each flat COPY set carries its own generated container-contract.gen.ts (relative imports resolve only inside one set); the
# ext/pomtree-browser copy ships with the ext/ COPY below. Never hand-edited: `pnpm gen:config` writes them.
COPY packages/sandbox-docker/src/proxy.ts packages/sandbox-docker/src/audit.ts packages/sandbox-docker/src/worker.ts packages/sandbox-docker/src/worker-ready.ts packages/sandbox-docker/src/container-contract.gen.ts /opt/pomtree/egress/
COPY packages/agent-image/src/container-contract.gen.ts /opt/pomtree/container-contract.gen.ts

# pomtree's own src runs as TS via node's type stripping (it lives outside node_modules, which node
# refuses to strip). Its runtime deps on other workspace packages ship as compiled JS instead.
COPY packages/pomtree/package.json /opt/pomtree/pomtree/package.json
COPY packages/pomtree/src /opt/pomtree/pomtree/src
# Workspace packages pomtree imports at runtime (@pomtree/observe, ...), compiled to JS on the host
# by scripts/build.ts and injected as the `bundle` build context. node 24 refuses to type-strip TS
# under node_modules, so these must be real .js here. /node_modules is reachable from both pomtree's
# src (/opt/pomtree/pomtree/src) and the /workspace working dir.
COPY --from=bundle node_modules /node_modules

COPY packages/harness-pi/src/agent-guide.md /opt/pomtree/agent-guide.md

# Pi extension loadout (TODO(pi-ext)): per-tool shims that forward calls to the host gateway via
# `pomtree ext call <name>`. Loaded explicitly with --extension, never from agent-writable /workspace/.pi.
COPY packages/agent-image/ext /opt/pomtree/ext
# test-fixtures/ is NOT baked in: the Docker-gated suites bind-mount the offline provider read-only under /opt/pomtree/ext
# (sandbox-docker test-mounts.ts offlineBrowserExtMount), so the image carries no test extension the browser allowlist would admit.

# Pi's config dir (PI_CODING_AGENT_DIR) is NOT baked in: /home/node is a tmpfs at run time, and pomtreed bind-mounts
# a per-agent writable dir there holding a copy of auth.json plus a read-only settings.json (trust "never").
# Pi creates auth.json.lock beside auth.json, so that dir must be writable by uid 1000 (see pomtreed pi-auth.ts).

FROM scratch AS app-browser
COPY packages/agent-image/src/browser-run.ts /opt/pomtree/browser-run.ts
COPY packages/agent-image/src/browser-capture.ts /opt/pomtree/browser-capture.ts
COPY packages/agent-image/src/main-content.ts /opt/pomtree/main-content.ts
# The model-free capture worker: run as `/usr/local/bin/node /opt/pomtree/capture-worker.ts`, no Pi.
# It imports browser-run.ts, browser-capture.ts and main-content.ts above, the CDP recorder, and the pure WARC/WACZ format modules.
COPY packages/agent-image/src/capture-worker.ts packages/agent-image/src/cdp-recorder.ts packages/agent-image/src/capture-types.ts packages/agent-image/src/warc.ts packages/agent-image/src/cdxj.ts packages/agent-image/src/zip.ts packages/agent-image/src/wacz.ts /opt/pomtree/

# The slim demo image (docs/demo.md, 'The slim image'): Pi, pomtree, git, the egress sidecar and the extension loadout, nothing browser- or toolchain-related.
FROM system AS demo
# Per-commit layers, last. The revision (short git sha) is supplied by scripts/build.ts; surfaced as an OCI label and the
# /opt/pomtree/pomtree/revision file so `pomtree --version` reports `v<version> (<sha>)`.
COPY --from=app / /
ARG AGENT_REVISION
ARG AGENT_VERSION
LABEL org.opencontainers.image.revision=$AGENT_REVISION
RUN printf '#!/bin/sh\nexec /usr/local/bin/node /opt/pomtree/pomtree/src/main.ts "$@"\n' > /usr/local/bin/pomtree \
 && chmod 0755 /usr/local/bin/pomtree \
 && printf '%s' "$AGENT_REVISION" > /opt/pomtree/pomtree/revision && printf '%s' "$AGENT_VERSION" > /opt/pomtree/pomtree/version
USER 1000:1000
# After USER so /workspace is created owned by uid 1000.
WORKDIR /workspace

# The full image (default target): adds the browser (Chromium, fonts, pi-browser, the capture worker) and the toolchains agents install with.
FROM system AS full
# Root for the installs below (the node image's default). npm's cache env points at the env-layer mount path, so `npm ci` uses a throwaway cache instead.
# python3/pip: pip installs; cargo + build-essential: cargo installs and native npm/pip builds; chromium + fonts: the browser.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip cargo build-essential chromium fonts-noto-cjk fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# Reviewed community browser extension. Its lockfile pins Playwright; no browser download/scripts.
RUN git clone --quiet https://github.com/larsderidder/pi-browser /opt/pomtree/pi-browser \
 && cd /opt/pomtree/pi-browser \
 && git checkout --quiet 32b5baaf7ca0d6258b1d0841cff9c6c88aafff2b \
 && test "$(git rev-parse HEAD)" = 32b5baaf7ca0d6258b1d0841cff9c6c88aafff2b \
 && rm -rf .git \
 && npm ci --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund --cache /tmp/npm-ci-cache \
 && rm -rf /tmp/npm-ci-cache

# Per-commit layers, last. The revision (short git sha) is supplied by scripts/build.ts; surfaced as an OCI label and the
# /opt/pomtree/pomtree/revision file so `pomtree --version` reports `v<version> (<sha>)`.
COPY --from=app / /
ARG AGENT_REVISION
ARG AGENT_VERSION
LABEL org.opencontainers.image.revision=$AGENT_REVISION
RUN printf '#!/bin/sh\nexec /usr/local/bin/node /opt/pomtree/pomtree/src/main.ts "$@"\n' > /usr/local/bin/pomtree \
 && chmod 0755 /usr/local/bin/pomtree \
 && printf '%s' "$AGENT_REVISION" > /opt/pomtree/pomtree/revision && printf '%s' "$AGENT_VERSION" > /opt/pomtree/pomtree/version
COPY --from=app-browser / /
USER 1000:1000
# After USER so /workspace is created owned by uid 1000.
WORKDIR /workspace
