import type { ComponentType } from "react";

import type { PurrExtensionModule } from "../extension-api/contracts";
import { createPurrApp as createInternalPurrApp } from "./create-purr-app";

export type CreatePurrAppOptions = Readonly<{ modules?: readonly PurrExtensionModule[] }>;

export function createPurrApp(options: CreatePurrAppOptions = {}): ComponentType {
  return createInternalPurrApp(options);
}
