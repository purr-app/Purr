import type { HttpTransportPort } from "../../application/ports/http";
import type { ObservabilityPort } from "../../application/ports/observability";
import type { ResponseContentPort } from "../../application/ports/response-content";
import type {
  CredentialResolver,
  SecureStore,
} from "../../application/ports/credentials";
import type {
  ApplicationLifecyclePort,
  DownloadPort,
  ImportDialogPort,
  ImportPort,
  OAuthCallbackPort,
  RuntimePlatform,
  RequestBodyPort,
  WorkspaceShellPort,
} from "../../application/ports/platform";
import type { WorkspacePersistence } from "../../application/workspace-persistence";

export type ApplicationServices = Readonly<{
  observability: ObservabilityPort;
  persistence: WorkspacePersistence;
  secureStore: SecureStore;
  credentialResolver: CredentialResolver;
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
