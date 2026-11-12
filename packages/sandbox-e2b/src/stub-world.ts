// Test support: the shared provider stub (@pomtree/testing) set up as a stateful E2B, for the conformance run and the dedup tests.
// Not shipped behavior.
//
// The stub's resource model is generic: one collection with create, list (repeated `k=v` tag filters), get and delete. E2B's wire
// differs in three places, so a shaping transport sits between the adapter's request facade and the loopback stub:
//   - the list is GET /v2/sandboxes with one `metadata` value `k=v&k=v`; it is forwarded as GET /sandboxes with one filter per pair;
//   - the model stores the create body, so list and get answers gain the `state` field E2B returns ("running" while the resource
//     exists) and lose the create-only fields; the create answer is reduced to E2B's {sandboxID, templateID, clientID};
//   - every create body is checked against the vendored E2B create schema, and its envVars are kept for the no-sentinel clause.
// The User-Agent the adapter's facade stamped is forwarded unchanged, so the stub's identity collector sees the adapter's own value.

import { createRequest } from "@pomtree/sandbox-kit";
import type { Requester, RequestFn } from "@pomtree/sandbox-kit/request";
import { checkSchema, type IdentityCollector, identityCollector, ProviderStub, type ProviderStubOptions } from "@pomtree/testing";
// TODO(e2b-schema-export): @pomtree/testing's barrel does not export the vendored E2B schema; current behavior: imported by path.
import { e2bSandboxCreate } from "../../testing/src/provider-schemas/e2b-sandbox-create.ts";

export const API_KEY_PLACEHOLDER = "<API_KEY>";

type ResourceSpec = NonNullable<ProviderStubOptions["resources"]>[number];
export const E2B_RESOURCES: readonly ResourceSpec[] = [
  { collection: "/sandboxes", idField: "sandboxID", idPrefix: "sbx", requireKey: false, tagsField: "metadata", filterParam: "metadata" },
];

export interface E2BStubWorld {
  readonly stub: ProviderStub;
  readonly identity: IdentityCollector;
  // Pass as the adapter's request dep: a requester stamping `userAgent`, shaped onto the stub.
  readonly request: Requester;
  // Schema violations of create bodies, as `path: message`.
  readonly schemaFailures: string[];
  // pomtree sandbox id -> the envVars of its create request.
  readonly createEnv: Map<string, Record<string, string>>;
  // After the next create that the stub answers with a 5xx, the next `times` list calls fail with a 5xx too.
  failListsAfterNextCreateError(times: number): void;
  // Removes the sandbox behind the adapter's back, as E2B does when a sandbox's timeout lapses.
  vanish(id: string): Promise<void>;
  close(): Promise<void>;
}

const enc = new TextEncoder();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// The list and get item E2B returns (inferred fields), from a stored create body.
const asInfo = (r: Record<string, unknown>) => ({ sandboxID: r.sandboxID, templateID: r.templateID, state: "running", metadata: r.metadata ?? {} });

export async function startE2BStub(o: {
  userAgent: string;
  stub?: Omit<ProviderStubOptions, "resources" | "observeUserAgent" | "requireHeaderNames">;
}): Promise<E2BStubWorld> {
  const identity = identityCollector();
  const stub = await ProviderStub.start({ ...o.stub, resources: E2B_RESOURCES, observeUserAgent: identity.observe, requireHeaderNames: ["x-api-key"] });
  const schemaFailures: string[] = [];
  const createEnv = new Map<string, Record<string, string>>();
  let failLists = 0;

  const forward: RequestFn = (url, init) => createRequest({ userAgent: init.headers?.["user-agent"] ?? "" })(url, init);
  const shape: RequestFn = async (url, init) => {
    const u = new URL(url);
    const method = init.method.toUpperCase();
    let path = u.pathname;
    let search = u.search;
    if (method === "GET" && path === "/v2/sandboxes") {
      const params = new URLSearchParams();
      for (const [k, v] of u.searchParams) {
        if (k !== "metadata") {
          params.append(k, v); // left for the stub to refuse as an undeclared parameter
          continue;
        }
        for (const part of v.split("&").filter((p) => p !== "")) {
          const eq = part.indexOf("=");
          params.append("metadata", `${decodeURIComponent(part.slice(0, eq))}=${decodeURIComponent(part.slice(eq + 1))}`);
        }
      }
      path = "/sandboxes";
      search = params.size > 0 ? `?${params}` : "";
    }
    const isCreate = method === "POST" && path === "/sandboxes";
    if (isCreate && typeof init.body === "string") {
      const body: unknown = JSON.parse(init.body);
      for (const f of checkSchema(body, e2bSandboxCreate)) schemaFailures.push(`${f.path}: ${f.message}`);
      const id = isObject(body) && isObject(body.metadata) ? body.metadata["pomtree.sandbox"] : undefined;
      if (typeof id === "string" && isObject(body) && isObject(body.envVars)) createEnv.set(id, body.envVars as Record<string, string>);
    }
    const res = await forward(`${u.origin}${path}${search}`, init);
    if (isCreate && res.status >= 500 && failLists > 0) {
      stub.faults.arm("server-error-after-apply", { method: "GET", path: "/sandboxes", times: failLists });
      failLists = 0;
    }
    if (res.status < 200 || res.status > 299 || res.body.length === 0) return res;
    const v: unknown = JSON.parse(Buffer.from(res.body).toString("utf8"));
    let out: unknown = v;
    if (isCreate && isObject(v)) out = { sandboxID: v.sandboxID, templateID: v.templateID, clientID: v.sandboxID };
    else if (method === "GET" && Array.isArray(v)) out = v.map((r) => asInfo(r as Record<string, unknown>));
    else if (method === "GET" && isObject(v)) out = asInfo(v);
    return { ...res, body: enc.encode(JSON.stringify(out)) };
  };
  const request = createRequest({ userAgent: o.userAgent, transport: shape });

  return {
    stub,
    identity,
    request,
    schemaFailures,
    createEnv,
    failListsAfterNextCreateError(times) {
      failLists = times;
    },
    async vanish(id) {
      const r = stub.model.resources("/sandboxes").find((x) => isObject(x.metadata) && x.metadata["pomtree.sandbox"] === id);
      if (r === undefined) throw new Error(`no stub sandbox carries pomtree id ${id}; start it first`);
      const res = await createRequest({ userAgent: o.userAgent })(`${stub.baseUrl}/sandboxes/${String(r.sandboxID)}`, {
        method: "DELETE",
        headers: { "x-api-key": API_KEY_PLACEHOLDER },
      });
      if (res.status !== 204) throw new Error(`the stub refused to remove sandbox ${id} (status ${res.status})`);
    },
    close: () => stub.close(),
  };
}
