import type { Credential, ProjectResource, SecretRef, WorkspaceDefinition } from "../domain/project";

export type ImportSource = { name: string; mediaType?: string; content: string; files?: ReadonlyMap<string, Uint8Array> };
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
};
export interface ImportAdapter {
  readonly id: string;
  canImport(source: ImportSource): boolean | Promise<boolean>;
  inspect(source: ImportSource): Promise<ImportPreview>;
  import(source: ImportSource, options: ImportOptions): Promise<NormalizedImportResult>;
}
export class ImportAdapterRegistry {
  private adapters = new Map<string, ImportAdapter>();
  register(adapter: ImportAdapter) {
    if (this.adapters.has(adapter.id)) throw new Error("An import adapter with this ID is already registered.");
    this.adapters.set(adapter.id, adapter);
  }
  async detect(source: ImportSource) {
    const matches: ImportAdapter[] = [];
    for (const adapter of this.adapters.values()) if (await adapter.canImport(source)) matches.push(adapter);
    return matches;
  }
}
