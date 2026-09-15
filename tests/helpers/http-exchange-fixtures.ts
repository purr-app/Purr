import { readFileSync } from "node:fs";

import { restoreStoredHttpResponse, type HttpExchange, type InlineHttpResponse } from "../../src/domain/http";

function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as unknown;
}

export function inlineHttpResponseFixture(): InlineHttpResponse {
  const response = restoreStoredHttpResponse(fixture("http-execution-v1-inline.json"));
  if (!response || !("text" in response)) throw new Error("Invalid inline HTTP fixture.");
  return response;
}

export function referencedHttpExchangeFixture(): HttpExchange {
  const response = restoreStoredHttpResponse(fixture("http-execution-v2-ref.json"));
  if (!response || !("protocolVersion" in response)) throw new Error("Invalid referenced HTTP fixture.");
  return response;
}
