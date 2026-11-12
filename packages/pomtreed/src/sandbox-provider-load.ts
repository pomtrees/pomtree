import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import nodeModule, { isBuiltin } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkPortVersion, hashExtensionTree, validateBackendId, validateDeclaration } from "@pomtree/core";
import type { ExtensionManifest, ExtensionTreeEntry, SandboxBackendModule, SandboxBackendProvider } from "@pomtree/core";

// The loader for sandbox backends contributed by extensions (`provides` entries of kind `sandbox`). It never loads a first-party
// built-in (their ids are reserved), and it loads lazily: an entry's module is imported only when its backend is selected, after the
// containment check, the port version check and the content-hash pin, and never constructs the provider (`create` is the registry's
// call). Everything that touches the filesystem or the module system is injected, so the decisions are unit-testable.
//
// What the pin and the hook protect: the operator-reviewed bytes of the extension tree against drift (a file changed, added, renamed
// or removed since review, including between measurement and import, because the hook serves the bytes that were hashed), and
// against accidental imports of the daemon's internals or of packages nobody reviewed. What they do NOT protect against: a hostile
// reviewed module. The extension runs in-process with the daemon's full Node privileges and can read its environment and files; the
// hook is a resolve-time review aid and cheap import friction (it also refuses a few process-spawning builtins), not isolation.
//
// TODO(sandbox-loader-isolation): the import guard is friction, not isolation: a contributed backend runs in-process with the daemon's privileges, and
// the content-hash pin plus operator review is the only protection. Out-of-process adapters are the real fix.
// Still skips the guard (so nobody should lean on it or on the denied-builtin list): `process.getBuiltinModule`, `process.binding`,
// `new Function`/`eval` code whose `import()` has a parent outside the tree, `createRequire(<a path outside the tree>)`, a
// `module.registerHooks` obtained that way (a hook registered later runs first), and `process.mainModule`.
//
// `.js`/`.ts` files take their format from the nearest `package.json` INSIDE the pinned tree and default to CommonJS when there is
// none (deterministic; Node itself would look further up the filesystem, outside the pin).
//
// Requires `module.registerHooks`: Node 22.15+ or 23.5+ (the repo targets Node 24+). On an older Node, installing the guard fails.
// Residual window: none for files in the pinned tree, since Node is handed the verified bytes. A file outside the tree can only be a
// shipped package or a builtin, which are not extension-controlled.

// The packages the daemon ships that a provider may import by bare name. Everything else bare (and `@pomtree/pomtreed`, the daemon's
// own internals) is refused by the resolve hook.
export const SHIPPED_PACKAGES: readonly string[] = ["@pomtree/core", "@pomtree/sandbox-kit"];

export interface TreeStat {
  readonly size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export interface LoaderFs {
  realpath(path: string): string;
  lstat(path: string): TreeStat;
  readdir(path: string): string[];
  readFile(path: string): Uint8Array;
}
export const nodeLoaderFs: LoaderFs = {
  realpath: (p) => realpathSync(p),
  lstat: (p) => lstatSync(p),
  readdir: (p) => readdirSync(p),
  readFile: (p) => readFileSync(p),
};

// What the pin covers: every regular file under the (realpathed) extension directory, with no exclusions.
export interface PinnedTree {
  readonly dir: string; // realpath of the extension directory
  readonly entries: readonly ExtensionTreeEntry[];
  readonly hash: string; // `sha256:<hex>`, from hashExtensionTree
  readonly contents: ReadonlyMap<string, Uint8Array>; // the hashed bytes by relative path, served to Node on import
}

// Generous defaults; a tree beyond them is almost certainly a vendored node_modules, which belongs behind a bundler, not in a pin.
export interface TreeLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxDirs: number;
  maxDepth: number;
}
export const DEFAULT_TREE_LIMITS: TreeLimits = { maxFiles: 2000, maxTotalBytes: 64 * 1024 * 1024, maxDirs: 500, maxDepth: 16 };

// Code the load hook cannot serve from verified bytes: Node would read these from disk (a native addon reaches process.dlopen).
// A tree holding one is refused outright; any other unsupported extension is refused when something imports it.
export const NATIVE_EXTENSIONS: readonly string[] = [".node", ".wasm"];
const FORMAT_BY_EXT: Record<string, string> = {
  ".mjs": "module",
  ".mts": "module-typescript",
  ".cjs": "commonjs",
  ".cts": "commonjs-typescript",
  ".json": "json",
};
const SUPPORTED_EXTENSIONS: readonly string[] = [...Object.keys(FORMAT_BY_EXT), ".js", ".ts"];
const extOf = (path: string): string => {
  const base = path.split(/[?#]/)[0] as string;
  const slash = base.lastIndexOf("/");
  const dot = base.lastIndexOf(".");
  return dot <= slash + 0 ? "" : base.slice(dot);
};

// Walks `dir` and measures every file. Refuses a symlink or any entry that is not a regular file or directory, because a link or
// device could point at bytes the listing did not measure.
export function measureExtensionTree(dir: string, fs: LoaderFs = nodeLoaderFs, given: Partial<TreeLimits> = {}): PinnedTree {
  const limits: TreeLimits = { ...DEFAULT_TREE_LIMITS, ...given };
  const root = fs.realpath(dir);
  const entries: ExtensionTreeEntry[] = [];
  const contents = new Map<string, Uint8Array>();
  let total = 0;
  let dirs = 0;
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > limits.maxDepth)
      throw new Error(`extension directory ${root} nests deeper than ${limits.maxDepth} levels (at ${rel}); flatten it or bundle the code into a few files`);
    for (const name of fs.readdir(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const st = fs.lstat(childAbs);
      if (st.isSymbolicLink())
        throw new Error(
          `extension directory ${root} contains the symlink ${childRel}; a pinned directory may hold only regular files, so replace the link with a copy of its target`,
        );
      if (st.isDirectory()) {
        if (++dirs > limits.maxDirs)
          throw new Error(`extension directory ${root} holds more than ${limits.maxDirs} directories; remove caches and vendored packages, or bundle the code`);
        walk(childAbs, childRel, depth + 1);
      } else if (st.isFile()) {
        if (entries.length >= limits.maxFiles)
          throw new Error(
            `extension directory ${root} holds more than ${limits.maxFiles} files; a pin covers every file, so remove build output, caches and vendored packages (bundle the code into a few files)`,
          );
        if (NATIVE_EXTENSIONS.includes(extOf(childRel)))
          throw new Error(
            `extension directory ${root} contains ${childRel}; native addons and WebAssembly cannot be served from the pinned bytes, so remove it and use a pure JavaScript module`,
          );
        const tooBig = () =>
          new Error(
            `extension directory ${root} holds more than ${limits.maxTotalBytes} bytes (at ${childRel}); remove large assets and caches, or bundle the code into smaller files`,
          );
        if (total + st.size > limits.maxTotalBytes) throw tooBig(); // before reading a huge file
        const bytes = fs.readFile(childAbs);
        total += bytes.byteLength; // the bytes actually read are what count
        if (total > limits.maxTotalBytes) throw tooBig();
        contents.set(childRel, bytes);
        entries.push({ path: childRel, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
      } else throw new Error(`extension directory ${root} contains ${childRel}, which is neither a regular file nor a directory; remove it`);
    }
  };
  walk(root, "", 1);
  return { dir: root, entries, hash: hashExtensionTree(entries), contents };
}

// Parses `sandbox.reviewedBackends` (`<id>=sha256:<hex>`, already shape-checked by config) into id -> pin.
export function parseReviewedBackends(entries: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    const eq = e.indexOf("=");
    if (eq > 0) out.set(e.slice(0, eq), e.slice(eq + 1));
  }
  return out;
}

// True when `child` is strictly inside `base` (both absolute and normalised).
function isInside(base: string, child: string): boolean {
  const rel = relative(base, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// ---- the resolve hook ----

// Handles returned by installResolveGuard and still installed; the loader accepts nothing else, so a plain object cannot stand in.
const INSTALLED_GUARDS = new WeakSet<object>();

export interface ResolveGuard {
  // Confine imports made by files under `tree.dir` to that tree. Idempotent per directory.
  pin(tree: PinnedTree): void;
  deregister(): void;
}

export interface ResolveGuardOptions {
  shipped?: readonly string[];
  // Where a shipped package really lives (default: resolved from this module, so the daemon's own copy is the one a provider gets).
  resolveShipped?: (specifier: string) => string;
  // The `node:module` surface to register on; injectable so a test can stand in an older Node that lacks `registerHooks`.
  moduleApi?: { registerHooks?: typeof nodeModule.registerHooks };
}

// Builtins a provider may not import. Cheap friction only (a reviewed module can still reach them through globals such as
// `process`; see the module header for what skips the guard); the action is the `run` dep, which the manifest declares and which
// logs the argv.
export const DENIED_BUILTINS: readonly string[] = ["child_process", "vm", "worker_threads", "module", "cluster", "inspector"];

// Registers one process-wide `node:module` hook pair that acts only on files of pinned directories. `resolve` governs the imports
// made BY those files: `node:` builtins (minus DENIED_BUILTINS), the shipped packages by exact bare name, and files in the pinned
// listing; anything else throws with the cause and the action. `load` serves the bytes that were hashed, so a file swapped after the
// pin check, the entry included, is never what runs.
export function installResolveGuard(opts: ResolveGuardOptions = {}): ResolveGuard {
  const registerHooks = (opts.moduleApi ?? nodeModule).registerHooks;
  if (typeof registerHooks !== "function")
    throw new Error(
      `this Node (${process.version}) has no module.registerHooks, which the sandbox backend import guard needs (Node 22.15+, 23.5+ or 24+); run the daemon on Node 24 or later`,
    );
  const shipped = opts.shipped ?? SHIPPED_PACKAGES;
  const resolveShipped = opts.resolveShipped ?? ((s: string) => import.meta.resolve(s));
  const trees = new Map<string, PinnedTree>();
  const owner = (path: string): PinnedTree | undefined => {
    for (const [dir, tree] of trees) if (isInside(dir, path)) return tree;
    return undefined;
  };
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : undefined;
      const own = parent === undefined ? undefined : owner(parent);
      if (own === undefined) return nextResolve(specifier, context);
      const refuse = (why: string): never => {
        throw new Error(`sandbox backend module ${relative(own.dir, parent as string)} may not import ${JSON.stringify(specifier)}: ${why}`);
      };
      const bare = !specifier.startsWith(".") && !specifier.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(specifier);
      const builtin = specifier.startsWith("node:") || (bare && isBuiltin(specifier));
      if (builtin) {
        const base = (specifier.startsWith("node:") ? specifier.slice(5) : specifier).split("/")[0] as string;
        if (DENIED_BUILTINS.includes(base))
          return refuse(`node:${base} is not available to sandbox backends; use the run dep (declare "run" in provides[].deps) to run a program`);
        return nextResolve(specifier, context);
      }
      if (bare) {
        if (shipped.includes(specifier)) return { url: resolveShipped(specifier), format: "module", shortCircuit: true };
        return refuse(
          `only node: builtins and the packages the daemon ships (${shipped.join(", ")}) may be imported by name; copy the code into the extension directory or use deps`,
        );
      }
      if (NATIVE_EXTENSIONS.includes(extOf(specifier)))
        return refuse(`${extOf(specifier)} files cannot be served from the pinned bytes; use a pure JavaScript module`);
      const r = nextResolve(specifier, context);
      if (!r.url.startsWith("file:")) return refuse(`${r.url.split(":")[0]}: imports are not allowed; import a file inside the extension directory`);
      const target = fileURLToPath(r.url);
      if (!isInside(own.dir, target))
        return refuse(`it resolves to ${target}, outside the pinned extension directory ${own.dir}; move the code inside the directory`);
      const rel = relative(own.dir, target).split(sep).join("/");
      if (!own.contents.has(rel)) return refuse(`${rel} was not in the reviewed listing; re-pin the directory`);
      if (!SUPPORTED_EXTENSIONS.includes(extOf(rel)))
        return refuse(`${rel} has the unsupported extension ${JSON.stringify(extOf(rel))}; use ${SUPPORTED_EXTENSIONS.join(", ")}`);
      return r;
    },
    load(url, context, nextLoad) {
      const file = url.startsWith("file:") ? fileURLToPath(url) : undefined;
      const own = file === undefined ? undefined : owner(file);
      if (own === undefined || file === undefined) return nextLoad(url, context);
      const rel = relative(own.dir, file).split(sep).join("/");
      const bytes = own.contents.get(rel);
      if (bytes === undefined) throw new Error(`sandbox backend file ${rel} is not in the reviewed listing of ${own.dir}; re-pin the directory`);
      const dot = rel.lastIndexOf(".");
      const ext = dot < 0 ? "" : rel.slice(dot);
      let format = FORMAT_BY_EXT[ext];
      if (format === undefined && (ext === ".js" || ext === ".ts")) {
        const typeModule = packageTypeIsModule(own, rel);
        format = ext === ".js" ? (typeModule ? "module" : "commonjs") : typeModule ? "module-typescript" : "commonjs-typescript";
      }
      if (format === undefined)
        throw new Error(`sandbox backend file ${rel} has the unsupported extension ${JSON.stringify(ext)}; use .mjs, .mts, .js, .ts, .cjs, .cts or .json`);
      return { format, source: bytes, shortCircuit: true };
    },
  });
  const guard: ResolveGuard = {
    pin(tree) {
      trees.set(tree.dir, tree);
    },
    deregister() {
      hook.deregister();
      trees.clear();
      INSTALLED_GUARDS.delete(guard);
    },
  };
  INSTALLED_GUARDS.add(guard);
  return guard;
}

// Whether the nearest package.json at or above `rel`'s directory, inside the pinned tree, says "type": "module".
function packageTypeIsModule(tree: PinnedTree, rel: string): boolean {
  const parts = rel.split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    const key = [...parts.slice(0, i), "package.json"].join("/");
    const bytes = tree.contents.get(key);
    if (bytes === undefined) continue;
    try {
      return (JSON.parse(Buffer.from(bytes).toString("utf8")) as { type?: unknown }).type === "module";
    } catch {
      return false;
    }
  }
  return false;
}

// ---- the loader ----

export interface LoadedSandboxExtension {
  dir: string; // the extension's directory under extensions.dir
  manifest: ExtensionManifest;
}

export interface SandboxProviderLoaderOptions {
  extensions: readonly LoadedSandboxExtension[];
  reviewedBackends: readonly string[]; // sandbox.reviewedBackends
  fs?: LoaderFs;
  limits?: Partial<TreeLimits>;
  importModule?: (fileUrl: string) => Promise<unknown>;
  // The handle installResolveGuard returned. Required: without the hook the pin would cover the entry and not the code it imports.
  guard?: ResolveGuard;
  // Explicit opt-out for unit tests of the pin and containment logic (the controls that show what the hook adds). Never set in the daemon.
  unguardedForTests?: boolean;
  // Ids the loader refuses to treat as contributed (the registry's built-ins), on top of the reserved list.
  builtinIds?: readonly string[];
}

export interface LoadedSandboxProvider {
  provider: SandboxBackendProvider;
  extension: string;
  dir: string; // realpath
  pin: string; // the hash the directory matched
  run: boolean; // the manifest declares the `run` dep
}

interface Indexed {
  ext: LoadedSandboxExtension;
  entry: NonNullable<ExtensionManifest["provides"]>[number];
}

// Index every `provides` entry across the extensions without importing anything. Refuses an id provided by two extensions (naming both),
// an id that collides with a built-in, and an invalid id.
export function indexSandboxProviders(extensions: readonly LoadedSandboxExtension[], builtinIds: readonly string[] = []): Map<string, Indexed> {
  const out = new Map<string, Indexed>();
  for (const ext of extensions) {
    for (const entry of ext.manifest.provides ?? []) {
      if (entry.kind !== "sandbox") continue;
      validateBackendId(entry.id);
      if (builtinIds.includes(entry.id))
        throw new Error(`extension ${ext.manifest.name} provides sandbox backend ${entry.id}, which is a built-in backend; rename the id`);
      const prior = out.get(entry.id);
      if (prior !== undefined)
        throw new Error(
          `sandbox backend ${entry.id} is provided by both extension ${prior.ext.manifest.name} (${prior.ext.dir}) and extension ${ext.manifest.name} (${ext.dir}); rename one id or remove one extension`,
        );
      out.set(entry.id, { ext, entry });
    }
  }
  return out;
}

export class SandboxProviderLoader {
  private readonly index: Map<string, Indexed>;
  private readonly fs: LoaderFs;
  private readonly pins: Map<string, string>;
  private readonly loaded = new Map<string, Promise<LoadedSandboxProvider>>();
  private readonly opts: SandboxProviderLoaderOptions;

  constructor(opts: SandboxProviderLoaderOptions) {
    this.opts = opts;
    if (opts.unguardedForTests !== true && (opts.guard === undefined || !INSTALLED_GUARDS.has(opts.guard)))
      throw new Error(
        "the sandbox backend loader needs the handle returned by installResolveGuard (still installed), because the pin does not cover the code a provider imports; call installResolveGuard() at boot and pass it as guard",
      );
    this.index = indexSandboxProviders(opts.extensions, opts.builtinIds);
    this.fs = opts.fs ?? nodeLoaderFs;
    this.pins = parseReviewedBackends(opts.reviewedBackends);
  }

  // Ids contributed by installed extensions (nothing imported), with the contributing extension, for the registry's unknown-id message.
  ids(): { id: string; extension: string }[] {
    return [...this.index].map(([id, { ext }]) => ({ id, extension: ext.manifest.name }));
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  // Imports and assembles the provider for `id`, once. Refuses, before any import, an unlisted id, a wrong `portVersion`, an entry
  // outside the extension directory, a symlink or any changed, added, renamed or removed file against the pin.
  load(id: string): Promise<LoadedSandboxProvider> {
    let p = this.loaded.get(id);
    if (p === undefined) {
      p = this.loadOnce(id);
      this.loaded.set(id, p);
      p.catch(() => this.loaded.delete(id));
    }
    return p;
  }

  private async loadOnce(id: string): Promise<LoadedSandboxProvider> {
    const found = this.index.get(id);
    if (found === undefined) {
      const known = [...this.index.keys()];
      throw new Error(
        `no installed extension provides sandbox backend ${id} (contributed: ${known.length === 0 ? "none" : known.join(", ")}); install the extension in extensions.dir or fix sandbox.backend`,
      );
    }
    const { ext, entry } = found;
    const extName = ext.manifest.name;
    checkPortVersion(id, entry.portVersion);
    for (const d of entry.deps ?? [])
      if ((d as string) !== "run")
        throw new Error(
          `sandbox backend ${id} (extension ${extName}) declares dep ${JSON.stringify(d)}; a sandbox backend may declare only "run"; remove it from provides[].deps`,
        );

    // Entry containment: lexical, then by realpath, so a link out of the directory is caught.
    const dirReal = this.fs.realpath(ext.dir);
    const entryAbs = resolve(dirReal, entry.entry);
    if (!isInside(dirReal, entryAbs))
      throw new Error(
        `sandbox backend ${id} (extension ${extName}): entry ${JSON.stringify(entry.entry)} escapes the extension directory ${dirReal}; keep the provider module inside it`,
      );
    let entryReal: string;
    try {
      entryReal = this.fs.realpath(entryAbs);
    } catch (e) {
      throw new Error(
        `sandbox backend ${id} (extension ${extName}): entry ${JSON.stringify(entry.entry)} cannot be resolved (${e instanceof Error ? e.message : String(e)}); create the file or fix provides[].entry`,
      );
    }
    if (!isInside(dirReal, entryReal))
      throw new Error(
        `sandbox backend ${id} (extension ${extName}): entry ${JSON.stringify(entry.entry)} escapes the extension directory ${dirReal} through a symlink (it resolves to ${entryReal}); keep the provider module inside it`,
      );

    // The pin, checked before the module is imported.
    const tree = measureExtensionTree(dirReal, this.fs, this.opts.limits);
    const pinned = this.pins.get(id);
    if (pinned === undefined)
      throw new Error(
        `sandbox backend ${id} is not reviewed: ${dirReal} hashes to ${tree.hash}; review the directory, then add ${id}=${tree.hash} to sandbox.reviewedBackends`,
      );
    if (pinned !== tree.hash)
      throw new Error(
        `sandbox backend ${id} does not match its pin: ${dirReal} hashes to ${tree.hash} but sandbox.reviewedBackends pins ${pinned}; a file was changed, added, renamed or removed. Review the directory, then replace the pin with ${id}=${tree.hash}`,
      );

    this.opts.guard?.pin(tree);
    const imp = this.opts.importModule ?? ((u: string) => import(u));
    let mod: Partial<SandboxBackendModule>;
    try {
      mod = (await imp(pathToFileURL(entryReal).href)) as Partial<SandboxBackendModule>;
    } catch (e) {
      throw new Error(
        `sandbox backend ${id} (extension ${extName}): importing ${entry.entry} failed: ${e instanceof Error ? e.message : String(e)}; fix the module or re-pin after changing it`,
      );
    }
    if (typeof mod !== "object" || mod === null || typeof mod.create !== "function" || mod.declaration === undefined)
      throw new Error(`sandbox backend ${id} (extension ${extName}): ${entry.entry} must export { portVersion, declaration, create }; add the missing export`);
    checkPortVersion(id, mod.portVersion);
    if (mod.declaration.backend !== id)
      throw new Error(
        `sandbox backend ${id} (extension ${extName}): its declaration names backend ${JSON.stringify(mod.declaration.backend)}; set declaration.backend to ${JSON.stringify(id)}`,
      );
    const reasons = validateDeclaration(mod.declaration);
    if (reasons.length > 0)
      throw new Error(`sandbox backend ${id} (extension ${extName}) has an invalid declaration: ${reasons.join("; ")}; fix the declaration`);
    const provider: SandboxBackendProvider = {
      id,
      portVersion: mod.portVersion as number,
      declaration: mod.declaration,
      params: entry.params ?? [],
      credentials: entry.credentials ?? [],
      create: mod.create,
    };
    return { provider, extension: extName, dir: dirReal, pin: tree.hash, run: (entry.deps ?? []).some((d) => (d as string) === "run") };
  }
}
