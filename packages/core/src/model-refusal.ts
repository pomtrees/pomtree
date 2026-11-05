// The one definition of the refusals the model proxy returns that the harness and the daemon must recognize. The proxy
// embeds `modelRefusalTag(code)` in its error text; consumers parse it back with `modelRefusalCodeIn`, never by matching
// free prose, so rewording a message cannot silently break classification.

export const MODEL_REFUSAL_CODES = ["model_budget_exhausted", "malformed_tool_arguments"] as const;
export type ModelRefusalCode = (typeof MODEL_REFUSAL_CODES)[number];

/** The human-readable phrase leading a budget refusal's message. */
export const MODEL_BUDGET_REFUSAL_MESSAGE = "model budget exhausted";

const TAG_PREFIX = "[pomtree-refusal:";
const TAG_RE = /\[pomtree-refusal:([a-z_]+)\]/g;

/** The stable machine-readable marker for `code`, e.g. `[pomtree-refusal:model_budget_exhausted]`. */
export function modelRefusalTag(code: ModelRefusalCode): string {
  return `${TAG_PREFIX}${code}]`;
}

/** The first known refusal code tagged in `text`, or undefined when there is none (unknown codes are ignored). */
export function modelRefusalCodeIn(text: string): ModelRefusalCode | undefined {
  for (const m of text.matchAll(TAG_RE)) {
    const code = m[1] as ModelRefusalCode;
    if ((MODEL_REFUSAL_CODES as readonly string[]).includes(code)) return code;
  }
  return undefined;
}
