import type { AppRelease } from "../application/ports/release";
export type { AppRelease } from "../application/ports/release";
import type { AppUpdater } from "../features/updates/update-controller";
export type { AppUpdater, AppUpdate } from "../features/updates/update-controller";
import type { ComponentType } from "react";

import type { PurrExtensionModule } from "../extension-api/contracts";
import { createPurrApp as createInternalPurrApp } from "./create-purr-app";

export type CreatePurrAppOptions = Readonly<{ release?: AppRelease; updater?: AppUpdater; modules?: readonly PurrExtensionModule[] }>;

export function createPurrApp(options: CreatePurrAppOptions = {}): ComponentType {
  return createInternalPurrApp(options);
}
