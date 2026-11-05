import type { AttributeValue, Span } from "./spans.ts";

// OTLP/HTTP JSON wire shapes: the subset of opentelemetry-proto's
// ExportTraceServiceRequest that collectors require. Pure mapping, no I/O.

export type OtlpValue =
  | { stringValue: string }
  | { intValue: string } // int64 as a decimal string, per the OTLP JSON mapping
  | { doubleValue: number }
  | { boolValue: boolean };

export interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

// 0 = STATUS_CODE_UNSET, 1 = STATUS_CODE_OK, 2 = STATUS_CODE_ERROR.
export type OtlpStatusCode = 0 | 1 | 2;

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 1; // SPAN_KIND_INTERNAL
  startTimeUnixNano: string; // uint64 as decimal string, per the OTLP JSON mapping
  endTimeUnixNano?: string; // omitted while the span is open
  attributes: OtlpAttribute[];
  status: { code: OtlpStatusCode };
}

export interface OtlpTracesRequest {
  resourceSpans: [
    {
      resource: { attributes: OtlpAttribute[] };
      scopeSpans: [{ scope: { name: string; version: string }; spans: OtlpSpan[] }];
    },
  ];
}

export const OTLP_SCOPE = { name: "pomtree", version: "0.0.0" };

export function otlpValue(v: AttributeValue): OtlpValue {
  switch (typeof v) {
    case "string":
      return { stringValue: v };
    case "boolean":
      return { boolValue: v };
    case "number":
      if (!Number.isFinite(v)) return { stringValue: String(v) }; // JSON would turn NaN/Infinity into null
      return Number.isInteger(v) && Math.abs(v) < 2 ** 63 ? { intValue: BigInt(v).toString() } : { doubleValue: v };
  }
}

export const otlpAttributes = (attrs: Record<string, AttributeValue>): OtlpAttribute[] =>
  Object.entries(attrs).map(([key, value]) => ({ key, value: otlpValue(value) }));

// Epoch ms -> Unix nanos as a decimal string. BigInt keeps full precision past 2^53.
// A non-finite timestamp has no nanos; callers pick a fallback rather than letting BigInt throw.
const nano = (ms: number): string | undefined => (Number.isFinite(ms) ? (BigInt(Math.round(ms)) * 1_000_000n).toString() : undefined);

export function toOtlpSpan(s: Span): OtlpSpan {
  const out: OtlpSpan = {
    traceId: s.traceId,
    spanId: s.spanId,
    name: s.name,
    kind: 1,
    startTimeUnixNano: nano(s.startTs) ?? "0",
    attributes: otlpAttributes(s.attributes),
    status: { code: s.status === "ok" ? 1 : s.status === "error" ? 2 : 0 },
  };
  if (s.parentSpanId !== null) out.parentSpanId = s.parentSpanId;
  const end = s.endTs === null ? undefined : nano(s.endTs);
  if (end !== undefined) out.endTimeUnixNano = end;
  return out;
}

export function toOtlpRequest(spans: readonly Span[], resource: Record<string, AttributeValue> = {}): OtlpTracesRequest {
  return {
    resourceSpans: [
      {
        resource: { attributes: otlpAttributes(resource) },
        scopeSpans: [{ scope: { ...OTLP_SCOPE }, spans: spans.map(toOtlpSpan) }],
      },
    ],
  };
}
