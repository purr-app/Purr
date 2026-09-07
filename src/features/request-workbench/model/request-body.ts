import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export const bodyTypeOptions = [
  { value: "none", label: "None", contentType: "" },
  { value: "json", label: "JSON", contentType: "application/json" },
  { value: "xml", label: "XML", contentType: "application/xml" },
  {
    value: "form-data",
    label: "Form-Data",
    contentType: "multipart/form-data",
  },
  {
    value: "url-encoded",
    label: "URL Encoded",
    contentType: "application/x-www-form-urlencoded",
  },
  { value: "binary", label: "Binary", contentType: "application/octet-stream" },
  { value: "text", label: "Text", contentType: "text/plain" },
] as const;

export type RequestBodyType = (typeof bodyTypeOptions)[number]["value"];
export type CodeBodyLanguage = "json" | "xml" | "text";
export type RequestBodyField = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  fieldType?: "text" | "file";
  attachment?: File | null;
  contentType?: string;
};
export type RequestBinaryFile = {
  file: File;
  name: string;
  size: number;
  mimeType: string;
};
type JsonShape =
  | { kind: "scalar" }
  | { kind: "array"; items: JsonShape[] }
  | { kind: "object"; properties: Record<string, JsonShape> };
type XmlConversionContext = {
  wrappedRoot: boolean;
  shape: JsonShape;
};
export type RequestBody = {
  type: RequestBodyType;
  autoConvert: boolean;
  json: string;
  xml: string;
  text: string;
  formData: RequestBodyField[];
  urlEncoded: RequestBodyField[];
  binary: RequestBinaryFile | null;
  boundary: string;
  xmlConversion?: XmlConversionContext;
};
export type BodyDiagnostic = {
  from: number;
  to: number;
  message: string;
  line: number;
  column: number;
  severity: "error";
};

export function createEmptyRequestBodyField(
  prefix: "form-data" | "url-encoded",
  fields: RequestBodyField[] = [],
): RequestBodyField {
  const highestId = fields.reduce((highest, field) => {
    const id = Number(field.id.replace(prefix + "-", ""));
    return Number.isFinite(id) ? Math.max(highest, id) : highest;
  }, 0);
  return {
    id: prefix + "-" + (highestId + 1),
    key: "",
    value: "",
    enabled: false,
  };
}

export function createRequestBody(): RequestBody {
  return {
    type: "none",
    autoConvert: false,
    json: "",
    xml: "",
    text: "",
    binary: null,
    formData: [createEmptyRequestBodyField("form-data")],
    urlEncoded: [createEmptyRequestBodyField("url-encoded")],
    boundary: "purr-" + crypto.randomUUID(),
  };
}

function diagnostic(
  content: string,
  offset: number,
  length: number,
  message: string,
): BodyDiagnostic {
  const from = Math.max(0, Math.min(offset, content.length));
  const before = content.slice(0, from).split("\n");
  return {
    from,
    to: Math.min(content.length, from + Math.max(1, length)),
    message,
    severity: "error",
    line: before.length,
    column: before[before.length - 1].length + 1,
  };
}

export function getBodyDiagnostics(
  language: CodeBodyLanguage,
  content: string,
): BodyDiagnostic[] {
  if (!content.trim() || language === "text") return [];
  if (language === "json") {
    const errors: ParseError[] = [];
    parse(content, errors, {
      disallowComments: true,
      allowTrailingComma: false,
    });
    return errors.map((error) =>
      diagnostic(
        content,
        error.offset,
        error.length,
        printParseErrorCode(error.error).replace(/([a-z])([A-Z])/g, "$1 $2"),
      ),
    );
  }
  const validation = XMLValidator.validate(content);
  if (validation === true) return [];
  const { line, col, msg } = validation.err;
  const offset =
    content
      .split("\n")
      .slice(0, Math.max(0, line - 1))
      .reduce((total, text) => total + text.length + 1, 0) +
    Math.max(0, col - 1);
  return [diagnostic(content, offset, 1, msg)];
}

export function getActiveBodyFields(body: RequestBody) {
  const fields =
    body.type === "form-data"
      ? body.formData
      : body.type === "url-encoded"
        ? body.urlEncoded
        : [];
  return fields.filter(
    (field) =>
      field.enabled &&
      (field.key.length > 0 ||
        field.value.length > 0 ||
        Boolean(field.attachment)),
  );
}

export function getRequestBodyValidationMessage(body: RequestBody) {
  if (body.type === "json" || body.type === "xml")
    return getBodyDiagnostics(body.type, body[body.type])[0]?.message ?? null;
  if (body.type === "form-data" || body.type === "url-encoded") {
    if (getActiveBodyFields(body).some((field) => !field.key))
      return "A field name is required.";
    if (
      body.type === "form-data" &&
      getActiveBodyFields(body).some(
        (field) => field.fieldType === "file" && !field.attachment,
      )
    )
      return "Choose a file for each file field.";
  }
  return null;
}

export function getBodyContentType(body: RequestBody): string | null {
  if (body.type === "none") return null;
  if (body.type === "binary")
    return body.binary?.mimeType || "application/octet-stream";
  if (body.type === "form-data")
    return "multipart/form-data; boundary=" + body.boundary;
  return (
    bodyTypeOptions.find((option) => option.value === body.type)?.contentType ||
    null
  );
}

function escapeDisposition(value: string) {
  return value.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
}

// One serializer drives the size display, boundary header, and future request sending.
export function serializeRequestBody(body: RequestBody): Blob | null {
  if (body.type === "none") return null;
  if (body.type === "binary") return body.binary?.file ?? null;
  if (body.type === "json" || body.type === "xml" || body.type === "text")
    return new Blob([body[body.type]], {
      type: getBodyContentType(body) ?? undefined,
    });
  const fields = getActiveBodyFields(body).filter(
    (field) => field.key.length > 0,
  );
  if (body.type === "url-encoded") {
    return new Blob(
      [
        new URLSearchParams(
          fields.map((field) => [field.key, field.value]),
        ).toString(),
      ],
      { type: getBodyContentType(body)! },
    );
  }
  const parts: BlobPart[] = [];
  fields.forEach((field) => {
    const file = field.fieldType === "file" ? field.attachment : null;
    if (field.fieldType === "file" && !file) return;
    let headers =
      "--" +
      body.boundary +
      '\r\nContent-Disposition: form-data; name="' +
      escapeDisposition(field.key) +
      '"';
    if (file) headers += '; filename="' + escapeDisposition(file.name) + '"';
    const mime = file ? file.type || "application/octet-stream" : "text/plain";
    headers += "\r\nContent-Type: " + mime.replace(/[\r\n]/g, "") + "\r\n\r\n";
    parts.push(headers, file || field.value.replace(/\r?\n/g, "\r\n"), "\r\n");
  });
  parts.push("--" + body.boundary + "--\r\n");
  return new Blob(parts, { type: getBodyContentType(body)! });
}

export function formatPayloadSize(bytes: number) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

const xmlOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  suppressBooleanAttributes: false,
};
const xmlSchemaInstanceNamespace = "http://www.w3.org/2001/XMLSchema-instance";
const xmlSchemaNamespace = "http://www.w3.org/2001/XMLSchema";

function isXmlName(value: string) {
  return /^[A-Za-z_][\w.:-]*$/.test(value);
}

function canUseJsonKeyInXml(key: string) {
  if (key === "#text") return true;
  return key.startsWith("@_") ? isXmlName(key.slice(2)) : isXmlName(key);
}

function decodeXmlScalar(type: string, value: unknown) {
  const lexicalValue = value == null ? "" : String(value);
  const localType = type.includes(":")
    ? type.slice(type.lastIndexOf(":") + 1)
    : type;
  if (localType === "boolean")
    return lexicalValue === "true" || lexicalValue === "1";
  if (
    [
      "byte",
      "short",
      "int",
      "integer",
      "long",
      "nonNegativeInteger",
      "positiveInteger",
      "unsignedByte",
      "unsignedShort",
      "unsignedInt",
      "unsignedLong",
    ].includes(localType)
  )
    return Number.parseInt(lexicalValue, 10);
  if (["decimal", "double", "float"].includes(localType))
    return Number(lexicalValue);
  if (localType === "string") return lexicalValue;
  return value;
}

function decodeXmlValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeXmlValue);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (object["@_xsi:nil"] === "true" || object["@_xsi:nil"] === "1")
    return null;
  const ignoredAttributes = new Set(["@_xsi:type", "@_xsi:nil"]);
  const decoded = Object.fromEntries(
    Object.entries(object)
      .filter(([key, entry]) => {
        if (ignoredAttributes.has(key)) return false;
        return !(
          (key === "@_xmlns:xsi" && entry === xmlSchemaInstanceNamespace) ||
          (key === "@_xmlns:xs" && entry === xmlSchemaNamespace)
        );
      })
      .map(([key, entry]) => [key, decodeXmlValue(entry)]),
  );
  const nonTextKeys = Object.keys(decoded).filter((key) => key !== "#text");
  if (typeof object["@_xsi:type"] === "string" && nonTextKeys.length === 0)
    return decodeXmlScalar(object["@_xsi:type"], decoded["#text"]);
  return decoded;
}

function encodeJsonValue(value: unknown): Record<string, unknown> {
  if (value === null) return { "@_xsi:nil": "true" };
  if (Array.isArray(value))
    return value.length ? { item: value.map(encodeJsonValue) } : {};
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return Object.fromEntries(
      entries.map(([key, entry]) => {
        if (key === "#text" || key.startsWith("@_")) return [key, entry];
        if (Array.isArray(entry))
          return [key, entry.length ? entry.map(encodeJsonValue) : {}];
        return [key, encodeJsonValue(entry)];
      }),
    );
  }
  if (typeof value === "boolean")
    return { "@_xsi:type": "xs:boolean", "#text": value ? "true" : "false" };
  if (typeof value === "number")
    return {
      "@_xsi:type": Number.isInteger(value) ? "xs:integer" : "xs:double",
      "#text": String(value),
    };
  return { "@_xsi:type": "xs:string", "#text": String(value) };
}

function readXml(content: string): Record<string, unknown> {
  if (getBodyDiagnostics("xml", content).length)
    throw new Error("Fix the XML errors before converting.");
  // Mixed content and comments cannot be represented faithfully as ordinary JSON.
  if (/<!DOCTYPE|<!\[CDATA\[|<!--/.test(content))
    throw new Error(
      "XML with comments, CDATA or a doctype is kept in its original draft.",
    );
  const result = new XMLParser({
    ...xmlOptions,
    ignoreDeclaration: true,
  }).parse(content) as Record<string, unknown>;
  const removeLayoutWhitespace = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (
      typeof object["#text"] === "string" &&
      !object["#text"].trim() &&
      Object.keys(object).some(
        (key) => !key.startsWith("@_") && key !== "#text",
      )
    )
      delete object["#text"];
    Object.values(object).forEach(removeLayoutWhitespace);
  };
  removeLayoutWhitespace(result);
  const hasMixedText = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hasMixedText);
    if (!value || typeof value !== "object") return false;
    const entries = Object.entries(value);
    if (
      entries.some(([key]) => key === "#text") &&
      entries.some(([key]) => !key.startsWith("@_") && key !== "#text")
    )
      return true;
    return entries.some(([, child]) => hasMixedText(child));
  };
  if (hasMixedText(result))
    throw new Error(
      "Mixed XML text cannot be converted without losing its order.",
    );
  return decodeXmlValue(result) as Record<string, unknown>;
}

function getJsonShape(value: unknown): JsonShape {
  if (Array.isArray(value))
    return { kind: "array", items: value.map(getJsonShape) };
  if (value && typeof value === "object")
    return {
      kind: "object",
      properties: Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          getJsonShape(entry),
        ]),
      ),
    };
  return { kind: "scalar" };
}

function restoreJsonShape(
  value: unknown,
  shape: JsonShape,
  usesItemContainer = false,
): unknown {
  if (shape.kind === "scalar") return value;
  if (shape.kind === "array") {
    let items: unknown;
    if (
      usesItemContainer &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    )
      items = (value as Record<string, unknown>).item;
    else items = value;
    if (shape.items.length === 0) return [];
    const values = Array.isArray(items) ? items : [items];
    return values.map((entry, index) => {
      const itemShape =
        shape.items[index] ?? shape.items[shape.items.length - 1];
      return restoreJsonShape(entry, itemShape, itemShape.kind === "array");
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return Object.keys(shape.properties).length ? value : {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      const propertyShape = shape.properties[key];
      return [
        key,
        propertyShape ? restoreJsonShape(entry, propertyShape) : entry,
      ];
    }),
  );
}

function assertJsonKeysCanBeXmlNames(value: unknown, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonKeysCanBeXmlNames(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    if (!canUseJsonKeyInXml(key))
      throw new Error(
        `JSON key ${JSON.stringify(key)} at ${path} is not a valid XML name.`,
      );
    assertJsonKeysCanBeXmlNames(entry, `${path}.${key}`);
  });
}

function writeXml(value: unknown): {
  content: string;
  context: XmlConversionContext;
} {
  assertJsonKeysCanBeXmlNames(value);
  const entries =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value)
      : [];
  const hasRoot =
    entries.length === 1 &&
    isXmlName(entries[0][0]) &&
    entries[0][1] &&
    typeof entries[0][1] === "object" &&
    !Array.isArray(entries[0][1]);
  const rootName = hasRoot ? entries[0][0] : "root";
  const rootValue = hasRoot ? entries[0][1] : value;
  const encodedRoot = encodeJsonValue(rootValue);
  const data = {
    [rootName]: {
      ...encodedRoot,
      "@_xmlns:xsi": xmlSchemaInstanceNamespace,
      "@_xmlns:xs": xmlSchemaNamespace,
    },
  };
  const content = new XMLBuilder({
    ...xmlOptions,
    format: true,
    indentBy: "  ",
    suppressEmptyNode: true,
  }).build(data) as string;
  if (getBodyDiagnostics("xml", content).length)
    throw new Error("This data cannot be represented as valid XML.");
  return {
    content: content.trimEnd(),
    context: { wrappedRoot: !hasRoot, shape: getJsonShape(value) },
  };
}

export function switchRequestBodyType(
  body: RequestBody,
  type: RequestBodyType,
): {
  body: RequestBody;
  notice: string | null;
  conversion: "converted" | "cleared" | null;
} {
  const next = { ...body, type };
  const convertsStructuredData =
    (body.type === "json" || body.type === "xml") &&
    (type === "json" || type === "xml");
  if (body.type === type || !body.autoConvert || !convertsStructuredData)
    return { body: next, notice: null, conversion: null };
  const sourceText = body.type === "json" ? body.json : body.xml;
  if (!sourceText.trim()) {
    if (type === "json") next.json = "";
    else {
      next.xml = "";
      next.xmlConversion = undefined;
    }
    return { body: next, notice: null, conversion: "cleared" };
  }
  try {
    let value: unknown;
    if (body.type === "json") {
      if (getBodyDiagnostics("json", sourceText).length)
        throw new Error("Fix the JSON errors before converting.");
      value = JSON.parse(sourceText);
    } else if (body.type === "xml") {
      value = readXml(body.xml);
      const entries = Object.entries(value as Record<string, unknown>);
      if (
        body.xmlConversion?.wrappedRoot &&
        entries.length === 1 &&
        entries[0][0] === "root"
      )
        value = entries[0][1];
      if (body.xmlConversion)
        value = restoreJsonShape(
          value,
          body.xmlConversion.shape,
          body.xmlConversion.wrappedRoot &&
            body.xmlConversion.shape.kind === "array",
        );
    }
    if (type === "json") next.json = JSON.stringify(value, null, 2);
    else {
      const converted = writeXml(value);
      next.xml = converted.content;
      next.xmlConversion = converted.context;
    }
    return { body: next, notice: null, conversion: "converted" };
  } catch (error) {
    return {
      body,
      notice:
        "Could not convert " +
        body.type.toUpperCase() +
        " to " +
        type.toUpperCase() +
        ": " +
        (error instanceof Error ? error.message : "Conversion is unavailable."),
      conversion: null,
    };
  }
}

export function prettifyBodyCode(language: "json" | "xml", content: string) {
  if (!content.trim() || getBodyDiagnostics(language, content).length)
    return content;
  if (language === "json") return JSON.stringify(JSON.parse(content), null, 2);
  // Preserve tag order, comments, attributes and text when formatting XML.
  const options = {
    ...xmlOptions,
    preserveOrder: true,
    commentPropName: "#comment",
    cdataPropName: "#cdata",
    processEntities: false,
  };
  const data = new XMLParser(options).parse(content);
  // Formatting must not insert whitespace into mixed text or xml:space content.
  if (/xml:space\s*=\s*["']preserve["']/.test(content)) return content;
  let mixedContent = false;
  const stripLayout = (
    nodes: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> => {
    const hasElements = nodes.some((node) =>
      Object.keys(node).some((key) => !key.startsWith("#") && key !== ":@"),
    );
    if (
      hasElements &&
      nodes.some(
        (node) =>
          typeof node["#text"] === "string" && Boolean(node["#text"].trim()),
      )
    )
      mixedContent = true;
    return nodes
      .filter(
        (node) =>
          !(
            hasElements &&
            typeof node["#text"] === "string" &&
            !node["#text"].trim()
          ),
      )
      .map((node) =>
        Object.fromEntries(
          Object.entries(node).map(([key, value]) => [
            key,
            Array.isArray(value) ? stripLayout(value) : value,
          ]),
        ),
      );
  };
  const formattedData = stripLayout(data);
  if (mixedContent) return content;
  return new XMLBuilder({
    ...options,
    format: true,
    indentBy: "  ",
    suppressEmptyNode: true,
  })
    .build(formattedData)
    .trim();
}
