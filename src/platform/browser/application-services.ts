import type { PlatformAdapters } from "../../application/ports/platform";
import type { ResponseContentRef } from "../../domain/http";
import {
  BrowserPersistenceBackend,
  BrowserSecureStore,
} from "../../storage/browser-backend";

type BrowserSavePicker = (options: {
  suggestedName: string;
  types: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<{
  createWritable: () => Promise<{
    write: (data: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
  }>;
}>;

function extensionOf(fileName: string) {
  const extension = fileName.match(/\.([a-z0-9]{1,12})$/i)?.[1];
  return extension ? `.${extension}` : ".bin";
}

async function saveInlineResponse(
  bodyBase64: string,
  suggestedName: string,
  mediaType: string,
) {
  const bytes = Uint8Array.from(atob(bodyBase64), (character) =>
    character.charCodeAt(0),
  );
  const picker = (
    globalThis as typeof globalThis & {
      showSaveFilePicker?: BrowserSavePicker;
    }
  ).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [
          {
            description: mediaType || "Response file",
            accept: {
              [mediaType || "application/octet-stream"]: [
                extensionOf(suggestedName),
              ],
            },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return suggestedName;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError")
        return null;
      throw cause;
    }
  }

  const url = URL.createObjectURL(
    new Blob([bytes], { type: mediaType || "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  return suggestedName;
}

const unavailable = (message: string) => Promise.reject(new Error(message));
const unavailableContent = () =>
  Promise.reject(
    new Error("Response content handles are not available before Phase 5."),
  );

export function createBrowserPlatformAdapters(): PlatformAdapters {
  const secureStore = new BrowserSecureStore();
  return {
    observability: {
      integrations: async () => [],
      trace: () => unavailable("unavailable"),
    },
    persistenceBackend: new BrowserPersistenceBackend(),
    secureStore,
    httpTransport: () =>
      unavailable(
        "Send requests and authorize OAuth in the Purr desktop app (npm run tauri dev).",
      ),
    responseContent: {
      inspect: unavailableContent,
      readRange: unavailableContent,
      readLines: unavailableContent,
      search: unavailableContent,
      format: unavailableContent,
      query: unavailableContent,
      save: unavailableContent,
      mediaUrl: () => { throw new Error("Native media handles are unavailable in the browser."); },
      release: async (_reference: ResponseContentRef) => unavailableContent(),
    },
    oauthCallback: {
      authorize: () =>
        unavailable("Open Purr desktop to authorize using the system browser."),
      cancel: async () => {},
    },
    imports: {
      normalize: () =>
        unavailable("Workspace import requires the desktop application."),
    },
    downloads: { saveInlineResponse },
    requestBodies: {
      stage: () => unavailable("Native request body handles are unavailable in the browser."),
      release: async () => {},
    },
    importDialog: {
      choosePath: () =>
        unavailable(
          "Workspace file selection requires the desktop application. Drag a local file into this dialog instead.",
        ),
    },
    workspaceShell: { openWorkspaceFolder: async () => {} },
    lifecycle: {
      onCloseRequested: async () => () => {},
      exit: async () => {},
    },
    runtime: Object.freeze({ kind: "browser", os: "other" }),
  };
}
