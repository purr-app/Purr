import { applyWorkspaceRequestConfig, getWorkspaceAuth, type WorkspaceRequestConfig } from "../../request-workbench/model/request-workspace-config";
import type { DynamicExecutionMetadata } from "../../../application/ports/history";
import type { RequestDraft } from "../../request-workbench/model/request";
import type { ResponseContentPort } from "../../../application/ports/response-content";
import {
  isInlineHttpResponse,
  type StoredHttpResponse,
} from "../../../domain/http";
import { queryResponseJson } from "../../request-workbench/model/response";
import type { DynamicVariableCacheEntry, RequestDocumentKind, Variable } from "../model/workspace";

export type DynamicVariableRequest = {
  id: string;
  name: string;
  kind: RequestDocumentKind;
  request: RequestDraft;
};

export type DynamicExecutionStep = {
  id: string;
  documentId: string;
  name: string;
  variableId: string;
  variableName: string;
  environmentId: string | null;
  parentId?: string;
  state: "pending" | "running" | "resolved" | "cached" | "failed" | "blocked" | "cycle";
  expression: string;
  language: "jq" | "jsonpath";
  status?: number;
  durationMs?: number;
  error?: string;
  historyEntryId?: string;
};
export type DynamicExecutionRecord = {
  document: DynamicVariableRequest;
  response: StoredHttpResponse | null;
  error: string;
  outcome: "response" | "error" | "cancelled";
  startedAt: number;
  durationMs: number;
  dynamicExecution: DynamicExecutionMetadata;
};

/** Apply the same inherited fields/auth as Send for dependency discovery only. */
export function effectiveDynamicRequest(document: DynamicVariableRequest, config?: WorkspaceRequestConfig): RequestDraft {
  if (!config) return document.request;
  const request = applyWorkspaceRequestConfig(document.request, document.kind, config);
  if (request.auth.type !== "inherit" || !request.workspace.authEnabled) return request;
  const auth = getWorkspaceAuth(config, document.kind, request.auth.inherit.profileId);
  return auth ? { ...request, auth: auth.value } : request;
}

export type DynamicVariableResolution = {
  steps: DynamicExecutionStep[];
  values: Record<string, string>;
  sensitiveNames: Set<string>;
  cache: Record<string, DynamicVariableCacheEntry>;
};

export class DynamicVariableResolutionError extends Error {
  constructor(message: string, readonly cache: Record<string, DynamicVariableCacheEntry>, readonly steps: DynamicExecutionStep[] = []) {
    super(message);
    this.name = "DynamicVariableResolutionError";
  }
}

type ResolveOptions = {
  root: DynamicVariableRequest;
  environmentId: string | null;
  documents: readonly DynamicVariableRequest[];
  variablesForEnvironment: (environmentId: string | null) => Promise<readonly Variable[]>;
  execute: (document: DynamicVariableRequest, values: Record<string, string>, environmentId: string | null, execution: { onDispatch: () => void }) => Promise<StoredHttpResponse>;
  persistentCache: Record<string, DynamicVariableCacheEntry>;
  sessionCache: Map<string, DynamicVariableCacheEntry>;
  responseContent?: ResponseContentPort;
  forceVariableIds?: ReadonlySet<string>;
  workspaceConfig?: WorkspaceRequestConfig;
  signal?: AbortSignal;
  onSteps?: (steps: DynamicExecutionStep[]) => void;
  onExecuted?: (record: DynamicExecutionRecord) => Promise<string | undefined>;
  onHistoryError?: () => void;
};

const placeholder = (name: string) => `{{${name}}}`;
export const referencedNames = (value: string) => [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1].trim());

export function requestTemplateText(request: RequestDraft) {
  const body = request.body.type === "json" || request.body.type === "xml" || request.body.type === "text"
    ? request.body[request.body.type]
    : request.body.type === "form-data" ? request.body.formData.filter((row) => row.enabled).map((row) => `${row.key}\n${row.fieldType === "file" ? "" : row.value}\n${row.contentType ?? ""}`).join("\n")
      : request.body.type === "url-encoded" ? request.body.urlEncoded.filter((row) => row.enabled).map((row) => `${row.key}\n${row.value}`).join("\n") : "";
  const auth = request.auth.type === "bearer" ? `${request.auth.bearer.prefix}\n${request.auth.bearer.token}`
    : request.auth.type === "basic" ? `${request.auth.basic.username}\n${request.auth.basic.password}`
      : request.auth.type === "api-key" ? `${request.auth.apiKey.name}\n${request.auth.apiKey.value}`
        : request.auth.type === "oauth2" ? `${request.auth.oauth2.authorizationUrl}\n${request.auth.oauth2.tokenUrl}\n${request.auth.oauth2.clientId}\n${request.auth.oauth2.clientSecret}\n${request.auth.oauth2.scopes}\n${request.auth.oauth2.redirectUri}` : "";
  return [request.url,
    ...request.params.filter((row) => row.enabled).flatMap((row) => [row.key, row.value]),
    ...(request.pathParams ?? []).filter((row) => row.enabled).flatMap((row) => [row.key, row.value]),
    ...(request.traceHeaderTemplates ?? []).flatMap((row) => [row.name, row.value.replace(/{{\s*\$(?:traceparent|b3|traceId|spanId)\s*}}/g, "")]),
    ...request.headers.filter((row) => row.enabled).flatMap((row) => [row.name, row.value]),
    request.graphql?.query ?? "", request.graphql?.variables ?? "", request.graphql?.operationName ?? "", body, auth,
  ].join("\n");
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (["number", "boolean", "bigint"].includes(typeof value)) return String(value);
  return JSON.stringify(value);
}

function fingerprint(variable: Variable) {
  return JSON.stringify(variable);
}

export function dynamicVariableCacheKey(variableId: string, environmentId: string | null) {
  return `${variableId}:${environmentId ?? "none"}`;
}

export async function resolveDynamicVariables(options: ResolveOptions): Promise<DynamicVariableResolution> {
  const perRun = new Map<string, DynamicVariableCacheEntry>();
  const nextPersistent = { ...options.persistentCache };
  const groupId = crypto.randomUUID();
  const steps: DynamicExecutionStep[] = [];
  const snapshot = () => steps.map((step) => ({ ...step }));
  const publish = () => options.onSteps?.(snapshot());

  const resolveDocument = async (
    document: DynamicVariableRequest,
    environmentId: string | null,
    path: Array<{ document: DynamicVariableRequest; variable?: Variable; environmentId: string | null }>,
    parentId?: string,
  ): Promise<{ values: Record<string, string>; sensitiveNames: Set<string> }> => {
    const repeated = path.findIndex((entry) => entry.document.id === document.id && entry.environmentId === environmentId);
    if (repeated >= 0) {
      const cycle = [...path.slice(repeated), { document, environmentId, variable: undefined }]
        .map((entry) => entry.variable ? `${entry.document.name} — {{${entry.variable.name}}}` : entry.document.name)
        .join(" → ");
      throw new Error(`Dynamic variable dependency cycle: ${cycle}`);
    }
    const namespace = (await options.variablesForEnvironment(environmentId)).filter((variable) => variable.name.trim());
    const ambiguous = namespace.find((variable, index) => namespace.findIndex((candidate) => candidate.name.trim() === variable.name.trim()) !== index);
    if (ambiguous) throw new Error(`Variable "${ambiguous.name.trim()}" has multiple definitions in the effective namespace.`);
    const scoped = namespace.filter((variable) => variable.enabled);
    const values = Object.fromEntries(scoped.flatMap((variable) => variable.kind === "static"
      ? [[variable.name.trim(), variable.value] as const] : []));
    const sensitiveNames = new Set(scoped.filter((variable) => variable.sensitive).map((variable) => variable.name.trim()));
    const templates = requestTemplateText(effectiveDynamicRequest(document, options.workspaceConfig));
    const needed = new Set(referencedNames(templates));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const variable of scoped) {
        if (!needed.has(variable.name.trim()) || variable.kind !== "static") continue;
        for (const dependency of referencedNames(variable.value)) if (!needed.has(dependency)) { needed.add(dependency); expanded = true; }
      }
    }
    for (const name of needed) {
      const definition = namespace.find((variable) => variable.name.trim() === name);
      if (definition && !definition.enabled) throw new Error(`Variable "${name}" is disabled.`);
    }
    const dynamic = scoped.filter((variable) => variable.kind === "dynamic-request" && needed.has(variable.name.trim()));
    for (const variable of dynamic) {
      if (variable.kind !== "dynamic-request") continue;
      const sourceEnvironmentId = variable.environment.type === "specific" ? variable.environment.environmentId : environmentId;
      const step: DynamicExecutionStep = { id: crypto.randomUUID(), documentId: variable.documentId, name: options.documents.find((item) => item.id === variable.documentId)?.name ?? "Missing request",
        variableId: variable.id, variableName: variable.name, environmentId: sourceEnvironmentId, parentId, state: "pending", expression: variable.expression || (variable.language === "jq" ? "." : "$"), language: variable.language };
      steps.push(step); publish();
      const key = dynamicVariableCacheKey(variable.id, sourceEnvironmentId);
      const hash = fingerprint(variable);
      const persisted = nextPersistent[key];
      const cacheFresh = variable.refresh === "cache" && persisted?.status === "success" && persisted.fingerprint === hash
        && Date.now() - Date.parse(persisted.resolvedAt) < (variable.cacheTtlSeconds ?? 300) * 1000;
      const cached = perRun.get(key)
        ?? (variable.refresh === "session" ? options.sessionCache.get(key) : undefined)
        ?? (cacheFresh ? persisted : undefined);
      let entry = options.forceVariableIds?.has(variable.id) ? undefined
        : cached?.status === "success" && cached.fingerprint === hash ? cached : undefined;
      if (!entry) {
        const sourceDocument = options.documents.find((candidate) => candidate.id === variable.documentId);
        if (!sourceDocument) { step.state = "failed"; step.error = `Dynamic variable “${variable.name}” refers to a missing saved request.`; publish(); throw new Error(step.error); }
        const startedAt = performance.now();
        let dispatched = false;
        let executionStartedAt = Date.now();
        let response: StoredHttpResponse | null = null;
        let extraction: DynamicExecutionMetadata["extraction"];
        try {
          const dependency = await resolveDocument(sourceDocument, sourceEnvironmentId, [...path, { document, variable, environmentId }], step.id);
          options.signal?.throwIfAborted();
          step.state = "running"; publish();
          executionStartedAt = Date.now();
          response = await options.execute(sourceDocument, dependency.values, sourceEnvironmentId, { onDispatch: () => { dispatched = true; } });
          dispatched = true;
          step.status = isInlineHttpResponse(response) ? response.status : response.response.status;
          const expression = variable.expression || (variable.language === "jq" ? "." : "$");
          let extracted: unknown;
          if (isInlineHttpResponse(response)) {
            let parsed: unknown;
            try { parsed = JSON.parse(response.text); }
            catch { throw new Error(`Dynamic variable “${variable.name}” expected a JSON response from ${sourceDocument.name}.`); }
            extracted = queryResponseJson(parsed, expression, variable.language);
          } else {
            if (!options.responseContent)
              throw new Error(`Dynamic variable “${variable.name}” cannot access native response content.`);
            {
              const result = await options.responseContent.query(response.content, {
                language: variable.language,
                expression,
              });
              if (result.kind === "value") extracted = result.value;
              else if (result.kind === "window") extracted = JSON.parse(result.window.content);
              else {
                await options.responseContent.release(result.reference).catch(() => {});
                throw new Error(`Dynamic variable “${variable.name}” produced a value too large to use in a request.`);
              }
            }
          }
          extraction = { language: variable.language, expression, status: "success" };
          step.state = "resolved";
          entry = { status: "success", value: valueText(extracted), resolvedAt: new Date().toISOString(), durationMs: performance.now() - startedAt,
            environmentId: sourceEnvironmentId, fingerprint: hash };
          nextPersistent[key] = entry;
          if (variable.refresh === "session") options.sessionCache.set(key, entry);
          perRun.set(key, entry);
        } catch (cause) {
          step.error = cause instanceof Error ? cause.message : String(cause);
          step.state = step.error.startsWith("Dynamic variable dependency cycle:") && !steps.some((item) => item.state === "cycle") ? "cycle" : dispatched ? "failed" : "blocked";
          if (response) extraction = { language: variable.language, expression: step.expression, status: "error", error: step.error };
          nextPersistent[key] = { status: "error", error: cause instanceof Error ? cause.message : String(cause), resolvedAt: new Date().toISOString(),
            durationMs: performance.now() - startedAt, environmentId: sourceEnvironmentId, fingerprint: hash };
          throw cause;
        } finally {
          step.durationMs = performance.now() - startedAt;
          if (dispatched) {
            try {
              step.historyEntryId = await options.onExecuted?.({ document: sourceDocument, response,
                error: response ? "" : step.error ?? "", outcome: response ? "response" : options.signal?.aborted ? "cancelled" : "error",
                startedAt: executionStartedAt, durationMs: Date.now() - executionStartedAt,
                dynamicExecution: { groupId, rootDocumentId: options.root.id, parentDocumentId: document.id, variableId: variable.id, variableName: variable.name, environmentId: sourceEnvironmentId, extraction } });
            } catch { options.onHistoryError?.(); }
          }
          if (response && !isInlineHttpResponse(response)) await options.responseContent?.release(response.content).catch(() => {});
          publish();
        }
      } else { step.state = "cached"; publish(); }
      values[variable.name.trim()] = entry.value ?? "";
    }
    return { values, sensitiveNames };
  };

  try {
    const resolved = await resolveDocument(options.root, options.environmentId, []);
    return { ...resolved, cache: nextPersistent, steps: snapshot() };
  } catch (cause) {
    throw new DynamicVariableResolutionError(cause instanceof Error ? cause.message : String(cause), nextPersistent, snapshot());
  }
}

export function dynamicVariableDependencies(root: DynamicVariableRequest, variables: readonly Variable[], documents: readonly DynamicVariableRequest[]) {
  const templates = requestTemplateText(root.request);
  return variables.filter((variable) => variable.kind === "dynamic-request"
    && templates.includes(placeholder(variable.name.trim()))).map((variable) => ({
      variable,
      document: documents.find((document) => variable.kind === "dynamic-request" && document.id === variable.documentId),
    }));
}

export type DynamicVariableGraph = { edges: string[]; cycle?: string; steps: DynamicExecutionStep[] };

/** A side-effect-free preview of the request chain used by the Variables UI. */
export function inspectDynamicVariableGraph(root: Variable, variables: readonly Variable[], documents: readonly DynamicVariableRequest[], config?: WorkspaceRequestConfig, environmentId: string | null = null, variablesForEnvironment?: (id: string | null) => readonly Variable[]): DynamicVariableGraph {
  const edges: string[] = [];
  const steps: DynamicExecutionStep[] = [];
  let cycle: string | undefined;
  const walk = (variable: Variable, path: Array<{ variable: Variable; document: DynamicVariableRequest; environmentId: string | null }>, parentId?: string, currentEnvironmentId = environmentId) => {
    if (cycle || variable.kind !== "dynamic-request") return;
    const document = documents.find((candidate) => candidate.id === variable.documentId);
    const sourceEnvironmentId = variable.environment.type === "specific" ? variable.environment.environmentId : currentEnvironmentId;
    const step: DynamicExecutionStep = { id: String(steps.length), parentId, documentId: variable.documentId, name: document?.name ?? "Missing request", variableId: variable.id, variableName: variable.name, environmentId: sourceEnvironmentId,
      expression: variable.expression, language: variable.language, state: document ? "pending" : "failed" };
    steps.push(step);
    if (!document) { edges.push(`{{${variable.name}}} → Missing request`); step.error = "Source request no longer exists."; return; }
    const repeated = path.findIndex((entry) => entry.document.id === document.id && entry.environmentId === sourceEnvironmentId);
    const next = [...path, { variable, document, environmentId: sourceEnvironmentId }];
    const label = `{{${variable.name}}} → ${document.name}`;
    if (!edges.includes(label)) edges.push(label);
    if (repeated >= 0) {
      step.state = "cycle";
      step.error = "This request is already in the dependency path.";
      cycle = next.slice(repeated).flatMap((entry) => [`{{${entry.variable.name}}}`, entry.document.name]).join(" → ");
      return;
    }
    const scoped = variablesForEnvironment?.(sourceEnvironmentId) ?? variables;
    const needed = new Set(referencedNames(requestTemplateText(effectiveDynamicRequest(document, config))));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const candidate of scoped) {
        if (!needed.has(candidate.name.trim()) || candidate.kind !== "static") continue;
        for (const dependency of referencedNames(candidate.value)) if (!needed.has(dependency)) { needed.add(dependency); expanded = true; }
      }
    }
    for (const dependency of scoped.filter((candidate) => candidate.kind === "dynamic-request"
      && needed.has(candidate.name.trim()))) walk(dependency, next, step.id, sourceEnvironmentId);
  };
  walk(root, []);
  return { edges, steps, ...(cycle ? { cycle } : {}) };
}
