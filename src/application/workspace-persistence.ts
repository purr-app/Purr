import { validateProject, type Project, type ProjectResource } from "../domain/project";
import { createWorkspace, validateWorkspace, type Workspace, type WorkspaceStore } from "../features/workspaces/model/workspace";
import { decodeFiles } from "../storage/file-codec";
import type { FileChange, LocalChange, LocalRecord, PersistenceBackend, SecureStore, StoredWorkspace } from "../storage/contracts";
import { deserializeManifestFile, deserializeResourceFile, pinnedSchemaPath, serializeManifest, serializeResource } from "../storage/yaml";
import { migrateWorkspaceAuthRuntime, projectGlobalVariables, projectWorkspace, restoreGlobalVariables, restoreWorkspace } from "./project-projection";
import { CachedSecureStore } from "../storage/secrets";
import type { Variable } from "../features/workspaces/model/workspace";

// Requests and request-adjacent documents share one canonical directory. The
// previous requests/ and graphql/ locations remain readable so existing
// workspaces can be migrated safely on their next save.
const resourceDirectory = (resource: ProjectResource) => ({ http: "documents", graphql: "documents", schema: "schemas", environment: "environments", folder: "documents", integration: "integrations" })[resource.kind];
const slug = (name: string) => name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "resource";
const key = (record: LocalRecord | LocalChange) => `${record.table}/${record.id}`;
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
export class WorkspacePersistence {
  private snapshots = new Map<string, StoredWorkspace>();
  private projects = new Map<string, Project>();
  private paths = new Map<string, Map<string, string>>();
  private sdlPaths = new Map<string, Map<string, string>>();
  private developmentRewrites = new Map<string, Set<string>>();
  private activeId = "";
  private globalSnapshot = "";
  private globalVariables: Variable[] = [];
  private deleted = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  readonly secure: CachedSecureStore;
  constructor(readonly backend: PersistenceBackend, secure: SecureStore) { this.secure = new CachedSecureStore(secure); }
  private readProject(snapshot: StoredWorkspace, index = true): Project {
    if (!snapshot.files["purr.yaml"]) throw new Error("Workspace manifest is missing. Existing local data has not been changed.");
    const manifest = deserializeManifestFile(snapshot.files["purr.yaml"].content); const workspace = manifest.value;
    if (workspace.id !== snapshot.id) throw new Error("Workspace manifest identifier does not match its registered directory.");
    const paths = new Map<string, string>(); const sdlPaths = new Map<string, string>(); const developmentRewrites = new Set<string>();
    if (manifest.developmentRewrite) developmentRewrites.add("purr.yaml");
    const resources = Object.entries(snapshot.files).filter(([path]) => path !== "purr.yaml" && path.endsWith(".yaml")).map(([path, file]) => {
      const decoded = deserializeResourceFile(file.content, (sdl) => { const value = snapshot.files[sdl]; if (!value) throw new Error(); return value.content; });
      const resource = decoded.value; if (decoded.developmentRewrite) developmentRewrites.add(path);
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
      if (resource.kind !== "http" && resource.kind !== "graphql") continue;
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
    for (const resource of resources) if (resource.kind === "schema") {
      const pinned = pinnedSchemaPath(snapshot.files[paths.get(resource.id)!].content); if (pinned) sdlPaths.set(resource.id, pinned);
    }
    const project = validateProject({ workspace, resources });
    if (index) {
      this.paths.set(snapshot.id, paths); this.sdlPaths.set(snapshot.id, sdlPaths);
      if (developmentRewrites.size) this.developmentRewrites.set(snapshot.id, developmentRewrites); else this.developmentRewrites.delete(snapshot.id);
    } return project;
  }
  async load(): Promise<WorkspaceStore> {
    this.secure.clear();
    const stored = await this.backend.load(); const workspaces: Workspace[] = [];
    for (const snapshot of stored.workspaces) {
      if (!snapshot.files["purr.yaml"] && !Object.keys(snapshot.files).length && !snapshot.local.length) continue;
      const project = this.readProject(snapshot);
      const local = migrateWorkspaceAuthRuntime(snapshot.local, snapshot.id);
      const workspace = await restoreWorkspace(project, local, this.secure, Object.fromEntries(Object.entries(snapshot.files).map(([path, file]) => [path, file.content])));
      this.snapshots.set(snapshot.id, snapshot); this.projects.set(snapshot.id, project); workspaces.push(workspace);
    }
    const legacy = stored.legacy as WorkspaceStore | undefined;
    if (legacy != null && !Array.isArray(legacy.workspaces)) throw new Error("Unsupported or damaged workspace index. The original data has not been changed.");
    for (const raw of legacy?.workspaces ?? []) {
      const workspace = validateWorkspace(decodeFiles(raw));
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(raw)));
      const legacySource = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (!workspaces.some((item) => item.id === workspace.id)) { await this.persist(workspace, legacySource); workspaces.push(workspace); }
      else if (this.snapshots.get(workspace.id)?.local.find((record) => record.table === "workspace_local_state" && record.id === "legacy-source")?.value !== legacySource)
        throw new Error("Legacy data changed after migration started. Both versions are preserved; resolve the legacy change before continuing.");
    }
    if (!workspaces.length) workspaces.push(createWorkspace("Personal", "personal"));
    const candidate = stored.activeWorkspaceId || legacy?.activeWorkspaceId;
    const activeWorkspaceId = workspaces.some((item) => item.id === candidate) ? candidate! : workspaces[0].id;
    this.activeId = stored.activeWorkspaceId;
    const globalRecord = stored.global?.find((record) => record.table === "workspace_local_state" && record.id === "variables");
    const globalVariables = await restoreGlobalVariables(globalRecord?.value, this.secure);
    this.globalVariables = globalVariables;
    this.globalSnapshot = JSON.stringify(globalRecord?.value ?? []);
    await this.save({ activeWorkspaceId, workspaces, globalVariables }); await this.backend.finishMigration();
    return { activeWorkspaceId, workspaces, globalVariables };
  }
  save(store: WorkspaceStore): Promise<void> {
    const work = async () => {
      for (const workspace of store.workspaces) await this.persist(workspace);
      const definitions = await projectGlobalVariables(store.globalVariables ?? [], this.secure);
      this.globalVariables = store.globalVariables ?? [];
      const serialized = JSON.stringify(definitions);
      if (serialized !== this.globalSnapshot) {
        await this.backend.writeGlobal([{ table: "workspace_local_state", id: "variables", value: definitions }]);
        this.globalSnapshot = serialized;
      }
      if (this.activeId !== store.activeWorkspaceId && !this.deleted.has(store.activeWorkspaceId)) { await this.backend.setActiveWorkspace(store.activeWorkspaceId); this.activeId = store.activeWorkspaceId; }
    };
    const next = this.queue.catch(() => {}).then(work); this.queue = next; return next;
  }
  async deleteWorkspace(id: string): Promise<void> {
    this.deleted.add(id);
    const remove = async () => {
      await this.backend.deleteWorkspace(id);
      this.secure.clear();
      this.snapshots.delete(id); this.projects.delete(id); this.paths.delete(id); this.sdlPaths.delete(id);
      this.developmentRewrites.delete(id);
      if (this.activeId === id) this.activeId = "";
    };
    const next = this.queue.catch(() => {}).then(remove); this.queue = next;
    try { await next; } catch (cause) { this.deleted.delete(id); throw cause; }
  }
  private async persist(workspace: Workspace, legacySource?: string) {
    if (this.deleted.has(workspace.id)) return;
    const { project, local, assets } = await projectWorkspace(workspace, this.secure); validateProject(project);
    if (legacySource) local.push({ table: "workspace_local_state", id: "legacy-source", value: legacySource });
    const snapshot = this.snapshots.get(workspace.id) ?? { id: workspace.id, files: {}, local: [] };
    const previousProject = this.projects.get(workspace.id); const paths = new Map(this.paths.get(workspace.id) ?? []);
    const sdlPaths = this.sdlPaths.get(workspace.id) ?? new Map<string, string>();
    const developmentRewrites = this.developmentRewrites.get(workspace.id) ?? new Set<string>();
    const desired: Record<string, string> = { "purr.yaml": serializeManifest(project.workspace), ...assets };
    // Unreferenced sidecar files belong to the directory owner, not to Purr's
    // deletion set. Managed SDL is removed only on explicit unpin/delete.
    for (const [path, file] of Object.entries(snapshot.files)) if (!path.endsWith(".yaml")
      && !previousProject?.resources.some((item) => item.kind === "schema" && item.pinnedSdl !== undefined && path === (sdlPaths.get(item.id) ?? `schemas/${item.id}.graphql`))) desired[path] ??= file.content;
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
        : resource.kind === "http" || resource.kind === "graphql"
          ? `${documentDirectory(resource.folderId)}/${existingPath?.startsWith("documents/") || existingPath?.startsWith("requests/") || existingPath?.startsWith("graphql/")
            ? fileName(existingPath) : `${slug(resource.name)}-${resource.id}.yaml`}`
          : existingPath ?? `${resourceDirectory(resource)}/${slug(resource.name)}-${resource.id}.yaml`;
      paths.set(resource.id, path);
      const sdlPath = sdlPaths.get(resource.id) ?? `schemas/${resource.id}.graphql`; desired[path] = serializeResource(resource, sdlPath);
      if (resource.kind === "schema" && resource.pinnedSdl !== undefined) desired[sdlPath] = resource.pinnedSdl;
      const previous = previousProject?.resources.find((item) => item.id === resource.id);
      if (previous && serializeResource(previous, sdlPath) === desired[path] && snapshot.files[path] && !developmentRewrites.has(path)) desired[path] = snapshot.files[path].content;
    }
    if (previousProject && serializeManifest(previousProject.workspace) === desired["purr.yaml"] && snapshot.files["purr.yaml"] && !developmentRewrites.has("purr.yaml")) desired["purr.yaml"] = snapshot.files["purr.yaml"].content;
    const changes: FileChange[] = [];
    for (const path of new Set([...Object.keys(snapshot.files), ...Object.keys(desired)])) {
      const content = desired[path] ?? null;
      if ((snapshot.files[path]?.content ?? null) !== content) changes.push({ path, content, expectedRevision: snapshot.files[path]?.revision ?? null });
    }
    const oldLocal = new Map(snapshot.local.map((record) => [key(record), record])); const nextLocal = new Map(local.map((record) => [key(record), record]));
    for (const record of snapshot.local) if ((record.table === "request_executions" || record.table === "workspace_local_state" && record.id === "legacy-source") && !nextLocal.has(key(record))) nextLocal.set(key(record), record);
    const localChanges: LocalChange[] = [];
    for (const id of new Set([...oldLocal.keys(), ...nextLocal.keys()])) {
      const next = nextLocal.get(id); const previous = oldLocal.get(id);
      if (JSON.stringify(next) !== JSON.stringify(previous)) localChanges.push(next ?? { ...previous!, value: null });
    }
    if (changes.length || localChanges.length) {
      const files = await this.backend.commit(workspace.id, changes, localChanges);
      this.snapshots.set(workspace.id, { id: workspace.id, files, local: [...nextLocal.values()] });
    }
    this.developmentRewrites.delete(workspace.id);
    this.projects.set(workspace.id, project); this.paths.set(workspace.id, paths);
  }
  private async reconcileWorkspace(id: string, paths: string[], working?: Workspace): Promise<Workspace | null> {
    const previous = this.snapshots.get(id); if (!previous) return null;
    const scanned = paths.includes("*") ? await this.backend.loadWorkspace(id) : undefined;
    const files = { ...previous.files }; let changed = false;
    if (scanned) paths = [...new Set([...Object.keys(previous.files), ...Object.keys(scanned.files)])];
    for (const path of new Set(paths)) {
      if (!/\.(yaml|graphql|bin)$/.test(path)) continue;
      const file = scanned ? scanned.files[path] : await this.backend.reloadResource(id, path); if (file?.revision === files[path]?.revision) continue;
      changed = true; if (file) files[path] = file; else delete files[path];
    }
    if (!changed) return null;
    const snapshot = { ...previous, files }; const project = this.readProject(snapshot, false);
    const projected = working ? await projectWorkspace(working, this.secure) : undefined;
    const local = projected?.local ?? previous.local;
    const baseline = this.projects.get(id);
    const merged: Project = { workspace: project.workspace, resources: [...project.resources] };
    if (baseline && projected) {
      const localManifest = serializeManifest(projected.project.workspace);
      if (localManifest !== serializeManifest(baseline.workspace)) {
        if (serializeManifest(project.workspace) !== serializeManifest(baseline.workspace) && localManifest !== serializeManifest(project.workspace)) throw new Error("Concurrent workspace settings edits");
        merged.workspace = projected.project.workspace;
      }
      for (const resourceId of new Set([...baseline.resources, ...projected.project.resources].map((item) => item.id))) {
        const before = baseline.resources.find((item) => item.id === resourceId);
        const localResource = projected.project.resources.find((item) => item.id === resourceId);
        const external = project.resources.find((item) => item.id === resourceId);
        const signature = (value?: ProjectResource) => value ? serializeResource(value, value.kind === "schema" ? `schemas/${value.id}.graphql` : undefined) + (value.kind === "schema" ? value.pinnedSdl ?? "" : "") : null;
        if (signature(localResource) === signature(before)) continue;
        if (signature(external) !== signature(before) && signature(external) !== signature(localResource)) throw new Error("Concurrent resource edits");
        merged.resources = merged.resources.filter((item) => item.id !== resourceId);
        if (localResource) merged.resources.push(localResource);
      }
      // Removing a saved definition must not discard an unsaved working copy.
      if (local.some((record) => record.table === "drafts" && (record.value as { saved?: boolean }).saved && !merged.resources.some((item) => item.id === record.id))) throw new Error("External deletion conflicts with a working copy");
    }
    const workspace = await restoreWorkspace(merged, local, this.secure, Object.fromEntries(Object.entries(files).map(([path, file]) => [path, file.content])));
    this.readProject(snapshot); this.snapshots.set(id, snapshot); this.projects.set(id, project); return workspace;
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
  async saveProject(project: Project): Promise<Workspace> {
    validateProject(project);
    const snapshot = this.snapshots.get(project.workspace.id);
    const workspace = await restoreWorkspace(project, snapshot?.local ?? [], this.secure, Object.fromEntries(Object.entries(snapshot?.files ?? {}).map(([path, file]) => [path, file.content])));
    await this.save({ activeWorkspaceId: this.activeId || workspace.id, workspaces: [workspace], globalVariables: this.globalVariables }); return workspace;
  }
  prepareImport(project: Project): Project {
    const existing = this.projects.get(project.workspace.id);
    if (existing && project.resources.some((resource) => existing.resources.some((current) => current.id === resource.id)))
      throw new Error("Imported resource IDs conflict with existing resources. Resolve duplicate IDs in the import preview first.");
    // Import is additive. Existing workspace defaults and unrelated resources
    // cannot be silently replaced by a collection adapter.
    return validateProject(existing ? { workspace: existing.workspace, resources: [...existing.resources, ...project.resources] } : project);
  }
  async attachDirectory(id: string, directory: string): Promise<Workspace> {
    if (!this.backend.attachDirectory) throw new Error("Directory workspaces require the desktop application.");
    if (this.snapshots.has(id)) throw new Error("This workspace is already open.");
    this.deleted.delete(id);
    const snapshot = await this.backend.attachDirectory(id, directory);
    const project = this.readProject(snapshot, false);
    const workspace = await restoreWorkspace(project, snapshot.local, this.secure, Object.fromEntries(Object.entries(snapshot.files).map(([path, file]) => [path, file.content])));
    this.readProject(snapshot); this.snapshots.set(id, snapshot); this.projects.set(id, project);
    await this.save({ activeWorkspaceId: id, workspaces: [workspace], globalVariables: this.globalVariables }); return workspace;
  }
}
