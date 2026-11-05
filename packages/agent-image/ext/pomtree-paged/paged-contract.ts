// The constants shared by every closed paged-reader tool profile (the digest analyst, the research specialist): the agent-id
// test and the failure causes the shared core (paged.ts) can return. Pure and dependency-free, so each profile's own contract file
// re-exports from it and the hosts that import those contracts stay free of Node and Pi. Not an extension: there is no index.ts here.

// A POMTREE_AGENT_ID is a plain id (the entrypoint applies the same test); anything else is refused rather than passed on as an argument.
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

// The causes paged.ts itself returns. Each profile's closed cause list must include all of them (the profile cores' outcome types check
// it at compile time); a profile adds only its own validation causes. Each reaches the model and the daemon journal only as the
// `(cause=<token>)` suffix the daemon parses (pomtreed toolFailureCauseOf, `[a-z_]{1,32}`), never with pomtree's stderr or any page text.
export const PAGED_CAUSES = ["invalid_page", "no_agent", "unavailable", "too_large", "timeout", "read_failed", "already_submitted", "submit_failed"] as const;
export type PagedCause = (typeof PAGED_CAUSES)[number];
