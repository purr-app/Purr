import { createContext, useContext } from "react";

/** Read-only editor metadata. Values are never resolved by UI controls. */
export type TemplateVariableDefinition = {
  id: string;
  name: string;
  enabled: boolean;
  sensitive: boolean;
  kind: "static" | "dynamic-request" | "external-secret";
  value?: string;
  secretRef?: string;
};
export type TemplateVariableActions = {
  definitions: readonly TemplateVariableDefinition[];
  onOpenVariable: (id: string) => void;
  onCreateMissingVariable: (name: string, kind: "static" | "dynamic-request", sensitive?: boolean) => void;
};
export const TemplateVariableContext = createContext<TemplateVariableActions | undefined>(undefined);
export const TemplateVariableProvider = TemplateVariableContext.Provider;
export const useTemplateVariableActions = () => useContext(TemplateVariableContext);
