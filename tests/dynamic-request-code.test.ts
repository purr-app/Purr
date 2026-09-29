import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialRequestDraft } from "../src/features/request-workbench/model/request";
import { compileResponseQuery, prepareDynamicRequestCode, type DynamicRequestCodeContext } from "../src/features/request-workbench/model/dynamic-request-code";
import { queryResponseJson } from "../src/features/request-workbench/model/response";
import type { Variable } from "../src/features/workspaces/model/workspace";

const run = promisify(execFile);
const variable = (name: string, expression = "$.value"): Variable => ({ id: name, name, enabled: true, sensitive: false, kind: "dynamic-request", documentId: name, expression, language: "jsonpath", refresh: "every-time", environment: { type: "current" } });
function setup(base: string) {
  const root = structuredClone(initialRequestDraft);
  root.url = `${base}/root?q={{alias}}`;
  root.method = "POST"; root.body.type = "json"; root.body.json = '{"token":"{{token}}"}';
  const source = structuredClone(initialRequestDraft); source.url = `${base}/source`;
  const options: DynamicRequestCodeContext = { rootId: "root", environmentId: null, documents: [{ id: "token", name: "Token", kind: "http", request: source }],
    variablesForEnvironment: async () => [variable("token"), { id: "alias", name: "alias", kind: "static", value: "{{token}}", enabled: true, sensitive: false }], contextForDocument: async () => ({}) };
  return { root, options };
}

test("exported chain can be pasted into Bash and interactive zsh without evaluating response data", async () => {
  const token = "'\"$(`echo never`)&+ /\\\nline\n";
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url!);
    if (request.url === "/source") { response.statusCode = 401; response.end(JSON.stringify({ value: token })); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    response.end(JSON.stringify({ url: request.url, body: JSON.parse(body) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "purr-curl-"));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const { root, options } = setup(`http://127.0.0.1:${address.port}`);
    const code = await prepareDynamicRequestCode(root, {}, options); assert(code);
    assert.equal(requests.length, 0, "generation cannot execute requests");
    const file = join(directory, "chain.sh"); await writeFile(file, code.code);
    assert.doesNotMatch(code.code, /#!|mktemp|purr_tmp|trap |command -v|--rawfile|--cookie-jar|^#/m);
    for (const [shell, args] of [["bash", [file]], ["zsh", ["-f", "-i", "-c", code.code]]] as const) {
      const result = await run(shell, [...args]);
      const actual = JSON.parse(result.stdout);
      assert.equal(new URL(actual.url, "http://localhost").searchParams.get("q"), token);
      assert.equal(actual.body.token, token);
    }
    assert.equal(requests.length, 4);
  } finally { server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("query compiler matches Purr results including null, false, objects, wildcards and UTF16 length", async () => {
  const value = { rows: [{ value: null }, { value: false }], text: "a😀", deep: { rows: [{ value: 7 }] } };
  const queries = ["$.rows[0].value", "$.rows[1].value", "$..value", "$.rows[*].value", "$.deep", ".text | length", ".rows | keys", ".rows[] | length"];
  for (const expression of queries) {
    const language = expression.startsWith("$") ? "jsonpath" : "jq";
    const filter = compileResponseQuery(expression, language);
    const result = await run("jq", ["-nc", `(${JSON.stringify(value)}) | ${filter}`]);
    assert.deepEqual(JSON.parse(result.stdout), queryResponseJson(value, expression, language), expression);
  }
  assert.equal(compileResponseQuery("$.data.body", "jsonpath"), ".data.body");
  // Simple selectors use native jq semantics: a missing property yields null.
  assert.equal((await run("jq", ["-n", `{} | ${compileResponseQuery("$.missing", "jsonpath")}`])).stdout.trim(), "null");
});

test("cycle detection and disabled references fail without transport; inactive fields do not create dependencies", async () => {
  const { root, options } = setup("https://example.test");
  options.documents[0].request.url += "/{{token}}";
  await assert.rejects(prepareDynamicRequestCode(root, {}, options), /dependency cycle/);
  const plain = structuredClone(initialRequestDraft); plain.url = "https://example.test";
  plain.body.json = '{"unused":"{{token}}"}'; plain.body.type = "none";
  assert.equal(await prepareDynamicRequestCode(plain, {}, options), null);
});

test("dependency scripts preserve Basic auth, raw JSON values, GraphQL typed values and complete URL references", async () => {
  const server = createServer(async (request, response) => {
    const origin = `http://${request.headers.host}`;
    if (request.url === "/token") { response.end(JSON.stringify({ value: { id: 12 } })); return; }
    if (request.url === "/target") { response.end(JSON.stringify({ value: `${origin}/root` })); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    response.end(JSON.stringify({ body: body ? JSON.parse(body) : null, auth: request.headers.authorization }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "purr-curl-"));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const { root, options } = setup(base);
    options.documents[0].request.url = `${base}/token`;
    root.url = `${base}/root`; root.body.json = '{"token":{{token}}}';
    root.auth.type = "basic"; root.auth.basic = { username: "user", password: "{{token}}" };
    let generated = await prepareDynamicRequestCode(root, {}, options); assert(generated);
    let file = join(directory, "script.sh"); await writeFile(file, generated.code);
    let result = JSON.parse((await run("bash", [file])).stdout);
    assert.deepEqual(result.body, { token: { id: 12 } });
    assert.equal(Buffer.from(result.auth.slice(6), "base64").toString(), 'user:{"id":12}');
    root.auth.type = "none"; root.body.type = "none";
    root.graphql = { query: "query($token: JSON) { echo(token: $token) }", operationName: "", variables: '{"token":"{{token}}"}' };
    generated = await prepareDynamicRequestCode(root, {}, options); assert(generated);
    await writeFile(file, generated.code); result = JSON.parse((await run("bash", [file])).stdout);
    assert.deepEqual(result.body.variables.token, { id: 12 });
    delete root.graphql; root.url = "{{token}}"; options.documents[0].request.url = `${base}/target`;
    generated = await prepareDynamicRequestCode(root, {}, options); assert(generated);
    file = join(directory, "url.sh"); await writeFile(file, generated.code);
    result = JSON.parse((await run("bash", [file])).stdout);
    assert.equal(result.body, null);
  } finally { server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("export uses inherited headers and environment context without leaking masked credentials", async () => {
  const { root, options } = setup("https://example.test");
  root.url = "https://example.test/root"; root.body.type = "none";
  options.workspaceConfig = { auth: [], headers: [{ id: "shared", enabled: true, name: "X-Token", value: "{{token}}", scope: "all" }] };
  // The dependency must not inherit itself.
  options.documents[0].request.workspace.headersEnabled = false;
  const generated = await prepareDynamicRequestCode(root, {}, options); assert(generated);
  assert.match(generated.code, /X-Token/);
  root.auth.type = "bearer"; root.auth.bearer.token = "private-credential";
  const masked = await prepareDynamicRequestCode(root, {}, options); assert(masked);
  assert.match(masked.code, /private-credential/);
  assert.doesNotMatch(masked.displayCode, /private-credential/);
});

test("binary export requires a real file path and sends bytes without fake payloads", async () => {
  const payload = Buffer.from([0, 1, 2, 255, 13, 10]);
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url!);
    if (request.url === "/source") { response.end('{"value":"token"}'); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    response.end(JSON.stringify({ body: Buffer.concat(chunks).toString("base64") }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "purr-curl-"));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const { root, options } = setup(`http://127.0.0.1:${address.port}`);
    root.body.type = "binary";
    root.body.binary = { file: new File([payload], "upload.bin"), name: "upload.bin", size: payload.length, mimeType: "application/octet-stream" };
    const generated = await prepareDynamicRequestCode(root, {}, options); assert(generated);
    const script = join(directory, "script.sh"), file = join(directory, "file.bin");
    await writeFile(script, generated.code); await writeFile(file, payload);
    const result = await run("bash", [script], { env: { ...process.env, PURR_FILE_2: file } });
    assert.equal(JSON.parse(result.stdout).body, payload.toString("base64"));
    assert.equal(requests.length, 2);
    assert.doesNotMatch(generated.code, /<binary file/);
  } finally { server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an extraction failure stops the generated chain before the root request", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => { requests.push(request.url!); response.end("not JSON"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "purr-curl-"));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const { root, options } = setup(`http://127.0.0.1:${address.port}`);
    const generated = await prepareDynamicRequestCode(root, {}, options); assert(generated);
    const file = join(directory, "script.sh"); await writeFile(file, generated.code);
    await assert.rejects(run("bash", [file]), /parse error/);
    assert.deepEqual(requests, ["/source"]);
  } finally { server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("URL export distinguishes literal templates from path parameters and merges full dynamic URL queries", async () => {
  let sourceValue = "a/b";
  const server = createServer((request, response) => {
    if (request.url === "/source") response.end(JSON.stringify({ value: sourceValue }));
    else response.end(JSON.stringify({ url: request.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "purr-curl-"));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const { root, options } = setup(base); root.body.type = "none";
    root.url = `${base}/{{token}}/explicit/:id`;
    root.pathParams = [{ id: "path", key: "id", value: "{{token}}", enabled: true }];
    let generated = await prepareDynamicRequestCode(root, {}, options); assert(generated);
    const file = join(directory, "script.sh"); await writeFile(file, generated.code);
    let result = JSON.parse((await run("bash", [file])).stdout);
    assert.equal(result.url, "/a/b/explicit/a%2Fb");
    sourceValue = `${base}/root?keep=1&override=old`;
    root.url = "{{token}}"; root.pathParams = [];
    root.params = [{ id: "param", key: "override", value: "new value", enabled: true }];
    generated = await prepareDynamicRequestCode(root, {}, options); assert(generated);
    await writeFile(file, generated.code); result = JSON.parse((await run("bash", [file])).stdout);
    const url = new URL(result.url, base);
    assert.equal(url.searchParams.get("keep"), "1");
    assert.equal(url.searchParams.get("override"), "new value");
    assert.equal(url.searchParams.getAll("override").length, 1);
  } finally { server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("masked scripts retain dynamic Bearer, Basic and API key bindings while hiding literal credential segments", async () => {
  const observedSources: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/source") {
      observedSources.push(request.headers.authorization ?? "");
      response.end('{"value":"resolved-token"}');
    } else response.end(JSON.stringify({ headers: request.headers, url: request.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "purr-curl-"));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const { root, options } = setup(`http://127.0.0.1:${address.port}`);
    root.url = `http://127.0.0.1:${address.port}/root`; root.body.type = "none";
    options.documents[0].request.auth.type = "bearer";
    options.documents[0].request.auth.bearer.token = "source-private-token";
    const file = join(directory, "script.sh");
    for (const kind of ["bearer", "basic", "header", "query", "cookie"] as const) {
      root.auth.type = kind === "bearer" || kind === "basic" ? kind : "api-key";
      root.auth.bearer.token = "private-prefix{{token}}private-suffix";
      root.auth.basic = { username: "private-username", password: "private-prefix{{token}}private-suffix" };
      root.auth.apiKey = { name: "api_key", value: "private-prefix{{token}}private-suffix", placement: kind === "query" || kind === "cookie" ? kind : "header" };
      const generated = await prepareDynamicRequestCode(root, {}, options); assert(generated);
      assert.doesNotMatch(generated.displayCode, /source-private-token|private-prefix|private-suffix|private-username/);
      await writeFile(file, generated.displayCode);
      const result = JSON.parse((await run("bash", [file])).stdout);
      const expected = "********resolved-token********";
      if (kind === "bearer") assert.equal(result.headers.authorization, `Bearer ${expected}`);
      else if (kind === "basic") assert.equal(Buffer.from(result.headers.authorization.slice(6), "base64").toString(), `********:${expected}`);
      else if (kind === "header") assert.equal(result.headers.api_key, expected);
      else if (kind === "query") assert.equal(new URL(result.url, "http://localhost").searchParams.get("api_key"), expected);
      else assert.equal(result.headers.cookie, `api_key=${expected}`);
    }
    assert.deepEqual(observedSources, Array(5).fill("Bearer ********"));
  } finally { server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("extracted values that resemble internal markers are substituted only once", async () => {
  const server = createServer(async (request, response) => {
    if (request.url === "/source") { response.end('{"value":"purrdynamicvalue1end"}'); return; }
    if (request.url === "/second") { response.end('{"value":"second-value"}'); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "purr-curl-"));
  try {
    const address = server.address(); assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const { root, options } = setup(base); root.url = `${base}/root`; root.body.json = '{"first":"{{token}}", "second":"{{second}}"}';
    const source = structuredClone(initialRequestDraft); source.url = `${base}/second`;
    options.documents = [...options.documents, { id: "second", name: "Second", kind: "http", request: source }];
    options.variablesForEnvironment = async () => [variable("token"), variable("second")];
    const generated = await prepareDynamicRequestCode(root, {}, options); assert(generated);
    const file = join(directory, "script.sh"); await writeFile(file, generated.code);
    const result = JSON.parse((await run("bash", [file])).stdout);
    assert.deepEqual(result, { first: "purrdynamicvalue1end", second: "second-value" });
  } finally { server.close(); await rm(directory, { recursive: true, force: true }); }
});
