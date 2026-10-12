import assert from "node:assert/strict";
import { test } from "node:test";
import type { HttpTransportOptions, HttpTransportPort } from "../src/application/ports/http";
import { workspaceHttpTransport } from "../src/features/request-workbench/services/workspace-http-transport";

const request = { url: "https://example.test", method: "GET", headers: [] as [string, string][], bodyBase64: null };

test("workspace transport fixes response ownership without changing request or execution options", async () => {
  const calls: HttpTransportOptions[] = [];
  const transport: HttpTransportPort = async (wire, options) => {
    assert.equal(wire, request);
    calls.push(options!);
    return { status: 200, statusText: "OK", headers: [], durationMs: 0, bodyBase64: "" };
  };
  const first = workspaceHttpTransport(transport, "workspace-a");
  const second = workspaceHttpTransport(transport, "workspace-b");
  const signal = new AbortController().signal;
  const progress = () => {};
  await first(request, { workspaceId: "cannot-rebind", signal, onProgress: progress });
  await second(request);
  await first(request);
  assert.deepEqual(calls.map((call) => call.workspaceId), ["workspace-a", "workspace-b", "workspace-a"]);
  assert.equal(calls[0].signal, signal);
  assert.equal(calls[0].onProgress, progress);
  assert.ok(!("workspaceId" in request), "ownership is local transport context, not protocol data");
});

test("workspace transport rejects missing or malformed ownership", () => {
  const transport: HttpTransportPort = async () => { throw new Error("Should not dispatch"); };
  for (const id of ["", "../workspace", "workspace|scope", "a".repeat(129)]) {
    assert.throws(() => workspaceHttpTransport(transport, id), /Invalid response workspace/);
  }
});
