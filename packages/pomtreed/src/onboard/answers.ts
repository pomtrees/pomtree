// Parses the `pomtreed init --answers` file and checks it covers every required and safety question. Registry values are checked later by
// the resolver itself (init.ts); this module only checks shape and completeness.
import { isAbsolute } from "node:path";
import type { Question } from "./questions.ts";
import { type RepoAnswers, parseRepoAnswers } from "./repo.ts";

export interface Answers {
  config: Record<string, unknown>;
  keyFile: string;
  output: "env" | "json";
  service: "systemd" | "none";
  repo: RepoAnswers;
}

export type ParsedAnswers = { ok: true; answers: Answers } | { ok: false; errors: string[] };

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `given`: config answers from the command line (`from` names the flag); each fills an unanswered key, and a different answer in the file is refused. */
export function parseAnswers(
  text: string,
  questions: readonly Question[],
  given: Readonly<Record<string, { value: string; from: string }>> = {},
): ParsedAnswers {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["answers file is not valid JSON; fix the syntax (see pomtreed init --questions --json for the shape)"] };
  }
  if (!isPlain(doc)) return { ok: false, errors: ["answers file must be a JSON object {config, keyFile, output, service}"] };
  const errors: string[] = [];
  for (const k of Object.keys(doc))
    if (!["config", "keyFile", "output", "service", "repo"].includes(k))
      errors.push(`unknown answers field ${k}; allowed: config, keyFile, output, service, repo`);
  const config = isPlain(doc.config) ? { ...doc.config } : (doc.config ?? {});
  if (!isPlain(config)) errors.push('"config" must be an object of registry path -> value');
  else
    for (const [k, g] of Object.entries(given)) {
      if (config[k] === undefined) config[k] = g.value;
      else if (config[k] !== g.value)
        errors.push(`${k}: the answers file says ${JSON.stringify(config[k])} but ${g.from} says ${JSON.stringify(g.value)}; keep one of them`);
    }
  const keyFile = doc.keyFile;
  if (keyFile !== undefined && (typeof keyFile !== "string" || !isAbsolute(keyFile))) errors.push('"keyFile" must be an absolute path');
  const output = doc.output ?? "env";
  if (output !== "env" && output !== "json") errors.push('"output" must be "env" or "json"');
  const service = doc.service ?? "none";
  if (service !== "systemd" && service !== "none") errors.push('"service" must be "systemd" or "none"');
  const repo = parseRepoAnswers(doc.repo);
  if (!repo.ok) errors.push(...repo.errors);
  for (const q of questions) {
    if (q.kind === "optional" || q.kind === "info") continue;
    if (q.sensitive) {
      if (keyFile === undefined) errors.push(`missing answer for ${q.id}: give "keyFile", the absolute path of a file that will hold the key`);
    } else if (!isPlain(config) || config[q.id] === undefined) errors.push(`missing answer for ${q.id} (${q.kind}): add it under "config"`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    answers: {
      config: config as Record<string, unknown>,
      keyFile: keyFile as string,
      output: output as Answers["output"],
      service: service as Answers["service"],
      repo: (repo as { repo: RepoAnswers }).repo,
    },
  };
}
