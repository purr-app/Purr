import { schemaConnectionIdentity } from "../features/graphql/model/schema-connection";
import { credentialSchema, resourceSchema, workspaceDefinitionSchema, variableDefinitionSchema, type AuthDefinition, type Credential, type Project, type ProjectResource, type RequestDefinition, type SchemaDefinition, type VariableDefinition } from "../domain/project";
import { responseForPersistence, restoreStoredHttpResponse, storedHttpResponseStartedAt, type StoredHttpResponse } from "../domain/http";
import { serializeResource, deserializeResourceFile, normalizeLegacyResource, normalizeLegacyWorkspace } from "../storage/yaml";
import { normalizeRequestAuth, createRequestAuth, type OAuthToken, type RequestAuth } from "../features/request-workbench/model/request-auth";
import { createRequestBody, type RequestBodyField } from "../features/request-workbench/model/request-body";
import type { RequestDraft, RequestHeader } from "../features/request-workbench/model/request";
import { createGraphqlDocument, createHttpDocument, createSchemaDocument, createWorkspace, getEffectiveVariableValues, isDocumentDirty, isExtensionDocument, isRequestDocument, validateWorkspace,
  type ExtensionDocument, type Workspace, type WorkspaceDocument, type RequestDocument, type SchemaDocument, type Variable } from "../features/workspaces/model/workspace";
import type { SecretBatch, SecureStore } from "./ports/credentials";
import type { LocalRecord } from "./ports/persistence";
import { decodeFiles, encodeFile, encodeFiles, type FileAttachmentLoader, type FileAttachmentRecord, type NativeFileAttachmentRecord } from "../storage/file-codec";
import { protectRuntime, materializeCredential, resolveRuntime, credentialRef, CachedSecureStore, secretRef, storeCredential, SecretPreparationStore } from "../storage/secrets";
import { isPureTemplateReference } from "../domain/template-expression";
import type { ProjectFormatVersion } from "../storage/yaml";

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
  secure: SecureStore, workspace: string, allowPendingProfiles = false): Promise<WorkspaceAuthRuntime> {
  const stored = await Promise.all(entries.map(async (entry) => {
    const definition = definitions.find((candidate) => candidate.id === entry.id);
    if (!definition) {
      // A v1 profile created locally has no canonical identity until upgrade.
      // Its protected settings/token belong to the versioned definition overlay.
      if (allowPendingProfiles) return null;
      throw new Error("Workspace authentication definition is missing.");
    }
    const token = entry.value.oauth2.token;
    const tokenMetadata = token ? { tokenType: token.tokenType, obtainedAt: token.obtainedAt,
      ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}), ...(token.scope !== undefined ? { scope: token.scope } : {}) } : undefined;
    const runtime = { id: entry.id, definitionHash: await valueHash(definition),
      ...(token && tokenMetadata ? { oauthToken: { ...tokenMetadata,
        accessToken: await storeCredential(secure, secretRef(workspace, `auth-runtime/${entry.id}`, "oauth2/access-token", "runtime"), token.accessToken, "secret", entry.value.credentialStates?.["oauth-access-token"]),
        ...(token.refreshToken !== undefined ? { refreshToken: await storeCredential(secure,
          secretRef(workspace, `auth-runtime/${entry.id}`, "oauth2/refresh-token", "runtime"), token.refreshToken, "secret", entry.value.credentialStates?.["oauth-refresh-token"]) } : {}) } } : {}) };
    return runtime.oauthToken ? runtime : null;
  }));
  return { version: 1, entries: stored.filter((entry): entry is NonNullable<typeof entry> => entry !== null) };
}

export function migrateWorkspaceAuthRuntime(records: LocalRecord[], workspace: string): LocalRecord[] {
  const record = records.find((candidate) => candidate.table === "workspace_local_state" && candidate.id === "auth-runtime");
  if (!record) return records;
  try { parseWorkspaceAuthRuntime(record.value, workspace); return records; }
  catch {
    const oldEntries = (value: unknown) => Array.isArray(value) && value.every((entry) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || !isRecord(entry.value)) return false;
      const auth = entry.value;
      return ["bearer", "basic", "apiKey", "oauth2", "inherit"].every((key) => isRecord(auth[key]));
    });
    const value = record.value;
    const knownLegacy = oldEntries(value) || isRecord(value) && value.version === undefined && Array.isArray(value.definitions) && oldEntries(value.entries)
      && Object.keys(value).every((key) => ["definitions", "entries"].includes(key));
    // Only the two documented pre-canonical shapes are expendable runtime.
    // Future or malformed records remain opaque and make the workspace read-only.
    if (!knownLegacy) throw new Error("Unsupported or damaged workspace auth state. Existing data has not been changed.");
    return records.map((candidate) => candidate === record ? { ...candidate, value: { version: 1, entries: [] } } : candidate);
  }
}

export async function authToDefinition(auth: RequestAuth, secure: SecureStore, workspace: string, owner: string): Promise<AuthDefinition> {
  const credential = async (field: string, value: string): Promise<Credential> => {
    const state = auth.credentialStates?.[field];
    if ((!state || state.edit?.kind === "set") && isPureTemplateReference(value)) {
      if (secure instanceof SecretPreparationStore) secure.onCommitted(() => {
        if (auth.secretRefs) delete auth.secretRefs[field];
        if (auth.credentialStates) delete auth.credentialStates[field];
      });
      return { kind: "template", value };
    }
    const ref = credentialRef(workspace, owner, field, auth.secretRefs?.[field]);
    const result = await storeCredential(secure, ref, value, "secret", state);
    if (result.kind === "secret" && secure instanceof SecretPreparationStore) secure.onCommitted(() => {
      auth.secretRefs = { ...auth.secretRefs, [field]: result.ref };
      auth.credentialStates = { ...auth.credentialStates, [field]: { ref: result.ref, status: state?.edit?.kind === "delete" ? "missing" : state?.edit?.kind === "keep" && state.status !== "available" ? state.status : "available", edit: { kind: "keep" } } };
    });
    return result;
  };
  switch (auth.type) {
    case "none": return { type: "none" };
    case "inherit": return { type: "inherit", ...(auth.inherit.source === "schema" ? { source: "schema" as const } : {}), ...(auth.inherit.profileId ? { profileId: auth.inherit.profileId } : {}) };
    case "bearer": return { type: "bearer", token: await credential("bearer", auth.bearer.token), prefix: auth.bearer.prefix };
    case "basic": return { type: "basic", username: auth.basic.username, password: await credential("password", auth.basic.password) };
    case "api-key": return { type: "api-key", name: auth.apiKey.name, placement: auth.apiKey.placement, value: await credential("api-key", auth.apiKey.value) };
    case "oauth2": return { type: "oauth2", grantType: auth.oauth2.grantType, tokenUrl: auth.oauth2.tokenUrl, clientId: auth.oauth2.clientId,
      clientSecret: await credential("client-secret", auth.oauth2.clientSecret), ...(auth.oauth2.authorizationUrl ? { authorizationUrl: auth.oauth2.authorizationUrl } : {}),
      ...(auth.oauth2.scopes ? { scopes: auth.oauth2.scopes } : {}), ...(auth.oauth2.redirectUri ? { redirectUri: auth.oauth2.redirectUri } : {}),
      clientAuthentication: auth.oauth2.clientAuthentication, autoRefresh: auth.oauth2.autoRefresh };
  }
}
export async function authFromDefinition(value: AuthDefinition, secure: SecureStore, hydrate = true): Promise<RequestAuth> {
  const auth = createRequestAuth(); auth.type = value.type;
  const remember = async (key: string, credential: Credential) => {
    if (credential.kind === "secret") auth.secretRefs = { ...auth.secretRefs, [key]: credential.ref };
    const field = await materializeCredential(secure, credential, hydrate);
    if (field.secretState) auth.credentialStates = { ...auth.credentialStates, [key]: field.secretState };
    return field.value;
  };
  switch (value.type) {
    case "inherit": auth.inherit = { source: value.source ?? "workspace", ...(value.profileId ? { profileId: value.profileId } : {}) }; break;
    case "bearer": auth.bearer = { ...auth.bearer, token: await remember("bearer", value.token), prefix: value.prefix };
      break;
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
async function headerToDefinition(header: RequestHeader, secure: SecureStore, workspace: string, owner: string) {
  const sensitive = header.secret === true || ["cookie", "set-cookie"].includes(header.name.trim().toLowerCase());
  const state = header.secretState;
  const credential: Credential = !sensitive ? { kind: "plain", value: header.value }
    : (!state || state.edit?.kind === "set") && isPureTemplateReference(header.value) ? { kind: "template", value: header.value }
    : await storeCredential(secure, credentialRef(workspace, `${owner}/${header.id}`, "value", header.secretRef), header.value, "secret", state);
  if (secure instanceof SecretPreparationStore) secure.onCommitted(() => {
    if (credential.kind === "secret") {
      header.secretRef = credential.ref;
      header.secretState = { ref: credential.ref, status: state?.edit?.kind === "delete" ? "missing" : state?.edit?.kind === "keep" && state.status !== "available" ? state.status : "available", edit: { kind: "keep" } };
    } else { delete header.secretRef; delete header.secretState; }
  });
  return { id: header.id, name: header.name, value: credential, enabled: header.enabled, sensitive };
}
async function headerFromDefinition(header: Project["workspace"]["headers"][number] | SchemaDefinition["introspectionHeaders"][number] | RequestDefinition["headers"][number], secure: SecureStore, hydrate: boolean): Promise<RequestHeader> {
  const field = await materializeCredential(secure, header.value, hydrate);
  return { id: header.id, name: header.name, enabled: header.enabled, value: field.value, secret: header.sensitive,
    ...(field.secretState ? { secretRef: field.secretState.ref, secretState: field.secretState } : {}) };
}
function schemaDefinitionIdentity(definition: SchemaDefinition) {
  return valueHash({ endpoint: definition.endpoint, source: definition.source, auth: definition.auth, introspectionHeaders: definition.introspectionHeaders });
}
function schemaSource(document: SchemaDocument): SchemaDefinition["source"] {
  const source = document.schemaSource;
  if (source?.type === "registry") return source;
  if (source?.type === "sdl-file" || source?.type === "introspection-json") return { type: source.type, ...(source.location ? { location: source.location } : {}) };
  return document.source === "file" ? { type: "sdl-file", location: document.sourceLabel } : { type: "introspection" };
}
async function protectedSchemaSource(document: SchemaDocument, secure: SecureStore, workspace: string): Promise<SchemaDefinition["source"]> {
  const source = schemaSource(document);
  if (source.type !== "registry" || !source.credential || source.credential.kind === "template") return source;
  const credential = source.credential.kind === "plain" && isPureTemplateReference(source.credential.value) ? { kind: "template" as const, value: source.credential.value }
    : await storeCredential(secure, secretRef(workspace, `schemas/${document.id}/registry`, "credential"), source.credential.kind === "secret" ? "" : source.credential.value, "secret", source.credential.kind === "secret" ? { ref: source.credential.ref, status: "unresolved", edit: { kind: "keep" } } : undefined);
  return { ...source, credential };
}

async function variableToDefinition(variable: Variable, secure: SecureStore, workspace: string, owner: string): Promise<VariableDefinition> {
  const common = { id: variable.id, name: variable.name, enabled: variable.enabled, sensitive: variable.sensitive };
  if (variable.kind === "static") {
    if (!variable.sensitive) return { ...common, kind: "static", value: variable.value };
    const credential = variable.loaded === false && variable.secretRef?.startsWith(`purr/${workspace}/credentials/`) && (!variable.secretState || variable.secretState.edit?.kind !== "set" && variable.secretState.edit?.kind !== "delete")
      ? { kind: "secret" as const, ref: variable.secretRef }
      : await storeCredential(secure, credentialRef(workspace, owner, variable.id, variable.secretRef), variable.value, "secret", variable.secretState ?? (variable.loaded === false && variable.secretRef ? { ref: variable.secretRef, status: "unresolved", edit: { kind: "keep" } } : undefined));
    if (credential.kind === "secret" && secure instanceof SecretPreparationStore) secure.onCommitted(() => {
      variable.secretRef = credential.ref;
      variable.secretState = { ref: credential.ref, status: variable.secretState?.edit?.kind === "delete" ? "missing" : variable.secretState?.edit?.kind === "keep" && variable.secretState.status !== "available" ? variable.secretState.status : "available", edit: { kind: "keep" } };
    });
    return { ...common, kind: "static", secretRef: credential.kind === "secret" ? credential.ref : variable.secretRef };
  }
  if (variable.kind === "dynamic-request") return { ...common, kind: variable.kind, documentId: variable.documentId,
    expression: variable.expression, language: variable.language, refresh: variable.refresh,
    ...(variable.cacheTtlSeconds ? { cacheTtlSeconds: variable.cacheTtlSeconds } : {}), environment: variable.environment };
  return { ...common, kind: variable.kind, provider: variable.provider, key: variable.key, sensitive: true };
}

async function variableFromDefinition(variable: VariableDefinition, secure: SecureStore, loadSecret: boolean): Promise<Variable> {
  if (variable.kind !== "static") return variable;
  if (!variable.sensitive) return { ...variable, kind: "static", value: variable.value ?? "" };
  const field = variable.secretRef ? await materializeCredential(secure, { kind: "secret", ref: variable.secretRef }, loadSecret) : { value: "" };
  return { id: variable.id, name: variable.name, enabled: variable.enabled, sensitive: true, kind: "static",
    secretRef: variable.secretRef, loaded: field.secretState?.status === "available", ...field };
}

async function protectDynamicVariableCache(cache: Workspace["dynamicVariableCache"], variables: readonly Variable[], secure: SecureStore, workspace: string) {
  return Object.fromEntries(await Promise.all(Object.entries(cache).map(async ([key, entry]) => {
    const variableId = key.split(":", 1)[0];
    const variable = variables.find((candidate) => candidate.id === variableId);
    if (!variable?.sensitive || entry.status !== "success" || entry.value === undefined) return [key, entry];
    const credential = await storeCredential(secure, secretRef(workspace, `dynamic-variables/${variableId}`, `cache/${entry.environmentId ?? "none"}`, "runtime"), entry.value, "secret", entry.secretState);
    const { secretState: _state, ...metadata } = entry;
    return [key, { ...metadata, value: { __purrSecret: credential } }];
  })));
}

export async function projectGlobalVariables(variables: readonly Variable[], source: SecureStore): Promise<{ definitions: VariableDefinition[]; secrets: SecretBatch }> {
  const secure = source instanceof SecretPreparationStore ? source : new SecretPreparationStore(source);
  const definitions = await Promise.all(variables.filter((variable) => variable.name.trim()).map((variable) => variableToDefinition(variable, secure, "global", "variables")));
  return { definitions, secrets: await secure.batch() };
}

export async function restoreGlobalVariables(value: unknown, secure: SecureStore, hydrate = true): Promise<Variable[]> {
  const definitions = variableDefinitionSchema.array().parse(value ?? []);
  const names = definitions.map((variable) => variable.name.trim());
  if (new Set(names).size !== names.length || new Set(definitions.map((variable) => variable.id)).size !== definitions.length)
    throw new Error("Global variable names and identifiers must be unique.");
  if (definitions.some((variable) => variable.kind !== "static"))
    throw new Error("Global variables must be static.");
  return Promise.all(definitions.map((variable) => variableFromDefinition(variable, secure, hydrate)));
}
async function requestDefinition(document: RequestDocument, workspace: string, secure: SecureStore, assets: Record<string, string>): Promise<RequestDefinition> {
  const draft = document.savedRequest ?? document.request;
  const fileRef = async (file: File) => {
    const encoded = await encodeFile(file);
    assets[`assets/${encoded.contentDigest}.bin`] = encoded.record.base64;
    return { id: encoded.contentDigest, name: file.name, mediaType: file.type };
  };
  const body = draft.body;
  const payload = body.type === "none" ? { type: "none" as const }
    : body.type === "json" || body.type === "xml" || body.type === "text" ? { type: body.type, data: body[body.type] }
    : body.type === "binary" ? { type: "binary" as const, file: body.binary ? await fileRef(body.binary.file) : null }
    : { type: body.type, fields: await Promise.all((body.type === "form-data" ? body.formData : body.urlEncoded)
      .filter((field) => field.key || field.value || field.attachment).map(async (field) => ({ name: field.key, value: field.value, enabled: field.enabled,
        ...(field.attachment ? { file: await fileRef(field.attachment) } : {}), ...(field.contentType ? { contentType: field.contentType } : {}) }))) };
  const common = { id: document.id, name: document.name, ...(document.description ? { description: document.description } : {}), ...(document.folderId ? { folderId: document.folderId } : {}), ...(document.origin ? { origin: document.origin } : {}),
    ...(draft.tracing ? { tracing: draft.tracing } : {}),
    ...(draft.settings ? { settings: draft.settings } : {}),
    ...(draft.tracePropagation ? { tracePropagation: draft.tracePropagation } : {}),
    method: draft.method, url: draft.url, ...(draft.documentation ? { documentation: draft.documentation } : {}), params: pairs(draft.params), pathParams: pairs(draft.pathParams ?? []),
    headers: await Promise.all(draft.headers.filter((header) => !header.readOnly && (header.name || header.value || header.secretRef))
      .map((header) => headerToDefinition(header, secure, workspace, `requests/${document.id}/saved/headers`))), body: payload,
    auth: await authToDefinition(draft.auth, secure, workspace, `requests/${document.id}/saved`), ...(draft.environmentId ? { environmentId: draft.environmentId } : {}),
    ...(!draft.workspace.headersEnabled || !draft.workspace.authEnabled || !draft.useCookieJar || Object.values(draft.workspace.headerOverrides).some((value) => !value)
      ? { overrides: { headers: draft.workspace.headersEnabled, auth: draft.workspace.authEnabled, cookies: draft.useCookieJar,
        excludedHeaderIds: Object.keys(draft.workspace.headerOverrides).filter((id) => draft.workspace.headerOverrides[id] === false).sort() } } : {}) };
  return document.kind === "graphql" ? { ...common, kind: "graphql", graphql: { query: draft.graphql!.query, variables: draft.graphql!.variables,
    ...(draft.graphql!.operationName ? { operation: draft.graphql!.operationName } : {}), ...(draft.graphql!.schemaId ? { schemaId: draft.graphql!.schemaId } : {}) } }
    : { ...common, kind: "http" };
}

export async function projectWorkspace(workspace: Workspace, source: SecureStore, options: { globalVariables?: readonly Variable[]; localOnlyBaseline?: Project; sourceVersion?: ProjectFormatVersion; legacyRevisions?: Record<string, string>; sourceRevisions?: Record<string, string> } = {}): Promise<{ project: Project; local: LocalRecord[]; assets: Record<string, string>; secrets: SecretBatch }> {
  const secure = source instanceof SecretPreparationStore ? source : new SecretPreparationStore(source);
  // Historical tabs are views of local executions, never saved documents or drafts.
  const historicalIds = new Set(workspace.documents.filter((document) => isRequestDocument(document) && document.historical).map((document) => document.id));
  const currentTabId = (id: string | null): string | null => {
    if (!id || !historicalIds.has(id)) return id;
    const document = workspace.documents.find((item) => item.id === id);
    if (!document || !isRequestDocument(document) || !document.historical?.inPlace) return null;
    const sourceId = document.historical.documentId;
    return workspace.documents.some((item) => item.id === sourceId && !historicalIds.has(item.id)) ? sourceId : null;
  };
  workspace = { ...workspace, documents: workspace.documents.filter((document) => !historicalIds.has(document.id)), ui: { ...workspace.ui,
    openDocumentIds: [...new Set(workspace.ui.openDocumentIds.flatMap((id) => { const current = currentTabId(id); return current ? [current] : []; }))],
    activeDocumentId: currentTabId(workspace.ui.activeDocumentId),
    previewDocumentId: historicalIds.has(workspace.ui.previewDocumentId ?? "") ? null : workspace.ui.previewDocumentId,
  } };
  const baseline = options.localOnlyBaseline;
  const resources: ProjectResource[] = [...(baseline ? baseline.resources.filter((item) => item.kind === "folder" || item.kind === "integration" || item.kind === "api-schema") : workspace.extraResources ?? [])];
  if (!baseline) for (let index = 0; index < resources.length; index++) {
    const resource = resources[index];
    if (resource.kind === "integration") resources[index] = { ...resource, credentials: Object.fromEntries(await Promise.all(Object.entries(resource.credentials).map(async ([key, credential]) =>
      [key, await storeCredential(secure, credentialRef(workspace.id, `integrations/${resource.id}`, key, credential.kind === "secret" ? credential.ref : undefined), credential.kind === "secret" ? "" : credential.value, "secret", credential.kind === "secret" ? { ref: credential.ref, status: "unresolved", edit: { kind: "keep" } } : undefined)]))) };
  }
  const assets: Record<string, string> = {};
  const attachments = new Map<string, FileAttachmentRecord | NativeFileAttachmentRecord>();
  const allVariables = [...workspace.variables, ...workspace.environments.flatMap((environment) => environment.variables)];
  const local: LocalRecord[] = [
    { table: "workspace_local_state", id: "state", value: { ui: workspace.ui, activeEnvironmentId: workspace.activeEnvironmentId } },
    { table: "workspace_local_state", id: "dynamic-variable-cache", value: await protectDynamicVariableCache(workspace.dynamicVariableCache, allVariables, secure, workspace.id) },
  ];
  if (!baseline) for (const environment of workspace.environments) resources.push({ id: environment.id, kind: "environment", name: environment.name,
    ...(environment.description ? { description: environment.description } : {}), ...(environment.folderId ? { folderId: environment.folderId } : {}),
    variables: await Promise.all(environment.variables.filter((row) => row.name).map((row) => variableToDefinition(row, secure, workspace.id, `environments/${environment.id}`))) });
  const auth = baseline?.workspace.auth ?? await Promise.all(workspace.requestConfig.auth.map(async (entry) => ({ id: entry.id, name: entry.name, scope: entry.scope, enabled: entry.enabled,
    config: await authToDefinition(entry.value, secure, workspace.id, `auth/${entry.id}`) })));
  const headers = baseline?.workspace.headers ?? await Promise.all(workspace.requestConfig.headers.filter((row) => row.name || row.value || row.secretRef)
    .map(async (header) => ({ ...await headerToDefinition(header, secure, workspace.id, "headers"), scope: header.scope })));
  // Lazy canonical materialization deliberately bypasses staged edit-intent restoration:
  // these are the identities the editor will own after successful publication.
  const canonicalReader = new CachedSecureStore(secure);
  const canonicalConfig = { ...workspace.requestConfig,
    auth: await Promise.all(auth.map(async (entry) => ({ ...entry, value: await authFromDefinition(entry.config, canonicalReader, false) }))),
    headers: await Promise.all(headers.map(async (header) => ({ ...await headerFromDefinition(header, canonicalReader, false), scope: header.scope }))),
  };
  const identityVariables = getEffectiveVariableValues(workspace, options.globalVariables ?? []);
  // Only acquired tokens are runtime state. Saved credentials remain canonical
  // definitions backed by SecureStore and inactive editor forms stay in session state.
  local.push({ table: "workspace_local_state", id: "auth-runtime", value: await createWorkspaceAuthRuntime(workspace.requestConfig.auth, auth, secure, workspace.id, Boolean(baseline)) });
  for (const document of workspace.documents) {
    if (isRequestDocument(document)) {
      const definition = document.saved ? baseline?.resources.find((item): item is RequestDefinition => item.id === document.id && (item.kind === "http" || item.kind === "graphql"))
        ?? (!baseline ? await requestDefinition(document, workspace.id, secure, assets) : undefined) : undefined;
      if (definition) resources.push(definition);
      if (!document.saved || isDocumentDirty(document)) {
        const draft = await protectRuntime({ ...document, lastResponse: null, sentAt: null }, secure, workspace.id, `drafts/${document.id}`) as Record<string, unknown>;
        // The portable baseline tracks external edits; it is not a runtime secret snapshot.
        local.push({ table: "drafts", id: document.id, value: await encodeFiles({ ...draft, base: baseline ? null : definition ?? null,
          ...(baseline && definition ? { baseFingerprint: await valueHash(serializeResource(definition, undefined, 1)) } : {}),
        }, attachments) });
      }
      local.push({ table: "document_session_state", id: document.id, value: { ui: document.ui, createdAt: document.createdAt, updatedAt: document.updatedAt, sentAt: document.sentAt,
        ...(definition ? { ...(baseline ? { definitionHash: await valueHash(serializeResource(definition, undefined, 1)), legacySourceRevision: options.legacyRevisions?.[document.id] } : { definition: serializeResource(definition, undefined, options.sourceVersion ?? 2) }),
          editor: await encodeFiles(await protectRuntime(document.request, secure, workspace.id, `editor/${document.id}`), attachments) } : {}) } });
      if (document.lastResponse) local.push({ table: "request_executions", id: `${document.id}-${document.lastResponse.timeline.startedAtMs}`, value: { documentId: document.id, response: responseForPersistence(document.lastResponse) } });
    } else if (document.kind === "schema") {
      const previousSchema = baseline?.resources.find((item): item is SchemaDefinition => item.kind === "schema" && item.id === document.id);
      const auth = previousSchema?.auth ?? (!baseline ? await authToDefinition(document.auth, secure, workspace.id, `schemas/${document.id}`) : { type: "none" as const });
      const introspectionHeaders = previousSchema?.introspectionHeaders ?? (!baseline ? await Promise.all(document.introspectionHeaders.map((header) => headerToDefinition(header, secure, workspace.id, `schemas/${document.id}/headers`))) : []);
      const definition: SchemaDefinition = previousSchema ?? { id: document.id, kind: "schema", name: document.name,
        ...(document.description ? { description: document.description } : {}), source: baseline ? schemaSource(document) : await protectedSchemaSource(document, secure, workspace.id),
        endpoint: document.endpoint, auth, introspectionHeaders, pin: document.pinned !== false,
        ...(document.pinned !== false && document.sdl ? { pinnedSdl: document.sdl } : {}) };
      if (document.saved) resources.push(definition);
      else local.push({ table: "drafts", id: document.id, value: await protectRuntime(document, secure, workspace.id, `schema-drafts/${document.id}`) });
      let cacheIdentity = document.cacheIdentity;
      if (!baseline && cacheIdentity && cacheIdentity === await schemaConnectionIdentity(document, workspace.requestConfig, identityVariables, workspace.activeEnvironmentId)) {
        const canonical = { ...document,
          auth: definition.auth ? await authFromDefinition(definition.auth, canonicalReader, false) : createRequestAuth(),
          introspectionHeaders: await Promise.all((definition.introspectionHeaders ?? []).map((header) => headerFromDefinition(header, canonicalReader, false))),
        };
        const before = cacheIdentity;
        cacheIdentity = await schemaConnectionIdentity(canonical, canonicalConfig, identityVariables, workspace.activeEnvironmentId);
        const committedIdentity = cacheIdentity;
        secure.onCommitted(() => { if (document.cacheIdentity === before) document.cacheIdentity = committedIdentity; });
      }
      local.push({ table: "schema_cache", id: document.id, value: { version: 2, definitionHash: await schemaDefinitionIdentity(definition), sdl: document.sdl, loadedAt: document.loadedAt, source: await protectRuntime(schemaSource(document), secure, workspace.id, `schema-cache/${document.id}/source`), cacheIdentity } });
      local.push({ table: "document_session_state", id: document.id, value: { ui: document.ui, createdAt: document.createdAt, updatedAt: document.updatedAt,
        ...(baseline ? { authDefinitionHash: await valueHash(auth) } : { authDefinition: JSON.stringify(auth) }), auth: await protectRuntime(document.auth, secure, workspace.id, `schema-auth/${document.id}`) } });
    } else {
      const definition: ProjectResource = { id: document.id, kind: "extension", name: document.name,
        ...(document.description ? { description: document.description } : {}), ...(document.folderId ? { folderId: document.folderId } : {}),
        extensionType: document.extensionType, configVersion: document.savedConfigVersion ?? document.configVersion,
        config: structuredClone(document.savedConfig ?? document.config) };
      if (document.saved) resources.push(definition);
      if (!document.saved || isDocumentDirty(document)) local.push({ table: "drafts", id: document.id, value: { ...document, base: document.saved ? definition : null } });
      local.push({ table: "document_session_state", id: document.id, value: { ui: document.ui, createdAt: document.createdAt, updatedAt: document.updatedAt } });
    }
  }
  if (baseline) {
    // This versioned local definition overlay deliberately excludes the runtime
    // aggregate: UI, cookies, history and caches already have their own records.
    const definitions = { name: workspace.name, description: workspace.description, defaultGraphqlSchemaId: workspace.defaultGraphqlSchemaId,
      variables: workspace.variables, environments: workspace.environments, requestConfig: workspace.requestConfig, extraResources: workspace.extraResources,
      documents: workspace.documents.map((document) => isRequestDocument(document) ? { ...document, lastResponse: null, sentAt: null } : document) };
    local.push({ table: "workspace_local_state", id: "legacy-definition-draft", value: { version: 1, sourceRevisions: options.sourceRevisions ?? {},
      definitions: await encodeFiles(await protectRuntime(definitions, secure, workspace.id, "legacy-definition-draft"), attachments) } });
  }
  for (const [id, value] of attachments) local.push({ table: "attachments", id, value });
  for (const cookie of workspace.cookies) local.push({ table: "cookie_jar", id: cookie.id, value: cookie });
  return { project: baseline ?? { workspace: { id: workspace.id, name: workspace.name, ...(workspace.description ? { description: workspace.description } : {}),
    ...(workspace.defaultGraphqlSchemaId ? { defaultGraphqlSchemaId: workspace.defaultGraphqlSchemaId } : {}),
    ...(workspace.requestConfig.tracePropagation ? { tracePropagation: workspace.requestConfig.tracePropagation } : {}),
    variables: await Promise.all(workspace.variables.filter((row) => row.name).map((row) => variableToDefinition(row, secure, workspace.id, "variables"))),
    headers, auth }, resources }, local, assets, secrets: await secure.batch() };
}

async function requestFromDefinition(resource: RequestDefinition, secure: SecureStore, assets: Record<string, string>, hydrate: boolean): Promise<RequestDocument> {
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
  const draft: RequestDraft = { ...document.request, method: resource.method, url: resource.url, documentation: resource.documentation ?? "", body, auth: await authFromDefinition(resource.auth, secure, hydrate),
    tracing: resource.tracing,
    settings: resource.settings,
    tracePropagation: resource.tracePropagation,
    params: [...resource.params.map((row, index) => ({ id: `param-${index}`, key: row.name, value: row.value, enabled: row.enabled })), { id: "param-empty", key: "", value: "", enabled: false }],
    pathParams: resource.pathParams.map((row, index) => ({ id: `path-param-${index}`, key: row.name, value: row.value, enabled: row.enabled })),
    headers: [...await Promise.all(resource.headers.map((header) => headerFromDefinition(header, secure, hydrate))), { id: "header-empty", name: "", value: "", enabled: false }],
    useCookieJar: resource.overrides?.cookies ?? true, environmentId: resource.environmentId,
    workspace: { headersEnabled: resource.overrides?.headers ?? true, authEnabled: resource.overrides?.auth ?? true,
      headerOverrides: Object.fromEntries((resource.overrides?.excludedHeaderIds ?? []).map((id) => [id, false])) },
    ...(resource.kind === "graphql" ? { graphql: { query: resource.graphql.query, variables: resource.graphql.variables, operationName: resource.graphql.operation ?? "", schemaId: resource.graphql.schemaId } } : {}) };
  return { ...document, id: resource.id, name: resource.name, description: resource.description, folderId: resource.folderId, origin: resource.origin, saved: true, request: draft, savedRequest: draft };
}

export async function restoreWorkspace(
  project: Project,
  records: LocalRecord[],
  secure: SecureStore,
  assets: Record<string, string>,
  loadAttachment?: FileAttachmentLoader,
  options: { hydrateSecrets?: boolean; sourceVersion?: ProjectFormatVersion } = {},
): Promise<Workspace> {
  const hydrate = options.hydrateSecrets ?? true;
  // Public application consumers may still provide v1 in-memory rows. This is
  // a read boundary only; strict v2 serializers never accept their wire shape.
  const oldHeader = (header: { value: unknown }) => typeof header.value === "string";
  if (project.workspace.headers.some(oldHeader) || project.resources.some((resource) => (resource.kind === "http" || resource.kind === "graphql") && resource.headers.some(oldHeader))) {
    project = { workspace: workspaceDefinitionSchema.parse(normalizeLegacyWorkspace(project.workspace as unknown as Record<string, unknown>)),
      resources: project.resources.map((resource) => resourceSchema.parse(normalizeLegacyResource(resource as unknown as Record<string, unknown>))) };
  }
  const workspace = createWorkspace(project.workspace.name, project.workspace.id); workspace.documents = [];
  workspace.description = project.workspace.description ?? "";
  workspace.defaultGraphqlSchemaId = project.workspace.defaultGraphqlSchemaId;
  workspace.extraResources = project.resources.filter((item) => item.kind === "folder" || item.kind === "integration" || item.kind === "api-schema");
  workspace.variables = await Promise.all(project.workspace.variables.map((variable) => variableFromDefinition(variable, secure, hydrate)));
  workspace.requestConfig = { headers: await Promise.all(project.workspace.headers.map(async (header) => ({ ...await headerFromDefinition(header, secure, hydrate), scope: header.scope }))),
    auth: await Promise.all(project.workspace.auth.map(async (entry) => ({ id: entry.id, name: entry.name, enabled: entry.enabled, scope: entry.scope, value: await authFromDefinition(entry.config, secure, hydrate) }))) };
  workspace.requestConfig.tracePropagation = project.workspace.tracePropagation;
  const get = (table: LocalRecord["table"], id: string) => records.find((item) => item.table === table && item.id === id)?.value;
  const attachments = new Map(records.filter((item) => item.table === "attachments").map((item) => [item.id, item.value]));
  const state = get("workspace_local_state", "state") as { ui: Workspace["ui"]; activeEnvironmentId: string | null } | undefined;
  if (state) { workspace.ui = state.ui; workspace.activeEnvironmentId = state.activeEnvironmentId; }
  else workspace.ui = { ...workspace.ui, openDocumentIds: [], activeDocumentId: null };
  workspace.dynamicVariableCache = await resolveRuntime(get("workspace_local_state", "dynamic-variable-cache") ?? {}, secure, hydrate) as Workspace["dynamicVariableCache"];
  const runtimeAuth = parseWorkspaceAuthRuntime(get("workspace_local_state", "auth-runtime"), workspace.id);
  workspace.requestConfig.auth = await Promise.all(workspace.requestConfig.auth.map(async (entry) => {
    const runtime = runtimeAuth.entries.find((item) => item.id === entry.id);
    const definition = project.workspace.auth.find((item) => item.id === entry.id);
    if (runtime && definition && runtime.definitionHash === await valueHash(definition)) {
      const oauth = runtime.oauthToken;
      const oauthMetadata = oauth ? { tokenType: oauth.tokenType, obtainedAt: oauth.obtainedAt,
        ...(oauth.expiresAt !== undefined ? { expiresAt: oauth.expiresAt } : {}), ...(oauth.scope !== undefined ? { scope: oauth.scope } : {}) } : undefined;
      const access = oauth ? await materializeCredential(secure, oauth.accessToken, hydrate) : undefined;
      const refresh = oauth?.refreshToken ? await materializeCredential(secure, oauth.refreshToken, hydrate) : undefined;
      entry.value = { ...entry.value,
        credentialStates: { ...entry.value.credentialStates,
          ...(access?.secretState ? { "oauth-access-token": access.secretState } : {}),
          ...(refresh?.secretState ? { "oauth-refresh-token": refresh.secretState } : {}) },
        oauth2: { ...entry.value.oauth2, token: oauth && oauthMetadata && access ? { ...oauthMetadata, accessToken: access.value,
          ...(refresh ? { refreshToken: refresh.value } : {}) } : null } };
    }
    return entry;
  }));
  for (const resource of project.resources) {
    if (resource.kind === "environment") workspace.environments.push({ id: resource.id, name: resource.name, description: resource.description, folderId: resource.folderId,
      variables: await Promise.all(resource.variables.map((variable) => variableFromDefinition(variable, secure, hydrate && workspace.activeEnvironmentId === resource.id))) });
    if (resource.kind === "http" || resource.kind === "graphql") workspace.documents.push(await requestFromDefinition(resource, secure, assets, hydrate));
    if (resource.kind === "extension") workspace.documents.push({ id: resource.id, kind: "extension", name: resource.name,
      description: resource.description, folderId: resource.folderId, saved: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      extensionType: resource.extensionType, configVersion: resource.configVersion, config: structuredClone(resource.config),
      savedConfigVersion: resource.configVersion, savedConfig: structuredClone(resource.config), ui: {} });
    if (resource.kind === "schema") {
      const storedCache = get("schema_cache", resource.id) as { version?: number; definitionHash?: string; sdl: string; loadedAt: string | null; source?: SchemaDefinition["source"]; cacheIdentity?: string } | undefined;
      const source = resource.source;
      const cache = storedCache && typeof storedCache.sdl === "string"
        && (storedCache.version === 2 || storedCache.version === undefined && JSON.stringify(storedCache.source) === JSON.stringify(source)) ? storedCache : undefined;
      workspace.documents.push({ ...createSchemaDocument(), id: resource.id, name: resource.name, description: resource.description, folderId: resource.folderId, saved: true,
        source: source.type === "introspection" ? "introspection" : "file", schemaSource: source,
        connectionVersion: resource.endpoint !== undefined ? 1 : undefined,
        auth: resource.auth ? await authFromDefinition(resource.auth, secure, hydrate) : createRequestAuth(),
        introspectionHeaders: await Promise.all((resource.introspectionHeaders ?? []).map((header) => headerFromDefinition(header, secure, hydrate))),
        cacheIdentity: cache?.definitionHash && cache.definitionHash !== await schemaDefinitionIdentity(resource) ? "changed" : typeof cache?.cacheIdentity === "string" ? cache.cacheIdentity : undefined,
        endpoint: resource.endpoint ?? ("endpoint" in source ? source.endpoint ?? "" : ""), sourceRequestId: source.type === "introspection" ? source.requestId ?? "" : "",
        sourceLabel: source.type === "introspection" ? resource.endpoint ?? source.endpoint ?? "" : "location" in source ? source.location ?? "" : "", pinned: resource.pin,
        sdl: resource.pinnedSdl ?? cache?.sdl ?? "", loadedAt: typeof cache?.loadedAt === "string" ? cache.loadedAt : null });
    }
  }
  for (const record of records.filter((item) => item.table === "drafts")) {
    const draft = await resolveRuntime(decodeFiles(record.value, attachments, workspace.id, loadAttachment), secure, hydrate) as (RequestDocument | SchemaDocument | ExtensionDocument) & { base?: ProjectResource | null; baseFingerprint?: string };
    const index = workspace.documents.findIndex((document) => document.id === draft.id);
    if (index < 0 && !draft.saved) workspace.documents.push(draft);
    else if (index >= 0 && (isRequestDocument(draft) || isExtensionDocument(draft))) {
      const definition = project.resources.find((item) => item.id === draft.id);
      if (draft.baseFingerprint && definition && draft.baseFingerprint !== await valueHash(serializeResource(definition, undefined, options.sourceVersion ?? 2)))
        throw new Error("A saved request changed on disk while it has local edits. Local edits are preserved; resolve or restore the external change before reloading.");
      const normalizedBase = draft.base && options.sourceVersion === 1 ? resourceSchema.parse(normalizeLegacyResource(draft.base as unknown as Record<string, unknown>)) : draft.base;
      const baseAtCanonicalLocation = normalizedBase && definition
        ? { ...normalizedBase, ...(definition.folderId ? { folderId: definition.folderId } : { folderId: undefined }) }
        : draft.base;
      if (baseAtCanonicalLocation && definition && serializeResource(baseAtCanonicalLocation, undefined, options.sourceVersion ?? 2) !== serializeResource(definition, undefined, options.sourceVersion ?? 2))
        throw new Error("A saved request changed on disk while it has local edits. Local edits are preserved; resolve or restore the external change before reloading.");
      // documents/ owns hierarchy. Preserve the dirty request editor state but
      // always take its location from the canonical filesystem projection.
      workspace.documents[index] = { ...draft, ...(definition?.folderId ? { folderId: definition.folderId } : { folderId: undefined }) };
    }
  }
  const canonicalFolderIds = new Set((workspace.extraResources ?? [])
    .filter((resource) => resource.kind === "folder")
    .map((resource) => resource.id));
  workspace.documents = workspace.documents.map((document) => document.folderId && !canonicalFolderIds.has(document.folderId)
    ? { ...document, folderId: undefined }
    : document);
  workspace.documents = await Promise.all(workspace.documents.map(async (document) => {
    const session = get("document_session_state", document.id) as (Partial<typeof document> & { editor?: unknown; definition?: string; definitionHash?: string }) | undefined;
    const result = { ...document, ...(session ? { ui: session.ui ?? document.ui, createdAt: session.createdAt ?? document.createdAt, updatedAt: session.updatedAt ?? document.updatedAt } : {}) } as WorkspaceDocument;
    if (result.kind === "schema") {
      const schemaSession = session as { auth?: unknown; authDefinition?: string; authDefinitionHash?: string } | undefined;
      const resource = project.resources.find((item) => item.id === result.id);
      if (isRecord(schemaSession?.auth) && ["bearer", "basic", "apiKey", "oauth2", "inherit"].every((key) => isRecord((schemaSession.auth as Record<string, unknown>)[key]))
        && resource?.kind === "schema" && (schemaSession.authDefinition === JSON.stringify(resource.auth) || schemaSession.authDefinitionHash === await valueHash(resource.auth))) {
        const restoredAuth = normalizeRequestAuth(await resolveRuntime(schemaSession.auth, secure, hydrate) as RequestAuth);
        const token = restoredAuth.oauth2.token;
        if (token && (typeof token.accessToken !== "string" || typeof token.obtainedAt !== "number" || token.tokenType !== "Bearer")) restoredAuth.oauth2.token = null;
        const active = result.auth;
        const group = { bearer: "bearer", basic: "basic", "api-key": "apiKey", oauth2: "oauth2", inherit: "inherit", none: null }[active.type];
        result.auth = { ...restoredAuth, type: active.type, secretRefs: active.secretRefs, credentialStorage: active.credentialStorage, credentialStates: { ...restoredAuth.credentialStates, ...active.credentialStates },
          ...(group ? { [group]: active[group as keyof RequestAuth] } : {}),
          ...(active.type === "oauth2" ? { oauth2: { ...active.oauth2, token: restoredAuth.oauth2.token } } : {}) };
      }
    }
    if (isRequestDocument(result)) {
      const definition = project.resources.find((item) => item.id === result.id);
      const sessionMatches = session?.definitionHash && definition ? session.definitionHash === await valueHash(serializeResource(definition, undefined, options.sourceVersion ?? 2)) : session?.definition && definition && (() => {
        try { return serializeResource(deserializeResourceFile(session.definition).value, undefined, options.sourceVersion ?? 2) === serializeResource(definition, undefined, options.sourceVersion ?? 2); }
        catch { return false; }
      })();
      if (session?.editor && definition && sessionMatches && !records.some((record) => record.table === "drafts" && record.id === result.id)) {
        const canonicalAuth = result.request.auth;
        const canonicalHeaders = result.request.headers;
        const editor = await resolveRuntime(decodeFiles(session.editor, attachments, workspace.id, loadAttachment), secure, hydrate) as RequestDraft;
        // Cached editor modes must not shadow a credential changed in SecureStore.
        // Dirty working copies use their own local refs until explicitly saved.
        const group = { bearer: "bearer", basic: "basic", "api-key": "apiKey", oauth2: "oauth2", inherit: "inherit", none: null }[canonicalAuth.type] as "bearer" | "basic" | "apiKey" | "oauth2" | "inherit" | null;
        editor.auth = { ...editor.auth, type: canonicalAuth.type, secretRefs: canonicalAuth.secretRefs, credentialStorage: canonicalAuth.credentialStorage, credentialStates: { ...editor.auth.credentialStates, ...canonicalAuth.credentialStates },
          ...(group ? { [group]: canonicalAuth[group] } : {}),
          ...(canonicalAuth.type === "oauth2" ? { oauth2: { ...canonicalAuth.oauth2, token: editor.auth.oauth2.token } } : {}) };
        // Clean session copies never own saved header credentials. A stale editor
        // ref must not overwrite a newer canonical vault value on startup autosave.
        editor.headers = [...canonicalHeaders.filter((header) => header.name || header.value || header.secretRef),
          ...editor.headers.filter((header) => !header.name && !header.value && !header.secretRef && !header.secretState)];
        result.request = editor;
        result.savedRequest = result.request;
      }
      const executions = records.filter((record) => record.table === "request_executions" && (record.value as { documentId?: unknown }).documentId === document.id)
        .map((record) => restoreStoredHttpResponse((record.value as { response?: unknown }).response))
        .filter((response): response is StoredHttpResponse => response !== null)
        .sort((a, b) => storedHttpResponseStartedAt(b) - storedHttpResponseStartedAt(a));
      result.lastResponse = executions[0] ?? null;
    }
    return result;
  }));
  const documentOrder = workspace.ui.sidebarItemOrder ?? workspace.ui.documentOrder ?? [];
  const documentIndexes = new Map(documentOrder.map((id, index) => [id, index]));
  workspace.documents.sort((left, right) => (documentIndexes.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (documentIndexes.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  workspace.cookies = records.filter((record) => record.table === "cookie_jar").map((record) => record.value as Workspace["cookies"][number]);
  const pending = get("workspace_local_state", "legacy-definition-draft");
  if (pending != null) {
    if (!isRecord(pending) || pending.version !== 1 || !isRecord(pending.sourceRevisions) || !isRecord(pending.definitions)
      || options.sourceVersion !== 1 || Object.keys(pending).some((key) => !["version", "sourceRevisions", "definitions"].includes(key)))
      throw new Error("Unsupported legacy definition overlay. Existing local data has not been changed.");
    const definitions = await resolveRuntime(decodeFiles(pending.definitions, attachments, workspace.id, loadAttachment), secure, hydrate) as Record<string, unknown>;
    if (Object.keys(definitions).some((key) => !["name", "description", "defaultGraphqlSchemaId", "variables", "environments", "requestConfig", "extraResources", "documents"].includes(key)) || !Array.isArray(definitions.documents))
      throw new Error("Unsupported legacy definition overlay. Existing local data has not been changed.");
    const documents = (definitions.documents as WorkspaceDocument[]).map((document) => {
      const restored = workspace.documents.find((item) => item.id === document.id);
      return isRequestDocument(document) && restored && isRequestDocument(restored) ? { ...document, lastResponse: restored.lastResponse, sentAt: restored.sentAt, ui: restored.ui } : document;
    });
    Object.assign(workspace, definitions, { documents });
  }
  return validateWorkspace(workspace);
}
