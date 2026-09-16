import { createContext, useContext, type PropsWithChildren } from "react";

import type { ExtensionRegistry } from "./registry";

const emptyRegistry: ExtensionRegistry = Object.freeze({
  modules: Object.freeze([]), integrations: Object.freeze([]), traceProviders: Object.freeze([]),
  correlationExtractors: Object.freeze([]), pages: Object.freeze([]), documentTypes: Object.freeze([]),
  integration: () => undefined, documentType: () => undefined,
});
const ExtensionContext = createContext<ExtensionRegistry>(emptyRegistry);

export function ExtensionRegistryProvider({ registry, children }: PropsWithChildren<{ registry: ExtensionRegistry }>) {
  return <ExtensionContext.Provider value={registry}>{children}</ExtensionContext.Provider>;
}
export function useExtensionRegistry(): ExtensionRegistry {
  return useContext(ExtensionContext);
}
