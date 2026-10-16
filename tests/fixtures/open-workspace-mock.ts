import type { Page } from "@playwright/test";
import { createWorkspace } from "../../src/features/workspaces/model/workspace";
import { projectWorkspace } from "../../src/application/project-projection";
import { serializeManifest, serializeResource } from "../../src/storage/yaml";
import { MemorySecureStore } from "../../src/storage/secrets";
import type { StoredWorkspace } from "../../src/application/ports/persistence";
import { installPersistenceMock } from "../ui/persistence-mock";

export const portableWorkspaceId = "portable-workspace";
export const portableSecretRef = `purr/${portableWorkspaceId}/credentials/variables/portable-token`;

/** Portable YAML fixture without source-device local state or secret values. */
export async function portableWorkspace(): Promise<StoredWorkspace> {
  const workspace = createWorkspace("Portable workspace", portableWorkspaceId);
  workspace.variables = [{ id: "portable-token", name: "API_TOKEN", kind: "static", sensitive: true, enabled: true,
    value: "", secretRef: portableSecretRef, loaded: false, secretState: { ref: portableSecretRef, status: "missing", edit: { kind: "keep" } } }];
  const { project } = await projectWorkspace(workspace, new MemorySecureStore());
  const files = { "purr.yaml": serializeManifest(project.workspace), ...Object.fromEntries(project.resources.map((resource) => [`documents/${resource.id}.yaml`, serializeResource(resource)])) };
  return { id: portableWorkspaceId, local: [], files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { content, revision: `fixture-${path}` }])) };
}

/** Protocol fake only. Rust tests own filesystem validation and attachment. */
export async function installOpenWorkspaceMock(page: Page, options: { cancel?: boolean; error?: string; nonPurr?: boolean } = {}) {
  await installPersistenceMock(page);
  await page.addInitScript(({ options, portable, reference }) => {
    const state = window as any;
    state.isTauri = true;
    state.__openWorkspaceCalls = [];
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      state.__openWorkspaceCalls.push({ command, args });
      if (command === "plugin:dialog|open") return options.cancel ? null : "/synthetic/copied-workspace";
      if (command === "read_project_directory" || command === "open_project_directory") {
        if (options.error) throw new Error(options.error);
        if (options.nonPurr && command === "read_project_directory") return null;
        if (command === "read_project_directory") return portable;
        const snapshot = JSON.parse(localStorage.getItem("purr-native-persistence-test")!);
        if (!snapshot.workspaces.some((workspace: any) => workspace.id === portable.id)) snapshot.workspaces.push(portable);
        localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot));
        return portable;
      }
      if (command === "import_collection") return { adapter: "postman-collection",
        workspace: { id: args.workspaceId, name: "Collection fixture", variables: [], headers: [], auth: [] },
        resources: [{ id: args.importId, kind: "http", name: "Imported request", method: "GET", url: "https://example.test", params: [], pathParams: [], headers: [], body: { type: "none" }, auth: { type: "none" } }],
        secrets: [], diagnostics: [] };
      if (command !== "secret_transfer") return;
      const action = args.action;
      if (action.type === "selectImportFile") return { id: "portable-package", name: "portable.purrsecrets" };
      if (action.type === "prepareImport") return { id: "portable-preview", workspaceId: portable.id, expiresAt: Date.now() + 300000,
        items: [{ ref: reference, owners: ["Portable workspace / API_TOKEN"], status: "missing" }], omissions: [], dependencies: [] };
      if (action.type === "commitImport") {
        const secrets = JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}");
        secrets[reference] = "synthetic-imported-token";
        localStorage.setItem("purr-native-secure-test", JSON.stringify(secrets));
        return { operationId: action.operationId, status: "committed" };
      }
      if (action.type === "cancel") return;
    } };
  }, { options, portable: await portableWorkspace(), reference: portableSecretRef });
}
