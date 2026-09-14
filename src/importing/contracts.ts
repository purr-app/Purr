import type { Credential, ProjectResource, SecretRef, WorkspaceDefinition } from "../domain/project";

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
export type NormalizedImportResult = {
  workspace: WorkspaceDefinition;
  resources: ProjectResource[];
  diagnostics: ImportDiagnostic[];
  // Transient values go directly to SecureStore, never to preview/errors or serializers.
  secrets: Array<{ ref: SecretRef; value: string }>;
  activeEnvironmentId?: string;
};
