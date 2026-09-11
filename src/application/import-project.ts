import { secretRefSchema, validateProject } from "../domain/project";
import type { NormalizedImportResult } from "../importing/contracts";
import type { WorkspacePersistence } from "./workspace-persistence";

export async function persistImport(result: NormalizedImportResult, persistence: WorkspacePersistence) {
  if (result.diagnostics.some((item) => item.severity === "error")) throw new Error("Resolve import errors before saving the project.");
  const project = persistence.prepareImport(validateProject({ workspace: result.workspace, resources: result.resources }));
  const refs = new Set<string>();
  for (const secret of result.secrets) {
    if (!secretRefSchema.safeParse(secret.ref).success || !secret.ref.startsWith(`purr/${project.workspace.id}/`) || refs.has(secret.ref))
      throw new Error("Import credentials must have unique references scoped to the destination workspace.");
    refs.add(secret.ref);
  }
  for (const secret of result.secrets) await persistence.secure.set(secret.ref, secret.value);
  return persistence.saveProject(project);
}
