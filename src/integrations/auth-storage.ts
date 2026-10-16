import type { SecureStore } from "../application/ports/credentials";
import { normalizeRequestAuth, type OAuthToken, type RequestAuth } from "../features/request-workbench/model/request-auth";
import { secretRef } from "../storage/secrets";

export const integrationCredentialRef = (workspace: string, integration: string, key: string) => secretRef(workspace, `integrations/${integration}`, key);
export const integrationTokenRef = (workspace: string, integration: string) => secretRef(workspace, `integrations/${integration}`, "oauth-token", "runtime");
const definition = (value: string) => {
  const auth = normalizeRequestAuth(JSON.parse(value));
  const { credentialStates: _states, secretRefs: _refs, credentialStorage: _storage, ...config } = auth;
  return JSON.stringify({ ...config,
    bearer: { ...auth.bearer, token: auth.type === "bearer" ? auth.bearer.token : "" },
    basic: { ...auth.basic, password: auth.type === "basic" ? auth.basic.password : "" },
    apiKey: { ...auth.apiKey, value: auth.type === "api-key" ? auth.apiKey.value : "" },
    oauth2: { ...auth.oauth2, clientSecret: auth.type === "oauth2" ? auth.oauth2.clientSecret : "", token: null },
  });
};
export async function readIntegrationCredential(store: SecureStore, workspace: string, integration: string, key: string): Promise<string | null> {
  const value = await store.get(integrationCredentialRef(workspace, integration, key));
  if (key !== "auth" || value === null) return value;
  const runtime = await store.get(integrationTokenRef(workspace, integration));
  if (!runtime) return value;
  const snapshot = JSON.parse(runtime) as { definition: string; auth: RequestAuth };
  if (snapshot.definition !== definition(value)) return value;
  return JSON.stringify(normalizeRequestAuth(snapshot.auth));
}
/** The host passes its preparation store, so both ownership classes publish atomically. */
export async function stageIntegrationCredential(store: SecureStore, workspace: string, integration: string, key: string, value: string): Promise<void> {
  if (key !== "auth") { await store.set(integrationCredentialRef(workspace, integration, key), value); return; }
  const auth = normalizeRequestAuth(JSON.parse(value)); const config = definition(value);
  await store.set(integrationCredentialRef(workspace, integration, key), config);
  await store.set(integrationTokenRef(workspace, integration), JSON.stringify({ definition: config, auth }));
}
export function integrationTokenRecord(value: string, token: OAuthToken): string {
  const auth = normalizeRequestAuth(JSON.parse(value));
  return JSON.stringify({ definition: definition(value), auth: { ...auth, oauth2: { ...auth.oauth2, token } } });
}
