import type { Schema } from "../schema-check.ts";

// Provenance: checked against E2B's published API reference on 2026-11-13, not against a live run. Request body (NewSandbox) of the create-sandbox call:
// https://docs.e2b.dev/api-reference/sandboxes/create-sandbox lists `templateID` (string, required), `timeout` (int32 seconds), `metadata` and `envVars` (string maps),
// and further optional fields this schema leaves out on purpose (cpuCount, autoPause, autoResume, network, mcp, iam, volumeMounts, allow_internet_access).
// The reference marks POST /sandboxes deprecated in favor of POST /v2/sandboxes; this schema covers only the fields the two have in common as documented for the former.
// Strict (additionalProperties:false) because this is a REQUEST body we author: an unknown field is likely our bug, so check the reference, then add the field here if it is real.
// Fixtures that rely on this schema still declare provenance "inferred" until checked against a live run.
export const e2bSandboxCreate: Schema = {
  type: "object",
  required: ["templateID"],
  additionalProperties: false,
  properties: {
    templateID: { type: "string" },
    timeout: { type: "integer" },
    metadata: { type: "object", additionalProperties: { type: "string" } },
    envVars: { type: "object", additionalProperties: { type: "string" } },
  },
};
