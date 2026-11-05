// Pure derivation of the live model upstream base from the Pi catalog entry of the chosen route. Pi builds request paths relative to the
// entry's own baseUrl (anthropic-messages: baseUrl https://openrouter.ai/api, path /v1/messages; openai-completions: baseUrl
// https://openrouter.ai/api/v1, path /chat/completions), and pomtreed's model proxy appends the request path to the configured base. So the
// base handed to the proxy must be the catalog baseUrl verbatim, never a hardcoded prefix. No fs, network or clock access here.
export const LIVE_UPSTREAM_ORIGIN = "https://openrouter.ai";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// The catalog entry for a model id, resolved like pomtreed's rates lookup (parseCatalogFile/parseStoreOverlay): built-in groups are
// api -> key -> model with later entries winning, chat entries only; the models-store overlay applies only when it is newer than the
// built-in data and then wins by id.
// TODO(catalog-baseurl): pomtreed's pi-catalog exposes rates only, so this mirrors its precedence for baseUrl; export the entry from pomtreed and delete this.
export function catalogRouteEntry(o: { builtin: unknown; overlay?: unknown; generatedAt?: number }, id: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  if (isObject(o.builtin)) {
    for (const group of Object.values(o.builtin)) {
      if (!isObject(group)) continue;
      for (const model of Object.values(group)) if (isObject(model) && model.type === "chat" && model.id === id) found = model;
    }
  }
  const overlay = o.overlay;
  if (
    isObject(overlay) &&
    Array.isArray(overlay.models) &&
    (o.generatedAt === undefined || (typeof overlay.lastModified === "number" && overlay.lastModified > o.generatedAt))
  ) {
    for (const model of overlay.models) if (isObject(model) && (model.type === undefined || model.type === "chat") && model.id === id) found = model;
  }
  return found;
}

// The proxy base for a catalog entry: its baseUrl without trailing slashes. Refuses unless it is an https URL on openrouter.ai (no
// credentials, query or fragment), so the upstream key can only be sent there.
export function liveUpstreamBaseUrl(entry: unknown): string {
  const raw = isObject(entry) ? entry.baseUrl : undefined;
  if (typeof raw !== "string" || raw === "") throw new Error("live content: refusing to start, the Pi catalog entry for the route has no baseUrl");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("live content: refusing to start, the Pi catalog baseUrl is not a URL");
  }
  if (url.origin !== LIVE_UPSTREAM_ORIGIN || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    throw new Error(`live content: refusing to start, the Pi catalog baseUrl must be a plain ${LIVE_UPSTREAM_ORIGIN} URL (origin ${url.origin})`);
  return LIVE_UPSTREAM_ORIGIN + url.pathname.replace(/\/+$/, "");
}
