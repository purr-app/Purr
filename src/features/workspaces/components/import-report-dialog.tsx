import type { ImportReport } from "../../../importing/contracts";
import { Modal } from "../../../shared/components/ui/modal";
import { Button } from "../../../shared/components/ui/button";

const labels: Record<keyof ImportReport["counts"], string> = {
  http: "HTTP requests", graphql: "GraphQL requests", folders: "Folders", environments: "Environments",
  variables: "Variables", secrets: "Secrets stored securely", schemas: "Schemas", integrations: "Integrations",
};
export function ImportReportDialog({ report, onClose }: { report: ImportReport; onClose: () => void }) {
  const groups = new Map<string, ImportReport["diagnostics"]>();
  for (const item of report.diagnostics) {
    const key = `${item.code}:${item.message}`;
    const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
  }
  return <Modal title="Import complete" onClose={onClose} initialFocus="dialog">
    <div className="space-y-ui-4 p-ui-5">
      <p className="text-ui-sm text-content-secondary">Imported resources have been saved.</p>
      <dl className="grid grid-cols-2 gap-ui-2 text-ui-sm">
        {(Object.keys(labels) as Array<keyof typeof labels>).filter((key) => report.counts[key] > 0).map((key) =>
          <div key={key} className="flex items-center justify-between gap-ui-2 rounded-ui-md bg-purr-surface p-ui-2"><dt>{labels[key]}</dt><dd className="font-code">{report.counts[key]}</dd></div>)}
      </dl>
      {report.diagnostics.length > 0 ? <div className="space-y-ui-2">
        <h3 className="text-ui-sm font-medium">Warnings and unsupported features ({report.diagnostics.length})</h3>
        <div className="max-h-ui-variable-list space-y-ui-2 overflow-auto text-ui-xs">
          {[...groups.entries()].map(([key, diagnostics]) => <details key={key} className="rounded-ui-md border border-border p-ui-2">
            <summary className="ui-focus-ring cursor-pointer rounded-ui-sm">{diagnostics[0].message} ({diagnostics.length})</summary>
            <ul className="space-y-ui-1 pt-ui-2 text-content-secondary">{diagnostics.map((item, index) => <li key={index} className="break-all font-code">{item.sourcePath ?? item.resourceId ?? item.code}</li>)}</ul>
          </details>)}
        </div>
      </div> : <p className="text-ui-sm text-content-secondary">No unsupported features found.</p>}
      <div className="flex justify-end"><Button variant="brand" onClick={onClose}>Done</Button></div>
    </div>
  </Modal>;
}
