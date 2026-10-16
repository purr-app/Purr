import { isPureTemplateReference, templateTokens } from "../../../domain/template-expression";
import { getRequestQueryParamsFromUrl, type RequestDraft } from "../../request-workbench/model/request";
import type { RequestBodyField } from "../../request-workbench/model/request-body";
import { resolveEnvironmentValue } from "../../../shared/lib/resolve-variables";

// Only the active fields are resolved. Templates in inactive body/auth modes and
// disabled rows must not prevent a request from being sent. Binary bytes are opaque.
export function resolveRequestEnvironment(draft: RequestDraft, variables: Record<string, string>, options: { redacted?: boolean } = {}): RequestDraft {
  const resolve = (value: string) => resolveEnvironmentValue(value, variables);
  const resolveJson = (value: string) => {
    if (!options.redacted) return resolve(value);
    let cursor = 0;
    let output = "";
    let quoted = false;
    for (const token of templateTokens(value)) {
      for (let index = cursor; index < token.from; index++) {
        if (value[index] === "\\" && quoted) index++;
        else if (value[index] === '"') quoted = !quoted;
      }
      const replacement = resolve(token.text);
      output += value.slice(cursor, token.from) + (!quoted && replacement.includes("********") ? JSON.stringify(replacement) : replacement);
      cursor = token.to;
    }
    return output + value.slice(cursor);
  };
  const resolveGraphqlVariables = (value: string) => {
    try {
      const visit = (current: unknown): unknown => {
        if (typeof current === "string") {
          const resolved = resolve(current);
          if (isPureTemplateReference(current)) {
            try { return JSON.parse(resolved); } catch { return resolved; }
          }
          return resolved;
        }
        if (Array.isArray(current)) return current.map(visit);
        if (current && typeof current === "object") return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, visit(child)]));
        return current;
      };
      return JSON.stringify(visit(value.trim() ? JSON.parse(value) : {}), null, 2);
    } catch {
      return resolveJson(value);
    }
  };
  const url = resolve(draft.url);
  const fields = (rows: RequestBodyField[]) => rows.map((row) => row.enabled
    ? { ...row, key: resolve(row.key), value: row.fieldType === "file" ? row.value : resolve(row.value), contentType: row.contentType ? resolve(row.contentType) : row.contentType }
    : row);
  const body = { ...draft.body };
  if (!draft.graphql && body.type === "json") body.json = resolveJson(body.json);
  if (!draft.graphql && (body.type === "xml" || body.type === "text")) body[body.type] = resolve(body[body.type]);
  if (!draft.graphql && body.type === "form-data") body.formData = fields(body.formData);
  if (!draft.graphql && body.type === "url-encoded") body.urlEncoded = fields(body.urlEncoded);
  const params = draft.params.map((param) => param.enabled ? { ...param, key: resolve(param.key), value: resolve(param.value) } : param);
  const pathParams = draft.pathParams?.map((param) => param.enabled
    ? { ...param, key: resolve(param.key), value: resolve(param.value) }
    : param);
  // A URL variable can include its own query string. Keep those parameters too.
  const urlParams = getRequestQueryParamsFromUrl(url).filter((param) => param.enabled)
    .map((param) => ({ ...param, key: resolve(param.key), value: resolve(param.value) }))
    .filter((param) => !params.some((row) => row.key === param.key));
  return { ...draft,
    traceHeaderTemplates: draft.traceHeaderTemplates?.map((header) => ({ name: resolve(header.name),
      value: header.value.replace(/\{\{([^{}]+)\}\}/g, (template, name: string) => ["$traceparent", "$b3", "$traceId", "$spanId"].includes(name.trim()) ? `{{${name.trim()}}}` : resolve(template)) })),
    ...(draft.graphql ? { graphql: { ...draft.graphql, query: resolve(draft.graphql.query), variables: resolveGraphqlVariables(draft.graphql.variables), operationName: resolve(draft.graphql.operationName) } } : {}),
    url, body,
    ...(pathParams ? { pathParams } : {}),
    params: [...urlParams, ...params],
    headers: draft.headers.map((header) => header.enabled ? { ...header, name: resolve(header.name), value: resolve(header.value) } : header),
  };
}
