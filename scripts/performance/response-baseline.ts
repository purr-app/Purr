import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { normalizeSchema } from "../../src/features/graphql/model/graphql";
import {
  formatResponseBody,
  inspectResponseBody,
  queryResponseJson,
} from "../../src/features/request-workbench/model/response";
import {
  responseBaselineSizes,
  syntheticFixtureText,
  syntheticGraphqlIntrospection,
} from "../../tests/performance/synthetic-fixtures";

type MemorySample = {
  label: string;
  rssMiB: number;
  heapMiB: number;
  externalMiB: number;
};

type OperationSample = {
  label: string;
  durationMs: number;
};

const mebibytes = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const milliseconds = (value: number) => Math.round(value * 10) / 10;

function collectMemory(label: string): MemorySample {
  const memory = process.memoryUsage();
  return {
    label,
    rssMiB: mebibytes(memory.rss),
    heapMiB: mebibytes(memory.heapUsed),
    externalMiB: mebibytes(memory.external),
  };
}

function responseWorker(bytes: number) {
  global.gc?.();
  const memory: MemorySample[] = [collectMemory("start")];
  const operations: OperationSample[] = [];
  const measured = <T>(label: string, work: () => T) => {
    const started = performance.now();
    const result = work();
    operations.push({ label, durationMs: milliseconds(performance.now() - started) });
    memory.push(collectMemory(label));
    return result;
  };
  const source = measured("generate", () => syntheticFixtureText("json", bytes));
  const bodyBase64 = measured("base64 encode", () => Buffer.from(source, "utf8").toString("base64"));
  const decodedBytes = measured("base64 decode", () => Uint8Array.from(Buffer.from(bodyBase64, "base64")));
  const decodedText = measured("UTF-8 decode", () => new TextDecoder().decode(decodedBytes));
  const info = measured("inspect/JSON.parse", () => inspectResponseBody([["content-type", "application/json"]], decodedText));
  const formatted = measured("pretty/JSON.stringify", () => formatResponseBody({ text: decodedText, bodyBase64 }, info, "pretty"));
  const queryResult = measured("jq subset query", () => queryResponseJson(info.parsedJson, ".meta.fixture", "jq"));
  const searchIndex = measured("text search", () => decodedText.lastIndexOf("purr-tail-marker"));
  const peak = memory.reduce((current, sample) => sample.rssMiB > current.rssMiB ? sample : current);
  return {
    bytes,
    base64Bytes: Buffer.byteLength(bodyBase64),
    formattedBytes: Buffer.byteLength(formatted),
    queryResult,
    searchIndex,
    operations,
    memory,
    peakRssMiB: peak.rssMiB,
  };
}

function graphqlWorker(typeCount: number) {
  global.gc?.();
  const memory: MemorySample[] = [collectMemory("start")];
  const introspection = syntheticGraphqlIntrospection(typeCount);
  const source = JSON.stringify({ data: introspection });
  memory.push(collectMemory("fixture generated"));
  const started = performance.now();
  const normalized = normalizeSchema(source);
  const durationMs = milliseconds(performance.now() - started);
  memory.push(collectMemory("normalize schema"));
  return {
    typeCount,
    sourceBytes: Buffer.byteLength(source),
    normalizedSdlBytes: Buffer.byteLength(normalized),
    durationMs,
    memory,
    peakRssMiB: Math.max(...memory.map((sample) => sample.rssMiB)),
  };
}

function childResult(arguments_: string[]) {
  const script = fileURLToPath(import.meta.url);
  const result = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", script, ...arguments_], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || `Baseline worker exited with ${result.status}.`);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

function markdownReport(report: {
  generatedAt: string;
  runtime: string;
  platform: string;
  responses: Array<Record<string, unknown>>;
  graphql: Array<Record<string, unknown>>;
}) {
  const lines = [
    "# Purr response and GraphQL baseline",
    "",
    `Generated: ${report.generatedAt}`,
    `Runtime: ${report.runtime}`,
    `Platform: ${report.platform}`,
    "",
    "These values are observations, not CI thresholds. Each response size runs in a fresh process with explicit GC available.",
    "",
    "## Current response representation path",
    "",
    "| Body | Base64 | Pretty output | Peak RSS | Encode | Decode | JSON parse | Pretty | Query | Search |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const response of report.responses) {
    const operations = Object.fromEntries((response.operations as OperationSample[]).map((item) => [item.label, item.durationMs]));
    const bodyMiB = mebibytes(response.bytes as number);
    lines.push(`| ${bodyMiB} MiB | ${mebibytes(response.base64Bytes as number)} MiB | ${mebibytes(response.formattedBytes as number)} MiB | ${response.peakRssMiB} MiB | ${operations["base64 encode"]} ms | ${operations["base64 decode"]} ms | ${operations["inspect/JSON.parse"]} ms | ${operations["pretty/JSON.stringify"]} ms | ${operations["jq subset query"]} ms | ${operations["text search"]} ms |`);
  }
  lines.push(
    "",
    "## GraphQL schema normalization",
    "",
    "| Synthetic types | Introspection JSON | Normalized SDL | Duration | Peak RSS |",
    "| ---: | ---: | ---: | ---: | ---: |",
  );
  for (const graphql of report.graphql) {
    lines.push(`| ${graphql.typeCount} | ${mebibytes(graphql.sourceBytes as number)} MiB | ${mebibytes(graphql.normalizedSdlBytes as number)} MiB | ${graphql.durationMs} ms | ${graphql.peakRssMiB} MiB |`);
  }
  lines.push(
    "",
    "Native TTFB, WebView RSS, first visible content, download completion, and cancellation behavior require the desktop procedure in `tests/performance/README.md`; this runner does not claim to measure them.",
  );
  return lines.join("\n");
}

const worker = process.argv.indexOf("--response-worker");
const graphql = process.argv.indexOf("--graphql-worker");
if (worker >= 0) {
  process.stdout.write(JSON.stringify(responseWorker(Number(process.argv[worker + 1]))));
} else if (graphql >= 0) {
  process.stdout.write(JSON.stringify(graphqlWorker(Number(process.argv[graphql + 1]))));
} else {
  const report = {
    generatedAt: new Date().toISOString(),
    runtime: process.version,
    platform: `${process.platform}/${process.arch}`,
    responses: responseBaselineSizes.map(({ bytes }) => childResult(["--response-worker", String(bytes)])),
    graphql: [40, 1200].map((types) => childResult(["--graphql-worker", String(types)])),
  };
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${markdownReport(report)}\n`);
}
