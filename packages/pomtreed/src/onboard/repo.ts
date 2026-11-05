// Part B of `pomtreed init`: the per-repository answers (agent templates and schedules). Shape checks, the canonical template file text and
// the `pomtree sched add` commands for the user to run. Pure; the template store itself validates the files (template-check.ts).
import { isAbsolute, relative, sep } from "node:path";

export interface TemplateAnswer {
  id: string;
  egress: { kind: "none" } | { kind: "registry" } | { kind: "allowlist"; hosts: string[] };
  systemPrompt?: string;
  provider?: string;
  model?: string;
  budgetMicros?: number;
  disposition?: { mode: string; ttlMs?: number };
}

export interface ScheduleAnswer {
  id: string;
  cron: string;
  task: string;
  tz?: string;
}

export interface RepoAnswers {
  templates: TemplateAnswer[];
  schedules: ScheduleAnswer[];
}

/** The template fields init offers. Each must be a key the template store handles (contract-drift test against HANDLED_TEMPLATE_KEYS). */
export const TEMPLATE_ANSWER_FIELDS = ["id", "systemPrompt", "egress", "provider", "model", "budgetMicros", "disposition"] as const;
const SCHEDULE_ANSWER_FIELDS = ["id", "cron", "task", "tz"] as const;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

export function parseRepoAnswers(doc: unknown): { ok: true; repo: RepoAnswers } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const repo: RepoAnswers = { templates: [], schedules: [] };
  if (doc === undefined) return { ok: true, repo };
  if (!isPlain(doc)) return { ok: false, errors: ['"repo" must be an object {templates, schedules}'] };
  for (const k of Object.keys(doc)) if (k !== "templates" && k !== "schedules") errors.push(`unknown repo field ${k}; allowed: templates, schedules`);
  const list = (key: "templates" | "schedules"): unknown[] => {
    const v = doc[key] ?? [];
    if (!Array.isArray(v)) {
      errors.push(`repo.${key} must be an array`);
      return [];
    }
    return v;
  };
  const seen = new Set<string>();
  for (const [i, raw] of list("templates").entries()) {
    const at = `repo.templates[${i}]`;
    if (!isPlain(raw)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    for (const k of Object.keys(raw))
      if (!(TEMPLATE_ANSWER_FIELDS as readonly string[]).includes(k)) errors.push(`${at}: unknown field ${k}; allowed: ${TEMPLATE_ANSWER_FIELDS.join(", ")}`);
    if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
      errors.push(`${at}.id must be letters, digits, - and _ (starting with a letter or digit): it names a file`);
      continue;
    }
    if (seen.has(raw.id)) errors.push(`${at}: duplicate template id ${raw.id}`);
    seen.add(raw.id);
    const t: TemplateAnswer = { id: raw.id, egress: { kind: "none" } };
    const e = raw.egress;
    if (e === "none" || e === "registry") t.egress = { kind: e };
    else if (isPlain(e) && (e.kind === "none" || e.kind === "registry") && Object.keys(e).length === 1) t.egress = { kind: e.kind };
    else if (isPlain(e) && e.kind === "allowlist" && Array.isArray(e.hosts) && e.hosts.length > 0 && e.hosts.every(nonEmpty))
      t.egress = { kind: "allowlist", hosts: e.hosts as string[] };
    else if (isPlain(e) && e.kind === "audited-public")
      errors.push(`${at}.egress audited-public is for browser workers only and is not offered by init; write that template by hand`);
    else errors.push(`${at}.egress is required: "none", "registry" or {"kind": "allowlist", "hosts": ["host", ...]}`);
    for (const k of ["systemPrompt", "provider", "model"] as const) {
      if (raw[k] === undefined) continue;
      if (nonEmpty(raw[k])) t[k] = raw[k];
      else errors.push(`${at}.${k} must be a non-empty string`);
    }
    if (raw.budgetMicros !== undefined) {
      if (typeof raw.budgetMicros === "number" && Number.isSafeInteger(raw.budgetMicros) && raw.budgetMicros >= 0) t.budgetMicros = raw.budgetMicros;
      else errors.push(`${at}.budgetMicros must be a non-negative integer of micro-dollars (1000000 = $1)`);
    }
    if (raw.disposition !== undefined) {
      const d = raw.disposition;
      if (typeof d === "string") t.disposition = { mode: d };
      else if (isPlain(d) && typeof d.mode === "string") t.disposition = { mode: d.mode, ...(typeof d.ttlMs === "number" && { ttlMs: d.ttlMs }) };
      else errors.push(`${at}.disposition must be "hold", "reap-on-exit" or {"mode", "ttlMs"?}`);
    }
    repo.templates.push(t);
  }
  const sched = new Set<string>();
  for (const [i, raw] of list("schedules").entries()) {
    const at = `repo.schedules[${i}]`;
    if (!isPlain(raw)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    for (const k of Object.keys(raw))
      if (!(SCHEDULE_ANSWER_FIELDS as readonly string[]).includes(k)) errors.push(`${at}: unknown field ${k}; allowed: ${SCHEDULE_ANSWER_FIELDS.join(", ")}`);
    for (const k of ["id", "cron", "task"] as const) if (!nonEmpty(raw[k])) errors.push(`${at}.${k} is required: a non-empty string`);
    if (raw.tz !== undefined && !nonEmpty(raw.tz)) errors.push(`${at}.tz must be a non-empty string when given`);
    if (nonEmpty(raw.id)) {
      if (sched.has(raw.id)) errors.push(`${at}: duplicate schedule id ${raw.id}`);
      sched.add(raw.id);
    }
    if (nonEmpty(raw.id) && nonEmpty(raw.cron) && nonEmpty(raw.task))
      repo.schedules.push({ id: raw.id, cron: raw.cron, task: raw.task, ...(nonEmpty(raw.tz) && { tz: raw.tz }) });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, repo };
}

/** Canonical template file text: fixed key order, 2-space JSON, trailing newline. The file stem is the id, so the id is not written. */
export function templateFileText(t: TemplateAnswer): string {
  const doc = {
    ...(t.systemPrompt !== undefined && { systemPrompt: t.systemPrompt }),
    egress: t.egress,
    ...(t.provider !== undefined && { provider: t.provider }),
    ...(t.model !== undefined && { model: t.model }),
    ...(t.budgetMicros !== undefined && { budgetMicros: t.budgetMicros }),
    ...(t.disposition !== undefined && { disposition: t.disposition }),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** `pomtree sched add <id> '<cron>' '<task>' [--tz <tz>]`, shell-quoted, for the user to run once the daemon is up. */
export function scheduleCommand(s: ScheduleAnswer): string {
  return `pomtree sched add ${shq(s.id)} ${shq(s.cron)} ${shq(s.task)}${s.tz !== undefined ? ` --tz ${shq(s.tz)}` : ""}`;
}

/** A path or word as it appears in a printed command: bare when plain, else single-quoted. */
export const shellWord = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : shq(s));

/** Whether `child` is `parent` or inside it (both realpaths). */
export const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Why `repo` cannot be the target repository given the pomtree checkout (both realpaths), or null. The checkout itself (or a
 * directory inside it) is the setup's own code, not a repository for agents; a checkout inside the target would let merged work
 * change the daemon's own code. Shared by preflight and init so both refuse the same thing.
 */
export function targetRepoRefusal(repo: string, checkout: string): string | null {
  if (within(repo, checkout))
    return `${repo} is the pomtree checkout (or inside it), not the repository agents work on; pass --repo with the target repository's path`;
  if (within(checkout, repo))
    return `the pomtree checkout ${checkout} is inside ${repo}: work agents merge there could change the daemon's own code; keep the checkout outside the target repository`;
  return null;
}
