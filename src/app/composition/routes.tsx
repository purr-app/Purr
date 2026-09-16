import type { ComponentType } from "react";

import { WorkspaceWorkbench } from "../../features/workspaces/workspace-workbench";

export type AppRouteDefinition = Readonly<{
  id: string;
  path: string;
  component: ComponentType;
}>;

export type AppComposition = Readonly<{
  routes: readonly AppRouteDefinition[];
  defaultPath: string;
}>;

const coreRoutes: readonly AppRouteDefinition[] = [
  Object.freeze({
    id: "core.workbench",
    path: "/workbench",
    component: WorkspaceWorkbench,
  }),
];

export function createAppComposition(
  additionalRoutes: readonly AppRouteDefinition[] = [],
): AppComposition {
  return freezeAppComposition([...coreRoutes, ...additionalRoutes], "/workbench");
}

export function extendAppComposition(
  composition: AppComposition,
  additionalRoutes: readonly AppRouteDefinition[],
): AppComposition {
  return freezeAppComposition([...composition.routes, ...additionalRoutes], composition.defaultPath);
}

function freezeAppComposition(routes: readonly AppRouteDefinition[], defaultPath: string): AppComposition {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const route of routes) {
    if (!route.id.trim() || !route.path.startsWith("/"))
      throw new Error("Application routes require a stable ID and absolute path.");
    if (ids.has(route.id))
      throw new Error(`Duplicate application route ID: ${route.id}`);
    if (paths.has(route.path))
      throw new Error(`Duplicate application route path: ${route.path}`);
    ids.add(route.id);
    paths.add(route.path);
  }
  return Object.freeze({
    routes: Object.freeze(routes.map((route) => Object.freeze({ ...route }))),
    defaultPath,
  });
}

export const coreComposition = createAppComposition();
