import type { Schema } from "../schema-check.ts";

// Provenance: checked against the Kubernetes API reference on 2026-11-13, not against a live cluster. meta/v1 Status (the body of a failed API call and of the exec status channel):
// https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/status/ (apiVersion, kind, metadata, status Success|Failure, message, reason, code, details),
// https://kubernetes.io/docs/reference/kubernetes-api/definitions/status-details-v1-meta/ (name, group, kind, uid, retryAfterSeconds, causes) and
// https://kubernetes.io/docs/reference/kubernetes-api/definitions/status-cause-v1-meta/ (reason, message, field).
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
