import { normalizeSchema } from "../model/graphql";
import type {
  GraphqlSchemaAnalysisProfile,
  GraphqlSchemaAnalysisRequest,
  GraphqlSchemaAnalysisResponse,
} from "./schema-analysis-contract";

export type GraphqlSchemaAnalysis = {
  normalizedSdl: string;
  profile: GraphqlSchemaAnalysisProfile & { roundTripMs: number; worker: boolean };
};

type WorkerMessageListener = (event: MessageEvent<GraphqlSchemaAnalysisResponse>) => void;
type WorkerErrorListener = (event: ErrorEvent) => void;

export interface GraphqlSchemaWorker {
  postMessage(message: GraphqlSchemaAnalysisRequest): void;
  addEventListener(type: "message", listener: WorkerMessageListener): void;
  addEventListener(type: "error", listener: WorkerErrorListener): void;
  removeEventListener(type: "message", listener: WorkerMessageListener): void;
  removeEventListener(type: "error", listener: WorkerErrorListener): void;
  terminate(): void;
}

export type GraphqlSchemaWorkerFactory = () => GraphqlSchemaWorker | undefined;

const abortError = () => new DOMException("GraphQL schema analysis was cancelled.", "AbortError");
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

export function analyzeGraphqlSchemaSynchronously(source: string): GraphqlSchemaAnalysis {
  const started = performance.now();
  const normalizedSdl = normalizeSchema(source);
  const durationMs = performance.now() - started;
  return {
    normalizedSdl,
    profile: {
      sourceBytes: byteLength(source),
      normalizedSdlBytes: byteLength(normalizedSdl),
      durationMs,
      roundTripMs: durationMs,
      worker: false,
    },
  };
}

function createBrowserWorker(): GraphqlSchemaWorker | undefined {
  if (typeof Worker === "undefined") return undefined;
  return new Worker(new URL("../workers/graphql-schema.worker.ts", import.meta.url), {
    type: "module",
    name: "purr-graphql-schema",
  });
}

export class GraphqlSchemaAnalyzer {
  private nextRequestId = 0;
  private worker: GraphqlSchemaWorker | undefined;
  private active: {
    requestId: number;
    reject: (reason: unknown) => void;
    removeAbortListener: () => void;
  } | undefined;

  constructor(private readonly workerFactory: GraphqlSchemaWorkerFactory | undefined = createBrowserWorker) {}

  async analyze(source: string, signal?: AbortSignal): Promise<GraphqlSchemaAnalysis> {
    if (signal?.aborted) throw abortError();
    this.cancel();
    if (!this.workerFactory) {
      await Promise.resolve();
      if (signal?.aborted) throw abortError();
      return analyzeGraphqlSchemaSynchronously(source);
    }

    const worker = this.workerFactory();
    if (!worker) return analyzeGraphqlSchemaSynchronously(source);
    this.worker = worker;
    const requestId = ++this.nextRequestId;
    const started = performance.now();

    return new Promise<GraphqlSchemaAnalysis>((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        if (this.active?.requestId === requestId) this.active = undefined;
      };
      const finish = () => {
        cleanup();
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
      };
      const onAbort = () => {
        finish();
        reject(abortError());
      };
      const onError = (event: ErrorEvent) => {
        finish();
        reject(new Error(event.message || "GraphQL schema analysis worker failed."));
      };
      const onMessage = (event: MessageEvent<GraphqlSchemaAnalysisResponse>) => {
        if (event.data.requestId !== requestId) return;
        const roundTripMs = performance.now() - started;
        finish();
        if (event.data.kind === "schema-analysis-error") {
          reject(new Error(event.data.message));
          return;
        }
        try { performance.measure("purr.graphql.schema.worker-round-trip", { start: started, end: performance.now() }); }
        catch { /* Performance entries are diagnostics and must not affect schema installation. */ }
        resolve({
          normalizedSdl: event.data.normalizedSdl,
          profile: {
            ...event.data.profile,
            roundTripMs,
            worker: true,
          },
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      this.active = { requestId, reject, removeAbortListener: cleanup };
      worker.postMessage({ kind: "normalize-schema", requestId, source });
    });
  }

  cancel() {
    if (!this.active) return;
    const active = this.active;
    this.active = undefined;
    active.removeAbortListener();
    this.worker?.terminate();
    this.worker = undefined;
    active.reject(abortError());
  }

  dispose() {
    this.cancel();
    this.worker?.terminate();
    this.worker = undefined;
  }
}
