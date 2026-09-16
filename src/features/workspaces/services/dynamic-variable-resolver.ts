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

export type DynamicVariableResolution = {
  values: Record<string, string>;
  sensitiveNames: Set<string>;
  cache: Record<string, DynamicVariableCacheEntry>;
};

export class DynamicVariableResolutionError extends Error {
  constructor(message: string, readonly cache: Record<string, DynamicVariableCacheEntry>) {
    super(message);
    this.name = "DynamicVariableResolutionError";
  }
}

type ResolveOptions = {
  root: DynamicVariableRequest;
  environmentId: string | null;
  documents: readonly DynamicVariableRequest[];
  variablesForEnvironment: (environmentId: string | null) => Promise<readonly Variable[]>;
  execute: (document: DynamicVariableRequest, values: Record<string, string>, environmentId: string | null) => Promise<StoredHttpResponse>;
  persistentCache: Record<string, DynamicVariableCacheEntry>;
  sessionCache: Map<string, DynamicVariableCacheEntry>;
  responseContent?: ResponseContentPort;
  forceVariableIds?: ReadonlySet<string>;
};

const placeholder = (name: string) => `{{${name}}}`;
const referencedNames = (value: string) => [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1].trim());

function requestTemplateText(request: RequestDraft) {
  const body = request.body.type === "json" || request.body.type === "xml" || request.body.type === "text"
    ? request.body[request.body.type]
    : request.body.type === "form-data" ? request.body.formData.filter((row) => row.enabled).map((row) => `${row.key}\n${row.value}\n${row.contentType ?? ""}`).join("\n")
      : request.body.type === "url-encoded" ? request.body.urlEncoded.filter((row) => row.enabled).map((row) => `${row.key}\n${row.value}`).join("\n") : "";
  const auth = request.auth.type === "bearer" ? `${request.auth.bearer.prefix}\n${request.auth.bearer.token}`
    : request.auth.type === "basic" ? `${request.auth.basic.username}\n${request.auth.basic.password}`
      : request.auth.type === "api-key" ? `${request.auth.apiKey.name}\n${request.auth.apiKey.value}`
        : request.auth.type === "oauth2" ? `${request.auth.oauth2.authorizationUrl}\n${request.auth.oauth2.tokenUrl}\n${request.auth.oauth2.clientId}\n${request.auth.oauth2.clientSecret}\n${request.auth.oauth2.scopes}\n${request.auth.oauth2.redirectUri}` : "";
  return [request.url,
    ...request.params.filter((row) => row.enabled).flatMap((row) => [row.key, row.value]),
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

  const resolveDocument = async (
    document: DynamicVariableRequest,
    environmentId: string | null,
    path: Array<{ document: DynamicVariableRequest; variable?: Variable }>,
  ): Promise<{ values: Record<string, string>; sensitiveNames: Set<string> }> => {
    const repeated = path.findIndex((entry) => entry.document.id === document.id);
    if (repeated >= 0) {
      const cycle = [...path.slice(repeated), { document }]
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
    const templates = requestTemplateText(document.request);
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
        if (!sourceDocument) throw new Error(`Dynamic variable “${variable.name}” refers to a missing saved request.`);
        const startedAt = performance.now();
        try {
          const dependency = await resolveDocument(sourceDocument, sourceEnvironmentId, [...path, { document, variable }]);
          const response = await options.execute(sourceDocument, dependency.values, sourceEnvironmentId);
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
            try {
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
            } finally {
              await options.responseContent.release(response.content).catch(() => {});
            }
          }
          entry = { status: "success", value: valueText(extracted), resolvedAt: new Date().toISOString(), durationMs: performance.now() - startedAt,
            environmentId: sourceEnvironmentId, fingerprint: hash };
          nextPersistent[key] = entry;
          if (variable.refresh === "session") options.sessionCache.set(key, entry);
          perRun.set(key, entry);
        } catch (cause) {
          nextPersistent[key] = { status: "error", error: cause instanceof Error ? cause.message : String(cause), resolvedAt: new Date().toISOString(),
            durationMs: performance.now() - startedAt, environmentId: sourceEnvironmentId, fingerprint: hash };
          throw cause;
        }
      }
      values[variable.name.trim()] = entry.value ?? "";
    }
    return { values, sensitiveNames };
  };

  try {
    const resolved = await resolveDocument(options.root, options.environmentId, []);
    return { ...resolved, cache: nextPersistent };
  } catch (cause) {
    throw new DynamicVariableResolutionError(cause instanceof Error ? cause.message : String(cause), nextPersistent);
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

export type DynamicVariableGraph = { edges: string[]; cycle?: string };

/** A side-effect-free preview of the request chain used by the Variables UI. */
export function inspectDynamicVariableGraph(root: Variable, variables: readonly Variable[], documents: readonly DynamicVariableRequest[]): DynamicVariableGraph {
  const edges: string[] = [];
  let cycle: string | undefined;
  const walk = (variable: Variable, path: Array<{ variable: Variable; document: DynamicVariableRequest }>) => {
    if (cycle || variable.kind !== "dynamic-request") return;
    const document = documents.find((candidate) => candidate.id === variable.documentId);
    if (!document) { edges.push(`{{${variable.name}}} → Missing request`); return; }
    const repeated = path.findIndex((entry) => entry.document.id === document.id);
    const next = [...path, { variable, document }];
    const label = `{{${variable.name}}} → ${document.name}`;
    if (!edges.includes(label)) edges.push(label);
    if (repeated >= 0) {
      cycle = next.slice(repeated).flatMap((entry) => [`{{${entry.variable.name}}}`, entry.document.name]).join(" → ");
      return;
    }
    const needed = new Set(referencedNames(requestTemplateText(document.request)));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const candidate of variables) {
        if (!needed.has(candidate.name.trim()) || candidate.kind !== "static") continue;
        for (const dependency of referencedNames(candidate.value)) if (!needed.has(dependency)) { needed.add(dependency); expanded = true; }
      }
    }
    for (const dependency of variables.filter((candidate) => candidate.kind === "dynamic-request"
      && needed.has(candidate.name.trim()))) walk(dependency, next);
  };
  walk(root, []);
  return { edges, ...(cycle ? { cycle } : {}) };
}
