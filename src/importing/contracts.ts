import type { Credential, ProjectResource, SecretRef, WorkspaceDefinition } from "../domain/project";

export type ImportTarget = "workspace" | "environment";
export type ImportSource =
  | { kind: "path"; path: string }
  | { kind: "file"; path: string }
  | { kind: "directory"; path: string }
  | { kind: "url"; url: string }
  | { kind: "text"; name: string; content: string };
export type ImportDiagnostic = {
  severity: "warning" | "error";
  code: "unsupported-script" | "omitted-secret" | "unsupported-auth" | "duplicate-name" | "unsupported-feature" | "invalid-input" | "missing-reference";
  message: string; sourcePath?: string; resourceId?: string;
};
export type ImportPreview = {
  adapter: string; counts: { http: number; graphql: number; environments: number; folders: number; schemas: number; integrations: number };
  diagnostics: ImportDiagnostic[];
  environmentCandidates?: Array<{ name: string; variables: Array<{ name: string; value: Credential }> }>;
};
export type ImportOptions = { workspaceId: string; includeSecrets: boolean; duplicatePolicy: "rename" | "skip" | "error" };
export type ImportReport = {
  adapter: string;
  counts: ImportPreview["counts"] & { variables: number; secrets: number };
  diagnostics: ImportDiagnostic[];
};
export type NormalizedImportResult = {
  adapter?: string;
  workspace: WorkspaceDefinition;
  resources: ProjectResource[];
  diagnostics: ImportDiagnostic[];
  // Transient values go directly to SecureStore, never to preview/errors or serializers.
  secrets: Array<{ ref: SecretRef; value: string }>;
  activeEnvironmentId?: string;
};

export function importReport(result: NormalizedImportResult): ImportReport {
  const counts: ImportReport["counts"] = { http: 0, graphql: 0, environments: 0, folders: 0, schemas: 0, integrations: 0,
    variables: result.workspace.variables?.length ?? 0, secrets: result.secrets.length };
  for (const resource of result.resources) {
    switch (resource.kind) {
      case "http": case "graphql": counts[resource.kind]++; break;
      case "environment": counts.environments++; counts.variables += resource.variables.length; break;
      case "folder": counts.folders++; break;
      case "schema": case "api-schema": counts.schemas++; break;
      case "integration": counts.integrations++; break;
    }
  }
  return { adapter: result.adapter ?? "import", counts, diagnostics: result.diagnostics };
}
