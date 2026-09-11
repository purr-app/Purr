import { useState } from "react";
import { Eye, EyeOff, LockKeyhole, Plus, Trash2 } from "lucide-react";
import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { Checkbox } from "../../../shared/components/ui/checkbox";
import { Modal } from "../../../shared/components/ui/modal";
import { validateEnvironment, type Environment } from "../model/workspace";

export function EnvironmentEditor({ initial, onSave, onClose }: {
  initial: Environment; onSave: (environment: Environment) => void; onClose: () => void;
}) {
  const [environment, setEnvironment] = useState(initial);
  const [error, setError] = useState("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  return <Modal title="Environment variables" onClose={onClose}>
    <form onSubmit={(event) => {
      event.preventDefault();
      const validation = validateEnvironment(environment);
      if (validation) { setError(validation); return; }
      onSave({ ...environment, name: environment.name.trim(), variables: environment.variables
        .filter((variable) => variable.name.trim()).map((variable) => ({ ...variable, name: variable.name.trim() })) });
    }}>
      <div className="space-y-ui-4 p-ui-5">
        <label className="block space-y-ui-2 text-ui-sm text-content-secondary">Environment name
          <Input autoFocus className="ui-focus-ring" aria-label="Environment name" value={environment.name} placeholder="Local, Staging, Production…"
            onChange={(event) => setEnvironment({ ...environment, name: event.target.value })} />
        </label>
        <p className="text-ui-sm text-content-secondary">Use <code className="font-code text-action-brand">{"{{variable}}"}</code> in URLs, headers, parameters, authentication, or request bodies.</p>
        <div className="max-h-ui-variable-list space-y-ui-2 overflow-auto p-ui-1">
          {environment.variables.map((variable, index) => {
            const update = (patch: Partial<typeof variable>) => setEnvironment((current) => ({ ...current,
              variables: current.variables.map((row) => row.id === variable.id ? { ...row, ...patch, ...(patch.value !== undefined ? { secretLoaded: true } : {}) } : row),
            }));
            return <div key={variable.id} className="flex items-center gap-ui-2">
              <Checkbox checked={variable.enabled} onCheckedChange={(enabled) => update({ enabled })} label={`Enable variable ${index + 1}`} hideLabel />
              <Input className="ui-focus-ring min-w-0 flex-1 font-code" aria-label={`Variable ${index + 1} name`} placeholder="variable_name" value={variable.name} onChange={(event) => update({ name: event.target.value })} spellCheck={false} />
              <Input className="ui-focus-ring min-w-0 flex-1 font-code" type={(revealed[variable.id] ?? !variable.secret) ? "text" : "password"} aria-label={`Variable ${index + 1} value`} placeholder="value" value={variable.value} onChange={(event) => update({ value: event.target.value })} spellCheck={false} autoComplete="off" />
              <Button type="button" variant="ghost" size="icon" aria-label={`Secret variable ${index + 1}`} aria-pressed={variable.secret} title="Store value securely on this device" className={variable.secret ? "text-action-brand" : "text-content-tertiary"} onClick={() => update({ secret: !variable.secret })}>
                <LockKeyhole className="size-ui-4" />
              </Button>
              <Button type="button" variant="ghost" size="icon" aria-label={`Reveal variable ${index + 1}`} aria-pressed={revealed[variable.id] ?? !variable.secret} title="Show or hide value" onClick={() => setRevealed((current) => ({ ...current, [variable.id]: !(current[variable.id] ?? !variable.secret) }))}>
                {(revealed[variable.id] ?? !variable.secret) ? <Eye className="size-ui-4" /> : <EyeOff className="size-ui-4" />}
              </Button>
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove variable ${index + 1}`} onClick={() => setEnvironment({ ...environment, variables: environment.variables.filter((row) => row.id !== variable.id) })}><Trash2 className="size-ui-4" /></Button>
            </div>;
          })}
          {!environment.variables.length && <p className="py-ui-6 text-center text-ui-sm text-content-tertiary">No variables yet. Add your first variable below.</p>}
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={() => setEnvironment({ ...environment, variables: [...environment.variables, { id: crypto.randomUUID(), name: "", value: "", enabled: true, secret: false }] })}><Plus className="size-ui-4" />Add variable</Button>
        {error && <p role="alert" className="text-ui-sm text-accent-red">{error}</p>}
        <p className="text-ui-xs text-content-tertiary">Plain values are shared in the workspace. Secret values stay in this device’s secure store; only their references are shared.</p>
      </div>
      <div className="flex justify-end gap-ui-2 border-t border-border p-ui-4">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="brand">Save environment</Button>
      </div>
    </form>
  </Modal>;
}
