import { getRequestQueryParamsFromUrl, type RequestDraft } from "../../request-workbench/model/request";
import type { RequestBodyField } from "../../request-workbench/model/request-body";
import { resolveEnvironmentValue } from "../../../shared/lib/resolve-variables";

// Only the active fields are resolved. Templates in inactive body/auth modes and
// disabled rows must not prevent a request from being sent. Binary bytes are opaque.
export function resolveRequestEnvironment(draft: RequestDraft, variables: Record<string, string>): RequestDraft {
  const resolve = (value: string) => resolveEnvironmentValue(value, variables);
  const resolveGraphqlVariables = (value: string) => {
    try {
      const visit = (current: unknown): unknown => {
        if (typeof current === "string") {
          const resolved = resolve(current);
          if (/^\s*{{[^{}]+}}\s*$/.test(current)) {
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
      return resolve(value);
    }
  };
  const url = resolve(draft.url);
  const fields = (rows: RequestBodyField[]) => rows.map((row) => row.enabled
    ? { ...row, key: resolve(row.key), value: row.fieldType === "file" ? row.value : resolve(row.value), contentType: row.contentType ? resolve(row.contentType) : row.contentType }
    : row);
  const body = { ...draft.body };
  if (body.type === "json" || body.type === "xml" || body.type === "text") body[body.type] = resolve(body[body.type]);
  if (body.type === "form-data") body.formData = fields(body.formData);
  if (body.type === "url-encoded") body.urlEncoded = fields(body.urlEncoded);
  const params = draft.params.map((param) => param.enabled ? { ...param, key: resolve(param.key), value: resolve(param.value) } : param);
  // A URL variable can include its own query string. Keep those parameters too.
  const urlParams = getRequestQueryParamsFromUrl(url).filter((param) => param.enabled)
    .map((param) => ({ ...param, key: resolve(param.key), value: resolve(param.value) }))
    .filter((param) => !params.some((row) => row.key === param.key));
  return { ...draft,
    ...(draft.graphql ? { graphql: { ...draft.graphql, query: resolve(draft.graphql.query), variables: resolveGraphqlVariables(draft.graphql.variables), operationName: resolve(draft.graphql.operationName) } } : {}),
    url, body,
    params: [...urlParams, ...params],
    headers: draft.headers.map((header) => header.enabled ? { ...header, name: resolve(header.name), value: resolve(header.value) } : header),
  };
}
