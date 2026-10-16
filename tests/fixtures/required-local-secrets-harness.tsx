import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { RequiredLocalSecrets } from "../../src/features/workspaces/components/required-local-secrets";
import { createWorkspace } from "../../src/features/workspaces/model/workspace";
import { MemorySecureStore } from "../../src/storage/secrets";
import type { ProtectedState } from "../../src/application/ports/persistence";

export async function mountRequiredSecretsFixture() {
  const workspace = createWorkspace("Synthetic fixture", "secret-fixture");
  const reference = "purr/secret-fixture/credentials/variables/token";
  workspace.variables = [{ id: "token", name: "token", kind: "static", enabled: true, sensitive: true, value: "", secretRef: reference }];
  const secure = new MemorySecureStore();
  await secure.set(reference, "MUST_NOT_RENDER_EXISTING_VALUE");
  let resolutionCalls = 0;
  const resolve = secure.resolve.bind(secure);
  secure.resolve = async (ref) => { resolutionCalls++; return resolve(ref); };
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const owners: string[] = [];
  const events: Array<{ ref: string; value: string | null }> = [];
  const retries: ProtectedState[] = [];
  let failNextSave = false;
  let retryResult: ProtectedState | undefined;
  let retryGate: Promise<void> | undefined;
  let releaseRetry: (() => void) | undefined;
  const render = (protectedState: ProtectedState = { status: "available" }, runtimeProtectedState?: ProtectedState) => root.render(createElement(RequiredLocalSecrets, {
    workspace, globalVariables: [], secure, protectedState, migrationRequired: true,
    runtimeProtectedState,
    onOpenOwner: (ownerId) => { owners.push(ownerId); }, onRetry: async () => {
      retries.push(protectedState);
      await retryGate;
      const result = retryResult ?? runtimeProtectedState ?? protectedState;
      render(result);
      return result;
    },
    onCreateSecret: async () => { throw new Error("Creation is covered by workspace integration tests."); },
    onSetValue: async (ref, value) => { if (failNextSave) { failNextSave = false; throw new Error("Synthetic save failure"); } events.push({ ref, value }); if (value === null) await secure.delete(ref); else await secure.set(ref, value); },
  }));
  render();
  return { events, owners, retries, render,
    resolutionCalls: () => resolutionCalls,
    failSave: () => { failNextSave = true; },
    setRetryResult: (state: ProtectedState) => { retryResult = state; },
    holdRetry: () => { retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; }); },
    releaseRetry: () => releaseRetry?.(),
    renderEmpty: () => { workspace.variables = []; render(); },
    renderLegacy: () => { workspace.variables = [{ ...workspace.variables[0], secretRef: "purr/secret-fixture/variables/token" }]; render(); } };
}
