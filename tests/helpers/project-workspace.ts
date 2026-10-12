import { projectWorkspace } from "../../src/application/project-projection";
import type { SecureStore } from "../../src/application/ports/credentials";
import type { Workspace } from "../../src/features/workspaces/model/workspace";

/** Round-trip fixtures explicitly publish their separately prepared credentials. */
export async function projectAndCommit(workspace: Workspace, secure: SecureStore) {
  const { secrets, ...persisted } = await projectWorkspace(workspace, secure);
  await secure.commit(secrets);
  return persisted;
}
