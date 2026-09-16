import type { HttpTransportPort } from "../application/ports/http";
import type { ResponseContentPort } from "../application/ports/response-content";
import type {
  ExtensionLogger,
  IntegrationPresentationContribution,
} from "../integrations/contracts";
import {
  extensionApiVersion,
  type ExtensionDocumentController,
  type ExtensionModuleContext,
  type ExtensionPage,
  type ExtensionPageContribution,
  type ExtensionRegistrar,
  type PurrExtensionModule,
  type WorkspaceDocumentTypeContribution,
} from "./contracts";

const stableId = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const localId = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const routeSegment = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export type RegisteredExtensionPage = Readonly<ExtensionPageContribution & ExtensionPage & {
  moduleId: string;
  fullPath: string;
}>;
export type RegisteredDocumentType = Readonly<WorkspaceDocumentTypeContribution & {
  moduleId: string;
  controller: ExtensionDocumentController;
}>;
export type OwnedContribution<T> = Readonly<T & { moduleId: string }>;

export type ExtensionRegistry = Readonly<{
  modules: readonly PurrExtensionModule["manifest"][];
  integrations: readonly OwnedContribution<IntegrationPresentationContribution>[];
  pages: readonly RegisteredExtensionPage[];
  documentTypes: readonly RegisteredDocumentType[];
  integration(id: string): OwnedContribution<IntegrationPresentationContribution> | undefined;
  documentType(extensionType: string): RegisteredDocumentType | undefined;
}>;

export type ExtensionHostCapabilities = Readonly<{ httpTransport: HttpTransportPort; responseContent: ResponseContentPort }>;

const freezeList = <T extends object>(items: T[]): readonly Readonly<T>[] => Object.freeze(items.map((item) => Object.freeze(item)));
const assertStableId = (value: string, label: string) => {
  if (!stableId.test(value)) throw new Error(`${label} must be a stable lowercase identifier: ${value || "<empty>"}`);
};

function logger(moduleId: string): ExtensionLogger {
  const write = (level: "debug" | "info" | "warn" | "error", message: string, details?: Readonly<Record<string, unknown>>) => {
    globalThis.console[level](`[extension:${moduleId}] ${message}`, details ?? {});
  };
  return Object.freeze({
    debug: (message: string, details?: Readonly<Record<string, unknown>>) => write("debug", message, details),
    info: (message: string, details?: Readonly<Record<string, unknown>>) => write("info", message, details),
    warn: (message: string, details?: Readonly<Record<string, unknown>>) => write("warn", message, details),
    error: (message: string, details?: Readonly<Record<string, unknown>>) => write("error", message, details),
  });
}

export function createExtensionRegistry(
  modules: readonly PurrExtensionModule[],
  capabilities: ExtensionHostCapabilities,
): ExtensionRegistry {
  const moduleIds = new Set<string>();
  const manifests = modules.map((module) => Object.freeze({ ...module.manifest }));
  for (const manifest of manifests) {
    assertStableId(manifest.id, "Extension module ID");
    if (manifest.extensionApi !== extensionApiVersion)
      throw new Error(`Extension module ${manifest.id} requires unsupported extension API ${manifest.extensionApi}.`);
    if (!manifest.version.trim()) throw new Error(`Extension module ${manifest.id} requires a version.`);
    if (moduleIds.has(manifest.id)) throw new Error(`Duplicate extension module ID: ${manifest.id}`);
    moduleIds.add(manifest.id);
  }

  const integrations: OwnedContribution<IntegrationPresentationContribution>[] = [];
  const pages: RegisteredExtensionPage[] = [];
  const documentTypes: RegisteredDocumentType[] = [];
  const integrationIds = new Set<string>();
  const pageIds = new Set<string>();
  const paths = new Set(["/", "/workbench"]);
  const documentTypeIds = new Set<string>();
  let frozen = false;

  const assertOpen = () => {
    if (frozen) throw new Error("Extension registries are frozen after application composition.");
  };
  const register = <T,>(target: T[], contribution: T) => {
    assertOpen();
    target.push(contribution);
  };
  try {
    for (let index = 0; index < modules.length; index += 1) {
      const module = modules[index];
      const moduleId = manifests[index].id;
      const context: ExtensionModuleContext = Object.freeze({
        moduleId,
        http: capabilities.httpTransport,
        responseContent: capabilities.responseContent,
        logger: logger(moduleId),
      });
      const registrar: ExtensionRegistrar = Object.freeze({
        integrations: Object.freeze({
          register: (value: IntegrationPresentationContribution) => {
            assertOpen();
            assertStableId(value.id, "Integration presentation ID");
            if (integrationIds.has(value.id)) throw new Error(`Duplicate integration presentation ID: ${value.id}`);
            if (!value.label.trim()) throw new Error(`Invalid integration presentation contribution: ${value.id}`);
            integrationIds.add(value.id);
            register(integrations, { ...value, moduleId });
          },
        }),
        pages: Object.freeze({ register: (value: ExtensionPageContribution) => {
          assertOpen();
          if (!localId.test(value.id)) throw new Error(`Extension page ID must be local and stable: ${value.id || "<empty>"}`);
          if (!routeSegment.test(value.routeSegment)) throw new Error(`Invalid extension page route segment: ${value.routeSegment || "<empty>"}`);
          const id = `${moduleId}.${value.id}`; const fullPath = `/extensions/${moduleId}/${value.routeSegment}`;
          if (pageIds.has(id)) throw new Error(`Duplicate extension page ID: ${id}`);
          if (paths.has(fullPath)) throw new Error(`Duplicate application route path: ${fullPath}`);
          if (!value.title.trim() || value.navigation && !value.navigation.label.trim()) throw new Error(`Invalid extension page contribution: ${id}`);
          const page = value.create(context);
          const navigation = value.navigation ? Object.freeze({ ...value.navigation }) : undefined;
          pageIds.add(id); paths.add(fullPath); register(pages, { ...value, ...page, navigation, moduleId, fullPath });
        } }),
        documentTypes: Object.freeze({ register: (value: WorkspaceDocumentTypeContribution) => {
          assertOpen();
          assertStableId(value.extensionType, "Extension document type");
          if (documentTypeIds.has(value.extensionType)) throw new Error(`Duplicate extension document type: ${value.extensionType}`);
          if (!value.label.trim()) throw new Error(`Invalid extension document type: ${value.extensionType}`);
          const controller = Object.freeze({ ...value.create(context) });
          documentTypeIds.add(value.extensionType); register(documentTypes, { ...value, moduleId, controller });
        } }),
      });
      module.register(registrar);
    }
  } finally {
    frozen = true;
  }
  const frozenIntegrations = freezeList(integrations);
  const frozenDocumentTypes = freezeList(documentTypes);
  return Object.freeze({
    modules: Object.freeze(manifests),
    integrations: frozenIntegrations,
    pages: freezeList([...pages].sort((left, right) => (left.navigation?.order ?? 0) - (right.navigation?.order ?? 0))),
    documentTypes: frozenDocumentTypes,
    integration: (id: string) => frozenIntegrations.find((integration) => integration.id === id),
    documentType: (extensionType: string) => frozenDocumentTypes.find((type) => type.extensionType === extensionType),
  });
}
