export const requestEditorSections = [
  { id: "body", label: "Body", description: "Configure the request payload." },
  { id: "query", label: "Params", description: "Add query parameters to the request URL." },
  { id: "headers", label: "Headers", description: "Set HTTP request headers." },
  { id: "auth", label: "Auth", description: "Configure request authentication." },
  { id: "settings", label: "Settings", description: "Adjust request execution settings." },
] as const;

export type RequestEditorSection = (typeof requestEditorSections)[number]["id"];

export function getRequestEditorSection(section: RequestEditorSection) {
  return requestEditorSections.find((item) => item.id === section);
}
