import { LoaderCircle, SendHorizontal } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { Button } from "../../../shared/components/ui/button";
import { Input } from "../../../shared/components/ui/input";
import { HttpMethodPicker } from "../../../shared/components/http/http-method-picker";
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
import type { SessionCookieJar } from "../model/cookie-jar";

type RequestComposerProps = {
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
  onSend: () => void;
  sending: boolean;
  authContext: AuthContext;
  authRuntime: AuthRuntime;
  cookieJar: SessionCookieJar;
};

export function RequestComposer({
  draft,
  onDraftChange,
  onSend,
  sending,
  authContext,
  authRuntime,
  cookieJar,
}: RequestComposerProps) {
  const [activeSection, setActiveSection] =
    useState<RequestEditorSection>("query");
  useSyncExternalStore(cookieJar.subscribe, cookieJar.getVersion);
  const headers = getRequestHeaders(draft, authContext);

  const selectSection = (section: RequestEditorSection) =>
    setActiveSection(section);

  return (
    <section
      className="flex min-w-0 flex-col gap-ui-3"
      aria-label="Request composer"
    >
      <div className="overflow-hidden rounded-ui-xl border-emphasis border-purr-elevated bg-purr-elevated shadow-panel px-ui-2 pt-2">
        <form
          className="bg-purr-codefield p-ui-2 rounded-ui-lg"
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
          cookieCount={cookieJar.list().length}
          useCookieJar={draft.useCookieJar}
        />
      </div>
      <RequestSectionPanel
        activeSection={activeSection}
        draft={draft}
        onDraftChange={onDraftChange}
        authContext={authContext}
        authRuntime={authRuntime}
        cookieJar={cookieJar}
      />
    </section>
  );
}
