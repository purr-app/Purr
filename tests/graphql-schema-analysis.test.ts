import test from "node:test";
import assert from "node:assert/strict";

import {
  GraphqlSchemaAnalyzer,
  analyzeGraphqlSchemaSynchronously,
  type GraphqlSchemaWorker,
} from "../src/features/graphql/services/schema-analysis";
import type {
  GraphqlSchemaAnalysisRequest,
  GraphqlSchemaAnalysisResponse,
} from "../src/features/graphql/services/schema-analysis-contract";

class FakeSchemaWorker {
  request?: GraphqlSchemaAnalysisRequest;
  terminated = false;
  private readonly messageListeners = new Set<(event: MessageEvent<GraphqlSchemaAnalysisResponse>) => void>();
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>();

  postMessage(message: GraphqlSchemaAnalysisRequest) { this.request = message; }
  addEventListener(type: "message" | "error", listener: ((event: MessageEvent<GraphqlSchemaAnalysisResponse>) => void) | ((event: ErrorEvent) => void)) {
    if (type === "message") this.messageListeners.add(listener as (event: MessageEvent<GraphqlSchemaAnalysisResponse>) => void);
    else this.errorListeners.add(listener as (event: ErrorEvent) => void);
  }
  removeEventListener(type: "message" | "error", listener: ((event: MessageEvent<GraphqlSchemaAnalysisResponse>) => void) | ((event: ErrorEvent) => void)) {
    if (type === "message") this.messageListeners.delete(listener as (event: MessageEvent<GraphqlSchemaAnalysisResponse>) => void);
    else this.errorListeners.delete(listener as (event: ErrorEvent) => void);
  }
  terminate() { this.terminated = true; }
  respond(response: GraphqlSchemaAnalysisResponse) {
    for (const listener of this.messageListeners) listener(new MessageEvent("message", { data: response }));
  }
}

test("schema analysis reports source/SDL sizes without changing schema semantics", () => {
  const source = "type Query { ping: String! }";
  const result = analyzeGraphqlSchemaSynchronously(source);
  assert.match(result.normalizedSdl, /type Query/);
  assert.match(result.normalizedSdl, /ping: String!/);
  assert.equal(result.profile.sourceBytes, Buffer.byteLength(source));
  assert.equal(result.profile.normalizedSdlBytes, Buffer.byteLength(result.normalizedSdl));
  assert.equal(result.profile.worker, false);
  assert.ok(result.profile.durationMs >= 0);
});

test("schema worker request IDs discard stale work and cancellation terminates the worker", async () => {
  const workers: FakeSchemaWorker[] = [];
  const analyzer = new GraphqlSchemaAnalyzer(() => {
    const worker = new FakeSchemaWorker();
    workers.push(worker);
    return worker as unknown as GraphqlSchemaWorker;
  });

  const first = analyzer.analyze("type Query { first: String }");
  const firstRejected = assert.rejects(first, (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError");
  const second = analyzer.analyze("type Query { second: String }");
  await firstRejected;
  assert.equal(workers[0].terminated, true);
  assert.ok(workers[0].request);
  assert.ok(workers[1].request);
  assert.ok(workers[1].request!.requestId > workers[0].request!.requestId);

  workers[0].respond({
    kind: "schema-normalized",
    requestId: workers[0].request!.requestId,
    normalizedSdl: "type Query { stale: String }",
    profile: { sourceBytes: 1, normalizedSdlBytes: 1, durationMs: 1 },
  });
  workers[1].respond({
    kind: "schema-normalized",
    requestId: workers[1].request!.requestId,
    normalizedSdl: "type Query { second: String }",
    profile: { sourceBytes: 29, normalizedSdlBytes: 29, durationMs: 2 },
  });
  assert.equal((await second).normalizedSdl, "type Query { second: String }");

  const controller = new AbortController();
  const third = analyzer.analyze("type Query { third: String }", controller.signal);
  const thirdRejected = assert.rejects(third, (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError");
  controller.abort();
  await thirdRejected;
  assert.equal(workers[2].terminated, true);
  analyzer.dispose();
});

