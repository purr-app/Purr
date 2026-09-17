import type { IntegrationDefinition } from "../../../domain/project";
import type { RequestDraft } from "./request";

export function resolveRequestTracing(request: RequestDraft, integrations: readonly IntegrationDefinition[], workspacePropagation?: string) {
  const integration = request.tracing?.integrationId
    ? integrations.find((item) => item.id === request.tracing?.integrationId && item.enabled)
    : integrations.find((item) => item.enabled);
  const legacy = request.tracePropagation ?? workspacePropagation;
  const enabled = request.tracing?.enabled ?? Boolean(legacy && legacy !== "off");
  return { integration, enabled: enabled && Boolean(integration),
    propagation: enabled && integration ? integration.tracing?.propagation ?? legacy ?? "w3c" : "off" };
}

export const standardTraceHeaderNames = ["traceparent", "tracestate", "b3", "x-b3-traceid", "x-b3-spanid", "x-b3-sampled", "x-b3-flags"];
export function traceHeaderPreview(draft: RequestDraft) {
  if (!draft.tracePropagation || draft.tracePropagation === "off") return [];
  if (draft.headers.some((header) => header.enabled && standardTraceHeaderNames.includes(header.name.toLowerCase()))) return [];
  const templates = draft.traceHeaderTemplates?.length ? draft.traceHeaderTemplates
    : draft.tracePropagation === "w3c" ? [{ name: "traceparent", value: "{{$traceparent}}" }]
      : draft.tracePropagation === "b3" ? [{ name: "b3", value: "{{$b3}}" }] : [];
  if (templates.some((template) => /\{\{\$(traceparent|b3|traceId|spanId)\}\}/.test(template.value)
    && draft.headers.some((header) => header.enabled && header.name.toLowerCase() === template.name.toLowerCase()))) return [];
  return templates.filter((template) => !draft.headers.some((header) => header.enabled && header.name.toLowerCase() === template.name.toLowerCase()))
    .map((header, index) => ({ ...header, id: `trace-generated-${index}`, enabled: true, readOnly: true,
      readOnlyReason: "Managed by tracing. Generated when this request is sent." }));
}
