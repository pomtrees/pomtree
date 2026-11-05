import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AllowlistProfile, BrowserLimits, EgressPolicy, ResultDisposition, ResumeLevel, Template, TemplateId, TemplateStore } from "@pomtree/core";
import {
  ALLOWLIST_PROFILES,
  BROWSER_MAX_MS_RANGE,
  BROWSER_MAX_STEPS_RANGE,
  BROWSER_PROFILES,
  TemplateError,
  allowlistTemplateProblem,
  dispositionError,
  isAllowlistProfile,
  isBrowserProfile,
  systemPromptProblem,
} from "@pomtree/core";

const EXT = ".json";

// Known agent-side extension names a template may reference in its `extensions` loadout.
// These are the in-repo Pi extensions only (TODO(pi-ext)); a template may only opt into this
// allowlist, never an arbitrary third-party source.
export const KNOWN_EXTENSIONS: readonly string[] = ["web_search", "web_fetch"];

// Same traversal-guard idiom as report-dir/GitWorkspace.dir: reject separators, NUL, `..`,
// and leading `-`/`.` so no caller-supplied name can escape the store root.
function valid(part: string): boolean {
  return !!part && !/[\/\\\0]/.test(part) && !part.includes("..") && !part.startsWith("-") && !part.startsWith(".");
}

// `lstat` never follows the final component, so a symlinked template file reads as "not a regular
// file" — we refuse to follow symlinks anywhere inside the store.
function lstatOrNull(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function bad(name: TemplateId, why: string): TemplateError {
  return new TemplateError(`${name}: ${why}` as TemplateId);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// A template image must be a pinned digest reference (`repo@sha256:<64 hex>`). The `@` digest form
// is immutable, so a checkpoint or resume can never start a different image than the template
// pinned; tag-only or `:latest` refs are rejected. The name before `@` must be non-empty and there
// must be exactly one `@` (the digest separator).
const DIGEST_SUFFIX = /^sha256:[0-9a-fA-F]{64}$/;
function isPinnedDigest(image: string): boolean {
  const at = image.indexOf("@");
  return at > 0 && at === image.lastIndexOf("@") && DIGEST_SUFFIX.test(image.slice(at + 1));
}

// Exhaustiveness guard: every Template key is either read by `validate` ("read") or deliberately dropped ("ignored"). Adding a key
// to core's Template without classifying it here fails the build, so a field can no longer be silently dropped by validation.
const TEMPLATE_KEY_HANDLING = {
  id: "read",
  name: "read",
  image: "read",
  env: "read",
  extensions: "read",
  provider: "read",
  model: "read",
  budgetMicros: "read",
  memoryBytes: "read",
  cpus: "read",
  shmBytes: "read",
  diskBytes: "read",
  systemPrompt: "read",
  egress: "read",
  resume: "read",
  requires: "read",
  browser: "read",
  allowlist: "read",
  disposition: "read",
  runtime: "read",
} as const satisfies Record<keyof Template, "read" | "ignored">;
export const HANDLED_TEMPLATE_KEYS = Object.keys(TEMPLATE_KEY_HANDLING) as (keyof Template)[];

// Validate a parsed manifest and normalize it into a `Template`. Throws TemplateError on any
// shape or constraint violation; the file stem (the store key) is the authoritative id.
function validate(name: TemplateId, raw: unknown): Template {
  if (!isObj(raw)) throw bad(name, "manifest must be a JSON object");
  if (raw.name !== undefined && raw.name !== name) throw bad(name, `name ${JSON.stringify(raw.name)} does not match the file stem`);
  if (raw.image !== undefined) {
    if (typeof raw.image !== "string" || !raw.image) throw bad(name, "image must be a non-empty string");
    if (!isPinnedDigest(raw.image)) throw bad(name, `image must be a pinned digest (repo@sha256:<hex>): ${JSON.stringify(raw.image)}`);
  }
  if (raw.systemPrompt !== undefined && typeof raw.systemPrompt !== "string") throw bad(name, "systemPrompt must be a string");
  if (typeof raw.systemPrompt === "string") {
    const problem = systemPromptProblem(raw.systemPrompt);
    if (problem !== undefined) throw bad(name, problem);
  }
  if (raw.provider !== undefined && (typeof raw.provider !== "string" || !raw.provider)) throw bad(name, "provider must be a non-empty string");
  if (raw.model !== undefined && (typeof raw.model !== "string" || !raw.model)) throw bad(name, "model must be a non-empty string");
  // provider requires model (piArgv and every model gateway need a model to select).
  if (raw.provider !== undefined && raw.model === undefined) throw bad(name, "provider requires model");

  let extensions: string[] = [];
  if (raw.extensions !== undefined) {
    if (!Array.isArray(raw.extensions) || raw.extensions.some((x) => typeof x !== "string" || !x)) {
      throw bad(name, "extensions must be an array of strings");
    }
    for (const x of raw.extensions as string[]) {
      if (!KNOWN_EXTENSIONS.includes(x)) throw bad(name, `unknown extension ${JSON.stringify(x)}`);
    }
    extensions = [...new Set(raw.extensions as string[])];
  }

  const num = (v: unknown, what: string) => {
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw bad(name, `${what} must be a non-negative number`);
    return v;
  };
  const shmBytes = num(raw.shmBytes, "shmBytes");
  const budgetMicros = num(raw.budgetMicros, "budgetMicros");
  const memoryBytes = num(raw.memoryBytes, "memoryBytes");
  const cpus = num(raw.cpus, "cpus");
  const diskBytes = num(raw.diskBytes, "diskBytes");

  if (raw.resume !== undefined && raw.resume !== "session" && raw.resume !== "task" && raw.resume !== "none") {
    throw bad(name, `resume must be "session", "task" or "none": ${JSON.stringify(raw.resume)}`);
  }
  if (raw.disposition !== undefined) {
    const problem = dispositionError(raw.disposition);
    if (problem !== null) throw bad(name, problem);
  }
  let requires: string[] = [];
  if (raw.requires !== undefined) {
    if (!Array.isArray(raw.requires) || raw.requires.some((x) => typeof x !== "string" || !x)) {
      throw bad(name, "requires must be an array of non-empty strings");
    }
    requires = [...new Set(raw.requires as string[])];
  }
  // `runtime` is the adapter's opaque block: core only requires it to be a plain JSON object.
  if (raw.runtime !== undefined && !isObj(raw.runtime)) throw bad(name, "runtime must be an object");

  // A template with no explicit egress normalizes to `none` (deny all): a template that does not opt
  // in to network access gets none.
  let egress: EgressPolicy = { kind: "none" };
  if (raw.egress !== undefined) {
    if (!isObj(raw.egress)) throw bad(name, "egress must be an object");
    switch (raw.egress.kind) {
      case "none":
      case "registry":
        egress = { kind: raw.egress.kind };
        break;
      case "audited-public":
        // Explicit operator opt-in only (never a default). The policy carries no fields: any extra key is rejected.
        if (Object.keys(raw.egress).some((k) => k !== "kind")) throw bad(name, "egress.audited-public takes no fields besides kind");
        egress = { kind: "audited-public" };
        break;
      case "allowlist": {
        const hosts = raw.egress.hosts;
        if (!Array.isArray(hosts) || hosts.some((h) => typeof h !== "string" || !h)) {
          throw bad(name, "egress.allowlist.hosts must be an array of non-empty strings");
        }
        egress = { kind: "allowlist", hosts: [...new Set(hosts as string[])] };
        break;
      }
      default:
        throw bad(name, `unknown egress kind: ${JSON.stringify(raw.egress.kind)}`);
    }
  }

  // `browser` makes the container a browser worker whose only network path is the audited proxy, so it requires audited-public egress.
  let browser: BrowserLimits | undefined;
  if (raw.browser !== undefined) {
    const b = raw.browser;
    if (!isObj(b)) throw bad(name, "browser must be an object");
    const unknown = Object.keys(b).find((k) => k !== "maxSteps" && k !== "maxMs" && k !== "profile");
    if (unknown !== undefined) throw bad(name, `unknown browser key ${JSON.stringify(unknown)}`);
    const int = (v: unknown, what: string, r: { min: number; max: number }) => {
      if (typeof v !== "number" || !Number.isInteger(v) || v < r.min || v > r.max) throw bad(name, `browser.${what} must be an integer in ${r.min}..${r.max}`);
      return v;
    };
    browser = { maxSteps: int(b.maxSteps, "maxSteps", BROWSER_MAX_STEPS_RANGE), maxMs: int(b.maxMs, "maxMs", BROWSER_MAX_MS_RANGE) };
    // `profile` names a closed browser profile (BROWSER_PROFILES); absent keeps the capture-only worker. An unknown name is refused, never a fallback.
    if (b.profile !== undefined) {
      if (!isBrowserProfile(b.profile)) throw bad(name, `browser.profile must be one of ${BROWSER_PROFILES.join(", ")}: ${JSON.stringify(b.profile)}`);
      browser.profile = b.profile;
    }
    if (egress.kind !== "audited-public") throw bad(name, "browser requires egress.kind audited-public");
    // The browser worker fixes its tool set from the profile and refuses caller tool flags, so an allowlist profile could only make it refuse to start.
    if (browser.profile !== undefined && raw.allowlist !== undefined) throw bad(name, "browser.profile excludes allowlist");
  }

  // `allowlist` names a closed profile (ALLOWLIST_PROFILES); an unknown name is refused rather than falling back to the default loadout.
  let allowlist: AllowlistProfile | undefined;
  if (raw.allowlist !== undefined) {
    if (!isAllowlistProfile(raw.allowlist)) throw bad(name, `allowlist must be one of ${ALLOWLIST_PROFILES.join(", ")}: ${JSON.stringify(raw.allowlist)}`);
    allowlist = raw.allowlist;
    // `browse` offers only web_fetch, which the host gateway scopes by the template's allowlist egress (webFetchScope): without both, the agent would have no usable tool.
    if (allowlist === "browse") {
      if (!extensions.includes("web_fetch")) throw bad(name, "allowlist browse requires the web_fetch extension");
      if (egress.kind !== "allowlist") throw bad(name, "allowlist browse requires egress.kind allowlist");
    }
    // `analyst` and `specialist` are closed paged readers (no listed extensions, relay-only egress); the rule is core's
    // allowlistTemplateProblem, which pomtreed also enforces at spawn and launch so a template built in code cannot bypass it.
    const problem = allowlistTemplateProblem({ allowlist, extensions, egress, env: raw.env });
    if (problem !== undefined) throw bad(name, problem);
  }

  const t: Template = { id: name };
  if (raw.name !== undefined) t.name = raw.name as string;
  if (raw.image !== undefined) t.image = raw.image as string;
  if (raw.env !== undefined) t.env = raw.env;
  if (extensions.length) t.extensions = extensions;
  if (raw.provider !== undefined) t.provider = raw.provider as string;
  if (raw.model !== undefined) t.model = raw.model as string;
  if (budgetMicros !== undefined) t.budgetMicros = budgetMicros;
  if (memoryBytes !== undefined) t.memoryBytes = memoryBytes;
  if (cpus !== undefined) t.cpus = cpus;
  if (shmBytes !== undefined) t.shmBytes = shmBytes;
  if (diskBytes !== undefined) t.diskBytes = diskBytes;
  if (raw.resume !== undefined) t.resume = raw.resume as ResumeLevel;
  if (requires.length) t.requires = requires;
  if (browser !== undefined) t.browser = browser;
  if (allowlist !== undefined) t.allowlist = allowlist;
  if (raw.disposition !== undefined)
    t.disposition = {
      mode: (raw.disposition as ResultDisposition).mode,
      ...((raw.disposition as ResultDisposition).ttlMs !== undefined && { ttlMs: (raw.disposition as ResultDisposition).ttlMs }),
    };
  if (raw.runtime !== undefined) t.runtime = raw.runtime;
  if (raw.systemPrompt !== undefined) t.systemPrompt = raw.systemPrompt as string;
  t.egress = egress;
  return t;
}

// One row of DirTemplateStore.listEntries(): a valid template, or the file's id with the TemplateError that refused it.
export type TemplateListEntry = Template | { id: TemplateId; error: TemplateError };

export class DirTemplateStore implements TemplateStore {
  private readonly root: string;

  constructor(opts: { root: string }) {
    mkdirSync(opts.root, { recursive: true });
    this.root = realpathSync(opts.root);
  }

  private file(name: TemplateId): string {
    if (!valid(name)) throw bad(name, "invalid template name");
    return join(this.root, `${name}${EXT}`);
  }

  private read(name: TemplateId): Template | null {
    const file = this.file(name);
    const st = lstatOrNull(file);
    if (!st?.isFile()) return null; // absent or symlinked/non-file
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw bad(name, "corrupt JSON");
    }
    return validate(name, raw);
  }

  async resolve(name: TemplateId): Promise<Template | null> {
    return this.read(name);
  }

  // Strict listing: the first invalid file throws its TemplateError (the TemplateStore contract). Callers that must show the valid
  // templates beside the broken ones use listEntries().
  async list(): Promise<Template[]> {
    const out: Template[] = [];
    for (const e of await this.listEntries()) {
      if ("error" in e) throw e.error;
      out.push(e);
    }
    return out;
  }

  // Per-file listing: each addressable `<stem>.json` is either its validated Template or `{ id, error }` carrying the file's
  // TemplateError (`template error: <id>: <field why>`), so one broken file no longer hides every other template.
  // TODO(contract-drift): not on core's TemplateStore port; pomtreed reads it by duck type until the port carries it.
  async listEntries(): Promise<TemplateListEntry[]> {
    if (!lstatOrNull(this.root)?.isDirectory()) return [];
    const out: TemplateListEntry[] = [];
    for (const ent of readdirSync(this.root, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith(EXT)) continue; // real regular files only; symlinks report as links
      const stem = ent.name.slice(0, -EXT.length);
      if (!valid(stem)) continue; // a stem that cannot be addressed safely is not a template
      try {
        const t = this.read(stem);
        if (t) out.push(t); // read() throws TemplateError on a bad file, never returns null for a listed file
      } catch (e) {
        if (!(e instanceof TemplateError)) throw e;
        out.push({ id: stem, error: e });
      }
    }
    return out;
  }
}
