import { Download, FileArchive } from "lucide-react";
import { useMemo, useState } from "react";

import { useApplicationServices } from "../../../app/application-services-context";
import type { HttpExchange } from "../../../domain/http";
import { Button } from "../../../shared/components/ui/button";
import { formatPayloadSize } from "../model/request-body";
import { getResponseContentType, getResponseFileName, type ResponseBodyKind } from "../model/response";

export function NativeResponseDownloadButton({ exchange, compact = false }: { exchange: HttpExchange; compact?: boolean }) {
  const { responseContent } = useApplicationServices();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const mediaType = getResponseContentType(exchange.response.headers)
    || exchange.content.mediaType
    || "application/octet-stream";
  const fileName = useMemo(
    () => getResponseFileName(exchange.response.headers, exchange.response.url, mediaType),
    [exchange.response.headers, exchange.response.url, mediaType],
  );
  return (
    <div className="flex min-w-0 items-center gap-ui-2">
      <Button
        type="button"
        size={compact ? "xs" : "default"}
        variant={compact ? "ghost" : "brand"}
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          setError("");
          setResult("");
          try {
            const path = await responseContent.save(exchange.content, { fileName, mediaType });
            if (path) setResult(`Saved to ${path}`);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not save the response.");
          } finally {
            setSaving(false);
          }
        }}
      >
        <Download className="size-ui-3" aria-hidden="true" />
        {saving ? "Saving…" : "Download"}
      </Button>
      {result ? <span role="status" className="max-w-validation-popover truncate font-code text-ui-xs text-status-success" title={result}>{result}</span> : null}
      {error ? <span role="alert" className="max-w-validation-popover font-code text-ui-xs text-accent-red">{error}</span> : null}
    </div>
  );
}

export function NativeMediaResponse({ exchange, kind }: { exchange: HttpExchange; kind: Extract<ResponseBodyKind, "image" | "audio" | "video"> }) {
  const { responseContent } = useApplicationServices();
  const source = useMemo(() => responseContent.mediaUrl(exchange.content), [exchange.content, responseContent]);
  const mediaType = getResponseContentType(exchange.response.headers)
    || exchange.content.mediaType
    || "application/octet-stream";
  return (
    <div className="flex h-full min-h-0 flex-col bg-purr-codefield">
      <div className="flex min-w-0 items-center justify-between gap-ui-2 border-b border-border-subtle bg-purr-surface p-ui-2">
        <div className="flex min-w-0 items-center gap-ui-2">
          <span className="rounded-ui-md bg-action-brand-surface px-ui-2 py-ui-1 font-code text-ui-xs font-medium text-action-brand">{kind[0].toUpperCase() + kind.slice(1)}</span>
          <span className="truncate font-code text-ui-xs text-content-tertiary">{mediaType}</span>
          <span className="font-code text-ui-xs text-content-tertiary">{formatPayloadSize(exchange.content.byteLength)}</span>
        </div>
        <NativeResponseDownloadButton exchange={exchange} compact />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-ui-3">
        {kind === "image" ? <img src={source} alt="Response preview" className="max-h-full max-w-full object-contain" />
          : kind === "audio" ? <audio aria-label="Audio response preview" className="w-full max-w-validation-popover" controls preload="metadata" src={source} />
            : <video aria-label="Video response preview" className="max-h-full max-w-full" controls preload="metadata" src={source} />}
      </div>
    </div>
  );
}

export function NativeBinaryResponse({ exchange }: { exchange: HttpExchange }) {
  const mediaType = getResponseContentType(exchange.response.headers)
    || exchange.content.mediaType
    || "application/octet-stream";
  const fileName = getResponseFileName(exchange.response.headers, exchange.response.url, mediaType);
  return <div className="flex h-full items-center justify-center bg-purr-codefield p-ui-4">
    <div className="flex max-w-ui-dialog flex-col items-center gap-ui-3 text-center">
      <span className="flex size-control-xl items-center justify-center rounded-ui-xl bg-action-brand-surface text-action-brand"><FileArchive className="size-ui-6" /></span>
      <div><h3 className="m-ui-0 text-ui-md font-medium text-content-primary">Binary response</h3>
        <p className="mb-ui-0 mt-ui-1 text-ui-sm text-content-tertiary">This format cannot be previewed safely. Choose where to save the original response.</p></div>
      <div className="font-code text-ui-xs text-content-secondary"><span>{fileName}</span><span aria-hidden="true"> · </span><span>{mediaType}</span><span aria-hidden="true"> · </span><span>{formatPayloadSize(exchange.content.byteLength)}</span></div>
      <NativeResponseDownloadButton exchange={exchange} />
    </div>
  </div>;
}
