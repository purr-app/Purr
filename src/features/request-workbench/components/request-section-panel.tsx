import {
  getRequestHeaders,
  getRequestPathParams,
  getRequestQueryParams,
  updateRequestPathParams,
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
import type { AuthContext } from "../model/request-auth";
import type { AuthRuntime } from "../hooks/use-auth-runtime";
import type { GraphQLSchema } from "graphql";
import { GraphqlQueryEditor } from "../../graphql/components/graphql-query-editor";
import type { TemplateVariableActions } from "./template-variable-popover";
import { MarkdownDocumentationEditor } from "./markdown-documentation-editor";

type RequestSectionPanelProps = {
  schema?: GraphQLSchema;
  onOpenGraphqlType?: (name: string) => void;
  onRunGraphqlOperation?: (name: string) => void;
  activeSection: RequestEditorSection;
  draft: RequestDraft;
  effectiveDraft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
  authContext: AuthContext;
  authRuntime: AuthRuntime;
  variableActions: TemplateVariableActions;
};

export function RequestSectionPanel({
  activeSection,
  draft,
  onDraftChange,
  authContext,
  authRuntime,
  schema,
  onOpenGraphqlType,
  onRunGraphqlOperation,
  effectiveDraft,
  variableActions,
}: RequestSectionPanelProps) {
  const section = getRequestEditorSection(activeSection);

  if (draft.graphql && (activeSection === "gql-query" || activeSection === "gql-variables")) return <GraphqlQueryEditor
    value={draft.graphql} schema={schema} onOpenType={onOpenGraphqlType} onRunOperation={onRunGraphqlOperation}
    templateVariableActions={variableActions}
    onChange={(graphql) => onDraftChange({ ...draft, graphql })} />;

  if (activeSection === "docs") return <MarkdownDocumentationEditor
    value={draft.documentation}
    onChange={(documentation) => onDraftChange({ ...draft, documentation })}
  />;

  return section?.id === "body" ? (
    <BodyEditor
      body={draft.body}
      onBodyChange={(body) => onDraftChange({ ...draft, body })}
      variableActions={variableActions}
    />
  ) : section?.id === "auth" ? (
    <AuthEditor
      auth={effectiveDraft.auth}
      onAuthChange={(auth) => onDraftChange({
        ...draft,
        auth,
        workspace: {
          ...draft.workspace,
          authEnabled: auth.type === "none"
            ? false
            : auth.type === "inherit"
              ? true
              : draft.workspace.authEnabled,
        },
      })}
      context={authContext}
      runtime={authRuntime}
      variableActions={variableActions}
    />
  ) : section?.id === "query" ? (
    <section
      id="request-section-query"
      role="tabpanel"
      aria-labelledby="request-tab-query"
      className="h-full min-h-0 overflow-auto bg-purr-surface"
    >
      <QueryParamsEditor
        pathParams={getRequestPathParams(draft)}
        onPathParamsChange={(pathParams) =>
          onDraftChange(updateRequestPathParams(draft, pathParams))
        }
        params={getRequestQueryParams(draft, authContext)}
        variableActions={variableActions}
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
        headers={getRequestHeaders(effectiveDraft, authContext)}
        variableActions={variableActions}
        onWorkspaceHeaderEnabledChange={(id, enabled) =>
          onDraftChange({
            ...draft,
            workspace: {
              ...draft.workspace,
              headersEnabled: enabled ? true : draft.workspace.headersEnabled,
              headerOverrides: {
                ...draft.workspace.headerOverrides,
                [id]: enabled,
              },
            },
          })
        }
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
