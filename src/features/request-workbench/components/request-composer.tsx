import { ChevronDown, LoaderCircle, Network, SendHorizontal } from "lucide-react";
import type { GraphQLSchema } from "graphql";

import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { HttpMethodPicker } from "../../../shared/components/http/http-method-picker";
import { cn } from "../../../shared/lib/cn";
import {
  getEnabledRequestHeaderCount,
  getEnabledRequestQueryParamCount,
  getRequestHeaders,
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
}: RequestComposerProps) {
  const headers = getRequestHeaders(draft, authContext);

  const selectSection = onSectionChange;

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
            <Input
              className="h-control-md min-w-0 flex-1 font-code text-ui-sm sm:text-ui-md"
              variant="transparent"
              value={draft.url}
              onChange={(event) => {
                const url = event.target.value;
                onDraftChange({
                  ...draft,
                  url,
                  params: getRequestQueryParamsFromUrl(url, draft.params),
                });
              }}
              aria-label="Request URL"
              placeholder="Enter URL or use {{base_url}}"
              spellCheck="false"
            />
            {draft.graphql && <Button type="button" variant="ghost" size="sm" aria-label="Open GraphQL schema" title="Schema explorer · introspection or import" onClick={onOpenSchema}>
              <Network className="size-ui-4 text-action-graphql" /><span className="hidden lg:inline">Schema</span>
            </Button>}
            <Button
              variant={draft.graphql ? "graphql" : "default"}
              className="shadow-action"
              size="default"
              type="submit"
              disabled={sending}
            >
              {sending ? "Sending…" : "Send"}
              {sending ? (
                <LoaderCircle
                  className="size-ui-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <SendHorizontal className="size-ui-4" aria-hidden="true" />
              )}
            </Button>
          </div>
        </form>
        {onToggleDetails ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={detailsCollapsed ? "Expand request details" : "Collapse request details"}
            aria-expanded={!detailsCollapsed}
            aria-controls="request-details"
            onClick={onToggleDetails}
          >
            <ChevronDown
              className={cn("size-ui-4 transition-transform duration-ui-layout motion-reduce:transition-none", !detailsCollapsed && "rotate-180")}
              aria-hidden="true"
            />
          </Button>
        ) : null}
      </div>
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
        <RequestSectionTabs
          graphql={Boolean(draft.graphql)}
          activeSection={activeSection}
          onSectionChange={selectSection}
          bodyType={draft.body.type}
          authType={draft.auth.type}
          queryCount={getEnabledRequestQueryParamCount(
            getRequestQueryParams(draft, authContext),
          )}
          headerCount={getEnabledRequestHeaderCount(headers)}
          hasHeaderError={hasRequestHeaderValidationError(headers)}
        />
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
            />
        </div>
      </div>
    </section>
  );
}
