import { createHash } from "node:crypto";
import type { AttachmentMetadata, AttachmentWritePort } from "../../src/application/ports/attachments";

/** Synthetic native boundary: tracks bounded chunks and publication lifetime. */
export function attachmentStagingFixture() {
  const stages = new Map<string, { workspace: string; metadata: AttachmentMetadata; chunks: Buffer[] }>();
  const events: string[] = [];
  const lengths: number[] = [];
  const port: AttachmentWritePort = {
    async begin(workspace, stageId, metadata) {
      events.push("begin"); stages.set(stageId, { workspace, metadata, chunks: [] });
    },
    async append(workspace, stageId, index, bytes) {
      const stage = stages.get(stageId)!;
      if (workspace !== stage.workspace || stage.chunks.length !== index) throw new Error("Invalid chunk scope or order");
      lengths.push(bytes.byteLength); stage.chunks.push(Buffer.from(bytes)); events.push("append");
    },
    async finish(workspace, stageId) {
      const stage = stages.get(stageId)!;
      if (workspace !== stage.workspace) throw new Error("Invalid scope");
      const contentDigest = createHash("sha256").update(Buffer.concat(stage.chunks)).digest("hex");
      const metadata = stage.metadata;
      const suffix = createHash("sha256").update(JSON.stringify([metadata.name, metadata.type, metadata.lastModified, contentDigest])).digest("hex").slice(0, 16);
      events.push("finish");
      return { attachmentId: `${contentDigest}-${suffix}`, contentDigest, record: { version: 2, native: true, ...metadata, stageId } };
    },
    async abort(workspace, stageId) {
      if (stages.get(stageId)?.workspace === workspace) stages.delete(stageId);
      events.push("abort");
    },
  };
  return { port, stages, events, lengths };
}
