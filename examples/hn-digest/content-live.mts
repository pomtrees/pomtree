// Entry for ONE live hn-content run (real HN API, real article GETs, Docker, OpenRouter haiku via the budgeted proxy). It spends money:
// run it only with explicit authorization. Usage:
//   node examples/hn-digest/content-live.mts --stories 1 --output-dir <dir> [--budget-micros N] [--i-know-the-cap] [--deadline-ms N]
//     [--approval approve|deny|pomtree] [--state-dir <dir>] [--seen-import <file>] [--seen-export <file>] [--article-method static-http|browser]
//     [--story-id <HN item id>]... (repeatable, at most 3, distinct: process exactly these stories instead of the top ones; --stories then defaults to their count)
//     [--image <repo@sha256:digest | sha256:image-id>] [--repo-dir <git repo>] [--keep-run-dir] [--config <file>] [--set key=value]...
// Bounds (capture, article, report and daemon report limits) are registry keys resolved exactly as pomtreed resolves them: default < the JSON
// file (--config, else $POMTREED_CONFIG) < env < --set. `<ENV>_FILE` secret names are recognized but never read.
// workflow.fetch.userAgent (env POMTREED_WORKFLOW_FETCH_USER_AGENT) is optional: unset or blank resolves to the registry default
// "pomtree"; naming a contact is recommended, e.g. "hn-digest (+https://example.org/contact)". A header-unsafe value is a config error.
// Exit codes: 0 run published and every assertion held, 2 refused before start (caps, pricing, auth, flags, any config error (one line
// each), a missing state dir, a malformed POMTREED_STATE_LIMITS, an unopenable or too-new or corrupt seen state, a bad seen import/export file, a model proxy the worker network cannot reach, or a browser image without Chromium and the browser runner), 3 run did not publish, produced no analysed story,
// or every URL-bearing story's article was dropped for a worker or verification reason (no usable article), 4 an assertion failed, 5 published and every assertion held but the seen state could not be updated.
// Output files are listed in CONTENT.md. The upstream key is read inside preflightLive from the 0600 file named by POMTREED_MODEL_UPSTREAM_KEY_FILE.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { ArticleMethod } from "./content-browser-method.mts";
import { executeLive } from "./content-live-run.mts";
import { CONFIG_FILE_ENV, CONFIG_REGISTRY, configEnvIgnore, extendRegistry, parseStateLimits, resolveConfig } from "../../packages/core/src/index.ts";
import { CONTENT_LIMIT } from "./content-contract.mts";
import type { ContentConfig } from "./content-bounds.mts";
import { HN_DIGEST_EXTENSION, HN_DIGEST_PARAMS } from "./params.mts";
import { openStateStore } from "../../packages/store-sqlite/src/index.ts";
import { createStoreSeen, exportSeenFile, importSeenFile, prepareSeenExport, SeenFileError, type SeenStore } from "./content-seen.mts";
import { createLiveBaseRepo, liveDefaultDeadlineMs, liveSessionMs, openLiveContentRuntime, preflightLive } from "./content-live-runtime.mts";

const OPENROUTER_ORIGIN = "https://openrouter.ai/";

// The proxy may only talk to OpenRouter; any other upstream URL is refused before it leaves the process.
const guardedModelFetch: typeof globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(OPENROUTER_ORIGIN)) throw new Error("live content: model upstream must be openrouter.ai");
  return globalThis.fetch(input, init);
};

export interface LiveArgs {
  stories: number;
  pick: number[]; // --story-id values in order, already validated; empty = the top-stories feed
  budgetMicros?: number;
  iKnowTheCap: boolean;
  articleMethod: ArticleMethod;
  outputDir: string;
  deadlineMs: number;
  approval: "approve" | "deny" | "pomtree";
  image?: string;
  repoDir?: string;
  stateDir?: string;
  seenImport?: string;
  seenExport?: string;
  keepRunDir: boolean;
  configFile?: string;
  set: string[];
}

// An image the run may start: a digest pin (`repo@sha256:<64 hex>`) or a local image id (`sha256:<64 hex>`, what `docker build` prints).
// Both name immutable content. A tag (`pomtree/agent:dev`) is refused: it names whatever the local tag points at when the worker
// starts, and the browser authority approves workers by this exact string.
const PINNED_IMAGE = /^(?:[^\s@]+@)?sha256:[0-9a-f]{64}$/;
export const isPinnedImage = (image: string): boolean => PINNED_IMAGE.test(image);

// The core registry composed with the digest's own keys (params.mts) exactly as pomtreed composes a loaded hn-digest extension
// (extendRegistry), so `ext.hnDigest.*` resolves from the file, the derived `POMTREED_EXT_HN_DIGEST_` env names and --set, and any
// other POMTREED_EXT_* name in the env is refused (strict, as in pomtreed).
export const LIVE_REGISTRY = extendRegistry(CONFIG_REGISTRY, [{ name: HN_DIGEST_EXTENSION, params: HN_DIGEST_PARAMS }]);

// Resolves the registry for this run exactly as pomtreed does (core resolveConfig: default < file < env < --set, configEnvIgnore), except that
// `<ENV>_FILE` secrets are never opened (skipSecretFiles): the digest needs bounds, not the operator's upstream key file. Returns the values,
// or every refusal as one line each; the entry exits 2 on any, before anything opens or spends.
export function resolveLiveConfig(o: {
  env: Readonly<Record<string, string | undefined>>;
  configFile?: string;
  set: readonly string[];
  readFile: (path: string) => string;
}): { ok: true; values: ContentConfig } | { ok: false; errors: string[] } {
  const path = o.configFile ?? o.env[CONFIG_FILE_ENV];
  let file: unknown;
  if (path !== undefined && path !== "") {
    let text: string;
    try {
      text = o.readFile(path);
    } catch (e) {
      return { ok: false, errors: [`config file ${path}: cannot read: ${e instanceof Error ? e.message : String(e)}`] };
    }
    try {
      file = JSON.parse(text);
    } catch {
      return { ok: false, errors: [`config file ${path}: not valid JSON`] };
    }
  }
  const r = resolveConfig(LIVE_REGISTRY, { ...(file !== undefined && { file }), env: o.env, set: o.set, skipSecretFiles: true, ...configEnvIgnore() });
  return r.ok ? { ok: true, values: r.values as unknown as ContentConfig } : r;
}

// Parses and validates the entry's flags. Every refusal throws an Error whose message starts with `live content:`; the entry exits 2 on it.
// Without --deadline-ms the deadline is the method's default for the story count (liveDefaultDeadlineMs); an explicit value overrides it.
// The daemon session cap is then raised to match (liveSessionMs), never lowered below the default.
export function parseLiveArgs(argv: readonly string[]): LiveArgs {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        stories: { type: "string" },
        "story-id": { type: "string", multiple: true },
        "budget-micros": { type: "string" },
        "article-method": { type: "string", default: "static-http" },
        "output-dir": { type: "string" },
        "deadline-ms": { type: "string" },
        approval: { type: "string", default: "approve" },
        "i-know-the-cap": { type: "boolean", default: false },
        image: { type: "string" },
        "repo-dir": { type: "string" },
        "state-dir": { type: "string" },
        "seen-import": { type: "string" },
        "seen-export": { type: "string" },
        "keep-run-dir": { type: "boolean", default: false },
        config: { type: "string" },
        set: { type: "string", multiple: true },
      },
      strict: true,
    }).values;
  } catch (e) {
    throw new Error(`live content: ${e instanceof Error ? e.message : String(e)}`);
  }
  const articleMethod = values["article-method"];
  if (articleMethod !== "static-http" && articleMethod !== "browser") throw new Error("live content: --article-method must be static-http or browser");
  if (values.approval !== "approve" && values.approval !== "deny" && values.approval !== "pomtree")
    throw new Error("live content: --approval must be approve, deny or pomtree");
  const outputDir = values["output-dir"];
  if (typeof outputDir !== "string" || outputDir === "") throw new Error("live content: --output-dir is required");
  const ids = (Array.isArray(values["story-id"]) ? values["story-id"] : []).filter((v): v is string => typeof v === "string");
  const pick = ids.map((v) => (/^[1-9][0-9]*$/.test(v) ? Number(v) : Number.NaN));
  if (!pick.every(Number.isSafeInteger)) throw new Error("live content: --story-id must be a positive integer HN item id");
  if (new Set(pick).size !== pick.length) throw new Error("live content: --story-id given more than once for the same id");
  if (pick.length > CONTENT_LIMIT) throw new Error(`live content: at most ${CONTENT_LIMIT} --story-id values`);
  const stories = values.stories === undefined ? Math.max(pick.length, 1) : Number(values.stories);
  if (pick.length > 0 && stories > pick.length) throw new Error("live content: --stories may not exceed the number of --story-id values");
  if (pick.length > 0 && stories < pick.length)
    throw new Error("live content: --stories may not be fewer than the number of --story-id values (an id would be dropped silently)");
  const budgetMicros = values["budget-micros"] === undefined ? undefined : Number(values["budget-micros"]);
  const deadlineMs =
    values["deadline-ms"] === undefined
      ? Number.isInteger(stories) && stories >= 1
        ? liveDefaultDeadlineMs(stories, articleMethod)
        : Number.NaN // planCaps refuses the story count with its own message
      : Number(values["deadline-ms"]);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error("live content: --deadline-ms must be positive");
  if (typeof values.image === "string" && !isPinnedImage(values.image))
    throw new Error("live content: --image must be a digest pin (repo@sha256:<64 hex>) or a local image id (sha256:<64 hex>), never a tag");
  if (values.config === "") throw new Error("live content: --config needs a file");
  return {
    stories,
    pick,
    ...(budgetMicros !== undefined && { budgetMicros }),
    iKnowTheCap: values["i-know-the-cap"] === true,
    keepRunDir: values["keep-run-dir"] === true,
    articleMethod,
    outputDir,
    deadlineMs,
    approval: values.approval,
    ...(typeof values.image === "string" && { image: values.image }),
    ...(typeof values["repo-dir"] === "string" && { repoDir: values["repo-dir"] }),
    ...(typeof values["state-dir"] === "string" && { stateDir: values["state-dir"] }),
    ...(typeof values["seen-import"] === "string" && { seenImport: values["seen-import"] }),
    ...(typeof values["seen-export"] === "string" && { seenExport: values["seen-export"] }),
    ...(typeof values.config === "string" && { configFile: values.config }),
    set: Array.isArray(values.set) ? values.set.filter((v): v is string => typeof v === "string") : [],
  };
}

// The persistent state directory, resolved as packages/pomtreed/src/main.ts does: --state-dir, else POMTREED_STATE_DIR, else ~/.pomtreed.
export const resolveStateDir = (o: { flag?: string; env: NodeJS.ProcessEnv; home: string }): string =>
  resolve(o.flag ?? o.env.POMTREED_STATE_DIR ?? join(o.home, ".pomtreed"));

export interface SeenState {
  store: SeenStore;
  label: string;
  close(): void;
}

// Opens <stateDir>/state.sqlite, the sibling of the production pomtreed.sqlite (which is never opened). The directory must already exist:
// it is never created, so a typo does not start a new empty store. The stored value is read once so a corrupt one is refused here.
// `limits` is the POMTREED_STATE_LIMITS value, parsed by the same core function pomtreed uses, so the tool and the daemon apply the same quotas.
export async function openSeenState(o: { stateDir: string; limits?: string; now?: () => Date }): Promise<SeenState> {
  let dir: string;
  try {
    if (!statSync(o.stateDir).isDirectory()) throw new Error("not a directory");
    dir = realpathSync(o.stateDir);
  } catch {
    throw new SeenFileError(`state dir ${o.stateDir} does not exist or is not a directory (it is never created; pass --state-dir or set POMTREED_STATE_DIR)`);
  }
  const path = join(dir, "state.sqlite");
  let limitsFor: ReturnType<typeof parseStateLimits>["limitsFor"];
  try {
    limitsFor = parseStateLimits(o.limits).limitsFor;
  } catch (e) {
    throw new SeenFileError(e instanceof Error ? e.message : String(e));
  }
  let db: ReturnType<typeof openStateStore>;
  try {
    db = openStateStore(path, { stateLimits: limitsFor });
  } catch (e) {
    throw new SeenFileError(`cannot open state database ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const store = createStoreSeen(db.state, o.now);
  try {
    await store.load();
  } catch (e) {
    db.close();
    throw e;
  }
  return { store, label: `seen state ${path}`, close: () => db.close() };
}

// Removes the per-run temp directory (pomtreed.sqlite, reports with article bodies, sessions, the default base repo) unless `keep`, in which case
// its path is printed. A failed removal is reported with the path, never silent.
export function disposeRunDir(dir: string, keep: boolean, log: (line: string) => void = console.error): void {
  if (keep) {
    log(`live content: run dir kept at ${dir}`);
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    log(`live content: could not remove run dir ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(): Promise<number> {
  let args: LiveArgs;
  try {
    args = parseLiveArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const config = resolveLiveConfig({
    env: process.env,
    ...(args.configFile !== undefined && { configFile: args.configFile }),
    set: args.set,
    readFile: (path) => readFileSync(path, "utf8"),
  });
  if (!config.ok) {
    for (const line of config.errors) console.error(`live content: config: ${line}`);
    return 2;
  }
  let pre: ReturnType<typeof preflightLive>;
  try {
    pre = preflightLive({
      env: process.env,
      stories: args.stories,
      ...(args.budgetMicros !== undefined && { budgetMicros: args.budgetMicros }),
      iKnowTheCap: args.iKnowTheCap,
      articleMethod: args.articleMethod,
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  // Seen state is always on. Every refusal here is before any model spend.
  let seen: SeenState;
  let exportPath: string | undefined;
  let importIds: number[] | undefined; // validated now, merged by executeLive after its preflights
  try {
    importIds = args.seenImport === undefined ? undefined : importSeenFile(resolve(args.seenImport));
    exportPath = args.seenExport === undefined ? undefined : prepareSeenExport(resolve(args.seenExport));
    seen = await openSeenState({
      stateDir: resolveStateDir({ ...(args.stateDir !== undefined && { flag: args.stateDir }), env: process.env, home: homedir() }),
      ...(process.env.POMTREED_STATE_LIMITS !== undefined && { limits: process.env.POMTREED_STATE_LIMITS }),
    });
  } catch (e) {
    if (!(e instanceof SeenFileError)) throw e;
    console.error(`live content: ${e.message}`);
    return 2;
  }
  const outputDir = resolve(args.outputDir);
  mkdirSync(outputDir, { recursive: true });
  // Private runtime state (sqlite, sockets, workspaces) stays under the OS temp dir: unix socket paths must stay short.
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "hnl-")));
  console.error(
    `live content: caps model=${pre.caps.modelBudgetMicros} root=${pre.caps.rootBudgetMicros} maxRequest=${pre.caps.maxRequestMicros} micros; article=${args.articleMethod}; state ${stateDir}`,
  );
  let rt: Awaited<ReturnType<typeof openLiveContentRuntime>> | undefined;
  let code = 3;
  try {
    let repoDir = args.repoDir;
    if (!repoDir) {
      repoDir = join(stateDir, "base-repo");
      createLiveBaseRepo(repoDir);
    }
    rt = await openLiveContentRuntime({
      stateDir,
      repoDir,
      caps: pre.caps,
      upstreamKey: pre.upstreamKey,
      upstreamBaseUrl: pre.upstreamBaseUrl,
      modelFetch: guardedModelFetch,
      hostAuditLog: join(outputDir, "host-audit.jsonl"),
      articleMethod: args.articleMethod,
      // The daemon's session cap follows the run deadline, so --deadline-ms also bounds the agents (TODO(deadline-session-cap): not yet verified live).
      sessionMs: liveSessionMs(args.deadlineMs, args.stories, args.articleMethod),
      ...(args.image && { image: args.image }),
      config: config.values,
    });
    code = await executeLive(rt, pre.caps, {
      outputDir,
      deadlineMs: args.deadlineMs,
      approval: args.approval,
      articleMethod: args.articleMethod,
      pick: args.pick,
      seenStore: seen.store,
      ...(importIds !== undefined && { seenImport: importIds }),
      seenLabel: seen.label,
      ...(exportPath !== undefined && { seenExport: (ids) => exportSeenFile(exportPath, ids, new Date()) }),
    });
  } finally {
    seen.close();
    await rt?.close().catch((e) => console.error(`live content: close failed: ${e instanceof Error ? e.message : String(e)}`));
    disposeRunDir(stateDir, args.keepRunDir);
  }
  return code;
}

// Only the process entry runs the live sequence; importing this module (the tests) has no effect.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`live content: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(3);
    },
  );
}
