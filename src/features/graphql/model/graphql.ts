import { buildClientSchema, buildSchema, getOperationAST, Kind, parse, print, printSchema, validateSchema, type IntrospectionQuery } from "graphql";
import type { RequestDraft } from "../../request-workbench/model/request";

export function prepareGraphqlRequest(draft: RequestDraft): RequestDraft {
  if (!draft.graphql) return draft;
  const { query, variables: rawVariables, operationName } = draft.graphql;
  if (!query.trim()) throw new Error("Enter a GraphQL query or mutation.");
  const document = parse(query);
  const operations = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
  const operation = getOperationAST(document, operationName.trim() || undefined);
  if (!operation) throw new Error(operations.length > 1 && !operationName.trim()
    ? "Select an operation to send when the query contains multiple operations."
    : "The selected GraphQL operation was not found.");
  if (operation.operation === "subscription") throw new Error("Subscriptions require a streaming transport. Send a query or mutation over HTTP.");
  let variables: unknown;
  try { variables = rawVariables.trim() ? JSON.parse(rawVariables) : {}; }
  catch { throw new Error("GraphQL variables must be valid JSON."); }
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) throw new Error("GraphQL variables must be a JSON object.");
  return { ...draft, method: "POST", body: { ...draft.body, type: "json", json: JSON.stringify({ query, variables,
    ...(operationName.trim() ? { operationName: operationName.trim() } : {}) }) } };
}

export function parseGraphqlSchema(text: string) {
  let schema;
  if (text.trimStart().startsWith("{")) {
    const result = JSON.parse(text);
    if (result.errors?.length) throw new Error(result.errors.map((error: { message: string }) => error.message).join("\n"));
    schema = buildClientSchema((result.data ?? result) as IntrospectionQuery);
  } else schema = buildSchema(text);
  const errors = validateSchema(schema);
  if (errors.length) throw new Error(errors.map((error) => error.message).join("\n"));
  return schema;
}

export function normalizeSchema(text: string): string {
  const schema = parseGraphqlSchema(text);
  // Printing the imported AST preserves applied custom directives and extensions,
  // which cannot be reconstructed by printSchema's introspection representation.
  return text.trimStart().startsWith("{") ? printSchema(schema) : print(parse(text));
}
