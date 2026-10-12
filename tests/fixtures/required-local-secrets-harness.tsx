import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { RequiredLocalSecrets } from "../../src/features/workspaces/components/required-local-secrets";
import { createWorkspace } from "../../src/features/workspaces/model/workspace";
import { MemorySecureStore } from "../../src/storage/secrets";
import type { ProtectedState } from "../../src/application/ports/persistence";

export async function mountRequiredSecretsFixture() {
  const workspace = createWorkspace("Synthetic fixture", "secret-fixture");
  const reference = "purr/secret-fixture/variables/token";
  workspace.variables = [{ id: "token", name: "token", kind: "static", enabled: true, sensitive: true, value: "", secretRef: reference }];
  const secure = new MemorySecureStore();
  await secure.set(reference, "MUST_NOT_RENDER_EXISTING_VALUE");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const events: Array<{ ref: string; value: string | null }> = [];
  const render = (protectedState: ProtectedState = { status: "available" }) => root.render(createElement(RequiredLocalSecrets, {
    workspace, globalVariables: [], secure, protectedState, migrationRequired: true,
    onOpenOwner: () => {}, onRetry: async () => {},
    onSetValue: async (ref, value) => { events.push({ ref, value }); if (value === null) await secure.delete(ref); else await secure.set(ref, value); },
  }));
  render();
  return { events, render };
}
