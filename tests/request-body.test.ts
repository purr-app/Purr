import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEmptyRequestBodyField,
  createRequestBody,
  getBodyContentType,
  getBodyDiagnostics,
  getRequestBodyValidationMessage,
  prettifyBodyCode,
  serializeRequestBody,
  switchRequestBodyType,
  type RequestBody,
  type RequestBodyField,
} from "../src/features/request-workbench/model/request-body";
import {
  getRequestHeaders,
  initialRequestDraft,
  updateRequestHeaders,
} from "../src/features/request-workbench/model/request";

function field(
  key: string,
  value: string,
  extra: Partial<RequestBodyField> = {},
): RequestBodyField {
  return { id: key, key, value, enabled: true, ...extra };
}

function body(overrides: Partial<RequestBody> = {}): RequestBody {
  return { ...createRequestBody(), autoConvert: true, ...overrides };
}

test("None has no payload or generated Content-Type", () => {
  const empty = createRequestBody();
  assert.equal(empty.type, "none");
  assert.equal(serializeRequestBody(empty), null);
  assert.equal(getBodyContentType(empty), null);
  assert.equal(empty.formData[0].enabled, false);
  assert.equal(empty.autoConvert, false);
});

test("auto-conversion can be disabled without changing either format draft", () => {
  const source = body({
    type: "json",
    autoConvert: false,
    json: '{"name":"Alex"}',
    xml: "<saved/>",
  });
  const result = switchRequestBodyType(source, "xml");
  assert.equal(result.notice, null);
  assert.equal(result.conversion, null);
  assert.equal(result.body.json, source.json);
  assert.equal(result.body.xml, source.xml);
});

test("strict JSON diagnostics include the exact line and column", () => {
  const content = '{\n  "name": "Alex"\n  "active": true\n}';
  const [error] = getBodyDiagnostics("json", content);
  assert.equal(error.message, "Comma Expected");
  assert.equal(error.line, 3);
  assert.equal(error.column, 3);
  assert.equal(content.slice(error.from, error.to), '"active"');
  assert.ok(getBodyDiagnostics("json", '{"name":"Alex",}').length);
  assert.ok(getBodyDiagnostics("json", '{/* comment */"name":"Alex"}').length);
  assert.deepEqual(getBodyDiagnostics("json", ""), []);
  assert.deepEqual(getBodyDiagnostics("text", content), []);
});

test("XML diagnostics are mapped to the document", () => {
  const content = "<root>\n  <name>Alex</other>\n</root>";
  const [error] = getBodyDiagnostics("xml", content);
  assert.equal(error.line, 2);
  assert.ok(error.column > 1);
  assert.match(error.message, /name|other/);
  assert.ok(error.to <= content.length);
  assert.deepEqual(
    getBodyDiagnostics("xml", "<root><name>Alex</name></root>"),
    [],
  );
});

test("form, URL encoded, and structured formats keep independent drafts", () => {
  const source = body({
    type: "form-data",
    formData: [
      field("name", "Alex"),
      field("note", "A & B"),
      field("skip", "private", { enabled: false }),
    ],
    urlEncoded: [field("query", "saved")],
    json: '{"nested":{"name":"Alex"}}',
    xml: "<saved/>",
  });
  for (const type of ["json", "xml", "url-encoded", "text"] as const) {
    const selected = switchRequestBodyType(source, type);
    assert.equal(selected.notice, null);
    assert.equal(selected.body.json, source.json);
    assert.equal(selected.body.xml, source.xml);
    assert.deepEqual(selected.body.formData, source.formData);
    assert.deepEqual(selected.body.urlEncoded, source.urlEncoded);
  }
});

test("JSON to XML round trip preserves numeric types, booleans, and arrays", () => {
  const data = {
    user: {
      name: "Alex",
      active: true,
      count: 120,
      roles: ["admin", "editor"],
      singleRole: ["owner"],
      emptyList: [],
      empty: null,
      nested: { field: "value" },
    },
  };
  const json = JSON.stringify(data, null, 2);
  const xml = switchRequestBodyType(body({ type: "json", json }), "xml");
  assert.equal(xml.notice, null);
  assert.equal(xml.conversion, "converted");
  assert.match(xml.body.xml, /xsi:type="xs:boolean">true/);
  assert.match(xml.body.xml, /xsi:type="xs:integer">120/);
  assert.doesNotMatch(xml.body.xml, /purr:/);
  assert.equal(xml.body.xml.match(/<roles /g)?.length, 2);
  assert.equal(xml.body.xml.match(/<singleRole /g)?.length, 1);
  assert.match(xml.body.xml, /xsi:nil="true"/);
  xml.body.xml = prettifyBodyCode("xml", xml.body.xml);
  xml.body.xml = xml.body.xml.replace(">120</count>", ">121</count>");
  const result = switchRequestBodyType(xml.body, "json");
  assert.equal(result.notice, null);
  assert.deepEqual(JSON.parse(result.body.json), {
    ...data,
    user: { ...data.user, count: 121 },
  });
});

test("editing XML converts the new values instead of restoring stale JSON", () => {
  const xml = switchRequestBodyType(
    body({ type: "json", json: '{"name":"Alex"}' }),
    "xml",
  );
  xml.body.xml = xml.body.xml.replace("Alex", "Rivera");
  const result = switchRequestBodyType(xml.body, "json");
  assert.equal(result.notice, null);
  assert.deepEqual(JSON.parse(result.body.json), { name: "Rivera" });
});

test("namespaced XML with attributes survives JSON conversion", () => {
  const xml =
    '<soap:Envelope xmlns:soap="https://example.com/soap"><soap:Body priority="HIGH"><name>Alex</name></soap:Body></soap:Envelope>';
  const json = switchRequestBodyType(body({ type: "xml", xml }), "json");
  assert.equal(json.notice, null);
  const result = switchRequestBodyType(json.body, "xml");
  assert.equal(result.notice, null);
  assert.match(result.body.xml, /xmlns:soap="https:\/\/example.com\/soap"/);
  assert.match(result.body.xml, /priority="HIGH"/);
  assert.deepEqual(getBodyDiagnostics("xml", result.body.xml), []);
});

test("an invalid structured conversion is blocked and leaves both drafts intact", () => {
  const source = body({ type: "json", json: '{"broken":', xml: "<saved/>" });
  const result = switchRequestBodyType(source, "xml");
  assert.ok(result.notice);
  assert.equal(result.body.type, "json");
  assert.equal(result.body.json, source.json);
  assert.equal(result.body.xml, source.xml);
});

test("an empty structured body clears the target draft", () => {
  const clearedXml = switchRequestBodyType(
    body({ type: "json", json: "", xml: "<stale/>" }),
    "xml",
  );
  assert.equal(clearedXml.body.type, "xml");
  assert.equal(clearedXml.body.xml, "");
  assert.equal(clearedXml.conversion, "cleared");
  const clearedJson = switchRequestBodyType(
    { ...clearedXml.body, json: '{"stale":true}' },
    "json",
  );
  assert.equal(clearedJson.body.json, "");
  assert.equal(clearedJson.conversion, "cleared");
});

test("JSON keys that are not valid XML names block conversion", () => {
  const data = {
    args: {
      "0": "<",
      "1": "u",
      "invalid name": "value",
      _purr_key_30: "literal",
      param: "1",
    },
    headers: {
      "content-type": "text/xml",
      cookie: "a=b; c=d",
    },
    url: "https://postman-echo.com/get?param=1&test=123",
  };
  const source = body({
    type: "json",
    json: JSON.stringify(data),
    xml: "<saved/>",
  });
  const converted = switchRequestBodyType(source, "xml");
  assert.match(converted.notice!, /JSON key "0".*not a valid XML name/);
  assert.equal(converted.body.type, "json");
  assert.equal(converted.body.json, source.json);
  assert.equal(converted.body.xml, source.xml);
});

test("duplicate form keys are preserved while switching tabs", () => {
  const source = body({
    type: "form-data",
    formData: [field("tag", "a", { id: "a" }), field("tag", "b", { id: "b" })],
  });
  const json = switchRequestBodyType(source, "json");
  assert.equal(json.notice, null);
  assert.deepEqual(
    switchRequestBodyType(json.body, "form-data").body.formData,
    source.formData,
  );
  const encoded = switchRequestBodyType(source, "url-encoded");
  assert.equal(encoded.notice, null);
  assert.deepEqual(encoded.body.urlEncoded, source.urlEncoded);
});

test("attachments are not lost when switching to an incompatible format and back", () => {
  const attachment = new File([new Uint8Array([0, 1, 255])], "data.bin");
  const source = body({
    type: "form-data",
    formData: [field("upload", "", { fieldType: "file", attachment })],
    json: '{"old":true}',
  });
  for (const type of ["json", "xml", "url-encoded"] as const) {
    const result = switchRequestBodyType(source, type);
    assert.equal(result.notice, null);
    const restored = switchRequestBodyType(result.body, "form-data");
    assert.equal(restored.body.formData[0].attachment, attachment);
  }
});

test("XML conversion rejects lossy structures", () => {
  for (const xml of [
    "<root>Hello <b>world</b>!</root>",
    "<root><!-- comment --><name>Alex</name></root>",
    "<root><![CDATA[plain]]></root>",
  ]) {
    const source = body({ type: "xml", xml });
    const result = switchRequestBodyType(source, "json");
    assert.ok(result.notice);
    assert.equal(result.body.xml, xml);
  }
});

test("prettifying JSON and XML is idempotent and does not change text semantics", () => {
  assert.equal(prettifyBodyCode("json", '{"n":1}'), '{\n  "n": 1\n}');
  const xml =
    '<root><!-- comment --><name title="A &amp; B"> Alex </name><![CDATA[A < B]]></root>';
  const formatted = prettifyBodyCode("xml", xml);
  assert.ok(formatted.startsWith("<root>"));
  assert.match(formatted, /<!-- comment -->/);
  assert.match(formatted, /title="A &amp; B"/);
  assert.match(formatted, /> Alex <\/name>/);
  assert.match(formatted, /<!\[CDATA\[A < B\]\]>/);
  assert.equal(prettifyBodyCode("xml", formatted), formatted);
  for (const content of [
    "<p>Hello <b>world</b>!</p>",
    '<root xml:space="preserve">  <name>Alex</name>  </root>',
  ]) {
    assert.equal(prettifyBodyCode("xml", content), content);
  }
});

test("payload size is UTF-8 bytes, not string length", async () => {
  const text = "Привіт 👋";
  const payload = serializeRequestBody(body({ type: "text", text }))!;
  assert.equal(payload.size, new TextEncoder().encode(text).byteLength);
  assert.equal(await payload.text(), text);
});

test("URL encoding includes repeated keys and excludes disabled fields", async () => {
  const source = body({
    type: "url-encoded",
    urlEncoded: [
      field("tag", "A & B"),
      field("tag", "c", { id: "tag2" }),
      field("skip", "hidden", { enabled: false }),
    ],
  });
  assert.equal(await serializeRequestBody(source)!.text(), "tag=A+%26+B&tag=c");
});

test("multipart payload matches the generated boundary and retains file bytes and MIME types", async () => {
  const attachment = new File([new Uint8Array([0, 1, 2, 255])], "report.bin", {
    type: "application/octet-stream",
  });
  const source = body({
    type: "form-data",
    formData: [
      field("title", "Report"),
      field("asset", "", { fieldType: "file", attachment }),
      field("skip", "hidden", { enabled: false }),
    ],
  });
  const payload = serializeRequestBody(source)!;
  assert.match(
    getBodyContentType(source)!,
    new RegExp("boundary=" + source.boundary),
  );
  const text = await payload.text();
  assert.ok(text.startsWith("--" + source.boundary + "\r\n"));
  assert.ok(text.endsWith("--" + source.boundary + "--\r\n"));
  assert.equal(payload.size, (await payload.arrayBuffer()).byteLength);
  const parsed = await new Response(payload, {
    headers: { "Content-Type": getBodyContentType(source)! },
  }).formData();
  assert.equal(parsed.get("title"), "Report");
  assert.equal(parsed.get("skip"), null);
  const file = parsed.get("asset") as File;
  assert.equal(file.name, "report.bin");
  assert.equal(file.type, "application/octet-stream");
  assert.deepEqual(
    new Uint8Array(await file.arrayBuffer()),
    new Uint8Array([0, 1, 2, 255]),
  );
});

test("file fields without a file are invalid; empty placeholders are ignored", () => {
  const source = body({
    type: "form-data",
    formData: [
      field("upload", "", { fieldType: "file" }),
      createEmptyRequestBodyField("form-data"),
    ],
  });
  assert.match(getRequestBodyValidationMessage(source)!, /Choose a file/);
  source.formData[0].enabled = false;
  assert.equal(getRequestBodyValidationMessage(source), null);
});

test("binary payload is the original file with its detected MIME type", () => {
  const file = new File(["Hello"], "hello.txt", { type: "text/plain" });
  const source = body({
    type: "binary",
    binary: { file, name: file.name, size: file.size, mimeType: file.type },
  });
  assert.equal(serializeRequestBody(source), file);
  assert.equal(getBodyContentType(source), "text/plain");
});

test("generated Content-Type is read-only and follows Body without losing the manual header", () => {
  const manual = {
    id: "manual",
    name: "content-type",
    value: "custom/type",
    enabled: true,
  };
  const draft = {
    ...initialRequestDraft,
    body: body({ type: "json" }),
    headers: [
      manual,
      { id: "accept", name: "Accept", value: "*/*", enabled: true },
    ],
  };
  const headers = getRequestHeaders(draft);
  assert.equal(
    headers.filter((header) => header.name.toLowerCase() === "content-type")
      .length,
    1,
  );
  assert.equal(headers[0].value, "application/json");
  assert.equal(headers[0].enabled, true);
  assert.equal(headers[0].readOnly, true);
  const updated = updateRequestHeaders(draft, [
    headers[0],
    { ...headers[1], value: "application/json" },
  ]);
  updated.body = switchRequestBodyType(updated.body, "xml").body;
  assert.equal(getRequestHeaders(updated)[0].value, "application/xml");
  updated.body = switchRequestBodyType(updated.body, "none").body;
  assert.deepEqual(getRequestHeaders(updated)[0], manual);
  assert.equal(getRequestHeaders(updated)[1].value, "application/json");
});
