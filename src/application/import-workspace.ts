import type { ImportSource, NormalizedImportResult } from "../importing/contracts";
import type { ImportPort } from "./ports/platform";
import { persistImport } from "./import-project";
import type { WorkspacePersistence } from "./workspace-persistence";

export async function importWorkspace(source: ImportSource, persistence: WorkspacePersistence, importer: ImportPort) {
  const workspaceId = crypto.randomUUID();
  const normalized: NormalizedImportResult = await importer.normalize(source, workspaceId);
  return persistImport(normalized, persistence);
}
