// OFFLINE demonstration composition, not production manifest autoload. Existing reviewed builtin registration and canonical
// operator/Discord actions are reused; sandbox/harness are fixtures supplied to openRuntime. No source/provider/live fallback.
// Real hosts install createContentExtension with their own scoped services and actual native-tool capture authority.
// TODO(flow-launch): manifest autoload of the service-injected content factory is not demonstrated; only this explicit offline
// composition exists, so a real host must install createContentExtension itself.
import { type ContentBounds, DEFAULT_CONTENT_BOUNDS } from "./content-bounds.mts";
import type { CaptureAuthority } from "./content-evidence.mts";
import { createContentExtension } from "./content-extension.mts";
import { openRuntime, type Runtime, type RuntimeOptions } from "./runtime.mts";

export function openContentRuntime(options: RuntimeOptions & { captureAuthority: CaptureAuthority; bounds?: ContentBounds }): Promise<Runtime> {
  return openRuntime({
    ...options,
    builtinExtensions: (services) => [
      ...(options.builtinExtensions?.(services) ?? []),
      createContentExtension({
        registry: services.store.registry,
        reports: services.reports,
        root: services.root,
        authority: options.captureAuthority,
        bounds: options.bounds ?? DEFAULT_CONTENT_BOUNDS,
      }),
    ],
  });
}
