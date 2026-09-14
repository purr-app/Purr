import { Network, SendHorizontal } from "lucide-react";
import type { GraphQLSchema } from "graphql";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../../../shared/components/ui/button";
import { HttpMethodPicker } from "../../../shared/components/http/http-method-picker";
import { cn } from "../../../shared/lib/cn";
import {
  getEnabledRequestHeaderCount,
  getEnabledRequestPathParamCount,
  getEnabledRequestQueryParamCount,
  getRequestHeaders,
  getRequestPathParams,
  getRequestPathParamsFromUrl,
  getRequestQueryParams,
  getRequestQueryParamsFromUrl,
  hasRequestHeaderValidationError,
  type RequestDraft,
} from "../model/request";
import { RequestSectionPanel } from "./request-section-panel";
import { RequestSectionTabs } from "./request-section-tabs";
import type { RequestEditorSection } from "../model/request-editor-section";
import type { AuthContext } from "../model/request-auth";
import type { AuthRuntime } from "../hooks/use-auth-runtime";
import { applyWorkspaceRequestConfig, type RequestKind, type WorkspaceRequestConfig } from "../model/request-workspace-config";
import type { Variable } from "../../workspaces/model/workspace";
import { TemplateVariablePopover, type TemplateVariableActions } from "./template-variable-popover";
import { ColorizedUrlInput } from "./colorized-url-input";
import { isCurlCommand } from "../model/curl-import";

type RequestComposerProps = {
  schema?: GraphQLSchema;
  onOpenSchema?: () => void;
  onOpenGraphqlType?: (name: string) => void;
  onRunGraphqlOperation?: (name: string) => void;
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
  onSend: () => void;
  sending: boolean;
  authContext: AuthContext;
  authRuntime: AuthRuntime;
  detailsCollapsed?: boolean;
  onToggleDetails?: () => void;
  activeSection: RequestEditorSection;
  onSectionChange: (section: RequestEditorSection) => void;
  onOpenCode: () => void;
  urlInvalid?: boolean;
  requestKind: RequestKind;
  workspaceConfig: WorkspaceRequestConfig;
  variableDefinitions: readonly Variable[];
  onOpenVariable: (id: string) => void;
  onCreateMissingVariable: (name: string, kind: "static" | "dynamic-request", sensitive?: boolean) => void;
  onImportCurl: (command: string) => void;
};

export function RequestComposer({
  draft,
  onDraftChange,
  onSend,
  sending,
  authContext,
  authRuntime,
  detailsCollapsed = false,
  onToggleDetails,
  activeSection,
  onSectionChange,
  schema,
  onOpenSchema,
  onOpenGraphqlType,
  onRunGraphqlOperation,
  onOpenCode,
  urlInvalid = false,
  requestKind,
  workspaceConfig,
  variableDefinitions,
  onOpenVariable,
  onCreateMissingVariable,
  onImportCurl,
}: RequestComposerProps) {
  const effectiveDraft = applyWorkspaceRequestConfig(draft, requestKind, workspaceConfig);
  const headers = getRequestHeaders(effectiveDraft, authContext);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!sending) {
      setElapsed(0);
      return;
    }
    const started = performance.now();
    const timer = window.setInterval(() => setElapsed(performance.now() - started), 50);
    return () => window.clearInterval(timer);
  }, [sending]);

  const selectSection = onSectionChange;
  const variableActionsRef = useRef<TemplateVariableActions>({ definitions: variableDefinitions, onOpenVariable, onCreateMissingVariable });
  variableActionsRef.current = { definitions: variableDefinitions, onOpenVariable, onCreateMissingVariable };
  const variableActions = useMemo<TemplateVariableActions>(() => ({
    get definitions() { return variableActionsRef.current.definitions; },
    onOpenVariable: (id) => variableActionsRef.current.onOpenVariable(id),
    onCreateMissingVariable: (name, kind, sensitive) => variableActionsRef.current.onCreateMissingVariable(name, kind, sensitive),
  }), []);

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-ui-xl border shadow-panel"
      aria-label="Request composer"
    >
      <div
        className="flex h-request-toolbar shrink-0 items-center gap-ui-2 border-b border-border-subtle bg-purr-elevated p-ui-1"
        data-request-url-bar
      >
        <form
          className="min-w-0 flex-1 rounded-ui-lg bg-purr-codefield p-ui-1"
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <div className="flex items-center gap-ui-2">
            {draft.graphql ? <span className="inline-flex h-control-md shrink-0 items-center rounded-ui-md bg-action-graphql-surface px-ui-3 font-code text-ui-md text-action-graphql">GQL</span> : <HttpMethodPicker
              value={draft.method}
              onValueChange={(method) => onDraftChange({ ...draft, method })}
            />}
            <div className="min-w-0 flex-1"><TemplateVariablePopover value={draft.url} actions={variableActions} onValueChange={(url) => onDraftChange({ ...draft, url, params: getRequestQueryParamsFromUrl(url, draft.params), pathParams: getRequestPathParamsFromUrl(url, draft.pathParams) })}>{(bindings) => <ColorizedUrlInput
              className={cn(urlInvalid && "border-accent-red")}
              value={draft.url}
              {...bindings}
              aria-label="Request URL"
              aria-invalid={urlInvalid}
              placeholder="Enter URL, paste cURL, or use {{variable}}"
              spellCheck="false"
              onPaste={(event) => {
                const command = event.clipboardData.getData("text/plain");
                if (!isCurlCommand(command)) return;
                event.preventDefault();
                onImportCurl(command);
              }}
            />}</TemplateVariablePopover></div>
            {draft.graphql && <Button type="button" variant="ghost" size="sm" aria-label="Open GraphQL schema" title="Schema explorer · introspection or import" onClick={onOpenSchema}>
              <Network className="size-ui-4 text-action-graphql" /><span className="hidden lg:inline">Schema</span>
            </Button>}
            <Button
              variant={sending ? "secondary" : draft.graphql ? "graphql" : "default"}
              className={cn(
                "shadow-action",
                sending && (draft.graphql
                  ? "border-action-graphql-border bg-action-graphql-surface text-action-graphql"
                  : "border-action-emerald-border bg-action-emerald-surface text-action-emerald"),
              )}
              size="default"
              type={sending ? "button" : "submit"}
              aria-label={sending ? `Request running, ${Math.round(elapsed)} milliseconds. Press Escape to cancel` : "Send"}
            >
              {sending ? (
                <>
                  <span className={cn("size-ui-2 animate-pulse rounded-full", draft.graphql ? "bg-action-graphql" : "bg-action-emerald")} aria-hidden="true" />
                  <span>Running ·</span>
                  <span className="font-semibold text-content-primary">{Math.round(elapsed)} ms</span>
                  <span aria-hidden="true" className={cn("h-control-xs border-l", draft.graphql ? "border-action-graphql-border" : "border-action-emerald-border")} />
                  <span className="text-content-secondary">esc</span>
                </>
              ) : (
                <>Send<SendHorizontal className="size-ui-4" aria-hidden="true" /></>
              )}
            </Button>
          </div>
        </form>
      </div>
      <RequestSectionTabs
          graphql={Boolean(draft.graphql)}
          activeSection={activeSection}
          onSectionChange={(section) => {
            selectSection(section);
            if (detailsCollapsed) onToggleDetails?.();
          }}
          bodyType={draft.body.type}
          authType={effectiveDraft.auth.type}
          queryCount={getEnabledRequestQueryParamCount(
            getRequestQueryParams(draft, authContext),
          ) + getEnabledRequestPathParamCount(getRequestPathParams(draft))}
          headerCount={getEnabledRequestHeaderCount(headers)}
          hasHeaderError={hasRequestHeaderValidationError(headers)}
          onOpenCode={onOpenCode}
          detailsCollapsed={detailsCollapsed}
          onToggleDetails={onToggleDetails}
        />
      <div
        id="request-details"
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden bg-purr-surface transition-opacity duration-ui-layout motion-reduce:transition-none",
          detailsCollapsed ? "opacity-ui-hidden" : "opacity-ui-visible",
        )}
        data-request-details={detailsCollapsed ? "collapsed" : "expanded"}
        aria-hidden={detailsCollapsed}
        inert={detailsCollapsed}
      >
        <div className="min-h-0 flex-1 overflow-hidden">
            <RequestSectionPanel
              schema={schema}
              onOpenGraphqlType={onOpenGraphqlType}
              onRunGraphqlOperation={onRunGraphqlOperation}
              activeSection={activeSection}
              draft={draft}
              onDraftChange={onDraftChange}
              authContext={authContext}
              authRuntime={authRuntime}
              effectiveDraft={effectiveDraft}
              variableActions={variableActions}
            />
        </div>
      </div>
    </section>
  );
}
