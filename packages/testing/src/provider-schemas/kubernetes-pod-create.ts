import type { Schema } from "../schema-check.ts";

// Provenance: checked against the Kubernetes API reference on 2026-11-13, not against a live cluster. Request-body subset for POST /api/v1/namespaces/{namespace}/pods (core/v1 Pod):
// https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/ (Pod, PodSpec: restartPolicy Always|OnFailure|Never, activeDeadlineSeconds, containers; Container: name, image, command, args, workingDir, env; EnvVar: name, value)
// and https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/object-meta/ (name, namespace, labels, annotations).
// Deliberately stricter than the reference where we author the body: `image` is optional there (workload controllers default it) and `metadata.name` may be replaced by `generateName`, but a Pod we create names both; EnvVar `valueFrom` is not authored, so it is not listed.
// Strict (additionalProperties:false) because this is a REQUEST body we author: an unknown field is likely our bug, so check the official reference, then add the field here if it is real.
export const kubernetesPodCreate: Schema = {
  type: "object",
  required: ["apiVersion", "kind", "metadata", "spec"],
  additionalProperties: false,
  properties: {
    apiVersion: { const: "v1" },
    kind: { const: "Pod" },
    metadata: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        namespace: { type: "string" },
        labels: { type: "object", additionalProperties: { type: "string" } },
        annotations: { type: "object", additionalProperties: { type: "string" } },
      },
    },
    spec: {
      type: "object",
      required: ["containers"],
      additionalProperties: false,
      properties: {
        restartPolicy: { enum: ["Always", "OnFailure", "Never"] },
        activeDeadlineSeconds: { type: "integer" },
        containers: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "image"],
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              image: { type: "string" },
              command: { type: "array", items: { type: "string" } },
              args: { type: "array", items: { type: "string" } },
              workingDir: { type: "string" },
              env: {
                type: "array",
                items: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string" }, value: { type: "string" } } },
              },
            },
          },
        },
      },
    },
  },
};
