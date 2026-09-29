import type { HttpRequestSnapshot } from "../../../domain/http";
import type { Variable, WorkspaceRequestConfig } from "../../workspaces/model/workspace";
import { referencedNames, requestTemplateText, type DynamicVariableRequest } from "../../workspaces/services/dynamic-variable-resolver";
import { resolveEnvironmentValue } from "../../../shared/lib/resolve-variables";
import { prepareWireRequest } from "../services/execute-request";
import { getAuthBindingForRequest, resolveAuth, type AuthContext } from "./request-auth";
import { parseQueryPath, type ResponseQueryLanguage } from "./response";
import type { RequestDraft } from "./request";
import { resolveRequestEnvironment } from "../../workspaces/model/environment";
import type { SessionCookieJar } from "./cookie-jar";
import { maskCookieHeader, mergeCookieHeader } from "../services/http-client";
import { applyWorkspaceRequestConfig } from "./request-workspace-config";

export type DynamicRequestCodeContext = {
  cookieJar?: SessionCookieJar;
  rootId: string;
  environmentId: string | null;
  documents: readonly DynamicVariableRequest[];
  variablesForEnvironment: (environmentId: string | null) => Promise<readonly Variable[]>;
  contextForDocument: (document: DynamicVariableRequest, environmentId: string | null) => Promise<AuthContext>;
  workspaceConfig?: WorkspaceRequestConfig;
};

export class DynamicRequestCodeError extends Error {
  readonly dynamicDependencies = true;
}

type Binding = { marker: string; file: string; encoding?: "url" | "path" };
type Step = { document: DynamicVariableRequest; request: HttpRequestSnapshot; display: HttpRequestSnapshot; bindings: Binding[]; variable?: Extract<Variable, { kind: "dynamic-request" }>; file: string; rawJsonMarkers: Set<string>; typedJsonMarkers: Set<string>; displayDraft: RequestDraft; originalUrl: string };
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Compile the same deliberately bounded selector language used by the response viewer. */
export function compileResponseQuery(expression: string, language: ResponseQueryLanguage): string {
  const source = expression.trim();
  if (!source || source === "." || source === "$") return ".";
  const parts = language === "jq" ? source.split("|").map((part) => part.trim()).filter(Boolean) : [source];
  return parts.map((part, index) => {
    if (index && part === "length") return '(if type == "string" then explode | map(if . > 65535 then 2 else 1 end) | add // 0 elif type == "array" or type == "object" then length else error("length requires a string, array, or object.") end)';
    if (index && part === "keys") return '(if type == "array" or type == "object" then keys else error("keys requires an array or object.") end)';
    const selectors = parseQueryPath(part, language).map((segment) => {
      if (segment.type === "property") return `select(type == "object") | select(has(${JSON.stringify(segment.key)})) | .[${JSON.stringify(segment.key)}]`;
      if (segment.type === "index") return `select(type == "array") | select(length > ${segment.index}) | .[${segment.index}]`;
      if (segment.type === "wildcard") return 'select(type == "array" or type == "object") | .[]';
      return `.. | select(type == "object") | select(has(${JSON.stringify(segment.key)})) | .[${JSON.stringify(segment.key)}]`;
    });
    return `[${selectors.length ? selectors.map((selector) => `(${selector})`).join(" | ") : "."}] | if length == 0 then error("The query did not match any response value.") elif length == 1 then .[0] else . end`;
  }).map((part) => `(${part})`).join(" | ");
}

function insideJsonString(source: string, end: number) {
  let inside = false;
  for (let i = 0; i < end; i++) {
    if (source[i] === "\\" && inside) i++;
    else if (source[i] === '"') inside = !inside;
  }
  return inside;
}

/** All output values remain data: neither templates nor extracted values are evaluated as shell code. */
export async function prepareDynamicRequestCode(draft: RequestDraft, rootContext: AuthContext, options: DynamicRequestCodeContext): Promise<{ code: string; displayCode: string } | null> {
  const steps: Step[] = [];
  const completed = new Map<string, Binding>();
  let sequence = 0;
  let foundDynamic = false;
  const visit = async (document: DynamicVariableRequest, environmentId: string | null, path: string[], variable?: Step["variable"]): Promise<Step> => {
    const identity = `${document.id}:${environmentId ?? "none"}`;
    if (path.includes(identity)) throw new Error(`Dynamic variable dependency cycle: ${[...path, identity].join(" → ")}`);
    if (options.workspaceConfig) document = { ...document, request: applyWorkspaceRequestConfig(document.request, document.kind, options.workspaceConfig) };
    const context = variable ? await options.contextForDocument(document, environmentId) : rootContext;
    const auth = resolveAuth(document.request.auth, context);
    if (auth.error) throw new Error(auth.error);
    const namespace = (await options.variablesForEnvironment(environmentId)).filter((value) => value.name.trim());
    const values: Record<string, string> = Object.fromEntries(namespace.filter((value) => value.enabled && value.kind === "static").map((value) => [value.name.trim(), value.kind === "static" ? value.value : ""]));
    const needed = new Set(referencedNames(requestTemplateText({ ...document.request, auth: auth.auth })));
    for (const name of needed) {
      const matches = namespace.filter((value) => value.name.trim() === name);
      if (matches.length > 1) throw new Error(`Variable "${name}" has multiple definitions in the effective namespace.`);
      const definition = matches[0];
      if (!definition) throw new Error(`Variable "${name}" is not defined.`);
      if (!definition.enabled) throw new Error(`Variable "${name}" is disabled.`);
      if (definition.kind === "static") referencedNames(definition.value).forEach((dependency) => needed.add(dependency));
    }
    const bindings: Binding[] = [];
    for (const definition of namespace) {
      if (!needed.has(definition.name.trim()) || definition.kind !== "dynamic-request") continue;
      foundDynamic = true;
      const sourceEnvironment = definition.environment.type === "specific" ? definition.environment.environmentId : environmentId;
      const cacheKey = `${definition.id}:${sourceEnvironment ?? "none"}`;
      let binding = completed.get(cacheKey);
      if (!binding) {
        const source = options.documents.find((candidate) => candidate.id === definition.documentId);
        if (!source) throw new Error(`Dynamic variable "${definition.name}" refers to a missing saved request.`);
        const dependency = await visit(source, sourceEnvironment, [...path, identity], definition);
        binding = { marker: `purrdynamicvalue${sequence++}end`, file: dependency.file };
        completed.set(cacheKey, binding);
      }
      bindings.push(binding);
      values[definition.name.trim()] = binding.marker;
    }
    // Existing composition validates JSON. Quote symbolic non-string expressions for preparation,
    // then restore their JSON type when rendering the script's body at runtime.
    const requestDraft = { ...document.request, body: { ...document.request.body }, auth: auth.auth };
    const rawJsonMarkers = new Set<string>();
    const typedJsonMarkers = new Set<string>();
    if (requestDraft.graphql) {
      const inspect = (value: unknown): void => {
        if (typeof value === "string" && /^\s*{{[^{}]+}}\s*$/.test(value)) {
          const resolved = resolveEnvironmentValue(value, values);
          if (bindings.some((binding) => binding.marker === resolved)) typedJsonMarkers.add(resolved);
        } else if (Array.isArray(value)) value.forEach(inspect);
        else if (value && typeof value === "object") Object.values(value).forEach(inspect);
      };
      try { inspect(JSON.parse(requestDraft.graphql.variables || "{}")); } catch { /* GraphQL preparation reports invalid JSON. */ }
    }
    if (requestDraft.body.type === "json") {
      const original = requestDraft.body.json;
      requestDraft.body.json = original.replace(/{{\s*([^{}]+?)\s*}}/g, (token, _name: string, offset: number) => {
        if (insideJsonString(original, offset)) return token;
        const value = resolveEnvironmentValue(token, values);
        if (bindings.some((binding) => binding.marker === value)) { rawJsonMarkers.add(value); return JSON.stringify(token); }
        return token;
      });
    }
    const originalUrl = resolveEnvironmentValue(requestDraft.url, values);
    requestDraft.url = originalUrl;
    for (const binding of [...bindings]) {
      const urlBinding = { ...binding, marker: binding.marker.replace("end", "urlend"), encoding: "url" as const };
      const pathBinding = { ...binding, marker: binding.marker.replace("end", "pathend"), encoding: "path" as const };
      requestDraft.url = requestDraft.url.split(binding.marker).join(urlBinding.marker);
      requestDraft.pathParams = requestDraft.pathParams?.map((param) => param.enabled ? { ...param, value: resolveEnvironmentValue(param.value, values).split(binding.marker).join(pathBinding.marker) } : param);
      bindings.push(urlBinding, pathBinding);
    }
    const dynamicNames = namespace.filter((value) => value.kind === "dynamic-request").map((value) => value.name.trim());
    const sensitiveNames = (context.sensitiveVariableNames ?? []).filter((name) => !dynamicNames.includes(name));
    const prepared = await prepareWireRequest(requestDraft, { ...context, variables: values, sensitiveVariableNames: sensitiveNames }, { fileMode: "summary" });
    for (const snapshot of [prepared.request, prepared.displayRequest]) {
      const queryIndex = snapshot.url.indexOf("?");
      if (queryIndex >= 0) {
        let query = snapshot.url.slice(queryIndex);
        for (const binding of bindings.filter((value) => value.encoding === "url"))
          query = query.split(binding.marker).join(binding.marker.replace("urlend", "end"));
        snapshot.url = snapshot.url.slice(0, queryIndex) + query;
      }
    }
    // Runtime markers represent instructions to read newly extracted data, not secret values.
    // Preserve those pieces while masking every literal credential segment.
    const maskCredential = (value: string) => {
      const resolved = resolveEnvironmentValue(value, values);
      const tokens = bindings.map((binding) => binding.marker);
      let cursor = 0;
      let result = "";
      while (cursor < resolved.length) {
        const next = tokens.map((token) => ({ token, index: resolved.indexOf(token, cursor) }))
          .filter((entry) => entry.index >= 0).sort((a, b) => a.index - b.index)[0];
        if (!next) { result += "********"; break; }
        if (next.index > cursor) result += "********";
        result += next.token; cursor = next.index + next.token.length;
      }
      return result;
    };
    const maskedAuth = { ...auth.auth,
      bearer: { ...auth.auth.bearer, token: auth.auth.type === "bearer" ? maskCredential(auth.auth.bearer.token) : auth.auth.bearer.token },
      basic: { ...auth.auth.basic,
        username: auth.auth.type === "basic" ? maskCredential(auth.auth.basic.username) : auth.auth.basic.username,
        password: auth.auth.type === "basic" ? maskCredential(auth.auth.basic.password) : auth.auth.basic.password },
      apiKey: { ...auth.auth.apiKey, value: auth.auth.type === "api-key" ? maskCredential(auth.auth.apiKey.value) : auth.auth.apiKey.value },
    };
    const maskedBinding = getAuthBindingForRequest(maskedAuth, prepared.request.url, { ...context, variables: values }).binding;
    if (maskedBinding && bindings.some((binding) => {
      if (auth.auth.type === "basic") return `${maskedAuth.basic.username}:${maskedAuth.basic.password}`.includes(binding.marker);
      return maskedBinding.value.includes(binding.marker);
    })) {
      if (maskedBinding.target === "header") prepared.displayRequest.headers = prepared.displayRequest.headers.map(([name, value]) =>
        [name, name.toLowerCase() === maskedBinding.name.toLowerCase() ? maskedBinding.value : value]);
      else if (maskedBinding.target === "query") {
        const url = new URL(prepared.displayRequest.url);
        url.searchParams.set(maskedBinding.name, maskedBinding.value);
        prepared.displayRequest.url = url.toString();
      } else prepared.displayRequest.headers = prepared.displayRequest.headers.map(([name, value]) => [name,
        name.toLowerCase() === "cookie" ? value.split(";").map((part) => part.trim().split("=", 1)[0] === maskedBinding.name
          ? `${maskedBinding.name}=${maskedBinding.value}` : part.trim()).join("; ") : value]);
    }
    if (options.cookieJar && requestDraft.useCookieJar) {
      const cookies = options.cookieJar.header(prepared.request.url, "strict");
      if (cookies) {
        for (const [snapshot, masked] of [[prepared.request, false], [prepared.displayRequest, true]] as const) {
          const manual = snapshot.headers.filter(([name]) => name.toLowerCase() === "cookie").map(([, value]) => value).join("; ");
          const combined = mergeCookieHeader(manual, masked ? maskCookieHeader(cookies) : cookies);
          snapshot.headers = [...snapshot.headers.filter(([name]) => name.toLowerCase() !== "cookie"), ["Cookie", combined]];
        }
      }
    }
    const displayValues = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, sensitiveNames.includes(name) ? "********" : value]));
    const step: Step = { document: { ...document, request: resolveRequestEnvironment(requestDraft, values) }, displayDraft: resolveRequestEnvironment(requestDraft, displayValues), originalUrl: requestDraft.url, request: prepared.request, display: prepared.displayRequest, bindings, variable, file: `value-${steps.length}`, rawJsonMarkers, typedJsonMarkers };
    steps.push(step);
    return step;
  };
  try {
    await visit({ id: options.rootId, name: "Request", kind: draft.graphql ? "graphql" : "http", request: draft }, options.environmentId, []);
  } catch (cause) {
    if (foundDynamic) throw new DynamicRequestCodeError(cause instanceof Error ? cause.message : String(cause));
    throw cause;
  }
  if (!foundDynamic) return null;
  try { return { code: renderScript(steps, false), displayCode: renderScript(steps, true) }; }
  catch (cause) { throw new DynamicRequestCodeError(cause instanceof Error ? cause.message : String(cause)); }
}

function renderScript(steps: Step[], masked: boolean) {
  const lines = ["#!/usr/bin/env bash", "set -euo pipefail", "", "# Requires Bash, curl and jq. Dependencies execute afresh; no Purr cache is exported.",
    'command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }',
    'command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }',
    'purr_tmp=$(mktemp -d)', 'trap \'rm -rf "$purr_tmp"\' EXIT', "umask 077", ""];
  steps.forEach((step, index) => {
    const snapshot = masked ? step.display : step.request;
    lines.push(`# Step ${index + 1}: ${step.document.name.replace(/[\r\n]/g, " ")}${step.variable ? ` → {{${step.variable.name.replace(/[\r\n]/g, " ")}}}` : ""}`);
    const expression = (value: string, mode: "raw" | "url" | "json" | "form" | "header" = "raw") => {
      const args = step.bindings.map((binding, i) => `--rawfile v${i} "$purr_tmp/${binding.file}"`).join(" ");
      const replacements: { token: string; expression: string }[] = [];
      step.bindings.forEach((binding, i) => {
        let replacement = `$v${i}`;
        if (mode === "form") replacement = `($v${i} | @uri | gsub("%20"; "+"))`;
        if (mode === "json") {
          // Replace full JSON literals first for raw values. String placeholders use JSON escaping.
          if (step.typedJsonMarkers.has(binding.marker)) { replacements.push({ token: JSON.stringify(binding.marker), expression: `($v${i} | (try fromjson catch $v${i}) | tojson)` }); return; }
          if (step.rawJsonMarkers.has(binding.marker)) { replacements.push({ token: JSON.stringify(binding.marker), expression: `($v${i} | fromjson | tojson)` }); return; }
          replacement = `($v${i} | tojson | .[1:-1])`;
        }
        if (mode === "url") {
          if (binding.encoding === "path") replacement = `($v${i} | @uri)`;
          else if (binding.encoding === "url") {
            // WHATWG URL keeps URI delimiters and already escaped bytes in literal URL templates.
            // Explicit path parameters are separately encoded above.
            const reserved = [";", "/", "?", ":", "@", "&", "=", "+", "$", ",", "#", "%"];
            replacement = `($v${i} | @uri${reserved.map((char) => ` | gsub(${JSON.stringify(encodeURIComponent(char))}; ${JSON.stringify(char)})`).join("")})`;
          } else replacement = `($v${i} | @uri | gsub("%20"; "+"))`;
        }
        replacements.push({ token: binding.marker, expression: replacement });
      });
      const segments: string[] = [];
      let cursor = 0;
      while (cursor < value.length) {
        const next = replacements.map((replacement) => ({ ...replacement, index: value.indexOf(replacement.token, cursor) }))
          .filter((replacement) => replacement.index >= 0).sort((a, b) => a.index - b.index || b.token.length - a.token.length)[0];
        if (!next) { segments.push(JSON.stringify(value.slice(cursor))); break; }
        if (next.index > cursor) segments.push(JSON.stringify(value.slice(cursor, next.index)));
        segments.push(next.expression); cursor = next.index + next.token.length;
      }
      // Only the original template is scanned. Extracted text is never interpreted as another marker.
      let filter = `[${segments.join(", ")}] | join("")`;
      if (mode === "header") filter += ' | if test("[\\r\\n]") then error("Header values cannot contain line breaks") else . end';
      return `jq -nrj ${args} ${quote(filter)}`;
    };
    let url = snapshot.url;
    const urlRoot = step.bindings.find((binding) => binding.encoding === "url" && step.originalUrl.startsWith(binding.marker));
    if (urlRoot) {
      // A whole URL is supplied at runtime. Keep its original query, then apply explicit rows.
      const preparedSuffix = snapshot.url.replace(`https://${urlRoot.marker}`, "");
      const path = preparedSuffix.split(/[?#]/, 1)[0];
      const extra = new URL(snapshot.url).search.slice(1);
      url = `${urlRoot.marker}${path === "/" && !step.originalUrl.startsWith(`${urlRoot.marker}/`) ? "" : path}`;
      lines.push(`purr_url=$(${expression(url, "url")})`);
      if (extra) {
        lines.push(`purr_query=$(${expression(extra, "form")})`);
        lines.push(`purr_url=$(jq -nrj --arg url "$purr_url" --arg extra "$purr_query" ${quote('$url | split("#") as $hash | $hash[0] | split("?") as $parts | ($extra | split("&") | map(split("=")[0])) as $keys | (($parts[1:] | join("?") | split("&") | map(select(length > 0) | select((split("=")[0] as $key | $keys | index($key)) == null))) + ($extra | split("&"))) as $query | $parts[0] + "?" + ($query | join("&")) + (if ($hash | length) > 1 then "#" + ($hash[1:] | join("#")) else "" end)')})`);
      }
    } else lines.push(`purr_url=$(${expression(url, "url")})`);
    lines.push('case "$purr_url" in https:*) purr_redirect="=https" ;; *) purr_redirect="=http,https" ;; esac');
    const args = ["curl --silent --show-error --location --max-redirs 10 --max-time 60 --proto =http,https", '  --proto-redir "$purr_redirect"', `  --request ${quote(snapshot.method)}`];
    snapshot.headers.forEach(([name, value], headerIndex) => {
      if (snapshot.bodySummary?.kind === "multipart" && name.toLowerCase() === "content-type") return;
      if (value.startsWith("Basic ") && /^[A-Za-z0-9+/=]+$/.test(value.slice(6))) {
        const decoded = new TextDecoder().decode(Uint8Array.from(atob(value.slice(6)), (char) => char.charCodeAt(0)));
        if (step.bindings.some((binding) => decoded.includes(binding.marker))) {
          lines.push(`purr_basic=$(${expression(decoded)} | jq -Rrsj '@base64')`);
          args.push(`  --header "Authorization: Basic $purr_basic"`); return;
        }
      }
      lines.push(`purr_header_${headerIndex}=$(${expression(`${name}: ${value}`, "header")})`);
      args.push(`  --header "$purr_header_${headerIndex}"`);
    });
    if (snapshot.bodySummary?.kind === "file") {
      const name = `PURR_FILE_${index + 1}`;
      lines.push(`: "\${${name}:?Set ${name} to the local path of ${snapshot.bodySummary.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}}"`);
      args.push(`  --data-binary "@$${name}"`);
    } else if (snapshot.bodySummary?.kind === "multipart") {
      (masked ? step.displayDraft : step.document.request).body.formData.filter((field) => field.enabled).forEach((field, fileIndex) => {
        if (field.fieldType === "file" && field.attachment) {
          const name = `PURR_FILE_${index + 1}_${fileIndex + 1}`;
          lines.push(`: "\${${name}:?Set ${name} to the local path of ${field.attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_")}}"`);
          args.push(`  --form "$(${expression(field.key)})=@$(printf '%s' \"$${name}\" | jq -Rs .)"`);
        } else args.push(`  --form-string "$(${expression(`${field.key}=${field.value}`)})"`);
      });
    } else if (snapshot.bodyBase64) {
      const body = new TextDecoder().decode(Uint8Array.from(atob(snapshot.bodyBase64), (char) => char.charCodeAt(0)));
      const mode = snapshot.headers.some(([name, value]) => name.toLowerCase() === "content-type" && value.includes("application/json")) ? "json"
        : step.document.request.body.type === "url-encoded" ? "form" : "raw";
      lines.push(`${expression(body, mode)} > "$purr_tmp/body-${index}"`);
      args.push(`  --data-binary "@$purr_tmp/body-${index}"`);
    }
    if (step.document.request.useCookieJar) args.push('  --cookie "$purr_tmp/cookies" --cookie-jar "$purr_tmp/cookies"');
    args.push(`  --output "$purr_tmp/response-${index}"`, '  "$purr_url"');
    lines.push(`${args.join(" \\\n")} || { echo ${quote(`Request failed at step ${index + 1}`)} >&2; exit 1; }`);
    if (step.variable) {
      const filter = `${compileResponseQuery(step.variable.expression, step.variable.language)} | if type == "string" then . else tojson end`;
      lines.push(`jq -rj ${quote(filter)} "$purr_tmp/response-${index}" > "$purr_tmp/${step.file}" || { echo ${quote(`Extraction failed at step ${index + 1}: {{${step.variable.name}}}`)} >&2; exit 1; }`);
    } else lines.push(`cat "$purr_tmp/response-${index}"`);
    lines.push("");
  });
  return lines.join("\n");
}
