import type { Environment } from "../features/workspaces/model/workspace";
import type { SecureStore } from "../storage/contracts";

export async function resolveEnvironmentSecrets(environment: Environment, store: SecureStore): Promise<Environment> {
  return { ...environment, variables: await Promise.all(environment.variables.map(async (variable) => variable.secret && variable.secretLoaded === false && variable.secretRef
    ? { ...variable, value: await store.get(variable.secretRef) ?? "", secretLoaded: true } : variable)) };
}
