import type { Schema } from "../schema-check.ts";

// Provenance: inferred. meta/v1 Status (the body of a failed API call and of the exec status channel), written from memory; not fetched and not verified against the official reference.
// Source to check against: https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/status/
// Lenient: this validates RESPONSES, which the provider may extend, so extra fields are accepted and only the fields the adapter depends on (kind, apiVersion, status) are required.
export const kubernetesStatus: Schema = {
  type: "object",
  required: ["kind", "apiVersion", "status"],
  properties: {
    kind: { const: "Status" },
    apiVersion: { const: "v1" },
    metadata: { type: "object" },
    status: { enum: ["Success", "Failure"] },
    message: { type: "string" },
    reason: { type: "string" },
    code: { type: "integer" },
    details: {
      type: "object",
      properties: {
        name: { type: "string" },
        group: { type: "string" },
        kind: { type: "string" },
        uid: { type: "string" },
        retryAfterSeconds: { type: "integer" },
        causes: {
          type: "array",
          items: {
            type: "object",
            properties: { reason: { type: "string" }, message: { type: "string" }, field: { type: "string" } },
          },
        },
      },
    },
  },
};
