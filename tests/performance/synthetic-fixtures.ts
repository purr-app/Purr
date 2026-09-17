import { buildSchema, introspectionFromSchema } from "graphql";

export const responseBaselineSizes = [
  { name: "100 KiB", bytes: 100 * 1024 },
  { name: "1 MiB", bytes: 1024 * 1024 },
  { name: "20 MiB", bytes: 20 * 1024 * 1024 },
  { name: "100 MiB", bytes: 100 * 1024 * 1024 },
] as const;

export type SyntheticResponseKind = "text" | "lines" | "json" | "graphql" | "ndjson" | "xml" | "binary";

const fixtures: Record<Exclude<SyntheticResponseKind, "binary" | "lines">, { prefix: string; suffix: string }> = {
  text: {
    prefix: "purr-synthetic-start\n",
    suffix: "\npurr-tail-marker\n",
  },
  json: {
    prefix: '{"meta":{"fixture":"purr-synthetic"},"payload":"',
    suffix: '","tail":"purr-tail-marker"}',
  },
  graphql: {
    prefix: '{"data":{"fixture":"purr-v1","payload":"',
    suffix: '"},"errors":[{"message":"Synthetic partial result","extensions":{"code":"SYNTHETIC"}}],"extensions":{"fixture":"purr-extension"}}',
  },
  ndjson: {
    prefix: '{"fixture":"purr-synthetic","index":0}\n{"payload":"',
    suffix: '","tail":"purr-tail-marker"}\n',
  },
  xml: {
    prefix: "<fixture><meta>purr-synthetic</meta><payload>",
    suffix: "</payload><tail>purr-tail-marker</tail></fixture>",
  },
};
const middleMarker = Buffer.from("purr-middle-marker");

function fixtureParts(kind: SyntheticResponseKind) {
  return kind === "binary" || kind === "lines" ? { prefix: "", suffix: "" } : fixtures[kind];
}

export function assertFixtureSize(kind: SyntheticResponseKind, bytes: number) {
  const { prefix, suffix } = fixtureParts(kind);
  if (!Number.isSafeInteger(bytes) || bytes < prefix.length + suffix.length) {
    throw new Error(`Synthetic ${kind} fixture size is too small.`);
  }
}

export function syntheticFixtureChunk(
  kind: SyntheticResponseKind,
  totalBytes: number,
  offset: number,
  length: number,
) {
  assertFixtureSize(kind, totalBytes);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > totalBytes) {
    throw new Error("Synthetic fixture chunk is outside the body bounds.");
  }
  const chunk = Buffer.alloc(length, kind === "binary" ? 0 : "x".charCodeAt(0));
  if (kind === "binary") {
    for (let index = 0; index < length; index++) chunk[index] = ((offset + index) * 31 + 17) % 256;
    return chunk;
  }
  if (kind === "lines") {
    for (let index = 0; index < length; index++) {
      chunk[index] = (offset + index) % 2 === 0 ? "x".charCodeAt(0) : "\n".charCodeAt(0);
    }
    return chunk;
  }
  const { prefix, suffix } = fixtureParts(kind);
  const prefixBytes = Buffer.from(prefix);
  const suffixBytes = Buffer.from(suffix);
  const suffixOffset = totalBytes - suffixBytes.length;
  const middleOffset = Math.floor((totalBytes - middleMarker.length) / 2);
  for (let index = 0; index < length; index++) {
    const absolute = offset + index;
    if (absolute < prefixBytes.length) chunk[index] = prefixBytes[absolute];
    else if (absolute >= suffixOffset) chunk[index] = suffixBytes[absolute - suffixOffset];
    else if (absolute >= middleOffset && absolute < middleOffset + middleMarker.length)
      chunk[index] = middleMarker[absolute - middleOffset];
  }
  return chunk;
}

export function syntheticFixtureBytes(kind: SyntheticResponseKind, bytes: number) {
  return syntheticFixtureChunk(kind, bytes, 0, bytes);
}

export function syntheticFixtureText(kind: Exclude<SyntheticResponseKind, "binary">, bytes: number) {
  return syntheticFixtureBytes(kind, bytes).toString("utf8");
}

export function syntheticGraphqlSdl(typeCount: number) {
  if (!Number.isSafeInteger(typeCount) || typeCount < 1 || typeCount > 5_000) {
    throw new Error("Synthetic GraphQL type count must be between 1 and 5000.");
  }
  const types = Array.from({ length: typeCount }, (_, index) => {
    const next = index + 1 < typeCount ? ` next: FixtureType${index + 1}` : "";
    return `type FixtureType${index} { id: ID! label: String! enabled: Boolean!${next} }`;
  });
  return [`type Query { fixture: FixtureType0! }`, ...types].join("\n");
}

export function syntheticGraphqlIntrospection(typeCount: number) {
  return introspectionFromSchema(buildSchema(syntheticGraphqlSdl(typeCount)));
}
