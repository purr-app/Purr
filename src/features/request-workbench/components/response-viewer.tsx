import { useMemo, useState } from "react";
import { Button } from "../../../shared/components/ui/button";
import { cn } from "../../../shared/lib/cn";
import { formatPayloadSize } from "../model/request-body";
import type { HttpResult } from "../services/http-client";

export function ResponseViewer({ response }: { response: HttpResult }) {
  const [tab, setTab] = useState<"body" | "headers">("body");
  const content = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(response.text), null, 2);
    } catch {
      return response.text;
    }
  }, [response.text]);
  return (
    <section
      aria-label="HTTP response"
      className="mt-ui-5 min-w-0 overflow-hidden rounded-ui-xl bg-purr-codefield"
    >
      <div className="flex flex-wrap items-center justify-between gap-ui-3 bg-purr-elevated p-ui-3">
        <div className="flex items-center gap-ui-2">
          <span className="text-ui-md font-medium">Response</span>
          <span
            className={cn(
              "font-code text-ui-xs",
              response.status < 400
                ? "text-syntax-string"
                : "text-accent-orange",
            )}
          >
            {response.status} {response.statusText}
          </span>
        </div>
        <div className="flex items-center gap-ui-3 font-code text-ui-xs text-content-tertiary">
          <span>{response.durationMs} ms</span>
          <span>{formatPayloadSize(response.size)}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setTab(tab === "body" ? "headers" : "body")}
          >
            {tab === "body" ? "View headers" : "View body"}
          </Button>
        </div>
      </div>
      <pre className="ui-auth-preview whitespace-pre-wrap break-words p-ui-4 font-code text-ui-sm text-syntax-property">
        {tab === "body"
          ? content || "Empty response"
          : response.headers
              .map(([name, value]) => `${name}: ${value}`)
              .join("\n")}
      </pre>
    </section>
  );
}
