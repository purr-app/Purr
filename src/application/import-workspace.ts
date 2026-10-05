import { importReport, type ImportSource, type NormalizedImportResult } from "../importing/contracts";
import type { Variable } from "../features/workspaces/model/workspace";
import type { ImportPort } from "./ports/platform";
import { persistImport } from "./import-project";
import type { WorkspacePersistence } from "./workspace-persistence";

export async function importWorkspace(source: ImportSource, persistence: WorkspacePersistence, importer: ImportPort, globals: readonly Variable[] = []) {
  const workspaceId = crypto.randomUUID();
  const normalized: NormalizedImportResult = await importer.normalize(source, workspaceId);
  const globalNames = new Set(globals.map((variable) => variable.name.trim()));
  const variables = [...(normalized.workspace.variables ?? []), ...normalized.resources.flatMap((resource) => resource.kind === "environment" ? resource.variables : [])];
  if (variables.some((variable) => globalNames.has(variable.name.trim())))
    throw new Error("Imported variables conflict with Global variables. Rename the conflicting Global variables before importing.");
  const workspace = await persistImport(normalized, persistence);
  return { workspace, report: importReport(normalized) };
}
