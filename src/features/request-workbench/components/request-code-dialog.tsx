import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "../../../shared/components/ui/button";
import { Modal } from "../../../shared/components/ui/modal";
import { SegmentedTabs } from "../../../shared/components/ui/segmented-tabs";
import type { SessionCookieJar } from "../model/cookie-jar";
import { formatRequestCode, type RequestCodeFormat } from "../model/request-code";
import type { RequestDraft } from "../model/request";
import type { AuthContext } from "../model/request-auth";
import { maskCookieHeader, mergeCookieHeader, type WireRequest } from "../services/http-client";
import { prepareWireRequest } from "../services/execute-request";
import { ResponseCodeViewer } from "./response-code-viewer";

function withCookies(request: WireRequest, jar: SessionCookieJar, enabled: boolean, masked = false): WireRequest {
  if (!enabled) return request;
  const manual = request.headers.filter(([name]) => name.toLowerCase() === "cookie").map(([, value]) => value).join("; ");
  const cookies = mergeCookieHeader(manual, jar.header(request.url, "strict"));
  return {
    ...request,
    headers: [...request.headers.filter(([name]) => name.toLowerCase() !== "cookie"), ...(cookies ? [["Cookie", masked ? maskCookieHeader(cookies) : cookies] as [string, string]] : [])],
  };
}

export function RequestCodeDialog({ draft, context, cookieJar, onClose }: {
  draft: RequestDraft;
  context: AuthContext;
  cookieJar: SessionCookieJar;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<RequestCodeFormat>("curl");
  const [request, setRequest] = useState<WireRequest | null>(null);
  const [displayRequest, setDisplayRequest] = useState<WireRequest | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let current = true;
    void prepareWireRequest(draft, context).then((prepared) => {
      if (current) {
        setRequest(withCookies(prepared.request, cookieJar, draft.useCookieJar));
        setDisplayRequest(withCookies(prepared.displayRequest, cookieJar, draft.useCookieJar, true));
      }
    }).catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { current = false; };
  }, [context, cookieJar, draft]);
  const shownRequest = revealed ? request : displayRequest;
  const code = useMemo(() => shownRequest ? formatRequestCode(shownRequest, format) : "", [format, shownRequest]);
  useEffect(() => setCopied(false), [format]);
  return <Modal title="Request code" onClose={onClose} className="w-ui-dialog">
    <div className="flex min-h-panel flex-col">
      <div className="flex items-center justify-between gap-ui-3 border-b border-border-subtle px-ui-4 py-ui-2">
        <SegmentedTabs id="request-code-format" panelId="request-code-panel" label="Request code format" value={format}
          options={[{ value: "curl", label: "cURL" }, { value: "wget", label: "wget" }, { value: "http", label: "HTTP/1.1" }]} onValueChange={setFormat} />
        <div className="flex items-center gap-ui-1"><Button type="button" variant="ghost" size="icon" aria-label={revealed ? "Hide request secrets" : "Reveal request secrets"} aria-pressed={revealed} title={revealed ? "Hide request secrets" : "Reveal request secrets"} onClick={() => setRevealed(!revealed)}>
          {revealed ? <EyeOff className="size-ui-4" /> : <Eye className="size-ui-4" />}
        </Button><Button type="button" variant="secondary" size="sm" disabled={!code} onClick={async () => {
          try { await navigator.clipboard.writeText(code); setCopied(true); } catch { /* The code remains selectable. */ }
        }}>{copied ? <Check className="size-ui-4" /> : <Copy className="size-ui-4" />}{copied ? "Copied" : "Copy"}</Button></div>
      </div>
      <div id="request-code-panel" role="tabpanel" className="min-h-panel bg-purr-codefield">
        {error ? <p role="alert" className="m-ui-0 p-ui-4 font-code text-ui-sm text-accent-red">{error}</p>
          : shownRequest ? <ResponseCodeViewer value={code} language="text" ariaLabel="Request code viewer" />
            : <p role="status" className="m-ui-0 p-ui-4 text-ui-sm text-content-tertiary">Preparing request…</p>}
      </div>
    </div>
  </Modal>;
}
