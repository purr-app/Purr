import assert from "node:assert/strict";
import { test } from "node:test";

import type { ResponseContentPort } from "../src/application/ports/response-content";
import type { ResponseContentRef } from "../src/domain/http";
import {
  readResponseContentPage,
  responsePageBytes,
  searchResponseContent,
} from "../src/features/request-workbench/services/response-content-reader";

const fixtureSize = 100 * 1024 * 1024;
const marker = new TextEncoder().encode("purr-large-marker");
const markerOffsets = [64, fixtureSize - 128];

function syntheticLargeContent(requestLengths: number[], searchRequests: string[]): ResponseContentPort {
  const unavailable = () => Promise.reject(new Error("unused operation"));
  return {
    inspect: unavailable,
    readRange: async (_reference, range, mode) => {
      requestLengths.push(range.length);
      const length = Math.min(range.length, fixtureSize - range.offset);
      const bytes = new Uint8Array(length).fill("x".charCodeAt(0));
      for (const markerOffset of markerOffsets) {
        const from = Math.max(range.offset, markerOffset);
        const to = Math.min(range.offset + length, markerOffset + marker.length);
        if (from >= to) continue;
        bytes.set(
          marker.slice(from - markerOffset, to - markerOffset),
          from - range.offset,
        );
      }
      const content = mode === "text"
        ? new TextDecoder().decode(bytes)
        : Buffer.from(bytes).toString("base64");
      return {
        offset: range.offset,
        bytesRead: bytes.length,
        content,
        complete: range.offset + bytes.length >= fixtureSize,
      };
    },
    readLines: unavailable,
    search: async (_reference, query, cursor) => {
      searchRequests.push(`${query.text}:${cursor ?? "first"}`);
      return {
        matches: markerOffsets.map((byteOffset) => ({
          byteOffset,
          snippet: `x ${query.text} x`,
        })),
        totalKnown: markerOffsets.length,
      };
    },
    format: unavailable,
    query: unavailable,
    save: unavailable,
    release: async () => {},
  };
}

test("100 MiB response paging and search retain only bounded content windows", async () => {
  const requests: number[] = [];
  const searchRequests: string[] = [];
  const content = syntheticLargeContent(requests, searchRequests);
  const reference: ResponseContentRef = {
    id: "synthetic-100-mib",
    byteLength: fixtureSize,
    mediaType: "text/plain",
    charset: "utf-8",
    complete: true,
  };

  const first = await readResponseContentPage(content, reference, 0, "text");
  const last = await readResponseContentPage(
    content,
    reference,
    fixtureSize - responsePageBytes,
    "text",
  );
  assert.equal(first.content.includes("purr-large-marker"), true);
  assert.equal(last.content.includes("purr-large-marker"), true);

  const matches = await searchResponseContent(content, reference, "purr-large-marker");
  assert.deepEqual(matches.map((match) => match.byteOffset), markerOffsets);
  assert.equal(searchRequests.length, 1);
  assert.ok(requests.every((length) => length <= responsePageBytes));
  assert.ok(requests.every((length) => length < fixtureSize));
});
