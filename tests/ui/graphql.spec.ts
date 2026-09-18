import { expect, test, type Page } from "@playwright/test";
import { installPersistenceMock } from "./persistence-mock";
test.beforeEach(async ({ page }) => installPersistenceMock(page));
import { buildSchema, introspectionFromSchema } from "graphql";

const sdl = `
  """A customer in the current workspace."""
  type Customer implements Node {
    id: ID!
    name: String!
    tier: Tier!
    oldName: String @deprecated(reason: "Use name instead")
    address: Address
  }
  type Address { city: String! }
  interface Node { id: ID! }
  enum Tier { FREE ENTERPRISE }
  input CustomerDetails { active: Boolean note: String }
  input CustomerInput { name: String! tier: Tier details: CustomerDetails }
  type Query { customer(id: ID!): Customer customers: [Customer!]! }
  type Mutation { update(input: CustomerInput!): Customer! }
`;
const query = "query Customer($id: ID!) { customer(id: $id) { id name } }";
const tabs = (page: Page) => page.getByRole("tablist", { name: "Documents", exact: true }).getByRole("tab");
const saved = (page: Page) => expect(page.getByRole("status").filter({ hasText: "Saved locally" })).toBeVisible();

async function createGraphql(page: Page) {
  await page.getByRole("button", { name: "Create document", exact: true }).click();
  await page.getByRole("menuitem", { name: "GraphQL request", exact: true }).click();
}

async function createSchema(page: Page) {
  await page.getByRole("button", { name: "Create document", exact: true }).click();
  await page.getByRole("menuitem", { name: "GraphQL schema", exact: true }).click();
}

async function createEnvironmentVariable(page: Page) {
  await page.getByRole("button", { name: "Select environment" }).click();
  await page.getByRole("button", { name: "New environment", exact: true }).click();
  await page.getByLabel("Environment name", { exact: true }).fill("GraphQL local");
  await page.getByRole("button", { name: "Variable", exact: true }).click();
  await page.getByLabel("Variable name", { exact: true }).fill("customer_id");
  await page.getByLabel("Variable value", { exact: true }).fill("42");
  await page.getByRole("button", { name: "Save variable", exact: true }).click();
  await page.getByRole("tab", { name: "Variables", exact: true }).hover();
  await page.getByRole("button", { name: "Close variables", exact: true }).click();
}

async function mockDesktop(page: Page) {
  await page.addInitScript(({ introspection }) => {
    (window as any).isTauri = true;
    (window as any).__requests = [];
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any) => {
        if (command !== "start_http") return;
        (window as any).__requests.push(args.request);
        const payload = JSON.parse(atob(args.request.bodyBase64));
        if ((window as any).__holdGraphqlRequest && payload.operationName !== "IntrospectionQuery") {
          await new Promise<void>((resolve) => {
            (window as any).__releaseGraphqlRequest = () => {
              (window as any).__holdGraphqlRequest = false;
              resolve();
            };
          });
        }
        const body = payload.operationName === "IntrospectionQuery"
          ? ((window as any).__failIntrospection ? { errors: [{ message: "Introspection disabled" }] } : { data: introspection })
          : (window as any).__graphqlNoErrors ? { data: { customer: { id: "42", name: "Ada" } } }
            : { data: { customer: { id: "42", name: "Ada" } }, errors: [{ message: "Partial field warning", path: ["customer", "name"], locations: [{ line: 1, column: 42 }], extensions: { code: "PARTIAL_DATA" } }], extensions: { traceId: "trace-42" } };
        return { status: 200, statusText: "OK", durationMs: 12, httpVersion: "HTTP/2", headers: [["content-type", "application/json"], ["set-cookie", "gql-session=one; Path=/; Secure; HttpOnly"]], bodyBase64: btoa(JSON.stringify(body)) };
      },
    };
  }, { introspection: introspectionFromSchema(buildSchema(sdl)) });
}

test("GraphQL creation menus, last-used request type, and saved query snapshots", async ({ page }) => {
  await page.goto("/");
  await createGraphql(page);
  const sections = page.getByRole("tablist", { name: "Request options" }).getByRole("tab");
  await expect(sections.nth(0)).toHaveText("Query");
  await expect(sections.nth(1)).toContainText("Headers");
  await expect(page.getByRole("tab", { name: "Variables", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("HTTP method")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveClass(/bg-action-graphql/);
  await page.getByLabel("Request URL", { exact: true }).fill("https://graphqlplaceholder.vercel.app/graphql");
  await expect(page.locator('[data-url-part="protocol"]')).toHaveClass(/text-action-emerald/);
  await expect(page.locator('[data-url-part="base"]')).toHaveClass(/text-syntax-property/);
  await expect(page.locator('[data-url-part="path"]')).toHaveClass(/text-syntax-attribute/);
  await expect(page.locator('[data-url-accent="graphql"]')).toHaveCount(2);
  await expect(page.locator('[data-url-accent="graphql"]').first()).toHaveClass(/text-action-graphql/);
  await page.getByLabel("GraphQL query", { exact: true }).fill(query);
  await page.getByRole("button", { name: "Save document", exact: true }).click();
  await page.getByLabel("Document name", { exact: true }).fill("Customers");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await page.getByLabel("GraphQL query", { exact: true }).fill("{ __typename }");
  await page.getByRole("button", { name: "Close Customers", exact: true }).click();
  await page.getByLabel("Documents", { exact: true }).getByRole("button", { name: "GQL Customers", exact: true }).click();
  await expect(page.getByLabel("GraphQL query", { exact: true })).toHaveText(query);
  await page.getByRole("button", { name: "New GraphQL request", exact: true }).click();
  await expect(page.getByLabel("GraphQL query", { exact: true })).toHaveText("");
  await page.getByRole("button", { name: "New GraphQL request", exact: true }).click({ button: "right" });
  await expect(tabs(page)).toHaveCount(3);
  await page.getByRole("menuitem", { name: "HTTP request", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Params", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New HTTP request", exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "GraphQL schema", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "GraphQL request", exact: true }).click();
  await saved(page); await page.reload();
  await expect(page.getByRole("button", { name: "New GraphQL request", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Query", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("large GraphQL envelopes extract data, errors and extensions through native queries", async ({ page }) => {
  await page.addInitScript(() => {
    const size = 2 * 1024 * 1024;
    (window as any).isTauri = true;
    (window as any).__largeGraphqlQueries = [];
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any) => {
        if (command === "start_http") return {
          status: 200,
          statusText: "OK",
          durationMs: 8,
          headers: [["content-type", "application/json"]],
          content: { id: "large-graphql-envelope", byteLength: size, mediaType: "application/json", charset: "utf-8", lineCount: 1, maxLineBytes: size, complete: true },
        };
        if (command === "response_content_read_lines") {
          const value = '{"data":{"fixture":"purr-v1"},"errors":[{"message":"Synthetic partial result"}],"extensions":{"fixture":"purr-extension"}}';
          return { offset: 0, bytesRead: value.length, segments: [{ byteOffset: 0, byteLength: value.length, text: value, continuesFromPrevious: false, continuesToNext: false }], complete: true };
        }
        if (command === "response_content_format") return { kind: "value", value: { data: { fixture: "purr-v1" } } };
        if (command === "response_content_query") {
          (window as any).__largeGraphqlQueries.push(args.request.expression);
          if (args.request.expression === ".data") return { kind: "value", value: { fixture: "purr-v1" } };
          if (args.request.expression === ".errors") return { kind: "value", value: [{ message: "Synthetic partial result" }] };
          if (args.request.expression === ".extensions") return { kind: "value", value: { fixture: "purr-extension" } };
        }
        if (command === "cancel_response_content_operation") return null;
        throw new Error(`Unexpected command: ${command}`);
      },
    };
  });
  await page.goto("/");
  await createGraphql(page);
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/large-graphql");
  await page.getByLabel("GraphQL query", { exact: true }).fill("{ fixture }");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const response = page.getByRole("region", { name: "HTTP response" });
  const viewer = response.getByLabel("Large response body viewer", { exact: true });
  await response.getByRole("button", { name: "Data", exact: true }).click();
  await expect(viewer).toContainText("purr-v1");
  await response.getByRole("button", { name: "Errors", exact: true }).click();
  await expect(viewer).toContainText("Synthetic partial result");
  await response.getByRole("button", { name: "Extensions", exact: true }).click();
  await expect(viewer).toContainText("purr-extension");
  expect(await page.evaluate(() => (window as any).__largeGraphqlQueries)).toEqual([
    ".data",
    ".errors",
    ".extensions",
  ]);
});

test("GraphQL shares HTTP auth/cookies, validates variables, introspects and persists the schema tab", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await createEnvironmentVariable(page);
  await createGraphql(page);
  await page.getByRole("button", { name: "Vertical split view", exact: true }).click();
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/graphql");
  await page.getByLabel("GraphQL query", { exact: true }).fill(query);
  const variablesDock = page.getByRole("region", { name: "GraphQL variables dock", exact: true });
  await expect(variablesDock).toBeVisible();
  await expect(variablesDock.getByLabel("GraphQL variable id", { exact: true })).toHaveAttribute("type", "text");
  const variablesDivider = page.getByRole("separator", { name: "Resize GraphQL variables", exact: true });
  await variablesDivider.focus();
  await page.keyboard.press("ArrowUp");
  await expect(variablesDivider).toHaveAttribute("aria-valuenow", "34");
  await variablesDock.getByLabel("GraphQL variable id", { exact: true }).fill("42");
  await page.screenshot({ path: "test-results/graphql-query.png" });
  await page.getByRole("tab", { name: "Auth", exact: true }).click();
  await page.getByRole("tab", { name: "Bearer Token", exact: true }).click();
  await page.getByLabel("Bearer token", { exact: true }).fill("gql-test-token");
  await page.evaluate(() => { (window as any).__holdGraphqlRequest = true; });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const running = page.getByRole("button", { name: /Request running/ });
  await expect(running).toHaveClass(/bg-action-graphql-surface/);
  await expect(running).toHaveClass(/text-action-graphql/);
  await expect(running.locator(".bg-action-graphql")).toHaveCount(1);
  const pending = page.getByRole("region", { name: "Response pending" });
  await expect(pending.locator("[data-pending-indicator]")).toHaveClass(/bg-action-graphql/);
  await expect(pending.locator("[data-pending-message]")).toHaveClass(/text-content-secondary/);
  await expect(pending.locator("[data-response-elapsed]")).toHaveClass(/text-action-graphql/);
  await expect(pending.locator("[data-pending-hint]")).toHaveClass(/text-content-tertiary/);
  await page.evaluate(() => (window as any).__releaseGraphqlRequest());
  await expect(page.getByText("200 OK", { exact: true })).toBeVisible();
  await expect(page.getByText("GraphQL errors 1", { exact: true })).toBeVisible();
  const responseModes = page.getByLabel("HTTP response").getByRole("button", { name: /^(Data|Prettify|Raw)$/ });
  await expect(responseModes).toHaveText(["Data", "Prettify", "Raw"]);
  await expect(page.getByRole("button", { name: "Data", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Raw", exact: true }).click();
  const responseBody = page.getByLabel("Response body viewer", { exact: true });
  await expect(responseBody).toContainText('"errors"');
  await expect(responseBody).toContainText('"extensions"');
  await page.waitForTimeout(1100);
  await expect(page.getByRole("button", { name: "Raw", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Prettify", exact: true }).click();
  await expect(responseBody).toContainText('"errors": [');
  await expect(responseBody).toContainText('"extensions": {');
  await page.getByRole("button", { name: "Data", exact: true }).click();
  await expect(responseBody).not.toContainText('"errors"');
  await page.getByRole("tab", { name: "Errors 1", exact: true }).click();
  await expect(page.getByText("Partial field warning", { exact: true })).toBeVisible();
  await expect(page.getByText("customer.name", { exact: true })).toBeVisible();
  await expect(page.getByText("PARTIAL_DATA", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Extensions", exact: true }).click();
  await expect(page.locator(".ui-response-code")).toContainText("trace-42");
  const sent = await page.evaluate(() => (window as any).__requests.at(-1));
  expect(sent.method).toBe("POST");
  expect(sent.headers).toContainEqual(["Authorization", "Bearer gql-test-token"]);
  expect(sent.headers).toContainEqual(["Content-Type", "application/json"]);
  expect(JSON.parse(Buffer.from(sent.bodyBase64, "base64").toString())).toEqual({ query, variables: { id: "42" } });
  await page.evaluate(() => { (window as any).__graphqlNoErrors = true; });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Errors/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Open GraphQL schema", exact: true }).click();
  await expect(page.getByText("No schema loaded", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__requests.length)).toBe(2);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  const registry = page.getByRole("complementary", { name: "Schema type registry" });
  await registry.getByRole("button", { name: "Customer", exact: true }).click();
  await expect(page.getByRole("region", { name: "Type Customer", exact: true })).toContainText("Use name instead");
  const introspected = await page.evaluate(() => (window as any).__requests[2]);
  expect(introspected.headers).toContainEqual(["Authorization", "Bearer gql-test-token"]);
  expect(introspected.headers).toContainEqual(["Cookie", "gql-session=one"]);
  await page.evaluate(() => { (window as any).__failIntrospection = true; });
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Introspection disabled");
  await expect(page.getByRole("region", { name: "Type Customer", exact: true })).toBeVisible();
  await saved(page); await page.reload();
  await expect(page.getByRole("region", { name: "Type Customer", exact: true })).toBeVisible();
  await expect(page.getByLabel("GraphQL schema endpoint", { exact: true })).toHaveValue("https://example.com/graphql");
  await expect(page.getByRole("region", { name: "Schemas", exact: true })).toContainText("SDL");
  await page.screenshot({ path: "test-results/graphql-schema.png" });
  await tabs(page).filter({ hasText: "GQL" }).click();
  await page.getByRole("tab", { name: "Query", exact: true }).click();
  await expect(page.getByLabel("GraphQL query", { exact: true })).toHaveText(query);
  await expect(page.getByText(/Schema connected/)).toBeVisible();
  const editor = page.getByLabel("GraphQL query", { exact: true });
  await editor.click();
  await page.locator(".cm-line span").filter({ hasText: /^customer$/ }).first().hover();
  await expect(page.locator(".ui-graphql-hover")).toContainText("Query.customer");
  await page.getByRole("button", { name: "Open Customer in Schema", exact: true }).click();
  await expect(page.getByRole("region", { name: "Type Customer", exact: true })).toBeVisible();
  await tabs(page).filter({ hasText: "GQL" }).click();
  await page.getByRole("tab", { name: "Query", exact: true }).click();
  await editor.fill("query ");
  await editor.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("QueryName");
  await editor.press("Escape");
  await editor.fill("{ customer(");
  await editor.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("id");
  await editor.press("Escape");
  await editor.fill('fragment CustomerFields on Customer { id }\nquery UseFragment { customer(id: "42") { ...');
  await editor.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("CustomerFields");
  await editor.press("Escape");
  await editor.fill('{ customer(id: "42") { missing } }');
  await expect(page.getByLabel("GraphQL diagnostics", { exact: true })).toHaveCount(0);
  await page.waitForTimeout(700);
  await expect(page.getByLabel("GraphQL diagnostics", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("GraphQL diagnostics", { exact: true })).toContainText('Cannot query field "missing"');
  await editor.fill('{ customer(id: "42") { oldName } }');
  await expect(page.getByLabel("GraphQL diagnostics", { exact: true })).toContainText("deprecated");
  await editor.fill("{ cust");
  await editor.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("customer");
  await page.screenshot({ path: "test-results/graphql-autocomplete.png" });
  await editor.press("Escape");
  await editor.fill('{ customer(id: "42") { i');
  await expect(page.getByRole("option", { name: /^id/ })).toBeVisible();
  await editor.press("Enter");
  await expect(editor).toContainText("id");
  await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible();
  await expect.poll(async () => editor.locator(".cm-line").allTextContents()).toEqual(['{ customer(id: "42") { id', ""]);
  await editor.press("Escape");
  await editor.type("na");
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: /^name/ })).toHaveAttribute("aria-selected", "true");
  await editor.press("Tab");
  await expect.poll(async () => editor.locator(".cm-line").allTextContents()).toEqual(['{ customer(id: "42") { id', "name", ""]);
  const tallQuery = ["query Tall($id: ID!) {", "  customer(id: $id) {", ...Array.from({ length: 16 }, () => "    id"), "    na", "  }", "}"].join("\n");
  await editor.fill(tallQuery);
  const lastField = editor.locator(".cm-line").filter({ hasText: /^\s*na\s*$/ });
  await lastField.click();
  await editor.press("End");
  await editor.press("Control+Space");
  const completion = page.locator(".cm-tooltip-autocomplete");
  await expect(page.getByRole("option", { name: /^name/ })).toHaveAttribute("aria-selected", "true");
  expect(Number(await completion.evaluate((element) => getComputedStyle(element).zIndex))).toBeGreaterThan(10);
  const variablesBox = await variablesDock.boundingBox();
  expect(variablesBox).not.toBeNull();
  await expect.poll(async () => {
    const box = await completion.boundingBox();
    return box ? box.y + box.height : Number.NEGATIVE_INFINITY;
  }).toBeGreaterThan(variablesBox!.y);
  const completionBox = await completion.boundingBox();
  expect(completionBox).not.toBeNull();
  expect(completionBox!.y + completionBox!.height).toBeGreaterThan(variablesBox!.y);
  const overlap = { x: completionBox!.x + completionBox!.width / 2, y: Math.max(completionBox!.y, variablesBox!.y) + 2 };
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".cm-tooltip-autocomplete")), overlap)).toBe(true);
  await page.screenshot({ path: "test-results/graphql-autocomplete-overlap.png" });
  await editor.press("Escape");
  await editor.fill('{ customer(id: "42") { i');
  await expect(page.getByRole("option", { name: /^id/ })).toHaveAttribute("aria-selected", "true");
  await editor.press("Enter");
  await editor.type("}");
  await page.waitForTimeout(150);
  await expect(completion).toHaveCount(0);
  await editor.fill("");
  await editor.type("{");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("customer");
  await editor.press("Escape");
  await editor.fill('{ customer(id: "42") { ');
  await editor.press("Control+Space");
  await expect(page.getByRole("option", { name: /Fill all fields/ })).toBeVisible();
  await page.getByRole("option", { name: /Fill all fields/ }).click();
  await expect(editor).toContainText("address");
  await editor.fill(query);
  await page.getByRole("region", { name: "GraphQL variables dock", exact: true }).getByRole("button", { name: "JSON", exact: true }).click();
  const jsonVariables = page.getByLabel("GraphQL variables", { exact: true });
  await jsonVariables.fill("{");
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await jsonVariables.press("Enter");
  await expect(page.getByRole("option", { name: /^id/ })).toBeVisible();
  await jsonVariables.press("Escape");
  await jsonVariables.type('"i');
  await expect(page.getByRole("option", { name: /^id/ })).toBeVisible();
  await jsonVariables.press("Enter");
  await expect(jsonVariables).toContainText('"id":');
  await expect(page.getByRole("option", { name: /customer_id/ })).toHaveCount(0);
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await jsonVariables.press("Control+Space");
  await expect(page.getByRole("option", { name: /^"value"/ })).toBeVisible();
  await jsonVariables.press("Enter");
  await expect(jsonVariables).toContainText('"id": "value"');
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await page.getByLabel("GraphQL variables", { exact: true }).fill("[]");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/GraphQL variables must be a JSON object/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__requests.length)).toBe(0);
});

test("standalone GraphQL schemas accept an endpoint and introspect without a request document", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await createSchema(page);
  const endpoint = page.getByLabel("GraphQL schema endpoint", { exact: true });
  await expect(endpoint).toHaveValue("");
  await expect(page.getByText("No schema loaded", { exact: true })).toBeVisible();
  await endpoint.fill("https://example.com/graphql");
  await expect(page.getByRole("region", { name: "Drafts", exact: true })).toContainText("Untitled GraphQL schema");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Schema type registry", exact: true })).toContainText("Customer");
  await expect(endpoint).toHaveValue("https://example.com/graphql");
});

test("referenced introspection responses above 1 MiB install through bounded reads", async ({ page }) => {
  const introspection = introspectionFromSchema(buildSchema(sdl));
  await page.addInitScript(({ introspection }) => {
    const base = JSON.stringify({ data: introspection });
    const source = base + " ".repeat(1024 * 1024 + 1 - base.length);
    (window as any).isTauri = true;
    (window as any).__releasedSchemaContent = 0;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: any) => {
        if (command === "start_http") return {
          status: 200,
          statusText: "OK",
          durationMs: 8,
          httpVersion: "HTTP/2",
          headers: [["content-type", "application/json"]],
          content: {
            id: "large-introspection",
            byteLength: source.length,
            mediaType: "application/json",
            charset: "utf-8",
            complete: true,
          },
        };
        if (command === "response_content_read_range") {
          const offset = args.range.offset;
          const end = Math.min(source.length, offset + args.range.length);
          return {
            offset,
            bytesRead: end - offset,
            content: btoa(source.slice(offset, end)),
            complete: end === source.length,
          };
        }
        if (command === "response_content_release") {
          (window as any).__releasedSchemaContent += 1;
          return null;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    };
  }, { introspection });

  await page.goto("/");
  await createSchema(page);
  await page.getByLabel("GraphQL schema endpoint", { exact: true }).fill("https://example.com/graphql");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  const registry = page.getByRole("complementary", { name: "Schema type registry", exact: true });
  await expect(registry).toContainText("Customer");
  await expect.poll(() => page.evaluate(() => (window as any).__releasedSchemaContent)).toBe(1);
  const measures = await page.evaluate(() => ({
    worker: performance.getEntriesByName("purr.graphql.schema.worker-round-trip").length,
    parse: performance.getEntriesByName("purr.graphql.schema.parse").length,
  }));
  expect(measures.worker).toBe(1);
  expect(measures.parse).toBeGreaterThanOrEqual(1);
});

test("schema file import supports SDL and introspection JSON and keeps the previous schema on invalid input", async ({ page }) => {
  await page.goto("/");
  await createGraphql(page);
  await page.getByRole("button", { name: "Open GraphQL schema", exact: true }).click();
  const upload = (name: string, text: string) => page.getByLabel("Schema file", { exact: true }).setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
  await upload("customers.graphql", sdl);
  const registry = page.getByRole("complementary", { name: "Schema type registry" });
  await page.getByLabel("Search schema types", { exact: true }).fill("Customer");
  await registry.getByRole("button", { name: "Customer", exact: true }).click();
  await expect(page.getByLabel("Schema source", { exact: true })).toContainText("implements Node");
  await page.getByRole("region", { name: "Type Customer", exact: true }).getByRole("button", { name: "Tier!", exact: true }).click();
  await expect(page.getByRole("region", { name: "Type Tier", exact: true })).toContainText("ENTERPRISE");
  await upload("broken.graphql", "type Query {");
  await expect(page.getByRole("alert")).toContainText("Syntax Error");
  await expect(page.getByRole("region", { name: "Type Tier", exact: true })).toBeVisible();
  await upload("schema.json", JSON.stringify({ data: introspectionFromSchema(buildSchema("type Query { ping: String! }")) }));
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Type Query", exact: true })).toContainText("ping");
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await expect(page.getByLabel("Schema source", { exact: true })).toContainText("__schema");
});

test("empty schema tabs stay out of the sidebar and explorer fields create linked requests", async ({ page }) => {
  await page.goto("/");
  await createGraphql(page);
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/graphql");
  await page.getByRole("button", { name: "Open GraphQL schema", exact: true }).click();
  await expect(tabs(page)).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Schemas", exact: true })).toHaveCount(0);
  await tabs(page).filter({ hasText: "GQL" }).click();
  await page.getByRole("button", { name: "Open GraphQL schema", exact: true }).click();
  await expect(tabs(page)).toHaveCount(3);

  await page.getByLabel("Schema file", { exact: true }).setInputFiles({ name: "customers.graphql", mimeType: "text/plain", buffer: Buffer.from(sdl) });
  await expect(page.getByRole("region", { name: "Schemas", exact: true })).toContainText("SDL");
  const queryType = page.getByRole("region", { name: "Type Query", exact: true });
  await expect(queryType.getByText("Depth", { exact: true })).toBeVisible();
  await expect(queryType.getByText("Fields", { exact: true })).toBeVisible();
  await expect(queryType.getByText("customer → address → city", { exact: true })).toBeVisible();
  const registry = page.getByRole("complementary", { name: "Schema type registry" });
  await registry.getByRole("button", { name: "customer", exact: true }).click();
  const operationDocs = page.getByRole("region", { name: "Operation customer", exact: true });
  await expect(operationDocs).toContainText("Returns");
  await expect(operationDocs.getByRole("button", { name: "Create request", exact: true })).toHaveClass(/bg-action-graphql/);
  await page.getByRole("button", { name: "Hide SDL pane", exact: true }).click();
  await expect(page.getByLabel("Schema source", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Show SDL pane", exact: true }).click();
  await page.getByLabel("Search schema types", { exact: true }).fill("customer");
  await expect(page.getByRole("button", { name: "Query.customer", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open return type Customer", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Type Customer", exact: true })).toBeVisible();
  await page.getByLabel("Search schema types", { exact: true }).fill("");
  await page.getByRole("button", { name: "Create request for customer", exact: true }).click();
  await expect(page.getByLabel("GraphQL query", { exact: true })).toContainText("query Customer($id: ID!)");
  await expect(page.getByRole("region", { name: "GraphQL variables dock", exact: true }).getByLabel("GraphQL variable id", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open GraphQL schema", exact: true }).click();
  await expect(tabs(page)).toHaveCount(4);
});

test("multiple operations expose inline run actions and variables navigate to their operation", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await createGraphql(page);
  await page.getByRole("button", { name: "Vertical split view", exact: true }).click();
  await page.getByLabel("Request URL", { exact: true }).fill("https://example.com/graphql");
  await page.getByRole("button", { name: "Open GraphQL schema", exact: true }).click();
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Schema type registry", exact: true })).toContainText("Customer");
  await tabs(page).filter({ hasText: "GQL" }).click();
  const operations = 'query Read { customer(id: "42") { id } }\nmutation Update($input: CustomerInput!) { update(input: $input) { id } }';
  await page.getByLabel("GraphQL query", { exact: true }).fill(operations);
  await expect(page.getByRole("button", { name: "Send query Read", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send mutation Update", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/graphql-operations.png" });
  await page.getByRole("combobox", { name: "GraphQL variables operation", exact: true }).click();
  await page.getByRole("option", { name: "mutation · Update", exact: true }).click();
  await expect(page.locator(".cm-activeLine")).toContainText("mutation Update");
  const variablesDock = page.getByRole("region", { name: "GraphQL variables dock", exact: true });
  await expect(variablesDock.getByRole("region", { name: "GraphQL input input", exact: true })).toBeVisible();
  await expect(variablesDock.getByRole("region", { name: "GraphQL input input.details", exact: true })).toBeVisible();
  await variablesDock.getByLabel("GraphQL variable input.name", { exact: true }).fill("Ada");
  await expect(variablesDock.getByRole("combobox", { name: "GraphQL variable input.tier", exact: true })).toBeVisible();
  await variablesDock.getByRole("button", { name: "JSON", exact: true }).click();
  const jsonVariables = page.getByLabel("GraphQL variables", { exact: true });
  await expect(jsonVariables).toContainText('"input": {');
  await expect(jsonVariables).toContainText('"name": "Ada"');
  await jsonVariables.fill("{}");
  await jsonVariables.press("ArrowLeft");
  await jsonVariables.press("Enter");
  await expect(page.getByRole("option", { name: /^input/ })).toBeVisible();
  await jsonVariables.press("Enter");
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await jsonVariables.press("Control+Space");
  await expect(page.getByRole("option", { name: /^\{\}/ })).toBeVisible();
  await jsonVariables.press("Enter");
  await expect(page.getByRole("option", { name: /^name/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /^input/ })).toHaveCount(0);
  const variablesText = await jsonVariables.textContent() ?? "";
  expect(variablesText.match(/\{/g)).toHaveLength(2);
  expect(variablesText.match(/\}/g)).toHaveLength(2);
  const variablesCompletion = page.locator(".cm-tooltip-autocomplete");
  expect(await variablesCompletion.evaluate((element) => element.closest(".ui-code-editor") === null)).toBe(true);
  const variablesCompletionBox = await variablesCompletion.boundingBox();
  expect(variablesCompletionBox).not.toBeNull();
  expect(variablesCompletionBox!.y + variablesCompletionBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".cm-tooltip-autocomplete")), {
    x: variablesCompletionBox!.x + variablesCompletionBox!.width / 2,
    y: variablesCompletionBox!.y + variablesCompletionBox!.height - 2,
  })).toBe(true);
  await jsonVariables.fill('{"input":{"name":"Ada"}}');
  await page.getByRole("button", { name: "Send mutation Update", exact: true }).click();
  await expect(page.getByText("200 OK", { exact: true })).toBeVisible();
  const sent = await page.evaluate(() => (window as any).__requests.at(-1));
  expect(JSON.parse(Buffer.from(sent.bodyBase64, "base64").toString())).toEqual({ query: operations, variables: { input: { name: "Ada" } }, operationName: "Update" });
});
