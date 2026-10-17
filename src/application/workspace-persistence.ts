import { entityId, validateProject, type Project, type ProjectResource } from "../domain/project";
import { createWorkspace, validateWorkspace, isRequestDocument, isDocumentDirty, type Workspace, type WorkspaceStore } from "../features/workspaces/model/workspace";
import { AttachmentPreparation, TransientAttachments, decodeFiles } from "../storage/file-codec";
import { commitRejection, isCommitRejected, RecoveryRequiredError, type SecretBatch, type SecureStore } from "./ports/credentials";
import type { FileChange, LocalChange, LocalRecord, PersistencePort, StoredWorkspace, WorkspaceDeletionResult, ProtectedState } from "./ports/persistence";
import { deserializeManifestFile, deserializeResourceFile, pinnedSchemaPath, serializeManifest, serializeResource, type ProjectFormatVersion } from "../storage/yaml";
import { migrateWorkspaceAuthRuntime, projectGlobalVariables, projectWorkspace, restoreGlobalVariables, restoreWorkspace } from "./project-projection";
import { CachedSecureStore, SecretPreparationStore } from "../storage/secrets";
import type { Variable } from "../features/workspaces/model/workspace";
import { invalidateSecretBuffers } from "./invalidate-secret-buffers";
import { RequestHistory } from "./request-history";
import { legacyHistoryEntry } from "./history-legacy";

// Requests and request-adjacent documents share one canonical directory. The
// previous requests/ and graphql/ locations remain readable so existing
// workspaces can be migrated safely on their next save.
const resourceDirectory = (resource: ProjectResource) => ({ http: "documents", graphql: "documents", extension: "documents", schema: "schemas", "api-schema": "schemas", environment: "environments", folder: "documents", integration: "integrations" })[resource.kind];
const slug = (name: string) => name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "resource";
const key = (record: Pick<LocalRecord, "table" | "id">) => `${record.table}/${record.id}`;
const folderMarker = ".purr-folder.yaml";
const parentPath = (path: string) => path.split("/").slice(0, -1).join("/");
const fileName = (path: string) => { const parts = path.split("/"); return parts[parts.length - 1] || ""; };
const pathAfter = (path: string, prefix: string) => path.startsWith(prefix) ? path.slice(prefix.length) : "";
const folderDirectoryName = (name: string) => {
  const value = name.normalize("NFC").trim().replace(/[\\/]+/g, "-").slice(0, 128);
  return value && value !== "." && value !== ".." && !value.startsWith(".") ? value : "folder";
};

function generatedFolderId(path: string, used: Set<string>) {
  const stem = `folder-${path.normalize("NFKD").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 112) || "root"}`;
  let id = stem; let suffix = 2;
  while (used.has(id)) id = `${stem}-${suffix++}`;
  used.add(id); return id;
}
class LegacyDefinitionConflict extends Error {
  constructor() { super("External project changes conflict with pending legacy definitions. Both sources are preserved."); }
}
function assertLegacyBaseline(snapshot: StoredWorkspace, revisions: Record<string, string>) {
  if (Object.keys(revisions).length !== Object.keys(snapshot.files).length || Object.entries(revisions).some(([path, revision]) => snapshot.files[path]?.revision !== revision))
    throw new LegacyDefinitionConflict();
}
/** A missing private attachment makes its owning editor opaque, not every document. */
function isolateUnavailableAttachments(snapshot: StoredWorkspace): StoredWorkspace {
  if (snapshot.unavailableLocal === undefined) return snapshot;
  const unavailable = new Set(snapshot.unavailableLocal.filter((row) => row.table === "attachments").map((row) => row.id));
  if (!unavailable.size) return snapshot;
  const usesUnavailable = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if ("__purrFileRef" in value && typeof value.__purrFileRef === "string" && unavailable.has(value.__purrFileRef)) return true;
    return Object.values(value).some(usesUnavailable);
  };
  const owners = snapshot.local.filter((row) => ["drafts", "document_session_state"].includes(row.table) && usesUnavailable(row.value));
  return { ...snapshot, local: snapshot.local.filter((row) => !owners.includes(row)), unavailableLocal: [...snapshot.unavailableLocal,
    ...owners.map((row) => ({ table: row.table, id: row.id, state: { status: "unavailable" as const, code: "request-attachment-unavailable" } }))] };
}
export class WorkspacePersistence {
  private snapshots = new Map<string, StoredWorkspace>();
  private projects = new Map<string, Project>();
  private paths = new Map<string, Map<string, string>>();
  private sdlPaths = new Map<string, Map<string, string>>();
  private developmentRewrites = new Map<string, Set<string>>();
  private formats = new Map<string, ProjectFormatVersion>();
  private protectedStates = new Map<string, ProtectedState>();
  private storageState: ProtectedState = { status: "available" };
  private activeId = "";
  private globalSnapshot = "";
  private globalState: ProtectedState = { status: "available" };
  private globalPublicWritable = true;
  getGlobalPublicWritable() { return this.globalPublicWritable; }
  private storageNotice: { legacyDirectory: string } | null = null;
  getStorageNotice() { return this.storageNotice; }
  getGlobalProtectedState() { return this.globalState; }
  private globalVariables: Variable[] = [];
  private deleted = new Set<string>();
  private externalGenerations = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  readonly secure: CachedSecureStore;
  readonly history: RequestHistory | null;
  constructor(readonly backend: PersistencePort, secure: SecureStore) {
    this.secure = new CachedSecureStore(secure);
    this.history = backend.history ? new RequestHistory(backend.history, this.secure, (work) => {
      const next = this.queue.catch(() => {}).then(work); this.queue = next; return next;
    }) : null;
  }
  private attachmentLoader(id: string) {
    return this.backend.readAttachment
      ? (attachmentId: string) => this.backend.readAttachment!(id, attachmentId)
      : undefined;
  }
  getWorkspaceStatus(id: string) {
    const sourceVersion = this.formats.get(id) ?? 2;
    const protectedState = this.protectedStates.get(id) ?? this.storageState;
    const snapshot = this.snapshots.get(id);
    const gitRecovery = Boolean(snapshot?.local.some((record) => record.table === "workspace_local_state" && record.id === "git-operation" && record.value));
    const publicWritable = !gitRecovery && (protectedState.status === "available" || protectedState.status !== "recovery-required" && !("code" in protectedState && ["local-record-unreadable", "local-history-unreadable"].includes(protectedState.code)) && snapshot?.unavailableLocal !== undefined && !snapshot.unavailableLocal.some((row) => row.id === "*"));
    return { gitRecovery, sourceVersion, migrationRequired: sourceVersion === 1, protectedState, publicWritable, runtimeProtectedState: snapshot?.runtimeProtectedState ?? protectedState, unavailableLocal: snapshot?.unavailableLocal ?? [], unavailableDocumentIds: snapshot?.unavailableLocal?.filter((row) => ["drafts", "document_session_state", "schema_cache"].includes(row.table)).map((row) => row.id) ?? [] };
  }
  getProject(id: string) { return this.projects.get(id); }
  fileOwner(id: string, path: string): { id: string; name: string } | undefined {
    const project = this.projects.get(id);
    if (path === "purr.yaml") return project?.workspace;
    const resourceId = [...this.paths.get(id)?.entries() ?? [], ...this.sdlPaths.get(id)?.entries() ?? []].find(([, value]) => value === path)?.[0];
    return project?.resources.find((resource) => resource.id === resourceId);
  }
  /** Native transfer publishes through the same save/history queue. Secret
   * buffers are invalidated even when transport loses the commit response. */
  runSecretTransfer<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(async () => {
      try { return await work(); }
      finally { this.secure.clear(); }
    });
    this.queue = next;
    return next;
  }
  /** Index mutations share the save queue but do not change canonical files. */
  runGitIndex<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(work); this.queue = next; return next;
  }
  runGit<T>(id: string, current: () => Workspace | undefined, onReload: (workspace: Workspace) => void, work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(async () => {
      try { return await work(); }
      finally { const refreshed = await this.reconcileWorkspace(id, ["*"], current()); if (refreshed) onReload(refreshed); }
    });
    this.queue = next; return next;
  }
  private assertWritable(id: string) {
    const state = this.getWorkspaceStatus(id).protectedState;
    if (this.getWorkspaceStatus(id).gitRecovery) throw new Error("Finish or abort the pending Git operation before saving this workspace.");
    if (!this.getWorkspaceStatus(id).publicWritable) throw new Error(`Storage ${state.status}. This workspace is read-only; retry before saving.`);
  }
  private async commitConfirmed<T>(batch: SecretBatch, work: () => Promise<T>, readCommitted: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (isCommitRejected(error)) throw commitRejection(error);
      let status;
      try { status = await this.secure.operationStatus(batch.operationId); }
      catch { throw new RecoveryRequiredError(batch.operationId); }
      if (status.status === "committed") return readCommitted();
      if (status.status === "recovery-required") throw new RecoveryRequiredError(batch.operationId);
      throw error;
    } finally { this.secure.clear(); }
  }
  private readProject(snapshot: StoredWorkspace, index = true): Project {
    if (!snapshot.files["purr.yaml"]) throw new Error("Workspace manifest is missing. Existing local data has not been changed.");
    const manifest = deserializeManifestFile(snapshot.files["purr.yaml"].content); const workspace = manifest.value;
    if (workspace.id !== snapshot.id) throw new Error("Workspace manifest identifier does not match its registered directory.");
    const paths = new Map<string, string>(); const sdlPaths = new Map<string, string>(); const developmentRewrites = new Set<string>();
    if (manifest.developmentRewrite) developmentRewrites.add("purr.yaml");
    const resources = Object.entries(snapshot.files).filter(([path]) => path !== "purr.yaml" && path.endsWith(".yaml")).map(([path, file]) => {
      const decoded = deserializeResourceFile(file.content, (sdl) => { const value = snapshot.files[sdl]; if (!value) throw new Error(); return value.content; });
      if (decoded.sourceVersion !== manifest.sourceVersion) throw new Error("Workspace contains mixed Purr format versions. Files are preserved; resolve the incomplete format change before saving.");
      const resource = decoded.value; if (decoded.developmentRewrite) developmentRewrites.add(path);
      if (manifest.sourceVersion === 1 && snapshot.protectedState?.status !== "locked" && (resource.kind === "http" || resource.kind === "graphql")
        && !snapshot.local.some((record) => record.table === "drafts" && record.id === resource.id)) {
        const session = snapshot.local.find((record) => record.table === "document_session_state" && record.id === resource.id)?.value as { editor?: { headers?: Array<{ id?: string; name: string; value?: unknown; enabled: boolean; secret?: boolean; readOnly?: boolean }> }; definition?: string; legacySourceRevision?: string } | undefined;
        let matches = session?.legacySourceRevision === file.revision;
        if (!matches && session?.definition) try { matches = serializeResource(deserializeResourceFile(session.definition).value, undefined, 1) === serializeResource(resource, undefined, 1); } catch { /* An unverified editor cannot classify canonical data. */ }
        const rows = session?.editor?.headers?.filter((row) => !row.readOnly && Boolean(row.name || row.value));
        if (matches && rows && rows.length === resource.headers.length && rows.every((row, index) => row.name === resource.headers[index].name && row.enabled === resource.headers[index].enabled)
          && rows.every((row) => entityId.safeParse(row.id).success) && new Set(rows.map((row) => row.id)).size === rows.length) {
          resource.headers = resource.headers.map((header, index) => ({ ...header, id: rows[index].id!, sensitive: header.sensitive || rows[index].secret === true }));
        }
      }
      paths.set(resource.id, path); return resource;
    });
    // documents/ is the hierarchy's source of truth. Folder marker files keep
    // stable IDs/metadata, while ordinary directories created outside Purr are
    // promoted to first-class folders on the next save.
    const folders = new Map(resources.filter((resource) => resource.kind === "folder").map((resource) => [resource.id, resource]));
    const directoryFolders = new Map<string, string>();
    const usedIds = new Set(resources.map((resource) => resource.id));
    for (const resource of folders.values()) {
      const path = paths.get(resource.id) ?? "";
      if (path.startsWith("documents/") && fileName(path) === folderMarker)
        directoryFolders.set(pathAfter(parentPath(path), "documents/"), resource.id);
    }
    const ensureDirectory = (directory: string): string | undefined => {
      if (!directory) return undefined;
      let parentId: string | undefined;
      let current = "";
      for (const part of directory.split("/").filter(Boolean)) {
        current = current ? `${current}/${part}` : part;
        let id = directoryFolders.get(current);
        if (!id) {
          id = generatedFolderId(current, usedIds);
          const folder: Extract<ProjectResource, { kind: "folder" }> = { id, name: part, kind: "folder", ...(parentId ? { folderId: parentId } : {}) };
          resources.push(folder); folders.set(id, folder); directoryFolders.set(current, id);
        } else {
          const folder = folders.get(id)!;
          const index = resources.findIndex((resource) => resource.id === id);
          const normalized = { ...folder, name: part, ...(parentId ? { folderId: parentId } : { folderId: undefined }) };
          folders.set(id, normalized); resources[index] = normalized;
        }
        parentId = id;
      }
      return parentId;
    };
    const legacyFolderDirectory = (id: string): string => {
      const folder = folders.get(id); if (!folder) return "";
      const existing = [...directoryFolders.entries()].find(([, folderId]) => folderId === id)?.[0];
      if (existing !== undefined) return existing;
      const parent = folder.folderId ? legacyFolderDirectory(folder.folderId) : "";
      const directory = parent ? `${parent}/${folderDirectoryName(folder.name)}` : folderDirectoryName(folder.name);
      directoryFolders.set(directory, id); return directory;
    };
    for (const folder of folders.values()) legacyFolderDirectory(folder.id);
    for (let index = 0; index < resources.length; index += 1) {
      const resource = resources[index];
      if (resource.kind !== "http" && resource.kind !== "graphql" && resource.kind !== "extension") continue;
      const path = paths.get(resource.id) ?? "";
      const inDocuments = pathAfter(path, "documents/");
      const inLegacyRequests = pathAfter(path, "requests/");
      const inLegacyGraphql = pathAfter(path, "graphql/");
      const relative = inDocuments || inLegacyRequests || inLegacyGraphql;
      const directory = parentPath(relative);
      // The legacy graphql/ root used to be a UI grouping, not a folder.
      const folderId = directory ? ensureDirectory(directory) : undefined;
      if ((resource.folderId ?? undefined) !== folderId)
        resources[index] = { ...resource, ...(folderId ? { folderId } : { folderId: undefined }) };
    }
    for (const resource of resources) if (resource.kind === "schema" || resource.kind === "api-schema") {
      const pinned = pinnedSchemaPath(snapshot.files[paths.get(resource.id)!].content); if (pinned) sdlPaths.set(resource.id, pinned);
    }
    const project = validateProject({ workspace, resources });
    if (index) {
      this.paths.set(snapshot.id, paths); this.sdlPaths.set(snapshot.id, sdlPaths);
      this.formats.set(snapshot.id, manifest.sourceVersion);
      if (developmentRewrites.size) this.developmentRewrites.set(snapshot.id, developmentRewrites); else this.developmentRewrites.delete(snapshot.id);
    } return project;
  }
  async load(): Promise<WorkspaceStore> {
    this.externalGenerations.clear();
    this.secure.clear();
    const stored = await this.backend.load(); const workspaces: Workspace[] = [];
    this.storageState = stored.protectedState ?? { status: "available" };
    this.globalState = stored.globalProtectedState ?? this.storageState;
    this.globalPublicWritable = this.globalState.status === "available" || this.globalState.status !== "recovery-required" && stored.globalUnavailableLocal !== undefined && !stored.globalUnavailableLocal.some((row) => row.id === "*" || row.table === "workspace_local_state" && row.id === "variables");
    this.storageNotice = stored.storageNotice ?? null;
    for (const originalSnapshot of stored.workspaces) {
      // Retention runs before restoring last responses, so an expired body does
      // not return through the workspace session after a restart.
      let protectedState = originalSnapshot.protectedState ?? this.storageState;
      let snapshot = isolateUnavailableAttachments(originalSnapshot);
      if (protectedState.status === "available" && !originalSnapshot.unavailableLocal?.length && this.backend.history) {
        try { await this.backend.history.prune(originalSnapshot.id); snapshot = isolateUnavailableAttachments({ ...originalSnapshot, local: await this.backend.readLocal(originalSnapshot.id) }); }
        catch { protectedState = { status: "corrupt", code: "local-history-unreadable" }; }
      }
      this.protectedStates.set(snapshot.id, protectedState);
      if (!snapshot.files["purr.yaml"] && !Object.keys(snapshot.files).length && !snapshot.local.length) continue;
      let project: Project;
      try { project = this.readProject({ ...snapshot, ...(protectedState.status !== "available" ? { local: [] } : {}) }); }
      catch {
        // One malformed/future workspace must not hide the rest of the catalogue.
        protectedState = { status: "recovery-required", code: "project-format-unreadable" }; this.protectedStates.set(snapshot.id, protectedState);
        const workspace = createWorkspace("Workspace needs recovery", snapshot.id); workspace.documents = []; workspace.protectedState = protectedState;
        this.snapshots.set(snapshot.id, snapshot); workspaces.push(workspace); continue;
      }
      const local = protectedState.status === "available" || snapshot.unavailableLocal !== undefined ? snapshot.local : [];
      let workspace: Workspace;
      try {
        const pending = local.find((record) => record.table === "workspace_local_state" && record.id === "legacy-definition-draft")?.value as { sourceRevisions?: Record<string, string> } | undefined;
        if (pending?.sourceRevisions) assertLegacyBaseline(snapshot, pending.sourceRevisions);
        workspace = await restoreWorkspace(project, migrateWorkspaceAuthRuntime(local, snapshot.id), this.secure, Object.fromEntries(Object.entries(snapshot.files).map(([path, file]) => [path, file.content])), this.attachmentLoader(snapshot.id), { hydrateSecrets: false, sourceVersion: this.formats.get(snapshot.id) });
      } catch (error) {
        protectedState = error instanceof LegacyDefinitionConflict ? { status: "recovery-required", code: "legacy-definition-conflict" } : { status: "corrupt", code: "local-record-unreadable" }; this.protectedStates.set(snapshot.id, protectedState);
        workspace = await restoreWorkspace(project, [], this.secure, Object.fromEntries(Object.entries(snapshot.files).map(([path, file]) => [path, file.content])), this.attachmentLoader(snapshot.id), { hydrateSecrets: false, sourceVersion: this.formats.get(snapshot.id) });
      }
      workspace.projectFormatVersion = this.formats.get(snapshot.id); workspace.protectedState = protectedState;
      workspace.publicWritable = protectedState.status === "available" || snapshot.unavailableLocal !== undefined && !snapshot.unavailableLocal.some((row) => row.id === "*") && protectedState.status !== "recovery-required" && !("code" in protectedState && ["local-record-unreadable", "local-history-unreadable"].includes(protectedState.code));
      this.snapshots.set(snapshot.id, snapshot); this.projects.set(snapshot.id, project); workspaces.push(workspace);
    }
    const legacy = stored.legacy as WorkspaceStore | undefined;
    if (legacy != null && !Array.isArray(legacy.workspaces)) throw new Error("Unsupported or damaged workspace index. The original data has not been changed.");
    for (const raw of legacy?.workspaces ?? []) {
      const workspace = validateWorkspace(decodeFiles(raw));
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(raw)));
      const legacySource = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (!workspaces.some((item) => item.id === workspace.id)) { await this.persist(workspace, legacySource); workspaces.push(workspace); }
      else if (this.snapshots.get(workspace.id)?.local.find((record) => record.table === "workspace_local_state" && ["legacy-source", "git-operation", "directory-relocation"].includes(record.id))?.value !== legacySource)
        throw new Error("Legacy data changed after migration started. Both versions are preserved; resolve the legacy change before continuing.");
    }
    if (!workspaces.length) workspaces.push(createWorkspace("Personal", "personal"));
    const candidate = stored.activeWorkspaceId || legacy?.activeWorkspaceId;
    const activeWorkspaceId = workspaces.some((item) => item.id === candidate) ? candidate! : workspaces[0].id;
    this.activeId = stored.activeWorkspaceId;
    const globalRecord = stored.global?.find((record) => record.table === "workspace_local_state" && record.id === "variables");
    let globalVariables: Variable[] = [];
    if (this.globalState.status === "available" || stored.globalUnavailableLocal !== undefined) try { globalVariables = await restoreGlobalVariables(globalRecord?.value, this.secure, false); }
    catch { this.globalState = { status: "corrupt", code: "global-variables-unreadable" }; this.globalPublicWritable = false; }
    this.globalVariables = globalVariables;
    this.globalSnapshot = JSON.stringify(globalRecord?.value ?? []);
    if (this.storageState.status === "available" || stored.workspaces.some((workspace) => workspace.unavailableLocal !== undefined)) { await this.save({ activeWorkspaceId, workspaces, globalVariables }); await this.backend.finishMigration(); }
    return { activeWorkspaceId, workspaces, globalVariables };
  }
  save(store: WorkspaceStore): Promise<void> {
    const work = async () => {
      for (const workspace of store.workspaces) if (this.getWorkspaceStatus(workspace.id).publicWritable) await this.persist(workspace);
      if (this.globalPublicWritable) {
        const preparedGlobal = new SecretPreparationStore(this.secure);
        await this.prepareVariableRemoval(this.globalVariables, store.globalVariables ?? [], preparedGlobal);
        const { definitions, secrets } = await projectGlobalVariables(store.globalVariables ?? [], preparedGlobal);
        const serialized = JSON.stringify(definitions);
        if (serialized !== this.globalSnapshot || secrets.mutations.length) {
          await this.commitConfirmed(secrets, () => this.backend.writeGlobal([{ table: "workspace_local_state", id: "variables", value: definitions, protection: "plaintext" }], secrets), async () => undefined);
          this.globalSnapshot = serialized;
        }
        preparedGlobal.acknowledge();
        this.globalVariables = store.globalVariables ?? [];
      }
      if (this.activeId !== store.activeWorkspaceId && !this.deleted.has(store.activeWorkspaceId)) {
        try { await this.backend.setActiveWorkspace(store.activeWorkspaceId); this.activeId = store.activeWorkspaceId; }
        catch { /* Selection is retried independently of committed project data. */ }
      }
    };
    const next = this.queue.catch(() => {}).then(work); this.queue = next; return next;
  }
  async deleteWorkspace(id: string): Promise<WorkspaceDeletionResult> {
    this.deleted.add(id);
    const remove = async () => {
      const result = await this.backend.deleteWorkspace(id);
      this.secure.clear();
      this.snapshots.delete(id); this.projects.delete(id); this.paths.delete(id); this.sdlPaths.delete(id);
      this.developmentRewrites.delete(id);
      if (this.activeId === id) this.activeId = "";
      return result ?? { committed: true as const, cleanupPending: false };
    };
    const next = this.queue.catch(() => {}).then(remove); this.queue = next;
    try { return await next; } catch (cause) { this.deleted.delete(id); throw cause; }
  }
  saveWorkspace(workspace: Workspace, prepared?: SecretPreparationStore, options: { intent: "automatic" | "explicit" } = { intent: "explicit" }): Promise<Workspace> {
    const attempt = prepared?.fork() ?? new SecretPreparationStore(this.secure);
    const next = this.queue.catch(() => {}).then(async () => {
      this.assertWritable(workspace.id);
      await this.persist(workspace, undefined, attempt, options.intent);
      return { ...workspace, projectFormatVersion: this.formats.get(workspace.id) ?? 2, protectedState: this.getWorkspaceStatus(workspace.id).protectedState, publicWritable: this.getWorkspaceStatus(workspace.id).publicWritable };
    });
    this.queue = next;
    return next;
  }
  upgradeWorkspace(workspace: Workspace): Promise<Workspace> { return this.saveWorkspace(workspace, undefined, { intent: "explicit" }); }
  async retryProtectedStorage(): Promise<WorkspaceStore> {
    await this.queue.catch(() => {});
    await this.backend.retryProtectedStorage?.();
    this.secure.clear(); this.snapshots.clear(); this.projects.clear(); this.paths.clear(); this.sdlPaths.clear(); this.formats.clear(); this.protectedStates.clear(); this.developmentRewrites.clear();
    return this.load();
  }
  getGlobalVariables() { return this.globalVariables; }
  setSecretValue(workspace: Workspace, ref: string, value: string | null): Promise<Workspace> {
    const next = this.queue.catch(() => {}).then(async () => {
      this.assertWritable(workspace.id);
      if (ref.startsWith("purr/global/") && this.globalState.status !== "available") throw new Error("Global protected storage is unavailable. Retry before editing global secrets.");
      if (!ref.startsWith(`purr/${workspace.id}/`) && !ref.startsWith("purr/global/")) throw new Error("Credential does not belong to this workspace.");
      const prepared = new SecretPreparationStore(this.secure);
      if (value === null) await prepared.delete(ref); else await prepared.set(ref, value);
      const batch = await prepared.batch();
      if (batch.mutations.length) await this.commitConfirmed(batch,
        async () => { if (ref.startsWith("purr/global/")) await this.backend.writeGlobal([], batch); else await this.backend.commit(workspace.id, [], [], batch); }, async () => undefined);
      this.globalVariables = invalidateSecretBuffers(this.globalVariables, ref);
      return invalidateSecretBuffers(workspace, ref);
    });
    this.queue = next; return next;
  }
  private async prepareVariableRemoval(before: readonly Variable[], after: readonly Variable[], secure: SecretPreparationStore) {
    const retained = new Set(after.flatMap((variable) => variable.kind === "static" && variable.sensitive && variable.secretRef ? [variable.secretRef] : []));
    for (const variable of before) if (variable.kind === "static" && variable.sensitive && variable.secretRef && !retained.has(variable.secretRef)
      && !after.some((candidate) => candidate.id === variable.id && candidate.kind === "static" && candidate.sensitive)) await secure.delete(variable.secretRef);
  }
  private async persist(workspace: Workspace, legacySource?: string, prepared = new SecretPreparationStore(this.secure), intent: "automatic" | "explicit" = "automatic") {
    const generation = this.externalGenerations.get(workspace.id);
    if (generation && workspace.externalRevision !== generation) throw new Error("The workspace changed externally while this save was queued. Reload before saving; incoming files and local edits are preserved.");
    const attachments = this.backend.attachments ? new AttachmentPreparation(workspace.id, this.backend.attachments,
      new Set(this.snapshots.get(workspace.id)?.local.filter((row) => row.table === "attachments").map((row) => row.id))) : undefined;
    try { await this.persistPrepared(workspace, legacySource, prepared, intent, attachments); attachments?.acknowledge(); }
    finally { await attachments?.dispose(); }
  }
  private async persistPrepared(workspace: Workspace, legacySource: string | undefined, prepared: SecretPreparationStore, intent: "automatic" | "explicit", attachments?: AttachmentPreparation) {
    if (this.deleted.has(workspace.id)) return;
    this.assertWritable(workspace.id);
    const unavailableDocuments = new Set(this.getWorkspaceStatus(workspace.id).unavailableDocumentIds);
    if (workspace.documents.some((document) => unavailableDocuments.has(document.id) && isDocumentDirty(document))) throw new Error("This document has unavailable local state. Retry / Unlock before editing it; other documents remain usable.");
    const previous = this.projects.get(workspace.id);
    const upgrading = this.formats.get(workspace.id) === 1;
    if (upgrading && intent === "automatic" && previous) {
      const snapshot = this.snapshots.get(workspace.id)!;
      const legacyRevisions = Object.fromEntries([...this.paths.get(workspace.id) ?? []].map(([id, path]) => [id, snapshot.files[path].revision]));
      const projection = await projectWorkspace(workspace, prepared, { attachments, includeExecutions: !this.backend.history, localOnlyBaseline: previous, sourceVersion: 1, legacyRevisions,
        sourceRevisions: Object.fromEntries(Object.entries(snapshot.files).map(([path, file]) => [path, file.revision])) });
      const local = projection.local.filter((record) => !this.backend.history || record.table !== "request_executions");
      const retained = new Map(snapshot.local.filter((record) => record.table === "request_executions" || record.table === "workspace_local_state" && ["legacy-source", "git-operation", "directory-relocation"].includes(record.id)).map((record) => [key(record), record]));
      for (const record of local) retained.set(key(record), record);
      if (this.history?.hasPendingExecutions(workspace.id)) for (const record of snapshot.local) if (record.table === "attachments" && !retained.has(key(record))) retained.set(key(record), record);
      const old = new Map(snapshot.local.map((record) => [key(record), record]));
      const changes: LocalChange[] = [];
      for (const id of new Set([...old.keys(), ...retained.keys()])) {
        if (this.backend.history && id.startsWith("request_executions/")) continue;
        const before = old.get(id), after = retained.get(id);
        if (JSON.stringify(before) !== JSON.stringify(after)) changes.push(after ?? { ...before!, value: null });
      }
      const secrets = await prepared.batch();
      if (changes.length || secrets.mutations.length) await this.commitConfirmed(secrets, () => this.backend.commit(workspace.id, [], changes, secrets), async () => undefined);
      this.snapshots.set(workspace.id, { ...snapshot, local: [...retained.values()] }); prepared.acknowledge();
      return;
    }
    const cleanDocuments = new Set(workspace.documents.filter((document) => isRequestDocument(document) && document.saved && !isDocumentDirty(document)).map((document) => document.id));
    const previousVariables = [...(previous?.workspace.variables ?? []), ...(previous?.resources.flatMap((resource) => resource.kind === "environment" ? resource.variables : []) ?? [])];
    const currentVariables = [...workspace.variables, ...workspace.environments.flatMap((environment) => environment.variables)];
    const retainedRefs = new Set(currentVariables.flatMap((variable) => variable.kind === "static" && variable.sensitive && variable.secretRef ? [variable.secretRef] : []));
    for (const variable of previousVariables) if (variable.kind === "static" && variable.sensitive && variable.secretRef && !retainedRefs.has(variable.secretRef)
      && !currentVariables.some((candidate) => candidate.id === variable.id && candidate.kind === "static" && candidate.sensitive)) await prepared.delete(variable.secretRef);
    const { project, local: projectedLocal, assets } = await projectWorkspace(workspace, prepared, { attachments, includeExecutions: !this.backend.history || Boolean(legacySource), globalVariables: this.globalVariables }); validateProject(project);
    const refs = (value: unknown, found = new Set<string>()): Set<string> => {
      if (Array.isArray(value)) for (const child of value) refs(child, found);
      else if (value && typeof value === "object") {
        const object = value as Record<string, unknown>;
        if (object.kind === "secret" && typeof object.ref === "string") found.add(object.ref);
        for (const child of Object.values(object)) refs(child, found);
      }
      return found;
    };
    const nextCacheRefs = refs(projectedLocal);
    for (const ref of refs(this.snapshots.get(workspace.id)?.local)) {
      if (ref.startsWith(`purr/${workspace.id}/runtime/dynamic-variables/`) && !nextCacheRefs.has(ref)) await prepared.delete(ref);
    }
    const secrets = await prepared.batch();
    const local = this.backend.history ? projectedLocal.filter((record) => record.table !== "request_executions") : projectedLocal;
    if (legacySource) {
      // Preserve executions from the one-time monolithic workspace migration.
      // No historical editor snapshot existed in that storage format.
      if (this.backend.history) for (const record of projectedLocal) if (record.table === "request_executions") {
        const entry = legacyHistoryEntry(record.id, record.value);
        if (entry) await this.backend.history.append(workspace.id, entry);
      }
      local.push({ table: "workspace_local_state", id: "legacy-source", value: legacySource });
    }
    const snapshot = this.snapshots.get(workspace.id) ?? { id: workspace.id, files: {}, local: [] };
    const previousProject = this.projects.get(workspace.id); const paths = new Map(this.paths.get(workspace.id) ?? []);
    const sdlPaths = this.sdlPaths.get(workspace.id) ?? new Map<string, string>();
    const developmentRewrites = this.developmentRewrites.get(workspace.id) ?? new Set<string>();
    const desired: Record<string, string> = { "purr.yaml": serializeManifest(project.workspace), ...assets };
    // Unreferenced sidecar files belong to the directory owner, not to Purr's
    // deletion set. Managed SDL is removed only on explicit unpin/delete.
    for (const [path, file] of Object.entries(snapshot.files)) if (!path.endsWith(".yaml")
      && !previousProject?.resources.some((item) => (item.kind === "schema" && item.pinnedSdl !== undefined || item.kind === "api-schema")
        && path === (sdlPaths.get(item.id) ?? (item.kind === "schema" ? `schemas/${item.id}.graphql` : `schemas/${item.id}.openapi`)))) desired[path] ??= file.content;
    const folders = new Map(project.resources.filter((resource): resource is Extract<ProjectResource, { kind: "folder" }> => resource.kind === "folder").map((resource) => [resource.id, resource]));
    const folderDirectories = new Map<string, string>();
    const documentDirectory = (folderId?: string): string => {
      if (!folderId) return "documents";
      const cached = folderDirectories.get(folderId); if (cached) return cached;
      const folder = folders.get(folderId); if (!folder) return "documents";
      const directory = `${documentDirectory(folder.folderId)}/${folderDirectoryName(folder.name)}`;
      folderDirectories.set(folderId, directory); return directory;
    };
    for (const resource of project.resources) {
      const existingPath = paths.get(resource.id);
      // Keep user-organized paths stable, except for legacy request roots. A
      // move preserves nested names (requests/users/a.yaml ->
      // documents/users/a.yaml) and lets the normal change-set delete the old
      // file only after its replacement is written.
      const path = resource.kind === "folder"
        ? `${documentDirectory(resource.id)}/${folderMarker}`
        : resource.kind === "http" || resource.kind === "graphql" || resource.kind === "extension"
          ? `${documentDirectory(resource.folderId)}/${existingPath?.startsWith("documents/") || existingPath?.startsWith("requests/") || existingPath?.startsWith("graphql/")
            ? fileName(existingPath) : `${slug(resource.name)}-${resource.id}.yaml`}`
          : existingPath ?? `${resourceDirectory(resource)}/${slug(resource.name)}-${resource.id}.yaml`;
      paths.set(resource.id, path);
      const sdlPath = sdlPaths.get(resource.id) ?? (resource.kind === "api-schema" ? `schemas/${resource.id}.openapi` : `schemas/${resource.id}.graphql`); desired[path] = serializeResource(resource, sdlPath);
      if (resource.kind === "schema" && resource.pinnedSdl !== undefined) desired[sdlPath] = resource.pinnedSdl;
      if (resource.kind === "api-schema") desired[sdlPath] = resource.document;
      const previous = previousProject?.resources.find((item) => item.id === resource.id);
      if (!upgrading && previous && serializeResource(previous, sdlPath) === desired[path] && snapshot.files[path] && !developmentRewrites.has(path)) desired[path] = snapshot.files[path].content;
    }
    if (!upgrading && previousProject && serializeManifest(previousProject.workspace) === desired["purr.yaml"] && snapshot.files["purr.yaml"] && !developmentRewrites.has("purr.yaml")) desired["purr.yaml"] = snapshot.files["purr.yaml"].content;
    const changes: FileChange[] = [];
    for (const path of new Set([...Object.keys(snapshot.files), ...Object.keys(desired)])) {
      const content = desired[path] ?? null;
      if ((snapshot.files[path]?.content ?? null) !== content) changes.push({ path, content, expectedRevision: snapshot.files[path]?.revision ?? null });
    }
    if (changes.some((change) => [...unavailableDocuments].some((id) => change.path === paths.get(id)))) throw new Error("This document has unavailable local state. Retry / Unlock before saving it.");
    const oldLocal = new Map(snapshot.local.map((record) => [key(record), record])); const nextLocal = new Map(local.map((record) => [key(record), record]));
    for (const record of snapshot.local) if ((record.table === "request_executions" || record.table === "workspace_local_state" && ["legacy-source", "git-operation", "directory-relocation"].includes(record.id)) && !nextLocal.has(key(record))) nextLocal.set(key(record), record);
    // An in-flight request can outlive its source document. Its lazy native
    // upload files must survive until the completed history entry adopts them.
    if (this.history?.hasPendingExecutions(workspace.id)) for (const record of snapshot.local)
      if (record.table === "attachments" && !nextLocal.has(key(record))) nextLocal.set(key(record), record);
    const localChanges: LocalChange[] = [];
    const unavailable = new Set(snapshot.unavailableLocal?.map(key));
    for (const id of new Set([...oldLocal.keys(), ...nextLocal.keys()])) {
      if (unavailable.has(id)) { nextLocal.delete(id); continue; }
      // Execution writes/deletes belong exclusively to the append-only history
      // service. A stale lastResponse must never resurrect an expired entry.
      if (this.backend.history && id.startsWith("request_executions/")) continue;
      const next = nextLocal.get(id); const previous = oldLocal.get(id);
      if (next?.table === "attachments" || previous?.table === "attachments") {
        if (!next || !previous) localChanges.push(next ?? { ...previous!, value: null });
      } else if (JSON.stringify(next) !== JSON.stringify(previous)) localChanges.push(next ?? { ...previous!, value: null });
    }
    if (changes.length || localChanges.length || secrets.mutations.length) {
      const files = await this.commitConfirmed(secrets,
        () => this.backend.commit(workspace.id, changes, localChanges, secrets),
        async () => (await this.backend.loadWorkspace(workspace.id)).files);
      this.snapshots.set(workspace.id, { ...snapshot, id: workspace.id, files, local: [...nextLocal.values()] });
    }
    this.developmentRewrites.delete(workspace.id);
    this.projects.set(workspace.id, project); this.paths.set(workspace.id, paths);
    this.formats.set(workspace.id, 2); prepared.acknowledge();
    for (const document of workspace.documents) if (isRequestDocument(document) && document.savedRequest && cleanDocuments.has(document.id)) {
      // Consume the committed credential intent on both clean editor buffers.
      // Inactive auth modes remain local and retain their independent refs.
      const saved = document.savedRequest.auth;
      const slot = { bearer: "bearer", basic: "password", "api-key": "api-key", oauth2: "client-secret", inherit: null, none: null }[saved.type];
      if (slot) {
        const savedState = saved.credentialStates?.[slot];
        const editorState = document.request.auth.credentialStates?.[slot];
        // Lazy saved definitions carry an unresolved buffer. They cannot undo
        // hydration (or a typed failure) already obtained for the same ref.
        const synchronizedState = savedState?.status === "unresolved" && savedState.ref === editorState?.ref
          ? editorState : savedState;
        document.request.auth.secretRefs = { ...document.request.auth.secretRefs, ...(saved.secretRefs?.[slot] ? { [slot]: saved.secretRefs[slot] } : {}) };
        document.request.auth.credentialStates = { ...document.request.auth.credentialStates, ...(synchronizedState ? { [slot]: synchronizedState } : {}) };
        if (!savedState) { delete document.request.auth.credentialStates[slot]; delete document.request.auth.secretRefs[slot]; }
      }
      for (const header of document.request.headers) {
        const savedHeader = document.savedRequest.headers.find((row) => row.id === header.id);
        if (savedHeader) {
          if (!(savedHeader.secretState?.status === "unresolved" && savedHeader.secretState.ref === header.secretState?.ref))
            header.secretState = savedHeader.secretState;
          header.secretRef = savedHeader.secretRef;
        }
      }
    }
  }
  private async reconcileWorkspace(id: string, paths: string[], working?: Workspace): Promise<Workspace | null> {
    const previous = this.snapshots.get(id); if (!previous) return null;
    const scanned = paths.includes("*") ? await this.backend.loadWorkspace(id) : undefined;
    const files = { ...previous.files }; let changed = false;
    if (scanned) paths = [...new Set([...Object.keys(previous.files), ...Object.keys(scanned.files)])];
    for (const path of new Set(paths)) {
      if (!/\.(yaml|graphql|openapi|bin)$/.test(path)) continue;
      const file = scanned ? scanned.files[path] : await this.backend.reloadResource(id, path); if (file?.revision === files[path]?.revision) continue;
      changed = true; if (file) files[path] = file; else delete files[path];
    }
    const gitPending = (snapshot: StoredWorkspace) => snapshot.local.some((record) => record.table === "workspace_local_state" && record.id === "git-operation" && record.value);
    const recoveryChanged = Boolean(scanned && Boolean(gitPending(scanned)) !== Boolean(gitPending(previous)));
    const protectedChanged = scanned && JSON.stringify(scanned.protectedState) !== JSON.stringify(previous.protectedState);
    if (!changed && !protectedChanged && !recoveryChanged) return null;
    const snapshot = { ...previous, ...(scanned ? { protectedState: scanned.protectedState, local: scanned.local } : {}), files };
    if (gitPending(snapshot)) {
      // Git recovery keeps a valid canonical baseline and local editors. It does
      // not change the credential vault's availability.
      this.snapshots.set(id, { ...snapshot, files: previous.files });
      if (working) return { ...working, publicWritable: false };
    }
    if (recoveryChanged && !gitPending(snapshot)) this.snapshots.set(id, snapshot);
    let project: Project;
    try { project = this.readProject(snapshot, false); }
    catch (error) { this.protectedStates.set(id, { status: "recovery-required", code: "project-format-unreadable" }); throw error; }
    if (project.workspace.id !== id) { this.protectedStates.set(id, { status: "recovery-required", code: "project-format-unreadable" }); throw new Error("The project identity changed externally. Files and local edits are preserved."); }
    const sourceVersion = deserializeManifestFile(files["purr.yaml"].content).sourceVersion;
    const legacyDraft = previous.local.find((record) => record.table === "workspace_local_state" && record.id === "legacy-definition-draft")?.value as { sourceRevisions?: Record<string, string> } | undefined;
    if (legacyDraft?.sourceRevisions) try { assertLegacyBaseline(snapshot, legacyDraft.sourceRevisions); }
    catch (error) { this.protectedStates.set(id, { status: "recovery-required", code: "legacy-definition-conflict" }); throw error; }
    const state = this.protectedStates.get(id);
    if (state?.status === "recovery-required" && ["project-format-unreadable", "legacy-definition-conflict"].includes(state.code)) this.protectedStates.set(id, { status: "available" });
    const prepared = new SecretPreparationStore(this.secure);
    const transientAttachments = new TransientAttachments();
    const projected = working && this.getWorkspaceStatus(id).protectedState.status === "available" ? await projectWorkspace(working, prepared,
      { transientAttachments, includeExecutions: !this.backend.history, ...(sourceVersion === 1 ? { localOnlyBaseline: this.projects.get(id), sourceVersion } : {}) }) : undefined;
    const local = projected?.local ?? previous.local;
    const baseline = this.projects.get(id);
    const merged: Project = { workspace: project.workspace, resources: [...project.resources] };
    if (baseline && projected) {
      const localManifest = serializeManifest(projected.project.workspace, sourceVersion);
      if (localManifest !== serializeManifest(baseline.workspace, sourceVersion)) {
        if (serializeManifest(project.workspace, sourceVersion) !== serializeManifest(baseline.workspace, sourceVersion) && localManifest !== serializeManifest(project.workspace, sourceVersion)) throw new Error("Concurrent workspace settings edits");
        merged.workspace = projected.project.workspace;
      }
      for (const resourceId of new Set([...baseline.resources, ...projected.project.resources].map((item) => item.id))) {
        const before = baseline.resources.find((item) => item.id === resourceId);
        const localResource = projected.project.resources.find((item) => item.id === resourceId);
        const external = project.resources.find((item) => item.id === resourceId);
        const signature = (value?: ProjectResource) => value ? serializeResource(value, value.kind === "schema" ? `schemas/${value.id}.graphql` : value.kind === "api-schema" ? `schemas/${value.id}.openapi` : undefined, sourceVersion)
          + (value.kind === "schema" ? value.pinnedSdl ?? "" : value.kind === "api-schema" ? value.document : "") : null;
        if (signature(localResource) === signature(before)) continue;
        if (signature(external) !== signature(before) && signature(external) !== signature(localResource)) throw new Error("Concurrent resource edits");
        merged.resources = merged.resources.filter((item) => item.id !== resourceId);
        if (localResource) merged.resources.push(localResource);
      }
      // restoreWorkspace keeps deleted dirty documents as local recovery drafts.
    }
    const workspace = await restoreWorkspace(merged, this.getWorkspaceStatus(id).publicWritable || this.getWorkspaceStatus(id).gitRecovery ? local : [], prepared, Object.fromEntries(Object.entries(files).map(([path, file]) => [path, file.content])), this.attachmentLoader(id), { hydrateSecrets: false, sourceVersion, transientAttachments });
    const changedDocumentIds = working?.documents.filter((document) => {
      const before = baseline?.resources.find((resource) => resource.id === document.id);
      const after = project.resources.find((resource) => resource.id === document.id);
      return JSON.stringify(before) !== JSON.stringify(after);
    }).map((document) => document.id) ?? [];
    workspace.externalRevision = crypto.randomUUID();
    this.externalGenerations.set(id, workspace.externalRevision);
    if (changedDocumentIds.length || JSON.stringify(baseline?.workspace) !== JSON.stringify(project.workspace)) workspace.dynamicVariableCache = {};
    workspace.documents = workspace.documents.map((document) => changedDocumentIds.includes(document.id) && isRequestDocument(document) ? { ...document, lastResponse: null, sentAt: null } : document);
    if (working?.ui.activeDocumentId && !workspace.documents.some((document) => document.id === working.ui.activeDocumentId)) {
      const index = working.ui.openDocumentIds.indexOf(working.ui.activeDocumentId);
      const recovered = workspace.documents.find((document) => workspace.editorConflicts?.[document.id]?.incoming?.id === working.ui.activeDocumentId);
      workspace.ui.activeDocumentId = recovered?.id ?? [...working.ui.openDocumentIds.slice(index + 1), ...working.ui.openDocumentIds.slice(0, index).reverse()].find((documentId) => workspace.ui.openDocumentIds.includes(documentId)) ?? null;
    }
    this.readProject(snapshot); this.snapshots.set(id, snapshot); this.projects.set(id, project);
    workspace.projectFormatVersion = sourceVersion; workspace.protectedState = this.getWorkspaceStatus(id).protectedState; workspace.publicWritable = this.getWorkspaceStatus(id).publicWritable; return workspace;
  }
  reconcileExternalChanges(store: WorkspaceStore): Promise<WorkspaceStore> {
    const reconcile = async () => {
      let result = store;
      for (const working of store.workspaces) {
        const workspace = await this.reconcileWorkspace(working.id, ["*"], working);
        if (workspace) result = { ...result, workspaces: result.workspaces.map((item) => item.id === workspace.id ? workspace : item) };
      }
      return result;
    };
    const next = this.queue.catch(() => {}).then(reconcile); this.queue = next; return next;
  }
  async watchChanges(onReload: (workspace: Workspace) => void, onError: (message: string) => void, current: () => WorkspaceStore | null) {
    return this.backend.watchChanges((id, paths) => {
      const reload = async () => {
        const working = current()?.workspaces.find((workspace) => workspace.id === id);
        const workspace = await this.reconcileWorkspace(id, paths, working);
        if (workspace) onReload(workspace);
      };
      this.queue = this.queue.catch(() => {}).then(reload).catch(() => onError("Project files changed externally but could not be reconciled. Local edits and files are preserved. Fix invalid YAML or conflicting edits, then reload."));
    });
  }
  async saveProject(project: Project, initialize: (workspace: Workspace) => Workspace = (workspace) => workspace,
    importedSecrets: readonly { ref: string; value: string }[] = []): Promise<Workspace> {
    const work = async () => {
      validateProject(project);
      this.assertWritable(project.workspace.id);
      if (this.formats.get(project.workspace.id) === 1) throw new Error("Upgrade this workspace to format v2 before importing additional resources. Existing files and local edits are preserved.");
      const prepared = new SecretPreparationStore(this.secure);
      for (const secret of importedSecrets) {
        if (!secret.ref.startsWith(`purr/${project.workspace.id}/`) || await prepared.exists(secret.ref)) throw new Error("Import credentials must not overwrite existing secrets.");
        await prepared.set(secret.ref, secret.value);
      }
      const snapshot = this.snapshots.get(project.workspace.id);
      this.assertWritable(project.workspace.id);
      const restored = await restoreWorkspace(project, snapshot?.local ?? [], prepared, Object.fromEntries(Object.entries(snapshot?.files ?? {}).map(([path, file]) => [path, file.content])), this.attachmentLoader(project.workspace.id), { hydrateSecrets: false, sourceVersion: this.formats.get(project.workspace.id) ?? 2 });
      const workspace = initialize(restored);
      await this.persist(workspace, undefined, prepared);
      // Selection is a separate local preference. Its failure cannot turn a
      // committed import into a failed import or hide its newly saved workspace.
      if (this.activeId !== workspace.id) {
        try { await this.backend.setActiveWorkspace(workspace.id); this.activeId = workspace.id; }
        catch { /* Leave activeId unchanged so the next autosave retries selection. */ }
      }
      return workspace;
    };
    const next = this.queue.catch(() => {}).then(work); this.queue = next; return next;
  }
  prepareImport(project: Project): Project {
    const existing = this.projects.get(project.workspace.id);
    if (existing && project.resources.some((resource) => existing.resources.some((current) => current.id === resource.id)))
      throw new Error("Imported resource IDs conflict with existing resources. Resolve duplicate IDs in the import preview first.");
    // Import is additive. Existing workspace defaults and unrelated resources
    // cannot be silently replaced by a collection adapter.
    return validateProject(existing ? { workspace: existing.workspace, resources: [...existing.resources, ...project.resources] } : project);
  }
  /** Open portable project files with their original identity, then start local state
   * on this installation. Preflight validation must finish before registration. */
  openDirectory(directory: string): Promise<Workspace> {
    return this.openDirectoryQueued(directory, false).then((workspace) => {
      if (!workspace) throw new Error("The selected folder does not contain a Purr workspace.");
      return workspace;
    });
  }
  /** Detect portable Purr files within the normal import flow. Non-Purr sources
   * continue through the existing collection importers; invalid Purr files fail. */
  tryOpenDirectory(location: string): Promise<Workspace | null> {
    if (!this.backend.inspectDirectory || !this.backend.openDirectory) return Promise.resolve(null);
    return this.openDirectoryQueued(location, true);
  }
  private openDirectoryQueued(directory: string, optional: boolean): Promise<Workspace | null> {
    const work = async () => {
      if (!this.backend.inspectDirectory || !this.backend.openDirectory) throw new Error("Opening workspace folders requires the Purr desktop app.");
      const candidate = await this.backend.inspectDirectory(directory, optional);
      if (!candidate) return null;
      const project = this.readProject(candidate, false);
      const sourceVersion = deserializeManifestFile(candidate.files["purr.yaml"].content).sourceVersion;
      await restoreWorkspace(project, [], this.secure, Object.fromEntries(Object.entries(candidate.files).map(([path, file]) => [path, file.content])), undefined, { hydrateSecrets: false, sourceVersion });
      const expectedRevisions = Object.fromEntries(Object.entries(candidate.files).map(([path, file]) => [path, file.revision]));
      const snapshot = isolateUnavailableAttachments(await this.backend.openDirectory(directory, expectedRevisions));
      this.secure.clear();
      this.deleted.delete(snapshot.id);
      const openedProject = this.readProject(snapshot);
      this.protectedStates.set(snapshot.id, snapshot.protectedState ?? this.storageState);
      this.snapshots.set(snapshot.id, snapshot);
      const workspace = await restoreWorkspace(openedProject, this.getWorkspaceStatus(snapshot.id).publicWritable || this.getWorkspaceStatus(snapshot.id).gitRecovery ? snapshot.local : [], this.secure,
        Object.fromEntries(Object.entries(snapshot.files).map(([path, file]) => [path, file.content])), this.attachmentLoader(snapshot.id), { hydrateSecrets: false, sourceVersion: this.formats.get(snapshot.id) });
      workspace.projectFormatVersion = this.formats.get(snapshot.id);
      workspace.protectedState = this.getWorkspaceStatus(snapshot.id).protectedState;
      workspace.publicWritable = this.getWorkspaceStatus(snapshot.id).publicWritable;
      this.projects.set(snapshot.id, openedProject);
      // Registration is already durable. A failed selection write can retry on autosave.
      try { await this.backend.setActiveWorkspace(snapshot.id); this.activeId = snapshot.id; } catch { /* Retry on next save. */ }
      return workspace;
    };
    const next = this.queue.catch(() => {}).then(work); this.queue = next; return next;
  }

  directoryInfo(id: string) {
    if (!this.backend.directoryInfo) return Promise.reject(new Error("Project directories require the desktop application."));
    return this.backend.directoryInfo(id);
  }
  createWorkspaceAt(workspace: Workspace, directory: string): Promise<Workspace> {
    const work = async () => {
      if (!this.backend.createDirectory) throw new Error("Custom project directories require the desktop application.");
      const prepared = new SecretPreparationStore(this.secure);
      const { project, local } = await projectWorkspace(workspace, prepared, { includeExecutions: false });
      if (project.resources.length) throw new Error("Create an empty workspace before adding saved documents.");
      const snapshot = await this.backend.createDirectory(workspace.id, directory,
        [{ path: "purr.yaml", content: serializeManifest(project.workspace), expectedRevision: null }], local, await prepared.batch());
      prepared.acknowledge(); this.snapshots.set(workspace.id, snapshot); this.projects.set(workspace.id, this.readProject(snapshot));
      this.protectedStates.set(workspace.id, snapshot.protectedState ?? { status: "available" });
      return workspace;
    };
    const next = this.queue.catch(() => {}).then(work); this.queue = next; return next;
  }
  moveDirectory(id: string, directory: string) {
    const work = async () => {
      if (!this.backend.moveDirectory) throw new Error("Moving projects requires the desktop application.");
      return this.backend.moveDirectory(id, directory);
    };
    const next = this.queue.catch(() => {}).then(work); this.queue = next; return next;
  }
  async attachDirectory(id: string, directory: string): Promise<Workspace> {
    if (!this.backend.attachDirectory) throw new Error("Directory workspaces require the desktop application.");
    if (this.snapshots.has(id)) throw new Error("This workspace is already open.");
    this.deleted.delete(id);
    const snapshot = await this.backend.attachDirectory(id, directory);
    const project = this.readProject(snapshot);
    this.protectedStates.set(id, snapshot.protectedState ?? this.storageState);
    const workspace = await restoreWorkspace(project, this.getWorkspaceStatus(id).publicWritable ? snapshot.local : [], this.secure, Object.fromEntries(Object.entries(snapshot.files).map(([path, file]) => [path, file.content])), this.attachmentLoader(id), { hydrateSecrets: false, sourceVersion: this.formats.get(id) });
    workspace.projectFormatVersion = this.formats.get(id); workspace.protectedState = this.getWorkspaceStatus(id).protectedState; workspace.publicWritable = this.getWorkspaceStatus(id).publicWritable;
    this.readProject(snapshot); this.snapshots.set(id, snapshot); this.projects.set(id, project);
    await this.save({ activeWorkspaceId: id, workspaces: [workspace], globalVariables: this.globalVariables }); return workspace;
  }
}
