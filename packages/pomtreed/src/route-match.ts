import type { ExtensionRequest, RouteDef, RouteScope } from "@pomtree/core";
import type { Principal } from "./auth.ts";

// Extension route matching shared by the HTTP server (server.ts) and the direct API handler
// (api.ts), so extension routes behave identically whether a request arrives over a socket or
// through `handle()` in tests. The server matches routes before reading a body (token-before-body),
// while `handle()` re-dispatches for direct callers; both use the same match + scope rules here.

// An extension request carries the authenticated principal. Core's ExtensionRequest has no principal
// field (the host does not yet inject one), so the server/API attach it as an extra property and the
// builtins read it back via principalOf() below. TODO(extensions): add `principal` to core's
// ExtensionRequest once the host owns the injection.
export interface AuthedExtensionRequest extends ExtensionRequest {
  readonly principal: Principal | null;
}

export function principalOf(req: ExtensionRequest): Principal | null {
  return (req as AuthedExtensionRequest).principal;
}

// Map a route's declared scope onto the verified principal. `public` is operator-socket only (no token
// required); every other scope requires a token. `agentOnly` is true on the agent TCP endpoint, where
// public routes are not served.
export function scopeAllows(scope: RouteScope, principal: Principal | null, agentOnly: boolean): boolean {
  switch (scope.kind) {
    case "operator":
      return principal?.scope === "operator";
    case "agent":
      return principal?.scope === "agent";
    case "host":
      return principal?.scope === "host" && (scope.channel === undefined || principal.channel === scope.channel);
    case "ext":
      return principal?.scope === "ext";
    case "public":
      return !agentOnly;
  }
}

// Exact-segment match with `:name` path params; returns null on no match.
export function matchPath(defPath: string, pathname: string): Record<string, string> | null {
  const segs = pathname.split("/").filter(Boolean);
  const defSegs = defPath.split("/").filter(Boolean);
  if (defSegs.length !== segs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    const want = defSegs[i]!;
    const got = segs[i]!;
    if (want.startsWith(":")) params[want.slice(1)] = decodeURIComponent(got);
    else if (want !== got) return null;
  }
  return params;
}

// First method+path match (no scope filtering), for stream routes and any single-scope match.
export function matchRoute<T extends { method: string; path: string }>(
  defs: T[],
  method: string,
  pathname: string,
): { def: T; params: Record<string, string> } | null {
  for (const def of defs) {
    if (def.method !== method) continue;
    const params = matchPath(def.path, pathname);
    if (params !== null) return { def, params };
  }
  return null;
}

export type ExtensionRouteMatch = { kind: "match"; def: RouteDef; params: Record<string, string> } | { kind: "denied" } | { kind: "none" };

// Match an extension route by method+path AND scope. Two routes may share a method+path with different
// scopes (e.g. an operator route and an agent self-child route); the first whose scope allows wins.
// `denied` means a route matched the path but none allowed the principal (403/401); `none` means no
// extension route owns this path at all (fall through to the core handler).
export function matchExtensionRoute(
  routes: RouteDef[],
  method: string,
  pathname: string,
  principal: Principal | null,
  agentOnly: boolean,
): ExtensionRouteMatch {
  let denied = false;
  for (const def of routes) {
    if (def.method !== method) continue;
    const params = matchPath(def.path, pathname);
    if (params === null) continue;
    if (scopeAllows(def.scope, principal, agentOnly)) return { kind: "match", def, params };
    denied = true;
  }
  return denied ? { kind: "denied" } : { kind: "none" };
}
