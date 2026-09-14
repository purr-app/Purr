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
  const writtenSecrets: typeof result.secrets = [];
  try {
    for (const secret of result.secrets) {
      await persistence.secure.set(secret.ref, secret.value);
      writtenSecrets.push(secret);
    }
    return await persistence.saveProject(project, (workspace) => {
      if (result.activeEnvironmentId && workspace.environments.some((environment) => environment.id === result.activeEnvironmentId))
        workspace.activeEnvironmentId = result.activeEnvironmentId;
      const firstDocument = workspace.documents.find((document) => document.saved);
      if (firstDocument) workspace.ui = { ...workspace.ui, openDocumentIds: [firstDocument.id], activeDocumentId: firstDocument.id };
      return workspace;
    });
  } catch (cause) {
    await Promise.allSettled(writtenSecrets.map((secret) => persistence.secure.delete(secret.ref)));
    throw cause;
  }
}
