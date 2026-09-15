import {
  createContext,
  useContext,
  type PropsWithChildren,
} from "react";

import type { ApplicationServices } from "./composition/application-services";

const ApplicationServicesContext = createContext<ApplicationServices | null>(
  null,
);

export function ApplicationServicesProvider({
  services,
  children,
}: PropsWithChildren<{ services: ApplicationServices }>) {
  return (
    <ApplicationServicesContext.Provider value={services}>
      {children}
    </ApplicationServicesContext.Provider>
  );
}

export function useApplicationServices() {
  const services = useContext(ApplicationServicesContext);
  if (!services)
    throw new Error(
      "Application services are unavailable outside the Purr application shell.",
    );
  return services;
}
