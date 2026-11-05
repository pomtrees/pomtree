// A tiny flag parser for the onboarding subcommands (`pomtreed preflight`, `pomtreed init`): declared boolean and value flags, `--flag value`
// or `--flag=value`, every problem collected so the operator fixes them in one pass. Pure.
export interface FlagSpec {
  bools: readonly string[];
  values: readonly string[];
}

export interface ParsedFlags {
  bools: ReadonlySet<string>;
  values: ReadonlyMap<string, string>;
  positional: string[];
  errors: string[];
}

export function parseFlags(argv: readonly string[], spec: FlagSpec): ParsedFlags {
  const bools = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    if (spec.bools.includes(name)) {
      if (eq !== -1) errors.push(`${name} takes no value`);
      else bools.add(name);
    } else if (spec.values.includes(name)) {
      const next = argv[i + 1];
      const v = eq !== -1 ? a.slice(eq + 1) : next !== undefined && !next.startsWith("--") ? next : undefined;
      if (v === undefined) errors.push(`${name} needs a value`);
      else {
        if (eq === -1) i++;
        values.set(name, v);
      }
    } else errors.push(`unknown option ${name}`);
  }
  return { bools, values, positional, errors };
}
