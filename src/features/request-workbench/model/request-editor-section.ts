export const requestEditorSections = [
  { id: "query", label: "Params", description: "Add query parameters to the request URL." },
  { id: "headers", label: "Headers", description: "Set HTTP request headers." },
  { id: "auth", label: "Auth", description: "Configure request authentication." },
  { id: "body", label: "Body", description: "Configure the request payload." },
  { id: "settings", label: "Settings", description: "Adjust request execution settings." },
  { id: "docs", label: "Docs", description: "Document this request with Markdown." },
] as const;

export const graphqlEditorSections = [
  { id: "gql-query", label: "Query", description: "Write a GraphQL query or mutation." },
  ...requestEditorSections.filter((section) => section.id === "headers" || section.id === "auth" || section.id === "settings" || section.id === "docs"),
] as const;

export type RequestEditorSection = (typeof requestEditorSections)[number]["id"] | "gql-query" | "gql-variables";

export function getRequestEditorSection(section: RequestEditorSection) {
  return [...requestEditorSections, ...graphqlEditorSections].find((item) => item.id === section);
}
