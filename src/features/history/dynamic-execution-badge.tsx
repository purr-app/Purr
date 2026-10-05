import { CircleAlert, Zap } from "lucide-react";
import type { DynamicExecutionMetadata } from "../../application/ports/history";
import { Button } from "../../shared/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../shared/components/ui/popover";
import { cn } from "../../shared/lib/cn";

export function dynamicExecutionLabel(execution: DynamicExecutionMetadata): string {
  const variable = `{{${execution.variableName}}}`;
  return `Dynamic vars execution · ${variable}${execution.extraction?.status === "error" ? ` · Extraction failed: ${execution.extraction.error || "No matching value"}` : ""}`;
}

/** Provenance is secondary to the response; extraction details open on demand. */
export function DynamicExecutionBadge({ dynamicExecution }: { dynamicExecution: DynamicExecutionMetadata }) {
  const extraction = dynamicExecution.extraction;
  const failed = extraction?.status === "error";
  return <Popover>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" title={dynamicExecutionLabel(dynamicExecution)}
        aria-label="Dynamic vars execution details"
        className={cn("shrink-0 gap-ui-1 font-ui text-ui-2xs", failed ? "text-accent-orange" : "text-content-secondary")}>
        <Zap className="size-ui-3 shrink-0" aria-hidden="true" />
        Dynamic vars execution
        {failed && <CircleAlert className="size-ui-3 shrink-0" aria-label="Extraction failed" />}
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" side="bottom" sideOffset={4}
      className="w-ui-history-popover space-y-ui-2 rounded-ui-lg border border-border bg-purr-surface p-ui-3 font-ui text-ui-sm text-content-secondary shadow-popover">
      <h3 className="font-medium text-content-primary">Dynamic vars execution</h3>
      <p>Executed to resolve <code className="break-all font-code italic text-accent-orange">{`{{${dynamicExecution.variableName}}}`}</code>.</p>
      {extraction && <>
        <div className="rounded-ui-md bg-purr-elevated p-ui-2">
          <p className="mb-ui-1 text-ui-xs text-content-tertiary">{extraction.language === "jq" ? "jq" : "JSONPath"} extraction</p>
          <code className="block break-all font-code text-ui-xs text-content-primary">{extraction.expression}</code>
        </div>
        {failed ? <p className="break-words text-status-server-error"><span className="font-medium">Extraction failed. </span>{extraction.error || "The query did not match any response value."}</p>
          : <p className="text-ui-xs text-content-tertiary">Value extracted successfully.</p>}
      </>}
      {failed && <p className="text-ui-xs text-content-tertiary">The HTTP response is preserved below. An extraction failure is separate from the HTTP status.</p>}
    </PopoverContent>
  </Popover>;
}
