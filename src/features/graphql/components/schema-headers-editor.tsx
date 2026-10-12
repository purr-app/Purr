import { HeadersEditor } from "../../request-workbench/components/headers-editor";
import type { RequestHeader } from "../../request-workbench/model/request";

export function SchemaHeadersEditor({ headers, onChange }: { headers: RequestHeader[]; onChange: (headers: RequestHeader[]) => void }) {
  return <HeadersEditor fillHeight={false} headers={headers} onHeadersChange={onChange} />;
}
