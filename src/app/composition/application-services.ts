import type { HttpTransportPort } from "../../application/ports/http";
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
  WorkspaceShellPort,
} from "../../application/ports/platform";
import type { WorkspacePersistence } from "../../application/workspace-persistence";

export type ApplicationServices = Readonly<{
  persistence: WorkspacePersistence;
  secureStore: SecureStore;
  credentialResolver: CredentialResolver;
  httpTransport: HttpTransportPort;
  responseContent: ResponseContentPort;
  oauthCallback: OAuthCallbackPort;
  imports: ImportPort;
  downloads: DownloadPort;
  importDialog: ImportDialogPort;
  workspaceShell: WorkspaceShellPort;
  lifecycle: ApplicationLifecyclePort;
  runtime: RuntimePlatform;
}>;
