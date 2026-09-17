import type { DownloadPort } from "../../../application/ports/platform";

export function downloadResponseBody(
  download: DownloadPort,
  bodyBase64: string,
  suggestedName: string,
  mediaType: string,
) {
  return download.saveInlineResponse(bodyBase64, suggestedName, mediaType);
}
