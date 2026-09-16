import assert from "node:assert/strict";
import { test } from "node:test";

import type { RequestBodyPort } from "../src/application/ports/platform";
import type { PreparedHttpTransportRequest, RequestFileRef } from "../src/application/ports/http";
import { initialRequestDraft } from "../src/features/request-workbench/model/request";
import { executeRequest, prepareWireRequest } from "../src/features/request-workbench/services/execute-request";
import { executeHttp } from "../src/features/request-workbench/services/http-client";
import { SessionCookieJar } from "../src/features/request-workbench/model/cookie-jar";
import { decodeFiles } from "../src/storage/file-codec";

function stagingPort(staged: File[], released: RequestFileRef[]): RequestBodyPort {
  return {
    stage: async (file) => {
      staged.push(file);
      return {
        id: `request-file-${staged.length}`,
        name: file.name,
        size: file.size,
        mediaType: file.type || "application/octet-stream",
      };
    },
    release: async (reference) => { released.push(reference); },
  };
}

test("binary and multipart files become opaque request handles without full-body encoding", async () => {
  const staged: File[] = [];
  const port = stagingPort(staged, []);
  const binary = structuredClone(initialRequestDraft);
  binary.method = "POST";
  binary.url = "https://example.test/upload";
  binary.body.type = "binary";
  const file = new File([new Uint8Array([0, 1, 2, 255])], "payload.bin", { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: () => { throw new Error("full file materialized"); } });
  binary.body.binary = { file, name: file.name, size: file.size, mimeType: file.type };
  const preparedBinary = await prepareWireRequest(binary, {}, {
    fileMode: "native",
    requestBodies: port,
  });
  assert.equal(preparedBinary.request.bodyBase64, null);
  assert.deepEqual(preparedBinary.request.bodySource, {
    kind: "file",
    reference: { id: "request-file-1", name: "payload.bin", size: 4, mediaType: "application/octet-stream" },
  });
  assert.deepEqual(preparedBinary.displayRequest.bodySummary, {
    kind: "file",
    fileName: "payload.bin",
    byteLength: 4,
    mediaType: "application/octet-stream",
  });

  const multipart = structuredClone(initialRequestDraft);
  multipart.method = "POST";
  multipart.url = "https://example.test/form";
  multipart.body.type = "form-data";
  multipart.body.formData = [
    { id: "form-data-1", key: "note", value: "hello", enabled: true, fieldType: "text" },
    { id: "form-data-2", key: "upload", value: "", enabled: true, fieldType: "file", attachment: file, contentType: file.type },
  ];
  const preparedMultipart = await prepareWireRequest(multipart, {}, {
    fileMode: "native",
    requestBodies: port,
  });
  assert.equal(preparedMultipart.request.bodyBase64, null);
  assert.deepEqual(preparedMultipart.request.bodySource, {
    kind: "multipart",
    parts: [
      { kind: "text", name: "note", value: "hello", mediaType: "text/plain" },
      { kind: "file", name: "upload", reference: { id: "request-file-2", name: "payload.bin", size: 4, mediaType: "application/octet-stream" } },
    ],
  });
  assert.deepEqual(preparedMultipart.displayRequest.bodySummary, {
    kind: "multipart",
    partCount: 2,
    files: [{ fileName: "payload.bin", byteLength: 4, mediaType: "application/octet-stream" }],
  });
  assert.equal(staged.length, 2);
});

test("request-code preparation summarizes file bodies without reading or staging them", async () => {
  const draft = structuredClone(initialRequestDraft);
  draft.method = "POST";
  draft.url = "https://example.test/upload";
  draft.body.type = "binary";
  const file = new File([new Uint8Array(32 * 1024)], "large.bin", {
    type: "application/octet-stream",
  });
  Object.defineProperty(file, "arrayBuffer", {
    value: () => { throw new Error("request code materialized the file"); },
  });
  draft.body.binary = {
    file,
    name: file.name,
    size: file.size,
    mimeType: file.type,
  };

  const prepared = await prepareWireRequest(draft, {}, { fileMode: "summary" });
  assert.equal(prepared.request.bodyBase64, null);
  assert.equal(prepared.request.bodySource, undefined);
  assert.deepEqual(prepared.request.bodySummary, {
    kind: "file",
    fileName: "large.bin",
    byteLength: 32 * 1024,
    mediaType: "application/octet-stream",
  });
  assert.deepEqual(prepared.displayRequest.bodySummary, prepared.request.bodySummary);
});

test("the Tauri adapter stages request files as bounded raw IPC chunks", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const expected = new Uint8Array(600 * 1024).map((_, index) => index % 251);
  const chunks: { offset: number; bytes: Uint8Array }[] = [];
  const reference: RequestFileRef = {
    id: "request-file-chunked",
    name: "chunked.bin",
    size: expected.length,
    mediaType: "application/octet-stream",
  };
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: unknown, options?: { headers?: Record<string, string> }) => {
            if (command === "request_file_create") return reference;
            if (command === "request_file_append") {
              assert.ok(args instanceof Uint8Array);
              assert.equal(options?.headers?.["x-purr-file-id"], reference.id);
              chunks.push({
                offset: Number(options?.headers?.["x-purr-file-offset"]),
                bytes: new Uint8Array(args),
              });
              return null;
            }
            if (command === "request_file_finish") return reference;
            if (command === "request_file_release") return null;
            throw new Error(`Unexpected command: ${command}`);
          },
        },
      },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { platform: "MacIntel" },
    });
    const { createTauriPlatformAdapters } = await import("../src/platform/tauri/application-services");
    const file = new File([expected], reference.name, { type: reference.mediaType });
    Object.defineProperty(file, "arrayBuffer", {
      value: () => { throw new Error("full file materialized"); },
    });
    assert.deepEqual(await createTauriPlatformAdapters().requestBodies.stage(file), reference);
    assert.deepEqual(chunks.map(({ offset }) => offset), [0, 256 * 1024, 512 * 1024]);
    assert.ok(chunks.every(({ bytes }) => bytes.length <= 256 * 1024));
    assert.deepEqual(Buffer.concat(chunks.map(({ bytes }) => Buffer.from(bytes))), Buffer.from(expected));
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: unknown }).window;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("the Tauri adapter stages a restored attachment inside Rust without loading it into the WebView", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const reference: RequestFileRef = {
    id: "request-file-local",
    name: "stored.bin",
    size: 32 * 1024 * 1024,
    mediaType: "application/octet-stream",
  };
  const calls: string[] = [];
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __TAURI_INTERNALS__: {
          invoke: async (command: string) => {
            calls.push(command);
            if (command === "request_file_from_attachment") return reference;
            throw new Error(`Unexpected command: ${command}`);
          },
        },
      },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { platform: "MacIntel" },
    });
    const file = decodeFiles(
      { __purrFileRef: "attachment-1" },
      new Map([["attachment-1", {
        version: 1,
        native: true,
        name: reference.name,
        type: reference.mediaType,
        lastModified: 1234,
        size: reference.size,
      }]]),
      "workspace-1",
      async () => { throw new Error("attachment bytes entered the WebView"); },
    );
    assert.ok(file instanceof File);
    const { createTauriPlatformAdapters } = await import("../src/platform/tauri/application-services");
    assert.deepEqual(
      await createTauriPlatformAdapters().requestBodies.stage(file),
      reference,
    );
    assert.deepEqual(calls, ["request_file_from_attachment"]);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: unknown }).window;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

for (const redirectStatus of [307, 308]) {
  test(`${redirectStatus} redirects replay the same repeatable request handle`, async () => {
    const reference: RequestFileRef = {
      id: "request-file-repeatable",
      name: "payload.bin",
      size: 1024,
      mediaType: "application/octet-stream",
    };
    const request: PreparedHttpTransportRequest = {
      url: "https://example.test/start",
      method: "POST",
      headers: [["Content-Type", reference.mediaType]],
      bodyBase64: null,
      bodySource: { kind: "file", reference },
      bodySummary: {
        kind: "file",
        fileName: reference.name,
        byteLength: reference.size,
        mediaType: reference.mediaType,
      },
    };
    const seen: PreparedHttpTransportRequest[] = [];
    let hop = 0;
    const result = await executeHttp(request, {
      transport: async (candidate) => {
        seen.push(candidate);
        hop += 1;
        return hop === 1
          ? { status: redirectStatus, statusText: "Redirect", durationMs: 1, headers: [["location", "/final"]], bodyBase64: "" }
          : { status: 200, statusText: "OK", durationMs: 1, headers: [["content-type", "text/plain"]], bodyBase64: btoa("ok") };
      },
    });
    assert.equal(result.status, 200);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0].bodySource, request.bodySource);
    assert.deepEqual(seen[1].bodySource, request.bodySource);
    assert.deepEqual(seen[1].bodySummary, request.bodySummary);
    assert.deepEqual(result.timeline.request.bodySummary, request.bodySummary);
    assert.equal(seen[1].method, "POST");
  });
}

test("request execution releases staged handles after success and transport failure", async () => {
  for (const fails of [false, true]) {
    const staged: File[] = [];
    const released: RequestFileRef[] = [];
    const port = stagingPort(staged, released);
    const draft = structuredClone(initialRequestDraft);
    draft.method = "POST";
    draft.url = "https://example.test/upload";
    draft.body.type = "binary";
    const file = new File(["payload"], "payload.txt", { type: "text/plain" });
    draft.body.binary = { file, name: file.name, size: file.size, mimeType: file.type };
    const execution = executeRequest(
      draft,
      {},
      new SessionCookieJar(),
      { busy: false, authorizing: false, error: "", now: 0, run: async () => null, cancel: () => {}, clearError: () => {} },
      async () => {
        if (fails) throw new Error("transport failed");
        return { status: 200, statusText: "OK", durationMs: 1, headers: [["content-type", "text/plain"]], bodyBase64: btoa("ok") };
      },
      undefined,
      undefined,
      port,
    );
    if (fails) await assert.rejects(execution, /transport failed/);
    else assert.equal((await execution).status, 200);
    assert.equal(staged.length, 1);
    assert.equal(released.length, 1);
    assert.equal(released[0].id, "request-file-1");
  }
});
