import type { ComponentType } from "react";
import type { IntegrationDefinition, JsonObject } from "../domain/project";

export type IntegrationSettingsProps = {
  value: IntegrationDefinition;
  onSave(value: IntegrationDefinition): Promise<void>;
  onCancel(): void;
  // Host binds this write-only capability to this instance and a declared slot.
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
  initialConfig?: JsonObject;
  credentialKeys?: readonly string[];
  Settings?: ComponentType<IntegrationSettingsProps>;
}>;
