import { credentialSchema, variableDefinitionSchema, type AuthDefinition, type Credential, type Project, type ProjectResource, type RequestDefinition, type SchemaDefinition, type VariableDefinition } from "../domain/project";
import { serializeResource } from "../storage/yaml";
import { createRequestAuth, base64Bytes, type OAuthToken, type RequestAuth } from "../features/request-workbench/model/request-auth";
import { createRequestBody, type RequestBodyField } from "../features/request-workbench/model/request-body";
import type { RequestDraft } from "../features/request-workbench/model/request";
import { createGraphqlDocument, createHttpDocument, createSchemaDocument, createWorkspace, isDocumentDirty, isRequestDocument, validateWorkspace,
  type Workspace, type WorkspaceDocument, type RequestDocument, type SchemaDocument, type Variable } from "../features/workspaces/model/workspace";
import type { LocalRecord, SecureStore } from "../storage/contracts";
import { decodeFiles, encodeFiles } from "../storage/file-codec";
import { protectRuntime, resolveCredential, resolveRuntime, secretRef, storeCredential } from "../storage/secrets";

type StoredOAuthToken = Omit<OAuthToken, "accessToken" | "refreshToken"> & { accessToken: Credential; refreshToken?: Credential };
type WorkspaceAuthRuntime = { version: 1; entries: Array<{
  id: string;
  definitionHash: string;
  oauthToken?: StoredOAuthToken;
}> };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function parseWorkspaceAuthRuntime(value: unknown, workspace: string): WorkspaceAuthRuntime {
  if (value == null) return { version: 1, entries: [] };
  const invalid = () => new Error("Unsupported or damaged workspace auth state. Existing data has not been changed.");
  const credential = (candidate: unknown): Credential => {
    const parsed = credentialSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.kind === "secret" && !parsed.data.ref.startsWith(`purr/${workspace}/`)) throw invalid();
    return parsed.data;
  };
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)
    || Object.keys(value).some((key) => !["version", "entries"].includes(key))) throw invalid();
  const entries = value.entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.definitionHash !== "string"
      || Object.keys(entry).some((key) => !["id", "definitionHash", "oauthToken"].includes(key))) throw invalid();
    const oauth = entry.oauthToken;
    if (oauth !== undefined && (!isRecord(oauth)
      || Object.keys(oauth).some((key) => !["accessToken", "refreshToken", "tokenType", "obtainedAt", "expiresAt", "scope"].includes(key))
      || oauth.accessToken === undefined || oauth.tokenType !== "Bearer"
      || typeof oauth.obtainedAt !== "number" || oauth.expiresAt !== undefined && typeof oauth.expiresAt !== "number"
      || oauth.scope !== undefined && typeof oauth.scope !== "string")) throw invalid();
    const storedOauth = oauth as Record<string, unknown> | undefined;
    return { id: entry.id, definitionHash: entry.definitionHash,
      ...(storedOauth ? { oauthToken: {
        accessToken: credential(storedOauth.accessToken), ...(storedOauth.refreshToken ? { refreshToken: credential(storedOauth.refreshToken) } : {}),
        tokenType: "Bearer" as const, obtainedAt: storedOauth.obtainedAt as number,
        ...(storedOauth.expiresAt !== undefined ? { expiresAt: storedOauth.expiresAt as number } : {}),
        ...(storedOauth.scope !== undefined ? { scope: storedOauth.scope as string } : {}),
      } } : {}) };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw invalid();
  return { version: 1, entries };
}

async function valueHash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createWorkspaceAuthRuntime(entries: Workspace["requestConfig"]["auth"], definitions: Project["workspace"]["auth"],
  secure: SecureStore, workspace: string): Promise<WorkspaceAuthRuntime> {
  const stored = await Promise.all(entries.map(async (entry) => {
    const definition = definitions.find((candidate) => candidate.id === entry.id);
    if (!definition) throw new Error("Workspace authentication definition is missing.");
    const token = entry.value.oauth2.token;
    const tokenMetadata = token ? { tokenType: token.tokenType, obtainedAt: token.obtainedAt,
      ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}), ...(token.scope !== undefined ? { scope: token.scope } : {}) } : undefined;
    const runtime = { id: entry.id, definitionHash: await valueHash(definition),
      ...(token && tokenMetadata ? { oauthToken: { ...tokenMetadata,
        accessToken: await storeCredential(secure, secretRef(workspace, `auth-runtime/${entry.id}`, "oauth2/access-token"), token.accessToken),
        ...(token.refreshToken ? { refreshToken: await storeCredential(secure,
          secretRef(workspace, `auth-runtime/${entry.id}`, "oauth2/refresh-token"), token.refreshToken) } : {}) } } : {}) };
    return runtime.oauthToken ? runtime : null;
  }));
  return { version: 1, entries: stored.filter((entry): entry is NonNullable<typeof entry> => entry !== null) };
}

export function migrateWorkspaceAuthRuntime(records: LocalRecord[], workspace: string): LocalRecord[] {
  const record = records.find((candidate) => candidate.table === "workspace_local_state" && candidate.id === "auth-runtime");
  if (!record) return records;
  try { parseWorkspaceAuthRuntime(record.value, workspace); return records; }
  catch { return records.map((candidate) => candidate === record ? { ...candidate, value: { version: 1, entries: [] } } : candidate); }
}

export async function authToDefinition(auth: RequestAuth, secure: SecureStore, workspace: string, owner: string): Promise<AuthDefinition> {
  const credential = (field: string, value: string, mode?: "plain" | "secret") => storeCredential(secure,
    auth.secretRefs?.[field] ?? secretRef(workspace, owner, field), value, mode ?? (/{{[^{}]+}}/.test(value) ? "plain" : "secret"));
  switch (auth.type) {
    case "none": return { type: "none" };
    case "inherit": return { type: "inherit" };
    case "bearer": return { type: "bearer", token: await credential("bearer", auth.bearer.token, auth.credentialStorage?.bearer), prefix: auth.bearer.prefix };
    case "basic": return { type: "basic", username: auth.basic.username, password: await credential("password", auth.basic.password) };
    case "api-key": return { type: "api-key", name: auth.apiKey.name, placement: auth.apiKey.placement, value: await credential("api-key", auth.apiKey.value) };
    case "oauth2": return { type: "oauth2", grantType: auth.oauth2.grantType, tokenUrl: auth.oauth2.tokenUrl, clientId: auth.oauth2.clientId,
      clientSecret: await credential("client-secret", auth.oauth2.clientSecret), ...(auth.oauth2.authorizationUrl ? { authorizationUrl: auth.oauth2.authorizationUrl } : {}),
      ...(auth.oauth2.scopes ? { scopes: auth.oauth2.scopes } : {}), ...(auth.oauth2.redirectUri ? { redirectUri: auth.oauth2.redirectUri } : {}),
      clientAuthentication: auth.oauth2.clientAuthentication, autoRefresh: auth.oauth2.autoRefresh };
  }
}
export async function authFromDefinition(value: AuthDefinition, secure: SecureStore): Promise<RequestAuth> {
  const auth = createRequestAuth(); auth.type = value.type;
  const remember = (key: string, credential: { kind: "plain"; value: string } | { kind: "secret"; ref: string }) => {
    if (credential.kind === "secret") auth.secretRefs = { ...auth.secretRefs, [key]: credential.ref };
    return resolveCredential(secure, credential);
  };
  switch (value.type) {
    case "inherit": auth.inherit.source = "workspace"; break;
    case "bearer": auth.bearer = { ...auth.bearer, token: await remember("bearer", value.token), prefix: value.prefix };
      auth.credentialStorage = { bearer: value.token.kind }; break;
    case "basic": auth.basic = { username: value.username, password: await remember("password", value.password) }; break;
    case "api-key": auth.apiKey = { name: value.name, placement: value.placement, value: await remember("api-key", value.value) }; break;
    case "oauth2": {
      const { type: _type, ...configuration } = value;
      auth.oauth2 = { ...auth.oauth2, ...configuration, clientSecret: await remember("client-secret", value.clientSecret) }; break;
    }
  }
  return auth;
}
const pairs = (rows: Array<{ key?: string; name?: string; value: string; enabled: boolean; readOnly?: boolean }>) => rows
  .filter((row) => !row.readOnly && Boolean(row.name || row.key || row.value)).map((row) => ({ name: row.name ?? row.key ?? "", value: row.value, enabled: row.enabled }));
function schemaSource(document: SchemaDocument): SchemaDefinition["source"] {
  return document.schemaSource ?? (document.source === "file" ? { type: "sdl-file", location: document.sourceLabel, endpoint: document.endpoint }
    : { type: "introspection", endpoint: document.endpoint || document.sourceLabel, ...(document.sourceRequestId ? { requestId: document.sourceRequestId } : {}) });
}
async function variableToDefinition(variable: Variable, secure: SecureStore, workspace: string, owner: string): Promise<VariableDefinition> {
  const common = { id: variable.id, name: variable.name, enabled: variable.enabled, sensitive: variable.sensitive };
  if (variable.kind === "static") {
    if (!variable.sensitive) return { ...common, kind: "static", value: variable.value };
    return { ...common, kind: "static", secretRef: variable.loaded === false && variable.secretRef
      ? variable.secretRef
      : (await storeCredential(secure, variable.secretRef ?? secretRef(workspace, owner, variable.id), variable.value, "secret") as { kind: "secret"; ref: string }).ref };
  }
  if (variable.kind === "dynamic-request") return { ...common, kind: variable.kind, documentId: variable.documentId,
    expression: variable.expression, language: variable.language, refresh: variable.refresh,
    ...(variable.cacheTtlSeconds ? { cacheTtlSeconds: variable.cacheTtlSeconds } : {}), environment: variable.environment };
  return { ...common, kind: variable.kind, provider: variable.provider, key: variable.key, sensitive: true };
}

async function variableFromDefinition(variable: VariableDefinition, secure: SecureStore, loadSecret: boolean): Promise<Variable> {
  if (variable.kind !== "static") return variable;
  if (!variable.sensitive) return { ...variable, kind: "static", value: variable.value ?? "" };
  return { id: variable.id, name: variable.name, enabled: variable.enabled, sensitive: true, kind: "static",
    secretRef: variable.secretRef, value: loadSecret && variable.secretRef ? await secure.get(variable.secretRef) ?? "" : "", loaded: loadSecret };
}

async function protectDynamicVariableCache(cache: Workspace["dynamicVariableCache"], variables: readonly Variable[], secure: SecureStore, workspace: string) {
  return Object.fromEntries(await Promise.all(Object.entries(cache).map(async ([key, entry]) => {
    const variableId = key.split(":", 1)[0];
    const variable = variables.find((candidate) => candidate.id === variableId);
    if (!variable?.sensitive || entry.status !== "success" || entry.value === undefined) return [key, entry];
    const credential = await storeCredential(secure, secretRef(workspace, `dynamic-variables/${variableId}`, `cache/${entry.environmentId ?? "none"}`), entry.value);
    return [key, { ...entry, value: { __purrSecret: credential } }];
  })));
}

export async function projectGlobalVariables(variables: readonly Variable[], secure: SecureStore): Promise<VariableDefinition[]> {
  return Promise.all(variables.filter((variable) => variable.name.trim()).map((variable) => variableToDefinition(variable, secure, "global", "variables")));
}

export async function restoreGlobalVariables(value: unknown, secure: SecureStore): Promise<Variable[]> {
  const definitions = variableDefinitionSchema.array().parse(value ?? []);
  const names = definitions.map((variable) => variable.name.trim());
  if (new Set(names).size !== names.length || new Set(definitions.map((variable) => variable.id)).size !== definitions.length)
    throw new Error("Global variable names and identifiers must be unique.");
  if (definitions.some((variable) => variable.kind !== "static"))
    throw new Error("Global variables must be static.");
  return Promise.all(definitions.map((variable) => variableFromDefinition(variable, secure, true)));
}
async function requestDefinition(document: RequestDocument, workspace: string, secure: SecureStore, assets: Record<string, string>): Promise<RequestDefinition> {
  const draft = document.savedRequest ?? document.request;
  const fileRef = async (file: File) => {
    const buffer = await file.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    assets[`assets/${digest}.bin`] = base64Bytes(new Uint8Array(buffer));
    return { id: digest, name: file.name, mediaType: file.type };
  };
  const body = draft.body;
  const payload = body.type === "none" ? { type: "none" as const }
    : body.type === "json" || body.type === "xml" || body.type === "text" ? { type: body.type, data: body[body.type] }
    : body.type === "binary" ? { type: "binary" as const, file: body.binary ? await fileRef(body.binary.file) : null }
    : { type: body.type, fields: await Promise.all((body.type === "form-data" ? body.formData : body.urlEncoded)
      .filter((field) => field.key || field.value || field.attachment).map(async (field) => ({ name: field.key, value: field.value, enabled: field.enabled,
        ...(field.attachment ? { file: await fileRef(field.attachment) } : {}), ...(field.contentType ? { contentType: field.contentType } : {}) }))) };
  const common = { id: document.id, name: document.name, ...(document.description ? { description: document.description } : {}), ...(document.folderId ? { folderId: document.folderId } : {}),
    method: draft.method, url: draft.url, params: pairs(draft.params), headers: pairs(draft.headers), body: payload,
    auth: await authToDefinition(draft.auth, secure, workspace, `requests/${document.id}/saved`), ...(draft.environmentId ? { environmentId: draft.environmentId } : {}),
    ...(!draft.workspace.headersEnabled || !draft.workspace.authEnabled || !draft.useCookieJar || Object.values(draft.workspace.headerOverrides).some((value) => !value)
      ? { overrides: { headers: draft.workspace.headersEnabled, auth: draft.workspace.authEnabled, cookies: draft.useCookieJar,
        excludedHeaderIds: Object.keys(draft.workspace.headerOverrides).filter((id) => draft.workspace.headerOverrides[id] === false).sort() } } : {}) };
  return document.kind === "graphql" ? { ...common, kind: "graphql", graphql: { query: draft.graphql!.query, variables: draft.graphql!.variables,
    ...(draft.graphql!.operationName ? { operation: draft.graphql!.operationName } : {}), ...(draft.graphql!.schemaId ? { schemaId: draft.graphql!.schemaId } : {}) } }
    : { ...common, kind: "http" };
}

export async function projectWorkspace(workspace: Workspace, secure: SecureStore): Promise<{ project: Project; local: LocalRecord[]; assets: Record<string, string> }> {
  const resources: ProjectResource[] = [...(workspace.extraResources ?? [])];
  const assets: Record<string, string> = {};
  const allVariables = [...workspace.variables, ...workspace.environments.flatMap((environment) => environment.variables)];
  const local: LocalRecord[] = [
    { table: "workspace_local_state", id: "state", value: { ui: workspace.ui, activeEnvironmentId: workspace.activeEnvironmentId } },
    { table: "workspace_local_state", id: "dynamic-variable-cache", value: await protectDynamicVariableCache(workspace.dynamicVariableCache, allVariables, secure, workspace.id) },
  ];
  for (const environment of workspace.environments) resources.push({ id: environment.id, kind: "environment", name: environment.name,
    ...(environment.description ? { description: environment.description } : {}), ...(environment.folderId ? { folderId: environment.folderId } : {}),
    variables: await Promise.all(environment.variables.filter((row) => row.name).map((row) => variableToDefinition(row, secure, workspace.id, `environments/${environment.id}`))) });
  const auth = await Promise.all(workspace.requestConfig.auth.map(async (entry) => ({ id: entry.id, name: entry.name, scope: entry.scope, enabled: entry.enabled,
    config: await authToDefinition(entry.value, secure, workspace.id, `auth/${entry.id}`) })));
  // Only acquired tokens are runtime state. Saved credentials remain canonical
  // definitions backed by SecureStore and inactive editor forms stay in session state.
  local.push({ table: "workspace_local_state", id: "auth-runtime", value: await createWorkspaceAuthRuntime(workspace.requestConfig.auth, auth, secure, workspace.id) });
  for (const document of workspace.documents) {
    if (isRequestDocument(document)) {
      const definition = document.saved ? await requestDefinition(document, workspace.id, secure, assets) : undefined;
      if (definition) resources.push(definition);
      if (!document.saved || isDocumentDirty(document)) local.push({ table: "drafts", id: document.id, value: await encodeFiles(await protectRuntime({
        ...document, lastResponse: null, sentAt: null, base: definition ?? null,
      }, secure, workspace.id, `drafts/${document.id}`)) });
      local.push({ table: "document_session_state", id: document.id, value: { ui: document.ui, createdAt: document.createdAt, updatedAt: document.updatedAt, sentAt: document.sentAt,
        ...(definition ? { definition: serializeResource(definition), editor: await encodeFiles(await protectRuntime(document.request, secure, workspace.id, `editor/${document.id}`)) } : {}) } });
      if (document.lastResponse) local.push({ table: "request_executions", id: `${document.id}-${document.lastResponse.timeline.startedAtMs}`, value: { documentId: document.id, response: document.lastResponse } });
    } else {
      if (document.saved) resources.push({ id: document.id, kind: "schema", name: document.name,
        ...(document.description ? { description: document.description } : {}), ...(document.folderId ? { folderId: document.folderId } : {}), source: schemaSource(document),
        pin: document.pinned !== false,
        ...(document.pinned !== false ? { pinnedSdl: document.sdl } : {}) });
      else local.push({ table: "drafts", id: document.id, value: document });
      local.push({ table: "schema_cache", id: document.id, value: { sdl: document.sdl, loadedAt: document.loadedAt, source: schemaSource(document) } });
      local.push({ table: "document_session_state", id: document.id, value: { ui: document.ui, createdAt: document.createdAt, updatedAt: document.updatedAt } });
    }
  }
  for (const cookie of workspace.cookies) local.push({ table: "cookie_jar", id: cookie.id, value: cookie });
  return { project: { workspace: { id: workspace.id, name: workspace.name, ...(workspace.description ? { description: workspace.description } : {}),
    variables: await Promise.all(workspace.variables.filter((row) => row.name).map((row) => variableToDefinition(row, secure, workspace.id, "variables"))),
    headers: workspace.requestConfig.headers.filter((row) => row.name || row.value).map(({ id, name, value, enabled, scope }) => ({ id, name, value, enabled, scope })), auth }, resources }, local, assets };
}

async function requestFromDefinition(resource: RequestDefinition, secure: SecureStore, assets: Record<string, string>): Promise<RequestDocument> {
  const document = resource.kind === "graphql" ? createGraphqlDocument() : createHttpDocument();
  const body = createRequestBody(); body.type = resource.body.type;
  const file = (ref: { id: string; name: string; mediaType: string }) => {
    const bytes = assets[`assets/${ref.id}.bin`];
    if (bytes === undefined) throw new Error("A request attachment is missing from the project directory.");
    return new File([Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0))], ref.name, { type: ref.mediaType });
  };
  if (resource.body.type === "json" || resource.body.type === "xml" || resource.body.type === "text") body[resource.body.type] = resource.body.data;
  if (resource.body.type === "binary" && resource.body.file) {
    const attachment = file(resource.body.file); body.binary = { file: attachment, name: attachment.name, size: attachment.size, mimeType: attachment.type };
  }
  if (resource.body.type === "form-data" || resource.body.type === "url-encoded") {
    const rows: RequestBodyField[] = resource.body.fields.map((field, index) => ({ id: `field-${index}`, key: field.name, value: field.value, enabled: field.enabled,
      fieldType: field.file ? "file" : "text", attachment: field.file ? file(field.file) : null, contentType: field.contentType }));
    rows.push({ id: "field-empty", key: "", value: "", enabled: false });
    if (resource.body.type === "form-data") body.formData = rows; else body.urlEncoded = rows;
  }
  const draft: RequestDraft = { ...document.request, method: resource.method, url: resource.url, body, auth: await authFromDefinition(resource.auth, secure),
    params: [...resource.params.map((row, index) => ({ id: `param-${index}`, key: row.name, value: row.value, enabled: row.enabled })), { id: "param-empty", key: "", value: "", enabled: false }],
    headers: [...resource.headers.map((row, index) => ({ id: `header-${index}`, ...row })), { id: "header-empty", name: "", value: "", enabled: false }],
    useCookieJar: resource.overrides?.cookies ?? true, environmentId: resource.environmentId,
    workspace: { headersEnabled: resource.overrides?.headers ?? true, authEnabled: resource.overrides?.auth ?? true,
      headerOverrides: Object.fromEntries((resource.overrides?.excludedHeaderIds ?? []).map((id) => [id, false])) },
    ...(resource.kind === "graphql" ? { graphql: { query: resource.graphql.query, variables: resource.graphql.variables, operationName: resource.graphql.operation ?? "", schemaId: resource.graphql.schemaId } } : {}) };
  return { ...document, id: resource.id, name: resource.name, description: resource.description, folderId: resource.folderId, saved: true, request: draft, savedRequest: draft };
}

export async function restoreWorkspace(project: Project, records: LocalRecord[], secure: SecureStore, assets: Record<string, string>): Promise<Workspace> {
  const workspace = createWorkspace(project.workspace.name, project.workspace.id); workspace.documents = [];
  workspace.description = project.workspace.description ?? "";
  workspace.extraResources = project.resources.filter((item) => item.kind === "folder" || item.kind === "integration");
  workspace.variables = await Promise.all(project.workspace.variables.map((variable) => variableFromDefinition(variable, secure, true)));
  workspace.requestConfig = { headers: project.workspace.headers, auth: await Promise.all(project.workspace.auth.map(async (entry) => ({ id: entry.id, name: entry.name, enabled: entry.enabled, scope: entry.scope, value: await authFromDefinition(entry.config, secure) }))) };
  const get = (table: LocalRecord["table"], id: string) => records.find((item) => item.table === table && item.id === id)?.value;
  const state = get("workspace_local_state", "state") as { ui: Workspace["ui"]; activeEnvironmentId: string | null } | undefined;
  if (state) { workspace.ui = state.ui; workspace.activeEnvironmentId = state.activeEnvironmentId; }
  else workspace.ui = { ...workspace.ui, openDocumentIds: [], activeDocumentId: null };
  workspace.dynamicVariableCache = await resolveRuntime(get("workspace_local_state", "dynamic-variable-cache") ?? {}, secure) as Workspace["dynamicVariableCache"];
  const runtimeAuth = parseWorkspaceAuthRuntime(get("workspace_local_state", "auth-runtime"), workspace.id);
  workspace.requestConfig.auth = await Promise.all(workspace.requestConfig.auth.map(async (entry) => {
    const runtime = runtimeAuth.entries.find((item) => item.id === entry.id);
    const definition = project.workspace.auth.find((item) => item.id === entry.id);
    if (runtime && definition && runtime.definitionHash === await valueHash(definition)) {
      const oauth = runtime.oauthToken;
      const oauthMetadata = oauth ? { tokenType: oauth.tokenType, obtainedAt: oauth.obtainedAt,
        ...(oauth.expiresAt !== undefined ? { expiresAt: oauth.expiresAt } : {}), ...(oauth.scope !== undefined ? { scope: oauth.scope } : {}) } : undefined;
      entry.value = { ...entry.value,
        oauth2: { ...entry.value.oauth2, token: oauth && oauthMetadata ? { ...oauthMetadata, accessToken: await resolveCredential(secure, oauth.accessToken),
          ...(oauth.refreshToken ? { refreshToken: await resolveCredential(secure, oauth.refreshToken) } : {}) } : null } };
    }
    return entry;
  }));
  for (const resource of project.resources) {
    if (resource.kind === "environment") workspace.environments.push({ id: resource.id, name: resource.name, description: resource.description, folderId: resource.folderId,
      variables: await Promise.all(resource.variables.map((variable) => variableFromDefinition(variable, secure, workspace.activeEnvironmentId === resource.id))) });
    if (resource.kind === "http" || resource.kind === "graphql") workspace.documents.push(await requestFromDefinition(resource, secure, assets));
    if (resource.kind === "schema") {
      const storedCache = get("schema_cache", resource.id) as { sdl: string; loadedAt: string | null; source?: SchemaDefinition["source"] } | undefined;
      const source = resource.source;
      const cache = storedCache && JSON.stringify(storedCache.source) === JSON.stringify(source) ? storedCache : undefined;
      workspace.documents.push({ ...createSchemaDocument(), id: resource.id, name: resource.name, description: resource.description, folderId: resource.folderId, saved: true,
        source: source.type === "introspection" ? "introspection" : "file", schemaSource: source,
        endpoint: "endpoint" in source ? source.endpoint ?? "" : "", sourceRequestId: source.type === "introspection" ? source.requestId ?? "" : "",
        sourceLabel: source.type === "introspection" ? source.endpoint : "location" in source ? source.location ?? "" : "", pinned: resource.pin,
        sdl: resource.pinnedSdl ?? cache?.sdl ?? "", loadedAt: cache?.loadedAt ?? null });
    }
  }
  for (const record of records.filter((item) => item.table === "drafts")) {
    const draft = await resolveRuntime(decodeFiles(record.value), secure) as (RequestDocument | SchemaDocument) & { base?: ProjectResource };
    const index = workspace.documents.findIndex((document) => document.id === draft.id);
    if (index < 0 && !draft.saved) workspace.documents.push(draft);
    else if (index >= 0 && isRequestDocument(draft)) {
      const definition = project.resources.find((item) => item.id === draft.id);
      if (draft.base && definition && serializeResource(draft.base) !== serializeResource(definition))
        throw new Error("A saved request changed on disk while it has local edits. Local edits are preserved; resolve or restore the external change before reloading.");
      workspace.documents[index] = draft;
    }
  }
  workspace.documents = await Promise.all(workspace.documents.map(async (document) => {
    const session = get("document_session_state", document.id) as (Partial<typeof document> & { editor?: unknown; definition?: string }) | undefined;
    const result = { ...document, ...(session ? { ui: session.ui ?? document.ui, createdAt: session.createdAt ?? document.createdAt, updatedAt: session.updatedAt ?? document.updatedAt } : {}) } as WorkspaceDocument;
    if (isRequestDocument(result)) {
      const definition = project.resources.find((item) => item.id === result.id);
      if (session?.editor && definition && session.definition === serializeResource(definition) && !records.some((record) => record.table === "drafts" && record.id === result.id)) {
        const canonicalAuth = result.request.auth;
        const editor = await resolveRuntime(decodeFiles(session.editor), secure) as RequestDraft;
        // Cached editor modes must not shadow a credential changed in SecureStore.
        // Dirty working copies use their own local refs until explicitly saved.
        const group = { bearer: "bearer", basic: "basic", "api-key": "apiKey", oauth2: "oauth2", inherit: "inherit", none: null }[canonicalAuth.type] as "bearer" | "basic" | "apiKey" | "oauth2" | "inherit" | null;
        editor.auth = { ...editor.auth, type: canonicalAuth.type, secretRefs: canonicalAuth.secretRefs, credentialStorage: canonicalAuth.credentialStorage,
          ...(group ? { [group]: canonicalAuth[group] } : {}),
          ...(canonicalAuth.type === "oauth2" ? { oauth2: { ...canonicalAuth.oauth2, token: editor.auth.oauth2.token } } : {}) };
        result.request = editor;
        result.savedRequest = result.request;
      }
      const executions = records.filter((record) => record.table === "request_executions" && (record.value as { documentId: string }).documentId === document.id)
        .map((record) => (record.value as { response: RequestDocument["lastResponse"] }).response).filter((response) => response !== null).sort((a, b) => b.timeline.startedAtMs - a.timeline.startedAtMs);
      result.lastResponse = executions[0] ?? null;
    }
    return result;
  }));
  workspace.cookies = records.filter((record) => record.table === "cookie_jar").map((record) => record.value as Workspace["cookies"][number]);
  return validateWorkspace(workspace);
}
