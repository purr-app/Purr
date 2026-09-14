import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ImportSource, NormalizedImportResult } from "../importing/contracts";
import { persistImport } from "./import-project";
import type { WorkspacePersistence } from "./workspace-persistence";

export async function importWorkspace(source: ImportSource, persistence: WorkspacePersistence) {
  if (!isTauri()) throw new Error("Workspace import requires the desktop application.");
  const workspaceId = crypto.randomUUID();
  const normalized = await invoke<NormalizedImportResult>("import_collection", { source, workspaceId });
  return persistImport(normalized, persistence);
}
