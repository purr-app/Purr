import { invoke } from "@tauri-apps/api/core";
import type { AttachmentWritePort } from "../../application/ports/attachments";

export const tauriAttachments: AttachmentWritePort = {
  begin: (workspaceId, stageId, metadata) => invoke("attachment_begin", {
    workspaceId, stageId, name: metadata.name, mediaType: metadata.type,
    size: metadata.size, lastModified: metadata.lastModified,
  }),
  append: (workspaceId, stageId, index, bytes) => invoke("attachment_append", bytes, {
    headers: { "x-purr-workspace": workspaceId, "x-purr-stage": stageId, "x-purr-index": String(index) },
  }),
  finish: (workspaceId, stageId) => invoke("attachment_finish", { workspaceId, stageId }),
  abort: (workspaceId, stageId) => invoke("attachment_abort", { workspaceId, stageId }),
};
