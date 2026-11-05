import { createHash } from "node:crypto";
import type { Template } from "./types.ts";

// Canonical JSON: object keys sorted recursively, undefined dropped, so equal templates hash equally.
export function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]),
    );
  }
  return v;
}

// sha256 hex of the template's canonical JSON; recorded in SpawnSpec and Checkpoint so a resume can
// tell which template an agent ran as.
export function templateDigest(t: Template): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(t)))
    .digest("hex");
}

// A template's systemPrompt reaches Pi as one argv value (`--append-system-prompt`): bounded in UTF-8 bytes (well under the 128 KiB Linux
// single-argument limit) and free of NUL, which no argv can carry. Returns the refusal reason, or undefined when acceptable.
export const SYSTEM_PROMPT_MAX_BYTES = 32_768;
export function systemPromptProblem(text: string): string | undefined {
  if (text.includes("\0")) return "systemPrompt must not contain NUL";
  if (Buffer.byteLength(text, "utf8") > SYSTEM_PROMPT_MAX_BYTES) return `systemPrompt must be at most ${SYSTEM_PROMPT_MAX_BYTES} bytes`;
  return undefined;
}

// Inclusive integer ranges a browser worker accepts. Mirror of `browserLimits` in packages/agent-image/src/browser-run.ts,
// which rejects anything outside them at container start; agent-image cannot import core, so keep the two in step.
export const BROWSER_MAX_STEPS_RANGE = { min: 1, max: 256 } as const;
export const BROWSER_MAX_MS_RANGE = { min: 1000, max: 600_000 } as const;

// One rule set for a result disposition (a spawn request's and a template's). Returns the refusal reason, or null when acceptable.
export function dispositionError(d: unknown): string | null {
  if (d === null || typeof d !== "object" || Array.isArray(d)) return 'disposition must be an object {mode: "hold" | "reap-on-exit", ttlMs?}';
  const { mode, ttlMs } = d as { mode?: unknown; ttlMs?: unknown };
  if (mode !== "hold" && mode !== "reap-on-exit") return `disposition.mode must be "hold" or "reap-on-exit": ${JSON.stringify(mode)}`;
  if (ttlMs === undefined) return null;
  if (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs <= 0)
    return "disposition.ttlMs must be a positive safe integer number of milliseconds";
  if (mode !== "hold") return "disposition.ttlMs applies only to mode hold; drop ttlMs or use mode hold";
  return null;
}
