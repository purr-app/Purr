import { ChevronDown, LoaderCircle, SendHorizontal } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

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
import {
  RequestCookiesButton,
  RequestSectionTabs,
} from "./request-section-tabs";
import type { RequestEditorSection } from "../model/request-editor-section";
import type { AuthContext } from "../model/request-auth";
import type { AuthRuntime } from "../hooks/use-auth-runtime";
import type { SessionCookieJar } from "../model/cookie-jar";

type RequestComposerProps = {
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
  onSend: () => void;
  sending: boolean;
  authContext: AuthContext;
  authRuntime: AuthRuntime;
  cookieJar: SessionCookieJar;
  detailsCollapsed?: boolean;
  onToggleDetails?: () => void;
};

export function RequestComposer({
  draft,
  onDraftChange,
  onSend,
  sending,
  authContext,
  authRuntime,
  cookieJar,
  detailsCollapsed = false,
  onToggleDetails,
}: RequestComposerProps) {
  const [activeSection, setActiveSection] =
    useState<RequestEditorSection>("query");
  useSyncExternalStore(cookieJar.subscribe, cookieJar.getVersion);
  const headers = getRequestHeaders(draft, authContext);

  const selectSection = (section: RequestEditorSection) => setActiveSection(section);

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-ui-xl border border-border-subtle shadow-panel"
      aria-label="Request composer"
    >
      <div
        className="flex h-request-toolbar shrink-0 items-center gap-ui-2 border-b border-border-subtle bg-purr-elevated p-ui-3"
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
            <HttpMethodPicker
              value={draft.method}
              onValueChange={(method) => onDraftChange({ ...draft, method })}
            />
            <Input
              className="min-w-0 flex-1 font-code text-ui-sm sm:text-ui-md"
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
              spellCheck="false"
            />
            <Button
              className="shadow-action"
              size="lg"
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
          activeSection={activeSection}
          onSectionChange={selectSection}
          bodyType={draft.body.type}
          authType={draft.auth.type}
          queryCount={getEnabledRequestQueryParamCount(
            getRequestQueryParams(draft, authContext),
          )}
          headerCount={getEnabledRequestHeaderCount(headers)}
          hasHeaderError={hasRequestHeaderValidationError(headers)}
          trailing={
            <RequestCookiesButton
              active={activeSection === "cookies"}
              cookieCount={cookieJar.list().length}
              useCookieJar={draft.useCookieJar}
              onClick={() => selectSection("cookies")}
            />
          }
        />
        <div className="min-h-0 flex-1 overflow-hidden">
            <RequestSectionPanel
              activeSection={activeSection}
              draft={draft}
              onDraftChange={onDraftChange}
              authContext={authContext}
              authRuntime={authRuntime}
              cookieJar={cookieJar}
            />
        </div>
      </div>
    </section>
  );
}
