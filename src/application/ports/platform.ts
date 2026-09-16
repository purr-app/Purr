import type {
  ImportSource,
  NormalizedImportResult,
} from "../../importing/contracts";
import type { SecureStore } from "./credentials";
import type { HttpTransportPort } from "./http";
import type { RequestFileRef } from "./http";
import type { PersistencePort } from "./persistence";
import type { ResponseContentPort } from "./response-content";
import type { ObservabilityPort } from "./observability";

export interface OAuthCallbackPort {
  authorize(input: {
    authorizationUrl: string;
    redirectUri: string;
    state: string;
    sessionId: string;
  }): Promise<string>;
  cancel(sessionId: string): Promise<void>;
}

export interface ImportPort {
  normalize(
    source: ImportSource,
    workspaceId: string,
  ): Promise<NormalizedImportResult>;
}

export interface DownloadPort {
  saveInlineResponse(
    bodyBase64: string,
    suggestedName: string,
    mediaType: string,
  ): Promise<string | null>;
}

export interface RequestBodyPort {
  stage(file: File, signal?: AbortSignal): Promise<RequestFileRef>;
  release(reference: RequestFileRef): Promise<void>;
}

export interface ImportDialogPort {
  choosePath(directory: boolean): Promise<string | null>;
}

export interface WorkspaceShellPort {
  openWorkspaceFolder(id: string): Promise<void>;
}

export type CloseRequest = { preventDefault(): void };
export interface ApplicationLifecyclePort {
  onCloseRequested(
    listener: (request: CloseRequest) => void | Promise<void>,
  ): Promise<() => void>;
  exit(): Promise<void>;
}

export type RuntimePlatform = Readonly<{
  kind: "browser" | "desktop";
  os: "macos" | "other";
}>;

export type PlatformAdapters = Readonly<{
  observability: ObservabilityPort;
  persistenceBackend: PersistencePort;
  secureStore: SecureStore;
  httpTransport: HttpTransportPort;
  responseContent: ResponseContentPort;
  oauthCallback: OAuthCallbackPort;
  imports: ImportPort;
  downloads: DownloadPort;
  requestBodies: RequestBodyPort;
  importDialog: ImportDialogPort;
  workspaceShell: WorkspaceShellPort;
  lifecycle: ApplicationLifecyclePort;
  runtime: RuntimePlatform;
}>;
