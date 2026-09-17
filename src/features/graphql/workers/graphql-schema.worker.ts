/// <reference lib="webworker" />

import { normalizeSchema } from "../model/graphql";
import type {
  GraphqlSchemaAnalysisRequest,
  GraphqlSchemaAnalysisResponse,
} from "../services/schema-analysis-contract";

const worker = self as DedicatedWorkerGlobalScope;
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

worker.addEventListener("message", (event: MessageEvent<GraphqlSchemaAnalysisRequest>) => {
  const { requestId, source } = event.data;
  try {
    const started = performance.now();
    const normalizedSdl = normalizeSchema(source);
    const response: GraphqlSchemaAnalysisResponse = {
      kind: "schema-normalized",
      requestId,
      normalizedSdl,
      profile: {
        sourceBytes: byteLength(source),
        normalizedSdlBytes: byteLength(normalizedSdl),
        durationMs: performance.now() - started,
      },
    };
    worker.postMessage(response);
  } catch (cause) {
    const response: GraphqlSchemaAnalysisResponse = {
      kind: "schema-analysis-error",
      requestId,
      message: cause instanceof Error ? cause.message : String(cause),
    };
    worker.postMessage(response);
  }
});

export {};
