// Text renderers for `pomtreed init`: the env file (systemd EnvironmentFile syntax that a POSIX shell can also source), the nested JSON
// config file (the shape resolve.ts reads from $POMTREED_CONFIG), and the systemd unit rendered from deploy/pomtreed.service. Pure.
// TODO(onboard-launchd): launchd plist rendering from deploy/io.github.pomtrees.pomtreed.plist is not built; current: service "systemd" or "none" only

const PLAIN = /^[A-Za-z0-9_@%+=:,./-]*$/;

/** One `NAME=value` line. A value with other characters is single-quoted (valid for systemd and sh alike); a value with `'` or a newline is refused. */
export function envLine(name: string, value: string): string {
  if (/[\n\r]/.test(value) || value.includes("'"))
    throw new Error(
      `${name}: the value contains a newline or a single quote, which an env file cannot carry safely; use output "json" (pomtreed.json) for this key or change the value`,
    );
  return `${name}=${PLAIN.test(value) ? value : `'${value}'`}`;
}

/** The inverse of envLine over a whole file; comment and blank lines are skipped. */
export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`env file line is not NAME=value: ${line}`);
    const raw = line.slice(eq + 1);
    env[line.slice(0, eq)] = raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
  }
  return env;
}

/** A registry value as env text: lists comma-joined, structures JSON, scalars as written. */
export function envValue(value: unknown): string {
  if (Array.isArray(value) && value.every((x) => typeof x === "string")) return value.join(",");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/** Dotted paths to the nested object resolve.ts reads; canonical JSON with a trailing newline. */
export function nestedConfigJson(config: Readonly<Record<string, unknown>>): string {
  const root: Record<string, unknown> = {};
  for (const path of Object.keys(config).sort()) {
    const segments = path.split(".");
    let node = root;
    for (const s of segments.slice(0, -1)) {
      const next = node[s];
      if (typeof next === "object" && next !== null) node = next as Record<string, unknown>;
      else {
        const child: Record<string, unknown> = {};
        node[s] = child;
        node = child;
      }
    }
    node[segments[segments.length - 1] as string] = config[path];
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

export interface ServicePaths {
  checkout: string;
  node: string;
  envFile: string;
  stateDir: string;
  repoDir: string;
}

const UNIT_LINES: { prefix: string; text: (p: ServicePaths) => string }[] = [
  { prefix: "ExecStart=", text: (p) => `ExecStart=${p.node} ${p.checkout}/packages/pomtreed/src/main.ts` },
  { prefix: "WorkingDirectory=", text: (p) => `WorkingDirectory=${p.checkout}` },
  { prefix: "EnvironmentFile=", text: (p) => `EnvironmentFile=${p.envFile}` },
  { prefix: "Environment=POMTREED_STATE_DIR=", text: (p) => `Environment=POMTREED_STATE_DIR=${p.stateDir}` },
  { prefix: "Environment=POMTREED_REPO_DIR=", text: (p) => `Environment=POMTREED_REPO_DIR=${p.repoDir}` },
  { prefix: "ReadWritePaths=", text: (p) => `ReadWritePaths=${p.stateDir} ${p.repoDir}` },
];

/** deploy/pomtreed.service with the host-specific lines replaced; throws naming the line when the template lacks one. */
export function renderService(template: string, paths: ServicePaths): string {
  for (const [k, v] of Object.entries(paths))
    if (/[\s%]/.test(v))
      throw new Error(
        `service path ${k}=${JSON.stringify(v)} contains whitespace or %, which the unit file cannot carry unescaped; choose a path without them`,
      );
  const lines = template.split("\n");
  for (const u of UNIT_LINES) {
    const i = lines.findIndex((l) => l.startsWith(u.prefix));
    if (i === -1)
      throw new Error(
        `deploy/pomtreed.service has no ${u.prefix} line to replace; the renderer and the template have drifted, update render.ts or the template`,
      );
    lines[i] = u.text(paths);
  }
  return lines.join("\n");
}
