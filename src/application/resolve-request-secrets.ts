import { isPureTemplateReference, templateTokens } from "../domain/template-expression";
import { SecretUnavailableError, type SecretFieldState, type SecureStore } from "./ports/credentials";
import { resolveAuth, type AuthContext, type RequestAuth } from "../features/request-workbench/model/request-auth";
import type { RequestDraft } from "../features/request-workbench/model/request";

export type RequestCompositionPurpose = "send" | "resolved-code" | "redacted-code";
export type SecretUsage = { owner: "request" | "workspace" | "auth-profile"; ownerId?: string; field: string; rowId?: string; secretRefs: string[]; variableNames: string[] };
export const redactedSecret = "********";

/** Resolve one deliberately selected field. Empty available values remain valid values. */
export async function resolveSecretField(value: string, state: SecretFieldState | undefined, store?: SecureStore, redacted = false): Promise<string> {
  if (redacted) return redactedSecret;
  if (!state) return value;
  if (state.edit?.kind === "set") return state.edit.value;
  if (state.edit?.kind === "delete") throw new SecretUnavailableError(state.ref, "missing");
  if (state.status === "available") return value;
  if (!store) throw new SecretUnavailableError(state.ref, "unavailable");
  const result = await store.resolve(state.ref);
  if (result.status !== "available") throw new SecretUnavailableError(state.ref, result.status, "code" in result ? result.code : undefined);
  return result.value;
}

export function credentialState(auth: RequestAuth, slot: string): SecretFieldState | undefined {
  return auth.credentialStates?.[slot] ?? (auth.secretRefs?.[slot] ? { ref: auth.secretRefs[slot], status: "unresolved" } : undefined);
}

/** Shared syntax inventory for dependency discovery and request composition. */
export function requestExpressions(request: RequestDraft): Array<{ field: string; rowId?: string; value: string; sensitive?: boolean; state?: SecretFieldState }> {
  const entries: ReturnType<typeof requestExpressions> = [{ field: "url", value: request.url }];
  for (const row of request.params.filter((row) => row.enabled)) entries.push({ field: "query-name", rowId: row.id, value: row.key }, { field: "query", rowId: row.id, value: row.value, sensitive: row.secret });
  for (const row of (request.pathParams ?? []).filter((row) => row.enabled)) entries.push({ field: "path-name", rowId: row.id, value: row.key }, { field: "path", rowId: row.id, value: row.value });
  for (const row of request.headers.filter((row) => row.enabled)) entries.push({ field: "header-name", rowId: row.id, value: row.name }, { field: "header", rowId: row.id, value: row.value, sensitive: row.secret, state: row.secretState ?? (row.secretRef ? { ref: row.secretRef, status: "unresolved" } : undefined) });
  for (const row of request.traceHeaderTemplates ?? []) entries.push({ field: "trace-header", value: row.name }, { field: "trace-header", value: row.value.replace(/{{\s*\$(?:traceparent|b3|traceId|spanId)\s*}}/g, "") });
  const body = request.body;
  if (request.graphql) entries.push(...[request.graphql.query, request.graphql.variables, request.graphql.operationName].map((value) => ({ field: "body", value })));
  else if (body.type === "json" || body.type === "xml" || body.type === "text") entries.push({ field: "body", value: body[body.type] });
  else if (body.type === "form-data" || body.type === "url-encoded") for (const row of (body.type === "form-data" ? body.formData : body.urlEncoded).filter((row) => row.enabled)) {
    entries.push({ field: "body", rowId: row.id, value: row.key }, { field: "body", rowId: row.id, value: row.fieldType === "file" ? "" : row.value }, { field: "body", rowId: row.id, value: row.contentType ?? "" });
  }
  const auth = request.auth;
  const add = (slot: string, value: string, sensitive = false) => entries.push({ field: `auth:${slot}`, value, sensitive, state: credentialState(auth, slot) });
  if (auth.type === "bearer") { add("prefix", auth.bearer.prefix); add("bearer", auth.bearer.token, true); }
  if (auth.type === "basic") { add("username", auth.basic.username); add("password", auth.basic.password, true); }
  if (auth.type === "api-key") { add("name", auth.apiKey.name); add("api-key", auth.apiKey.value, true); }
  if (auth.type === "oauth2" && auth.oauth2.token) add("oauth-access-token", auth.oauth2.token.accessToken, true);
  return entries;
}

export async function resolveRequestSecrets(draft: RequestDraft, input: AuthContext, purpose: RequestCompositionPurpose = "send") {
  const redacted = purpose === "redacted-code";
  const effective = resolveAuth(draft.auth, input);
  if (effective.error) throw new Error(effective.error);
  let auth = effective.auth;
  if (redacted && auth.type === "oauth2" && !auth.oauth2.token) auth = { ...auth, oauth2: { ...auth.oauth2, token: { accessToken: redactedSecret, tokenType: "Bearer", obtainedAt: 0 } } };
  const read = (slot: string, value: string) => redacted && !credentialState(auth, slot) && isPureTemplateReference(value) ? Promise.resolve(value) : resolveSecretField(value, credentialState(auth, slot), input.secretStore, redacted);
  if (auth.type === "bearer") auth = { ...auth, bearer: { ...auth.bearer, token: await read("bearer", auth.bearer.token) } };
  if (auth.type === "basic") auth = { ...auth, basic: { ...auth.basic, password: await read("password", auth.basic.password) } };
  if (auth.type === "api-key") auth = { ...auth, apiKey: { ...auth.apiKey, value: await read("api-key", auth.apiKey.value) } };
  if (auth.type === "oauth2" && auth.oauth2.token) auth = { ...auth, oauth2: { ...auth.oauth2, token: { ...auth.oauth2.token, accessToken: await read("oauth-access-token", auth.oauth2.token.accessToken) } } };
  const headers = await Promise.all(draft.headers.map((header) => /^(cookie|set-cookie)$/i.test(header.name.trim()) ? { ...header, secret: true } : header).map(async (header) => !header.enabled || !header.secret ? header : { ...header, value: redacted && !header.secretState && !header.secretRef && isPureTemplateReference(header.value) ? header.value : await resolveSecretField(header.value, header.secretState ?? (header.secretRef ? { ref: header.secretRef, status: "unresolved" } : undefined), input.secretStore, redacted) }));
  const slots = auth.type === "bearer" ? ["bearer"] : auth.type === "basic" ? ["password"] : auth.type === "api-key" ? ["api-key"] : auth.type === "oauth2" && auth.oauth2.token ? ["oauth-access-token"] : [];
  auth = { ...auth, credentialStates: { ...auth.credentialStates } };
  for (const slot of slots) if (credentialState(auth, slot)) auth.credentialStates![slot] = { ...credentialState(auth, slot)!, status: "available", edit: { kind: "keep" } };
  const request = { ...draft, auth, headers: headers.map((header) => header.enabled && header.secret && (header.secretState || header.secretRef) ? { ...header, secretState: { ...(header.secretState ?? { ref: header.secretRef! }), status: "available" as const, edit: { kind: "keep" as const } } } : header) };
  const expressions = requestExpressions(request);
  const { values, sensitiveNames, dependencies, variableStates } = await resolveSecretVariables(expressions.map((entry) => entry.value), input, redacted);
  const provenance: SecretUsage[] = [];
  for (const expression of expressions) {
    const names = new Set<string>();
    const collect = (name: string) => { if (names.has(name)) return; names.add(name); for (const child of dependencies.get(name) ?? []) collect(child); };
    for (const token of templateTokens(expression.value)) collect(token.name);
    const secretNames = [...names].filter((name) => sensitiveNames.has(name));
    if (expression.sensitive || expression.state || secretNames.length) provenance.push({ owner: expression.field.startsWith("auth:") && effective.source ? "auth-profile" : request.headers.some((header) => header.id === expression.rowId && header.workspaceHeaderId) ? "workspace" : "request", ownerId: expression.field.startsWith("auth:") && effective.source ? effective.source.id : input.requestDocumentId, field: expression.field, rowId: request.headers.find((header) => header.id === expression.rowId)?.workspaceHeaderId ?? expression.rowId, secretRefs: [...new Set([...(expression.state ? [expression.state.ref] : []), ...secretNames.flatMap((name) => input.variableStates?.[name] ? [input.variableStates[name].ref] : [])])], variableNames: [...names] });
  }
  return { draft: request, context: { ...input, variables: values, variableStates, sensitiveVariableNames: [...sensitiveNames] }, provenance, sensitiveBody: provenance.some((usage) => usage.field === "body") };
}

/** Resolve only the transitive variable dependencies of selected operation inputs. */
export async function resolveSecretVariables(expressions: readonly string[], input: AuthContext, redacted = false) {
  const values = { ...input.variables };
  const variableStates = { ...input.variableStates };
  const sensitiveNames = new Set(input.sensitiveVariableNames ?? []);
  const visited = new Set<string>();
  const dependencies = new Map<string, Set<string>>();
  const resolveVariable = async (name: string, stack: string[] = []): Promise<void> => {
    if (stack.includes(name) || stack.length >= 32) throw new Error(`Variable “${name}” contains a circular reference.`);
    if (visited.has(name)) return;
    const state = input.variableStates?.[name];
    if (state) sensitiveNames.add(name);
    if (state || (redacted && sensitiveNames.has(name))) values[name] = await resolveSecretField(values[name] ?? "", state, input.secretStore, redacted);
    const children = new Set(templateTokens(values[name] ?? "").map((token) => token.name));
    dependencies.set(name, children);
    for (const child of children) { await resolveVariable(child, [...stack, name]); if (sensitiveNames.has(child)) sensitiveNames.add(name); }
    if (state) variableStates[name] = { ...state, status: "available", edit: { kind: "keep" } };
    visited.add(name);
  };
  for (const expression of expressions) for (const token of templateTokens(expression)) await resolveVariable(token.name);
  return { values, sensitiveNames, dependencies, variableStates };
}
