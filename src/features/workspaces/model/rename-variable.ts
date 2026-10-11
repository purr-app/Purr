import type { RequestDraft, RequestHeader } from "../../request-workbench/model/request";
import type { RequestAuth } from "../../request-workbench/model/request-auth";
import { isRequestDocument, type Variable, type Workspace } from "./workspace";

export type VariableRenames = ReadonlyMap<string, string>;

export function variableRenames(previous: readonly Variable[], next: readonly Variable[]): VariableRenames {
  const byId = new Map(previous.map((variable) => [variable.id, variable.name]));
  return new Map(next.flatMap((variable) => {
    const before = byId.get(variable.id);
    return before && before !== variable.name ? [[before, variable.name] as const] : [];
  }));
}

/** Replace complete template tokens only, including URL-encoded query templates. */
export function renameTemplateReferences(value: string, renames: VariableRenames): string {
  return value.replace(/{{\s*([^{}]+?)\s*}}|%7B%7B(?:(?!%7D%7D).)*%7D%7D/gi, (token: string, name: string | undefined) => {
    if (name !== undefined) {
      const next = renames.get(name.trim());
      return next === undefined ? token : token.replace(name.trim(), () => next);
    }
    try {
      const decoded = decodeURIComponent(token);
      const renamed = renameTemplateReferences(decoded, renames);
      return renamed === decoded ? token : encodeURIComponent(renamed);
    } catch { return token; }
  });
}

export function renameVariableDefinitions(variables: readonly Variable[], renames: VariableRenames): Variable[] {
  return variables.map((variable) => ({ ...variable, name: renames.get(variable.name) ?? variable.name,
    ...(variable.kind === "static" ? { value: renameTemplateReferences(variable.value, renames) } : {}),
  }));
}

/** Validate the family of same-name overrides before changing any references. */
export function variableRenameError(workspaces: readonly Workspace[], previous: Variable | undefined, next: Variable): string {
  if (!previous || previous.name === next.name.trim()) return "";
  for (const workspace of workspaces) {
    for (const scope of [workspace.variables, ...workspace.environments.map((environment) => environment.variables)]) {
      if (scope.some((variable) => variable.id !== previous.id && variable.name === next.name.trim()))
        return `Variable “${next.name.trim()}” already exists in an affected scope in “${workspace.name}”.`;
    }
  }
  return "";
}

/** Refactor definitions and editable snapshots, never response/history data or opaque extension config. */
export function renameWorkspaceReferences(workspace: Workspace, renames: VariableRenames): Workspace {
  if (!renames.size) return workspace;
  const text = (value: string) => renameTemplateReferences(value, renames);
  const auth = (value: RequestAuth): RequestAuth => ({ ...value,
    bearer: { ...value.bearer, token: text(value.bearer.token), prefix: text(value.bearer.prefix) },
    basic: { username: text(value.basic.username), password: text(value.basic.password) },
    apiKey: { ...value.apiKey, name: text(value.apiKey.name), value: text(value.apiKey.value) },
    oauth2: { ...value.oauth2, authorizationUrl: text(value.oauth2.authorizationUrl), tokenUrl: text(value.oauth2.tokenUrl),
      clientId: text(value.oauth2.clientId), clientSecret: text(value.oauth2.clientSecret), scopes: text(value.oauth2.scopes), redirectUri: text(value.oauth2.redirectUri) },
  });
  const headers = <T extends RequestHeader>(values: T[]): T[] => values.map((header) => ({ ...header, name: text(header.name), value: text(header.value) }));
  const pairs = <T extends { key: string; value: string }>(values: T[]): T[] => values.map((field) => ({ ...field, key: text(field.key), value: text(field.value) }));
  const request = (value: RequestDraft): RequestDraft => ({ ...value,
    url: text(value.url), documentation: text(value.documentation), headers: headers(value.headers),
    params: pairs(value.params), pathParams: value.pathParams && pairs(value.pathParams), auth: auth(value.auth),
    graphql: value.graphql && { ...value.graphql, query: text(value.graphql.query), variables: text(value.graphql.variables), operationName: text(value.graphql.operationName) },
    body: { ...value.body, json: text(value.body.json), xml: text(value.body.xml), text: text(value.body.text),
      formData: pairs(value.body.formData).map((field) => ({ ...field, contentType: field.contentType && text(field.contentType) })), urlEncoded: pairs(value.body.urlEncoded) },
  });
  return { ...workspace,
    variables: renameVariableDefinitions(workspace.variables, renames),
    environments: workspace.environments.map((environment) => ({ ...environment, variables: renameVariableDefinitions(environment.variables, renames) })),
    requestConfig: { ...workspace.requestConfig, headers: headers(workspace.requestConfig.headers),
      auth: workspace.requestConfig.auth.map((profile) => ({ ...profile, value: auth(profile.value) })) },
    documents: workspace.documents.map((document) => {
      if (isRequestDocument(document)) return document.historical ? document : { ...document,
        request: request(document.request), savedRequest: document.savedRequest && request(document.savedRequest) };
      if (document.kind === "schema") return { ...document, endpoint: text(document.endpoint), auth: auth(document.auth), introspectionHeaders: headers(document.introspectionHeaders) };
      return document;
    }),
    dynamicVariableCache: {},
  };
}
