import assert from "node:assert/strict";
import { test } from "node:test";

import type { ResponseContentPort } from "../src/application/ports/response-content";
import { isInlineHttpResponse, responseForPersistence, type ResponseContentRef } from "../src/domain/http";
import { createRequestAuth } from "../src/features/request-workbench/model/request-auth";
import { executeHttp } from "../src/features/request-workbench/services/http-client";
import { fetchOAuthToken } from "../src/features/request-workbench/services/oauth-client";

const unavailable = () => Promise.reject(new Error("unused test operation"));

function contentPort(payloads: Map<string, Uint8Array>, released: string[]): ResponseContentPort {
  return {
    inspect: unavailable,
    readRange: async (reference, range) => {
      const payload = payloads.get(reference.id);
      if (!payload) throw new Error("missing fixture content");
      const bytes = payload.slice(range.offset, range.offset + range.length);
      return {
        offset: range.offset,
        bytesRead: bytes.length,
        content: Buffer.from(bytes).toString("base64"),
        complete: range.offset + bytes.length >= payload.length,
      };
    },
    readLines: unavailable,
    search: unavailable,
    format: unavailable,
    query: unavailable,
    save: unavailable,
    release: async (reference) => { released.push(reference.id); },
  };
}

function reference(id: string, bytes: Uint8Array): ResponseContentRef {
  return {
    id,
    byteLength: bytes.length,
    mediaType: "application/json",
    charset: "utf-8",
    complete: true,
  };
}

const pipelineTimings = (networkMs: number) => ({
  setupMs: 1,
  networkMs,
  encryptionMs: 0.5,
  sqliteWriteMs: 0.5,
  storageBackpressureMs: 0,
  nativeTotalMs: networkMs + 2,
  ipcMs: 1,
});

test("native response references materialize in bounded windows while persistence retains the reference", async () => {
  const marker = "purr-tail-marker";
  const bytes = new TextEncoder().encode(`${"x".repeat(192 * 1024 + 17)}${marker}`);
  const ref = reference("content-final", bytes);
  const released: string[] = [];
  const result = await executeHttp(
    { url: "https://example.com/data", method: "GET", headers: [], bodyBase64: null },
    {
      content: contentPort(new Map([[ref.id, bytes]]), released),
      transport: async () => ({
        status: 200,
        statusText: "OK",
        headers: [["content-type", "application/json"]],
        durationMs: 12,
        headersDurationMs: 4,
        downloadDurationMs: 8,
        content: ref,
      }),
    },
  );
  assert.equal(result.text.endsWith(marker), true);
  assert.deepEqual(Buffer.from(result.bodyBase64, "base64"), Buffer.from(bytes));
  assert.equal(result.sourceExchange?.content.id, ref.id);
  assert.equal(result.sourceExchange?.response.byteLength, bytes.length);
  const persisted = responseForPersistence(result);
  assert.equal(isInlineHttpResponse(persisted), false);
  assert.equal(JSON.stringify(persisted).includes(marker), false);
  assert.deepEqual(released, []);
});

test("native responses at the inline viewer limit stay as opaque exchanges", async () => {
  const bytes = new Uint8Array(1024 * 1024);
  const ref = reference("content-large", bytes);
  let reads = 0;
  const content = contentPort(new Map([[ref.id, bytes]]), []);
  const result = await executeHttp(
    { url: "https://example.com/large", method: "GET", headers: [], bodyBase64: null },
    {
      content: { ...content, readRange: async (...arguments_) => {
        reads++;
        return content.readRange(...arguments_);
      } },
      transport: async () => ({
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/plain"]],
        durationMs: 10,
        content: ref,
      }),
    },
  );
  assert.equal(isInlineHttpResponse(result), false);
  assert.equal("content" in result && result.content.id, ref.id);
  assert.equal(reads, 0);
});

test("redirect content handles are released before the next TypeScript-owned hop", async () => {
  const redirectBytes = new TextEncoder().encode("redirect body");
  const finalBytes = new TextEncoder().encode('{"ok":true}');
  const redirect = reference("content-redirect", redirectBytes);
  const final = reference("content-final", finalBytes);
  const released: string[] = [];
  let calls = 0;
  const result = await executeHttp(
    { url: "https://example.com/start", method: "GET", headers: [], bodyBase64: null },
    {
      content: contentPort(new Map([[final.id, finalBytes]]), released),
      transport: async () => ++calls === 1
        ? {
            status: 302,
            statusText: "Found",
            headers: [["location", "/final"]],
            durationMs: 2,
            pipelineTimings: pipelineTimings(2),
            content: redirect,
          }
        : {
            status: 200,
            statusText: "OK",
            headers: [["content-type", "application/json"]],
            durationMs: 3,
            pipelineTimings: pipelineTimings(3),
            content: final,
          },
    },
  );
  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.durationMs, 5);
  assert.equal(result.timeline.processing?.networkMs, 5);
  assert.equal(result.timeline.processing?.encryptionMs, 1);
  assert.deepEqual(released, [redirect.id]);
});

test("OAuth token parsing uses the same referenced native response path", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({
    access_token: "purr-fixture-access-token",
    token_type: "Bearer",
    expires_in: 3600,
  }));
  const ref = reference("content-oauth", bytes);
  const content = contentPort(new Map([[ref.id, bytes]]), []);
  const token = await fetchOAuthToken(
    {
      ...createRequestAuth().oauth2,
      grantType: "client_credentials",
      tokenUrl: "https://auth.example.com/token",
      clientId: "client",
      clientSecret: "secret",
    },
    "initial",
    undefined,
    async () => ({
      status: 200,
      statusText: "OK",
      headers: [["content-type", "application/json"]],
      durationMs: 2,
      content: ref,
    }),
    content,
  );
  assert.equal(token.accessToken, "purr-fixture-access-token");
});
