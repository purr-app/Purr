import type { Page } from "@playwright/test";
import { createWorkspace, cloneRequestDraft, isRequestDocument } from "../../src/features/workspaces/model/workspace";
import { projectWorkspace } from "../../src/application/project-projection";
import { MemorySecureStore } from "../../src/storage/secrets";
import { serializeManifest, serializeResource } from "../../src/storage/yaml";
import { installPersistenceMock } from "../ui/persistence-mock";

export async function installGitMock(page: Page, options: { initialized?: boolean; cloneError?: boolean; conflicts?: boolean; editorConflict?: boolean } = {}) {
  const workspace = createWorkspace("API project", "git-fixture"); const document = workspace.documents[0];
  if (!isRequestDocument(document)) throw new Error("Expected request fixture");
  document.id = "get-user"; document.name = "Get user"; document.saved = true; document.request.url = "https://api.example.test/users/123";
  document.request.headers = [{ id: "accept", name: "Accept", value: "application/json", enabled: true }, { id: "debug", name: "X-Debug", value: "verbose", enabled: false }];
  document.savedRequest = cloneRequestDraft(document.request); workspace.ui.openDocumentIds = [document.id]; workspace.ui.activeDocumentId = document.id;
  if (options.editorConflict) document.request.url = "https://api.example.test/users/local";
  const secure = new MemorySecureStore(); const projected = await projectWorkspace(workspace, secure, { includeExecutions: false });
  const resource = projected.project.resources.find((resource) => resource.id === document.id)!;
  const after = serializeResource(resource); const before = after.replace("/users/123", "/users").replace("verbose", "minimal");
  const files = { "purr.yaml": { content: serializeManifest(projected.project.workspace), revision: "manifest-1" }, "documents/get-user.yaml": { content: options.editorConflict ? after.replace("/users/123", "/users/incoming") : after, revision: "request-1" } };
  await installPersistenceMock(page);
  await page.addInitScript(({ files, local, before, after, options }) => {
    const state = window as any; state.isTauri = true; state.__gitCalls = [];
    const now = Date.now(); const initial = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const snapshot = { activeWorkspaceId: "git-fixture", workspaces: [{ id: "git-fixture", files, local }] };
    localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot));
    state.__gitStatus = { directory: "/projects/api", initialized: options.initialized !== false, version: "git version 2.50.1", branch: "main", head: initial, upstream: "origin/main", ahead: 1, behind: 2,
      files: [{ path: "documents/get-user.yaml", index: ".", worktree: "M", conflicted: false }], branches: [{ name: "main", remote: false, current: true }, { name: "feature/team", remote: false, current: false }, { name: "origin/main", remote: true, current: false }], remotes: [{ name: "origin", url: "git@example.test:team/api.git" }], operation: null, lastFetched: now, recovery: false };
    state.__gitHistory = [{ id: initial, shortId: "aaaaaaa", message: "Add user endpoint", author: "Purr fixture", timestamp: now }]; state.__gitStashes = [];
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      state.__gitCalls.push({ command, args });
      if (command === "plugin:dialog|open") return "/projects/chosen";
      if (command === "git_clone") { if (options.cloneError) throw { code: "invalid-project", message: "This repository is not a valid Purr workspace: purr.yaml is missing." }; return args.directory; }
      if (command === "read_project_directory" || command === "open_project_directory") {
        const clone = { id: "cloned-workspace", files: { "purr.yaml": { content: "purr: 2\nworkspace:\n  id: cloned-workspace\n  name: Cloned API\n", revision: "cloned-manifest" } }, local: [] };
        if (command === "open_project_directory") { const snapshot = JSON.parse(localStorage.getItem("purr-native-persistence-test")!); snapshot.workspaces.push(clone); localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot)); }
        return clone;
      }
      if (command !== "git_workspace") return;
      const query = args.query; const s = state.__gitStatus;
      if (query.type === "status") return structuredClone(s);
      if (query.type === "history") return state.__gitHistory;
      if (query.type === "commitFiles") return [{ path: "documents/get-user.yaml", index: "M", worktree: ".", conflicted: false }];
      if (query.type === "stashes") return state.__gitStashes;
      if (query.type === "conflicts") return s.files.filter((file: any) => file.conflicted).map((file: any) => ({ path: file.path, base: before, local: after, incoming: after.replace("/123", "/incoming"), binary: false, revision: "conflict-revision" }));
      if (query.type === "diff") return { path: query.request.path, before, after, beforeBytes: before.length, afterBytes: after.length, binary: false, truncated: false };
      const action = query.action;
      if (action.type === "init") s.initialized = true;
      if (action.type === "stage" || action.type === "unstage") for (const file of s.files) if (action.paths.includes(file.path)) { file.index = action.type === "stage" ? "M" : "."; file.worktree = action.type === "stage" ? "." : "M"; }
      if (action.type === "commit") { if (!s.files.some((file: any) => file.index !== ".")) throw { code: "git", message: "Nothing staged." }; s.head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; state.__gitHistory.unshift({ id: s.head, shortId: "bbbbbbb", message: action.message, author: "Purr fixture", timestamp: Date.now() }); s.files = s.files.filter((file: any) => file.index === "."); s.ahead++; }
      if (action.type === "createBranch") s.branches.push({ name: action.name, remote: false, current: false });
      if (action.type === "switchBranch") { if (s.files.length && !action.allowDirty) throw { code: "dirty", message: "There are uncommitted changes." }; s.branch = action.name; s.branches.forEach((branch: any) => { branch.current = branch.name === action.name; }); }
      if (action.type === "pull") { if (s.files.length && !action.allowDirty) throw { code: "dirty", message: "There are uncommitted changes." }; if (options.conflicts) { s.operation = "merge"; s.recovery = true; s.files = [{ path: "documents/get-user.yaml", index: "U", worktree: "U", conflicted: true }]; throw { code: "conflict", message: "Pull has merge conflicts." }; } s.behind = 0; }
      if (action.type === "resolveConflict") s.files = s.files.filter((file: any) => file.path !== action.path);
      if (action.type === "finishMerge" || action.type === "abortMerge") { s.operation = null; s.recovery = false; s.files = []; }
      if (action.type === "push") s.ahead = 0;
      if (action.type === "setRemote") s.remotes = [...s.remotes.filter((remote: any) => remote.name !== action.name), { name: action.name, url: action.url }];
      if (action.type === "removeRemote") s.remotes = s.remotes.filter((remote: any) => remote.name !== action.name);
      if (action.type === "stash") { state.__gitStashes.unshift({ id: "cccccccccccccccccccccccccccccccccccccccc", message: `Purr [${s.branch}]: ${action.message}` }); s.files = []; }
      if (action.type === "applyStash" || action.type === "dropStash") state.__gitStashes = state.__gitStashes.filter((stash: any) => stash.id !== action.id);
      return structuredClone(s);
    } };
  }, { files, local: projected.local, before, after, options });
}
