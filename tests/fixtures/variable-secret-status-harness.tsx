import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ApplicationServicesProvider } from "../../src/app/application-services-context";
import type { ApplicationServices } from "../../src/app/composition/application-services";
import { VariablesExplorer, type VariableScope } from "../../src/features/workspaces/components/variables-explorer";
import { createWorkspace, type Variable } from "../../src/features/workspaces/model/workspace";
import { MemorySecureStore } from "../../src/storage/secrets";

// Definitions can become visible while the durable credential write is queued.
export function mountVariableSecretStatusFixture() {
  const secure = new MemorySecureStore();
  let finishSave: (() => void) | undefined;
  const services = { persistence: { secure } } as ApplicationServices;
  const globals: Variable[] = [];
  function Fixture() {
    const [workspace, setWorkspace] = useState(() => createWorkspace("Status fixture", "status-fixture"));
    const [scope, setScope] = useState<VariableScope>("workspace");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draft, setDraft] = useState<Variable | null>(null);
    return <ApplicationServicesProvider services={services}><VariablesExplorer workspace={workspace} globalVariables={globals}
      scope={scope} selectedId={selectedId} draft={draft} documents={[]}
      onScopeChange={setScope} onSelectionChange={setSelectedId} onDraftChange={setDraft}
      onWorkspaceVariablesChange={(variables) => setWorkspace({ ...workspace, variables })}
      onGlobalVariablesChange={() => {}} onEnvironmentChange={() => {}} onDeleteEnvironment={() => {}}
      onOpenRequest={() => {}} onResolveVariable={async () => undefined}
      onSaveVariables={async (_, variables) => {
        setWorkspace({ ...workspace, variables });
        await new Promise<void>((resolve) => { finishSave = resolve; });
        for (const variable of variables) if (variable.kind === "static" && variable.sensitive && variable.secretRef && variable.value)
          await secure.set(variable.secretRef, variable.value);
      }} /></ApplicationServicesProvider>;
  }
  createRoot(document.body.appendChild(document.createElement("div"))).render(<Fixture />);
  return { finishSave: () => finishSave?.() };
}
