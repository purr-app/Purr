import type { SemanticPreview } from "./semantic-git";
import type { Page } from "@playwright/test";
import { createWorkspace, createSchemaDocument, cloneRequestDraft, isRequestDocument } from "../../src/features/workspaces/model/workspace";
import { projectWorkspace } from "../../src/application/project-projection";
import { MemorySecureStore } from "../../src/storage/secrets";
import { serializeManifest, serializeResource } from "../../src/storage/yaml";
import { installPersistenceMock } from "../ui/persistence-mock";

export async function installGitMock(page: Page, options: { initialized?: boolean; cloneError?: boolean; conflicts?: boolean; editorConflict?: boolean; noTabs?: boolean; stageDelayMs?: number; stageError?: boolean; newFile?: boolean; recovery?: boolean; preview?: SemanticPreview; branchStash?: boolean; reloadDelayMs?: number; stashConcurrentChange?: boolean; listDelayMs?: number; holdHistory?: boolean } = {}) {
  const workspace = createWorkspace("API project", "git-fixture"); const document = workspace.documents[0];
  if (!isRequestDocument(document)) throw new Error("Expected request fixture");
  document.id = "get-user"; document.name = "Get user"; document.saved = true; document.request.url = "https://api.example.test/users/123";
  document.request.headers = [{ id: "accept", name: "Accept", value: "application/json", enabled: true }, { id: "debug", name: "X-Debug", value: "verbose", enabled: false }];
  document.savedRequest = cloneRequestDraft(document.request); workspace.ui.openDocumentIds = [document.id]; workspace.ui.activeDocumentId = document.id;
  if (options.noTabs) { workspace.ui.openDocumentIds = []; workspace.ui.activeDocumentId = null; }
  if (options.editorConflict) document.request.url = "https://api.example.test/users/local";
  if (options.branchStash) {
    const schema = createSchemaDocument(document); schema.id = "new-schema"; schema.saved = true; schema.name = "Rick and Morty copy";
    schema.source = "introspection"; schema.endpoint = "https://example.test/graphql"; schema.sdl = "type Query { hello: String }";
    workspace.documents.push(schema);
  }
  const secure = new MemorySecureStore(); const projected = await projectWorkspace(workspace, secure, { includeExecutions: false });
  const resource = projected.project.resources.find((resource) => resource.id === document.id)!;
  const after = serializeResource(resource); const before = after.replace("/users/123", "/users").replace("verbose", "minimal");
  const files = { "purr.yaml": { content: serializeManifest(projected.project.workspace), revision: "manifest-1" }, "documents/get-user.yaml": { content: options.editorConflict ? after.replace("/users/123", "/users/incoming") : after, revision: "request-1" } };
  if (options.branchStash) for (const schema of projected.project.resources) if (schema.kind === "schema") {
    Object.assign(files, { "schemas/new-schema.yaml": { content: serializeResource(schema, "schemas/new-schema.graphql"), revision: "schema-1" }, "schemas/new-schema.graphql": { content: schema.pinnedSdl, revision: "sdl-1" } });
  }
  if (options.recovery) projected.local.push({ table: "workspace_local_state", id: "git-operation", protection: "encrypted", value: { version: 1, kind: "stash", projectFiles: files } });
  await installPersistenceMock(page);
  await page.addInitScript(({ files, local, before, after, options }) => {
    const state = window as any; state.isTauri = true; state.__gitCalls = [];
    state.__purrProjectLoadDelayMs = options.reloadDelayMs;
    state.__gitListDelayMs = options.listDelayMs;
    state.__gitHoldNextHistory = options.holdHistory;
    const now = Date.now(); const initial = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const snapshot = { activeWorkspaceId: "git-fixture", workspaces: [{ id: "git-fixture", files, local }] };
    if (!localStorage.getItem("purr-native-persistence-test")) localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot));
    state.__gitStatus = { directory: "/projects/api", initialized: options.initialized !== false, version: "git version 2.50.1", branch: "main", head: initial, upstream: "origin/main", ahead: 1, behind: 2,
      files: [{ path: options.preview?.path ?? "documents/get-user.yaml", index: options.newFile ? "?" : ".", worktree: "M", conflicted: false }], branches: [{ name: "main", remote: false, current: true }, { name: "feature/team", remote: false, current: false }, { name: "origin/main", remote: true, current: false }], remotes: [{ name: "origin", url: "git@example.test:team/api.git" }], operation: null, lastFetched: now, recovery: Boolean(options.recovery) };
    state.__gitHistory = [{ id: initial, shortId: "aaaaaaa", message: "Add user endpoint", author: "Purr fixture", timestamp: now }]; state.__gitStashes = [];
    const baseline = { "purr.yaml": files["purr.yaml"], "documents/get-user.yaml": { content: before, revision: "baseline-request" } };
    const stashFiles = new Map<string, any>();
    const syncFiles = () => {
      if (!options.branchStash) return;
      const current = JSON.parse(localStorage.getItem("purr-native-persistence-test")!).workspaces[0].files;
      s.files = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].flatMap((path) => (baseline as any)[path]?.content === current[path]?.content ? [] : [{ path, index: (baseline as any)[path] ? "." : "?", worktree: current[path] ? "M" : "D", conflicted: false }]);
    };
    const s = state.__gitStatus; syncFiles();
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      state.__gitCalls.push({ command, args });
      if (command === "plugin:dialog|open") return "/projects/chosen";
      if (command === "git_clone") { if (options.cloneError) throw { code: "invalid-project", message: "This repository is not a valid Purr workspace: purr.yaml is missing." }; return args.directory || "/projects/cloned-workspace"; }
      if (command === "read_project_directory" || command === "open_project_directory") {
        const clone = { id: "cloned-workspace", files: { "purr.yaml": { content: "purr: 2\nworkspace:\n  id: cloned-workspace\n  name: Cloned API\n", revision: "cloned-manifest" } }, local: [] };
        if (command === "open_project_directory") { const snapshot = JSON.parse(localStorage.getItem("purr-native-persistence-test")!); snapshot.workspaces.push(clone); localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot)); }
        return clone;
      }
      if (command === "project_directory" && args.action.type === "info") return { directory: `/projects/${args.workspaceId}`, projectsDirectory: "/projects", managed: true };
      if (command !== "git_workspace") return;
      const query = args.query; const s = state.__gitStatus;
      if (query.type === "status") { syncFiles(); return structuredClone(s); }
      if (query.type === "history" || query.type === "stashes") {
        if (state.__gitListBusy === query.type) { state.__gitListBusy = undefined; throw { code: "busy", message: "Repository is busy" }; }
        const items = structuredClone(query.type === "history" ? state.__gitHistory : state.__gitStashes);
        if (query.type === "history" && state.__gitHoldNextHistory) { state.__gitHoldNextHistory = false; await new Promise((resolve) => { state.__gitReleaseHistory = resolve; }); }
        if (state.__gitListDelayMs) await new Promise((resolve) => setTimeout(resolve, state.__gitListDelayMs));
        state.__gitListResponses ??= []; state.__gitListResponses.push({ type: query.type, items });
        return items;
      }
      if (query.type === "commitFiles") return [{ path: "documents/get-user.yaml", index: "M", worktree: ".", conflicted: false }];
      if (query.type === "conflicts") return s.files.filter((file: any) => file.conflicted).map((file: any) => ({ path: file.path, base: before, local: after, incoming: after.replace("/123", "/incoming"), binary: false, revision: "conflict-revision" }));
      if (query.type === "diff") {
        const left = options.preview?.before ?? (options.newFile ? "" : before), right = options.preview?.after ?? after;
        return { path: query.request.path, before: left, after: right, beforeExists: Boolean(left), afterExists: Boolean(right), beforeBytes: left.length, afterBytes: right.length, binary: false, truncated: false };
      }
      const action = query.action;
      if (action.type === "stage" || action.type === "unstage") { if (options.stageDelayMs) await new Promise((resolve) => setTimeout(resolve, options.stageDelayMs)); if (options.stageError) throw { code: "git", message: "Could not update the Git index." }; }
      if (action.type === "discard") s.files = s.files.filter((file: any) => !action.paths.includes(file.path));
      if (action.type === "init") s.initialized = true;
      if (action.type === "stage" || action.type === "unstage") for (const file of s.files) if (action.paths.includes(file.path)) { file.index = action.type === "stage" ? "M" : "."; file.worktree = action.type === "stage" ? "." : "M"; }
      if (action.type === "commit") { if (!s.files.some((file: any) => file.index !== ".")) throw { code: "git", message: "Nothing staged." }; s.head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; state.__gitHistory.unshift({ id: s.head, shortId: "bbbbbbb", message: action.message, author: "Purr fixture", timestamp: Date.now() }); s.files = s.files.filter((file: any) => file.index === "."); s.ahead++; }
      if (action.type === "createBranch") s.branches.push({ name: action.name, remote: false, current: false });
      if (action.type === "switchBranch") { syncFiles(); if (s.files.length && !action.allowDirty) throw { code: "dirty", message: "There are uncommitted changes." }; s.branch = action.name; s.branches.forEach((branch: any) => { branch.current = branch.name === action.name; }); if (options.branchStash) { s.head = "dddddddddddddddddddddddddddddddddddddddd"; state.__gitHistory = [{ id: s.head, shortId: "ddddddd", message: "Test branch commit", author: "Purr fixture", timestamp: now }]; } }
      if (action.type === "pull") { if (s.files.length && !action.allowDirty) throw { code: "dirty", message: "There are uncommitted changes." }; if (options.conflicts) { s.operation = "merge"; s.recovery = true; s.files = [{ path: "documents/get-user.yaml", index: "U", worktree: "U", conflicted: true }]; throw { code: "conflict", message: "Pull has merge conflicts." }; } s.behind = 0; }
      if (action.type === "resolveConflict") s.files = s.files.filter((file: any) => file.path !== action.path);
      if (action.type === "finishMerge" || action.type === "abortMerge") { s.operation = null; s.recovery = false; s.files = []; const snapshot = JSON.parse(localStorage.getItem("purr-native-persistence-test")!); snapshot.workspaces[0].local = snapshot.workspaces[0].local.filter((record: any) => record.id !== "git-operation"); localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot)); }
      if (action.type === "push") s.ahead = 0;
      if (action.type === "setRemote") s.remotes = [...s.remotes.filter((remote: any) => remote.name !== action.name), { name: action.name, url: action.url }];
      if (action.type === "removeRemote") s.remotes = s.remotes.filter((remote: any) => remote.name !== action.name);
      if (action.type === "stash") { const id = `ccccccccccccccccccccccccccccccccccccccc${state.__gitStashes.length}`; state.__gitStashes.unshift({ id, message: `Purr [${s.branch}]: ${action.message}` }); s.files = []; if (options.branchStash) { const snapshot = JSON.parse(localStorage.getItem("purr-native-persistence-test")!); stashFiles.set(id, snapshot.workspaces[0].files); snapshot.workspaces[0].files = structuredClone(baseline); if (options.stashConcurrentChange) snapshot.workspaces[0].files["schemas/external.graphql"] = { content: "scalar External", revision: "external" }; localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot)); } }
      if (action.type === "applyStash" && options.branchStash) { const snapshot = JSON.parse(localStorage.getItem("purr-native-persistence-test")!); snapshot.workspaces[0].files = stashFiles.get(action.id); localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot)); syncFiles(); }
      if (action.type === "applyStash" || action.type === "dropStash") state.__gitStashes = state.__gitStashes.filter((stash: any) => stash.id !== action.id);
      return structuredClone(s);
    } };
  }, { files, local: projected.local, before, after, options });
}
