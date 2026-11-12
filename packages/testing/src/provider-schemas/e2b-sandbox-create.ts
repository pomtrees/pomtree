import type { Schema } from "../schema-check.ts";

// Provenance: inferred. Request body of E2B's create-sandbox call; no source was consulted, so every field here is a guess to check against https://e2b.dev/docs.
// Strict (additionalProperties:false) because this is a REQUEST body we author: an unknown field is likely our bug, so check the official docs, then add the field here if it is real.
// Fixtures that rely on this schema must declare provenance "inferred" until checked against a live run.
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
