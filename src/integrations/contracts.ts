import type { TemplateVariableActions } from "../features/request-workbench/components/template-variable-popover";
import type { AuthContext } from "../features/request-workbench/model/request-auth";
import type { ComponentType } from "react";
import type { IntegrationDefinition, JsonObject } from "../domain/project";

export type IntegrationSettingsProps = {
  value: IntegrationDefinition;
  onSave(value: IntegrationDefinition): Promise<void>;
  onCancel(): void;
  variables?: Record<string, string>;
  variableActions?: TemplateVariableActions;
  authContext?: AuthContext;
  // Host scopes credential access to this instance and a declared slot.
  getCredential?(key: string): Promise<string | null>;
  setCredential(key: string, value: string): Promise<void>;
};
export type ExtensionLogger = Readonly<{
  debug(message: string, details?: Readonly<Record<string, unknown>>): void;
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}>;

// Frontend modules describe presentation only. Executable observability
// providers, config validation, credentials, correlation, parsing, and cache
// ownership belong to the native Rust registry and service.
export type IntegrationPresentationContribution = Readonly<{
  id: string;
  label: string;
  description?: string;
  icon?: string;
  /** Presentation hint; native registry remains authoritative for availability. */
  capabilities?: readonly string[];
  initialConfig?: JsonObject;
  credentialKeys?: readonly string[];
  Settings?: ComponentType<IntegrationSettingsProps>;
}>;
