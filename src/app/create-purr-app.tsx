import type { AppRelease } from "../application/ports/release";
import { UpdateController, type AppUpdater } from "../features/updates/update-controller";
import { UpdateProvider } from "../features/updates/update-context";
import { UpdateNotifications } from "../features/updates/update-ui";
import type { ComponentType } from "react";

import { ThemeProvider } from "../shared/theme/theme-provider";
import { AppRouter } from "./app-router";
import { ApplicationServicesProvider } from "./application-services-context";
import { ExtensionRegistryProvider } from "../extension-api/extension-context";
import { createExtensionRegistry } from "../extension-api/registry";
import type { PurrExtensionModule } from "../extension-api/contracts";
import type { ApplicationServices } from "./composition/application-services";
import { createCoreServices } from "./composition/core-services";
import {
  coreComposition,
  extendAppComposition,
  type AppComposition,
} from "./composition/routes";

export type CreatePurrAppOptions = Readonly<{
  release?: AppRelease;
  updater?: AppUpdater;
  composition?: AppComposition;
  services?: ApplicationServices;
  modules?: readonly PurrExtensionModule[];
}>;

export function createPurrApp(
  options: CreatePurrAppOptions = {},
): ComponentType {
  const updates = new UpdateController(options.updater);
  const services = options.services ?? createCoreServices();
  const extensions = createExtensionRegistry(options.modules ?? [], services);
  const composition = extendAppComposition(options.composition ?? coreComposition, extensions.pages.map((page) => ({
    id: `${page.moduleId}.${page.id}`,
    path: page.fullPath,
    component: page.component,
  })));

  return function PurrApp() {
    return (
      <ApplicationServicesProvider services={services}>
        <ExtensionRegistryProvider registry={extensions}>
          <ThemeProvider>
            <UpdateProvider controller={updates} release={options.release}>
              <AppRouter composition={composition} />
              <UpdateNotifications />
            </UpdateProvider>
          </ThemeProvider>
        </ExtensionRegistryProvider>
      </ApplicationServicesProvider>
    );
  };
}
