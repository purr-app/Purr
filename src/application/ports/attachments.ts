export type AttachmentMetadata = { name: string; type: string; size: number; lastModified: number };
export type NativeFileAttachmentRecord = AttachmentMetadata & { version: 1 | 2; native: true; stageId?: string };
export type PreparedAttachment = { attachmentId: string; contentDigest: string; record: NativeFileAttachmentRecord };

/** Encrypted staging only. Publication adopts the finished descriptor atomically. */
export interface AttachmentWritePort {
  begin(workspaceId: string, stageId: string, metadata: AttachmentMetadata): Promise<void>;
  append(workspaceId: string, stageId: string, index: number, bytes: ArrayBuffer): Promise<void>;
  finish(workspaceId: string, stageId: string): Promise<PreparedAttachment>;
  abort(workspaceId: string, stageId: string): Promise<void>;
}
