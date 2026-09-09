import {
  getRequestHeaders,
  getRequestQueryParams,
  updateRequestQueryParams,
  updateRequestHeaders,
  type RequestDraft,
} from "../model/request";
import {
  getRequestEditorSection,
  type RequestEditorSection,
} from "../model/request-editor-section";
import { BodyEditor } from "./body-editor";
import { HeadersEditor } from "./headers-editor";
import { QueryParamsEditor } from "./query-params-editor";
import { AuthEditor } from "./auth-editor";
import { CookieJarEditor } from "./cookie-jar-editor";
import type { AuthContext } from "../model/request-auth";
import type { AuthRuntime } from "../hooks/use-auth-runtime";
import type { SessionCookieJar } from "../model/cookie-jar";

type RequestSectionPanelProps = {
  activeSection: RequestEditorSection;
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
  authContext: AuthContext;
  authRuntime: AuthRuntime;
  cookieJar: SessionCookieJar;
};

export function RequestSectionPanel({
  activeSection,
  draft,
  onDraftChange,
  authContext,
  authRuntime,
  cookieJar,
}: RequestSectionPanelProps) {
  const section = getRequestEditorSection(activeSection);

  return section?.id === "body" ? (
    <BodyEditor
      body={draft.body}
      onBodyChange={(body) => onDraftChange({ ...draft, body })}
    />
  ) : section?.id === "auth" ? (
    <AuthEditor
      auth={draft.auth}
      onAuthChange={(auth) => onDraftChange({ ...draft, auth })}
      context={authContext}
      runtime={authRuntime}
    />
  ) : section?.id === "cookies" ? (
    <section
      id="request-section-cookies"
      role="region"
      aria-labelledby="request-cookies-button"
      className="h-full min-h-0 min-w-0 overflow-auto bg-purr-surface"
    >
      <CookieJarEditor
        jar={cookieJar}
        url={draft.url}
        enabled={draft.useCookieJar}
        onEnabledChange={(useCookieJar) =>
          onDraftChange({ ...draft, useCookieJar })
        }
      />
    </section>
  ) : section?.id === "query" ? (
    <section
      id="request-section-query"
      role="tabpanel"
      aria-labelledby="request-tab-query"
      className="h-full min-h-0 overflow-auto bg-purr-surface"
    >
      <QueryParamsEditor
        params={getRequestQueryParams(draft, authContext)}
        onParamsChange={(params) =>
          onDraftChange(updateRequestQueryParams(draft, params, authContext))
        }
      />
    </section>
  ) : section?.id === "headers" ? (
    <section
      id="request-section-headers"
      role="tabpanel"
      aria-labelledby="request-tab-headers"
      className="h-full min-h-0 overflow-auto bg-purr-surface"
    >
      <HeadersEditor
        headers={getRequestHeaders(draft, authContext)}
        onHeadersChange={(headers) =>
          onDraftChange(updateRequestHeaders(draft, headers, authContext))
        }
      />
    </section>
  ) : section ? (
    <section
      id={`request-section-${section.id}`}
      role="tabpanel"
      className="h-full min-h-0 overflow-auto bg-purr-surface px-ui-4 py-ui-4 sm:px-ui-5"
    >
      <div className="flex items-baseline justify-between gap-ui-4">
        <h2 className="m-ui-0 text-ui-md font-medium text-content-primary">
          {section.label}
        </h2>
        <p className="m-ui-0 text-ui-xs text-content-tertiary">
          {section.description}
        </p>
      </div>
      <div className="mt-ui-4 min-h-panel rounded-ui-lg border border-dashed border-border-subtle bg-purr-surface" />
    </section>
  ) : null;
}
