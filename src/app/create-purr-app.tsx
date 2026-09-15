import type { ComponentType } from "react";

import { ThemeProvider } from "../shared/theme/theme-provider";
import { AppRouter } from "./app-router";
import { ApplicationServicesProvider } from "./application-services-context";
import type { ApplicationServices } from "./composition/application-services";
import { createCoreServices } from "./composition/core-services";
import {
  coreComposition,
  type AppComposition,
} from "./composition/routes";

export type CreatePurrAppOptions = Readonly<{
  composition?: AppComposition;
  services?: ApplicationServices;
}>;

export function createPurrApp(
  options: CreatePurrAppOptions = {},
): ComponentType {
  const composition = options.composition ?? coreComposition;
  const services = options.services ?? createCoreServices();

  return function PurrApp() {
    return (
      <ApplicationServicesProvider services={services}>
        <ThemeProvider>
          <AppRouter composition={composition} />
        </ThemeProvider>
      </ApplicationServicesProvider>
    );
  };
}
