import type { ComponentType } from "react";

import type { HttpTransportPort } from "../application/ports/http";
import type { ResponseContentPort } from "../application/ports/response-content";
import type { ExtensionDocumentDefinition, JsonObject } from "../domain/project";
import type {
  ExtensionLogger,
  IntegrationPresentationContribution,
} from "../integrations/contracts";

export const extensionApiVersion = 1 as const;

export type ExtensionModuleContext = Readonly<{
  moduleId: string;
  http: HttpTransportPort;
  responseContent: ResponseContentPort;
  logger: ExtensionLogger;
}>;

export type ExtensionNavigationContribution = Readonly<{
  area: "primary";
  label: string;
  order?: number;
}>;
export type ExtensionPage = Readonly<{ component: ComponentType }>;
export type ExtensionPageContribution = Readonly<{
  id: string;
  routeSegment: string;
  title: string;
  navigation?: ExtensionNavigationContribution;
  create(context: ExtensionModuleContext): ExtensionPage;
}>;

export type ExtensionDocumentChange = Readonly<{ configVersion: number; config: JsonObject }>;
export type ExtensionDocumentEditorProps = Readonly<{
  document: ExtensionDocumentDefinition;
  onChange(change: ExtensionDocumentChange): void;
}>;
export type ExtensionDocumentController = Readonly<{
  editor: ComponentType<ExtensionDocumentEditorProps>;
  createNew(): Readonly<{ name: string; configVersion: number; config: JsonObject }>;
}>;
export type WorkspaceDocumentTypeContribution = Readonly<{
  extensionType: string;
  label: string;
  validateAndMigrate(configVersion: number, config: JsonObject): ExtensionDocumentChange;
  create(context: ExtensionModuleContext): ExtensionDocumentController;
}>;

export interface ExtensionContributionRegistrar<T> {
  register(contribution: T): void;
}
export type ExtensionMenuActionContext = Readonly<{
  openPage(pageId: string): void;
  openDialog(dialog: { title: string; component: ComponentType<{ onClose(): void }> }): void;
  notify(message: { title: string; description?: string; variant?: "info" | "success" | "warning" | "error" }): void;
}>;
export type ExtensionMenuContribution = Readonly<{
  id: string; label: string; icon?: ComponentType<{ className?: string }>; order?: number;
  action: Readonly<{ type: "link"; url: string } | { type: "action"; run(context: ExtensionMenuActionContext): void | Promise<void> }>;
}>;
export type ExtensionRegistrar = Readonly<{
  menuItems: ExtensionContributionRegistrar<ExtensionMenuContribution>;
  integrations: ExtensionContributionRegistrar<IntegrationPresentationContribution>;
  pages: ExtensionContributionRegistrar<ExtensionPageContribution>;
  documentTypes: ExtensionContributionRegistrar<WorkspaceDocumentTypeContribution>;
}>;
export type PurrExtensionModule = Readonly<{
  manifest: Readonly<{ id: string; extensionApi: typeof extensionApiVersion; version: string }>;
  register(registrar: ExtensionRegistrar): void;
}>;

export function defineExtensionModule(module: PurrExtensionModule): PurrExtensionModule {
  return module;
}
