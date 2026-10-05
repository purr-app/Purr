import type { ImportSource } from "../importing/contracts";
import { importReport } from "../importing/contracts";
import type { Variable, Workspace } from "../features/workspaces/model/workspace";
import type { ImportPort } from "./ports/platform";
import type { WorkspacePersistence } from "./workspace-persistence";
import { persistImport } from "./import-project";

// Call after flushing the latest workspace. Reuse the canonical commit and vault
// rollback path, but retain the current runtime documents/session when adding envs.
export async function importEnvironment(source: ImportSource, current: Workspace, globals: readonly Variable[], persistence: WorkspacePersistence, importer: ImportPort) {
  const normalized = await importer.normalize(source, current.id, "environment");
  if (normalized.workspace.id !== current.id || normalized.resources.length !== 1 || normalized.resources[0].kind !== "environment")
    throw new Error("Select a Postman environment export.");
  const environment = normalized.resources[0];
  const globalNames = new Set(globals.map((variable) => variable.name.trim()));
  if (environment.variables.some((variable) => globalNames.has(variable.name.trim())))
    throw new Error("Imported environment variables conflict with Global variables. Rename the conflicting Global variables before importing.");
  const originalName = environment.name.trim() || "Imported environment";
  const names = new Set(current.environments.map((item) => item.name.trim()));
  let name = originalName; let suffix = 2;
  while (names.has(name)) name = `${originalName} (${suffix++})`;
  environment.name = name;
  if (name !== originalName) normalized.diagnostics.push({ severity: "warning", code: "duplicate-name", message: `Environment renamed to “${name}” because its name already exists.`, sourcePath: "#/name" });
  const secrets = new Map(normalized.secrets.map((secret) => [secret.ref, secret.value]));
  const workspace = await persistImport(normalized, persistence, (restored) => ({ ...current, environments: [
    ...current.environments,
    ...restored.environments.filter((item) => item.id === environment.id).map((item) => ({ ...item, variables: item.variables.map((variable) =>
      variable.kind === "static" && variable.secretRef && secrets.has(variable.secretRef)
        ? { ...variable, value: secrets.get(variable.secretRef)!, loaded: true } : variable) })),
  ] }));
  return { workspace, environmentId: environment.id, report: importReport(normalized) };
}
