import { invoke, isTauri } from "@tauri-apps/api/core";

type BrowserSavePicker = (options: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<{ createWritable: () => Promise<{ write: (data: Uint8Array) => Promise<void>; close: () => Promise<void> }> }>;

function responseBytes(bodyBase64: string) {
  return Uint8Array.from(atob(bodyBase64), (character) => character.charCodeAt(0));
}

function extensionOf(fileName: string) {
  const extension = fileName.match(/\.([a-z0-9]{1,12})$/i)?.[1];
  return extension ? `.${extension}` : ".bin";
}

export async function downloadResponseBody(bodyBase64: string, suggestedName: string, mediaType: string) {
  if (isTauri())
    return invoke<string | null>("save_response_body", { bodyBase64, suggestedName, extension: extensionOf(suggestedName).slice(1) });

  const bytes = responseBytes(bodyBase64);
  const picker = (globalThis as typeof globalThis & { showSaveFilePicker?: BrowserSavePicker }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName, types: [{ description: mediaType || "Response file", accept: { [mediaType || "application/octet-stream"]: [extensionOf(suggestedName)] } }] });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return suggestedName;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return null;
      throw cause;
    }
  }

  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType || "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  return suggestedName;
}
