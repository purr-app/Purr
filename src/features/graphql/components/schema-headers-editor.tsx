import { Checkbox } from "../../../shared/components/ui/checkbox";
import { HeadersEditor } from "../../request-workbench/components/headers-editor";
import type { RequestHeader } from "../../request-workbench/model/request";

export function SchemaHeadersEditor({ headers, onChange }: { headers: RequestHeader[]; onChange: (headers: RequestHeader[]) => void }) {
  return <div className="space-y-ui-2">
    <HeadersEditor fillHeight={false} headers={headers} onHeadersChange={onChange} />
    <div className="flex flex-wrap gap-ui-3 p-ui-3">{headers.filter((header) => header.name.trim()).map((header) => {
      const credential = /authorization|cookie|api[-_]?key|token|secret/i.test(header.name);
      return <Checkbox key={header.id} label={`Store ${header.name} securely`} checked={credential || header.secret === true} disabled={credential}
        onCheckedChange={(secret) => onChange(headers.map((item) => item.id === header.id ? { ...item, secret } : item))} />;
    })}</div>
  </div>;
}
