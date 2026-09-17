import type {
  ContentWindow,
  ResponseContentPort,
} from "../../../application/ports/response-content";
import type { ResponseContentRef } from "../../../domain/http";

// Native responses smaller than this may use the compatibility CodeMirror
// viewer. The boundary itself stays on the bounded path because a 1 MiB body
// can consist of one pathological line that blocks WebView layout.
export const inlineResponseLimitBytes = 1024 * 1024;
// A single source line above this threshold can synchronously stall CodeMirror
// even when the complete response is below the total-size boundary.
export const inlineResponseMaximumLineBytes = 64 * 1024;
export const responsePageBytes = 192 * 1024;
const maximumSearchMatches = 10_000;

export type ResponseContentMatch = {
  byteOffset: number;
  byteLength?: number;
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

export async function searchResponseContent(
  content: ResponseContentPort,
  reference: ResponseContentRef,
  query: string,
  signal?: AbortSignal,
  options: { regularExpression?: boolean; caseSensitive?: boolean } = {},
): Promise<readonly ResponseContentMatch[]> {
  if (!query) return [];
  const matches: ResponseContentMatch[] = [];
  let cursor: string | undefined;

  do {
    throwIfAborted(signal);
    const page = await content.search(
      reference,
      {
        text: query,
        caseSensitive: options.caseSensitive ?? false,
        regularExpression: options.regularExpression ?? false,
      },
      cursor,
      signal,
    );
    matches.push(...page.matches.slice(0, maximumSearchMatches - matches.length));
    if (!page.nextCursor || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  } while (matches.length < maximumSearchMatches);
  return matches;
}
