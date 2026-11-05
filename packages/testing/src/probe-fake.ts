// Structural twin of pomtreed's ProbeRunner (onboard/probes.ts; testing depends on core only, so it cannot import pomtreed).
// TODO(onboard-probe-port): ProbeRunner belongs in core ports.ts so the fake can implement it nominally; current: structural type in pomtreed, the fake in @pomtree/testing matches it structurally.
export interface FakeProbeResult {
  code: number | null; // null = not on PATH / could not spawn / timed out
  stdout: string;
  stderr: string;
}

export interface FakeProbeOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

// Scripts host command results keyed by "<command> <args joined by space>" (exact match) and records every call with the options
// it was given (only those given). An unscripted command behaves as one that is not on PATH ({ code: null }), so a test names
// exactly the tools the host "has".
export class FakeProbeRunner {
  readonly calls: Array<{ command: string; args: readonly string[] } & FakeProbeOptions> = [];
  private readonly script: Map<string, FakeProbeResult>;

  constructor(script: Record<string, FakeProbeResult> = {}) {
    this.script = new Map(Object.entries(script));
  }

  async run(command: string, args: readonly string[], opts: FakeProbeOptions = {}): Promise<FakeProbeResult> {
    this.calls.push({
      command,
      args,
      ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
      ...(opts.cwd !== undefined && { cwd: opts.cwd }),
      ...(opts.env !== undefined && { env: opts.env }),
    });
    return this.script.get([command, ...args].join(" ")) ?? { code: null, stdout: "", stderr: "" };
  }
}
