// Image facts: paths, ports, env-name lists and protocol constants fixed by the agent image and the daemon/worker protocol. They
// are not parameters (nothing overrides them at run time; they change only with an image rebuild). Each reaches the container
// code through the generated container-contract.gen.ts copies (container-gen.ts), and the host imports them from here. Pure.

// The fixed PATH of every in-image child process (pomtree, Pi, Chromium).
export const FIXED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
// The in-image pomtree CLI entry.
export const CLI_POMTREE_MAIN = "/opt/pomtree/pomtree/src/main.ts";
// The sandbox is --network none, so an in-container `pomtree` reaches the daemon only through the egress proxy these names select;
// sandbox-docker proxyEnv sets exactly these, and the scrubbed pomtree child envs pass exactly these through.
export const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"] as const;
// Chromium's loopback DevTools port.
export const CDP_PORT = 9222;
// The in-image loopback bridge (node, argv: one port) that the loopback facet execs, and the only ports it may open.
export const LOOPBACK_BRIDGE_MAIN = "/opt/pomtree/loopback-bridge.ts";
export const LOOPBACK_PORTS = [CDP_PORT] as const;
// How long one in-image `pomtree` call (capture publish, finish) may run.
export const CLI_POMTREE_TIMEOUT_MS = 10_000;
// The in-container loopback port of the egress byte bridge (worker.ts), which proxyEnv points at.
export const EGRESS_PROXY_PORT = 3128;
// The egress proxy's unix socket: a volume mounted read-only at this directory in the worker.
export const EGRESS_SOCKET_DIR = "/run/pomtree-egress";
export const EGRESS_SOCKET_NAME = "proxy.sock";
// UTF-8 bytes of an agent's handoff summary (pomtree finish --summary): pomtreed's limit and the browser finish tool's cap.
export const MAX_HANDOFF_BYTES = 8 * 1024;
// Absolute paths of the node runtime and the Pi CLI in the image. Pi's shebang is `env node` (PATH lookup, and PATH leads with
// agent-writable directories), so Pi runs as NODE_BIN plus the realpath of PI_BIN, started by absolute path.
export const NODE_BIN = "/usr/local/bin/node";
export const PI_BIN = "/usr/local/bin/pi";
// Chromium's own egress listener : a second sidecar socket without relay authorities, bridged to this
// loopback port in the browser worker. Chromium's --proxy-server points here, never at EGRESS_PROXY_PORT, which reaches the relays.
export const EGRESS_BROWSER_PROXY_PORT = 3129;
export const EGRESS_BROWSER_SOCKET_NAME = "proxy-browser.sock";
