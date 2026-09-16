import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  responseBaselineSizes,
  syntheticFixtureBytes,
  syntheticFixtureChunk,
  syntheticFixtureText,
  syntheticGraphqlIntrospection,
  syntheticGraphqlSdl,
} from "./performance/synthetic-fixtures";

test("performance fixture sizes are declared without allocating heavyweight CI bodies", () => {
  assert.deepEqual(responseBaselineSizes.map(({ bytes }) => bytes), [
    100 * 1024,
    1024 * 1024,
    20 * 1024 * 1024,
    100 * 1024 * 1024,
  ]);
});

test("synthetic response fixtures are exact, deterministic, and structurally valid", () => {
  const bytes = 4096;
  for (const kind of ["text", "lines", "json", "graphql", "ndjson", "xml", "binary"] as const) {
    const first = syntheticFixtureBytes(kind, bytes);
    const second = Buffer.concat([
      syntheticFixtureChunk(kind, bytes, 0, 997),
      syntheticFixtureChunk(kind, bytes, 997, bytes - 997),
    ]);
    assert.equal(first.length, bytes);
    assert.equal(createHash("sha256").update(first).digest("hex"), createHash("sha256").update(second).digest("hex"));
  }
  assert.equal(JSON.parse(syntheticFixtureText("json", bytes)).tail, "purr-tail-marker");
  assert.match(JSON.parse(syntheticFixtureText("json", bytes)).payload, /purr-middle-marker/);
  const graphql = JSON.parse(syntheticFixtureText("graphql", bytes));
  assert.equal(graphql.data.fixture, "purr-v1");
  assert.equal(graphql.errors[0].extensions.code, "SYNTHETIC");
  assert.equal(graphql.extensions.fixture, "purr-extension");
  const ndjson = syntheticFixtureText("ndjson", bytes).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(ndjson.at(-1).tail, "purr-tail-marker");
  assert.match(syntheticFixtureText("text", bytes), /purr-tail-marker/);
  assert.match(syntheticFixtureText("text", bytes), /purr-middle-marker/);
  assert.equal(syntheticFixtureText("lines", 20), "x\n".repeat(10));
  const xml = syntheticFixtureText("xml", bytes);
  assert.match(xml, /^<fixture>/);
  assert.match(xml, /purr-middle-marker/);
  assert.match(xml, /<tail>purr-tail-marker<\/tail><\/fixture>$/);
});

test("synthetic GraphQL fixtures contain no external data and scale deterministically", () => {
  const sdl = syntheticGraphqlSdl(12);
  assert.match(sdl, /type FixtureType11/);
  assert.doesNotMatch(sdl, /https?:|@|token|secret/i);
  const introspection = syntheticGraphqlIntrospection(12);
  assert.equal(introspection.__schema.queryType.name, "Query");
  assert.equal(introspection.__schema.types.filter((type) => type.name.startsWith("FixtureType")).length, 12);
});

test("the media fixture core is a small synthetic MP4 without local paths", () => {
  const video = readFileSync(new URL("./performance/fixtures/purr-synthetic-video.mp4", import.meta.url));
  assert.ok(video.length < 32 * 1024);
  assert.equal(video.subarray(4, 8).toString("ascii"), "ftyp");
  assert.doesNotMatch(video.toString("latin1"), /\/Users\/|\\Users\\|https?:|token|secret/i);
});
