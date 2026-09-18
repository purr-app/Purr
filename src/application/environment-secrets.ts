import type { Environment } from "../features/workspaces/model/workspace";
import type { SecureStore } from "./ports/credentials";

export async function resolveEnvironmentSecrets(environment: Environment, store: SecureStore): Promise<Environment> {
  const variables = await Promise.all(environment.variables.map(async (variable) => variable.kind === "static" && variable.sensitive && variable.loaded === false && variable.secretRef
    ? { ...variable, value: await store.get(variable.secretRef) ?? "", loaded: true } : variable));
  return variables.every((variable, index) => variable === environment.variables[index])
    ? environment
    : { ...environment, variables };
}
