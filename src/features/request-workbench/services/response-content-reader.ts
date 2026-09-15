import type {
  ContentWindow,
  ResponseContentPort,
} from "../../../application/ports/response-content";
import type { ResponseContentRef } from "../../../domain/http";

// Native responses smaller than this may use the compatibility CodeMirror
// viewer. The boundary itself stays on the bounded path because a 1 MiB body
// can consist of one pathological line that blocks WebView layout.
export const inlineResponseLimitBytes = 1024 * 1024;
export const responsePageBytes = 192 * 1024;
export const responseSearchWindowBytes = 4 * 1024 * 1024;
const maximumSearchMatches = 10_000;

export type ResponseContentMatch = {
  byteOffset: number;
  snippet: string;
};

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException("The operation was aborted", "AbortError");
}

export async function readResponseContentPage(
  content: ResponseContentPort,
  reference: ResponseContentRef,
  offset: number,
  mode: "text" | "hex" | "base64",
  signal?: AbortSignal,
): Promise<ContentWindow> {
  throwIfAborted(signal);
  const boundedOffset = Math.max(
    0,
    Math.min(Math.trunc(offset), Math.max(0, reference.byteLength - 1)),
  );
  return content.readRange(
    reference,
    {
      offset: boundedOffset,
      length: Math.min(
        responsePageBytes,
        reference.byteLength - boundedOffset,
      ),
    },
    mode,
    signal,
  );
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

function snippetAround(value: string, index: number, length: number) {
  const start = Math.max(0, index - 48);
  const end = Math.min(value.length, index + length + 96);
  return value.slice(start, end).replace(/\s+/g, " ");
}

// Phase 8 replaces this bounded TypeScript scanner with the native search
// operation. It deliberately retains only a small overlap and match metadata.
export async function searchResponseContent(
  content: ResponseContentPort,
  reference: ResponseContentRef,
  query: string,
  signal?: AbortSignal,
): Promise<readonly ResponseContentMatch[]> {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const matches: ResponseContentMatch[] = [];
  const overlapCharacters = Math.min(Math.max(needle.length - 1, 0), 4096);
  let carry = "";
  let offset = 0;

  while (offset < reference.byteLength && matches.length < maximumSearchMatches) {
    throwIfAborted(signal);
    const window = await content.readRange(
      reference,
      {
        offset,
        length: Math.min(responseSearchWindowBytes, reference.byteLength - offset),
      },
      "text",
      signal,
    );
    const decoded = window.content;
    const combined = carry + decoded;
    const searchable = combined.toLocaleLowerCase();
    const combinedOffset = Math.max(0, offset - byteLength(carry));
    let index = 0;
    while (matches.length < maximumSearchMatches) {
      index = searchable.indexOf(needle, index);
      if (index < 0) break;
      const matchOffset = combinedOffset + byteLength(combined.slice(0, index));
      const matchEnd = matchOffset + byteLength(combined.slice(index, index + query.length));
      if (matchEnd > offset) {
        matches.push({
          byteOffset: matchOffset,
          snippet: snippetAround(combined, index, query.length),
        });
      }
      index += Math.max(needle.length, 1);
    }
    if (!window.bytesRead) break;
    offset += window.bytesRead;
    carry = overlapCharacters ? combined.slice(-overlapCharacters) : "";
  }
  return matches;
}
