import type { AttachmentWritePort, NativeFileAttachmentRecord, PreparedAttachment } from "../application/ports/attachments";
import { base64Bytes } from "../features/request-workbench/model/request-auth";

export type FileAttachmentRecord = {
  version: 1;
  name: string;
  type: string;
  lastModified: number;
  size: number;
  base64: string;
};

export type { NativeFileAttachmentRecord, PreparedAttachment } from "../application/ports/attachments";

export type LocalAttachmentReference = {
  workspaceId: string;
  attachmentId: string;
};

export type FileAttachmentLoader = (attachmentId: string) => Promise<Uint8Array>;

/** Reconciliation is in-memory: preserve File objects instead of serializing bytes. */
export class TransientAttachments {
  readonly files = new Map<string, File>();
  private ids = new WeakMap<File, string>();
  retain(file: File): string {
    let id = this.ids.get(file);
    if (!id) { id = `transient-${crypto.randomUUID()}`; this.ids.set(file, id); this.files.set(id, file); }
    return id;
  }
}

const publishedAttachments = new WeakMap<File, Map<string, PreparedAttachment>>();

/** One publication owns its encrypted stages; never change the original File. */
export class AttachmentPreparation {
  private files = new WeakMap<File, Promise<PreparedAttachment>>();
  private stages = new Set<string>();
  private prepared = new Map<File, PreparedAttachment>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly workspaceId: string, private port: AttachmentWritePort, private existing: ReadonlySet<string> = new Set()) {}

  prepare(file: File): Promise<PreparedAttachment> {
    const previous = this.files.get(file);
    if (previous) return previous;
    const published = publishedAttachments.get(file)?.get(this.workspaceId);
    if (published && this.existing.has(published.attachmentId)) return Promise.resolve(published);
    // Serializing files also bounds a projection with hundreds of attachments.
    const result = this.queue.then(async () => {
      if (getLocalAttachmentReference(file))
        throw new Error("A local attachment cannot be moved to another workspace without exporting it first.");
      const stageId = crypto.randomUUID();
      this.stages.add(stageId);
      await this.port.begin(this.workspaceId, stageId, { name: file.name, type: file.type, size: file.size, lastModified: file.lastModified });
      const chunkSize = 256 * 1024;
      for (let offset = 0, index = 0; offset < file.size; offset += chunkSize, index += 1) {
        const bytes = await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer();
        await this.port.append(this.workspaceId, stageId, index, bytes);
      }
      const prepared = await this.port.finish(this.workspaceId, stageId);
      this.prepared.set(file, prepared);
      return prepared;
    });
    this.files.set(file, result);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Cache only confirmed publication, and reuse only while its owner is present. */
  acknowledge(): void {
    for (const [file, prepared] of this.prepared) {
      const { stageId: _stageId, ...record } = prepared.record;
      const scopes = publishedAttachments.get(file) ?? new Map<string, PreparedAttachment>();
      scopes.set(this.workspaceId, { ...prepared, record });
      publishedAttachments.set(file, scopes);
    }
  }

  async dispose(): Promise<void> {
    await this.queue;
    // Adopted stages are already gone. Lost replies and projection failures
    // still release every known stage; window/startup cleanup covers a lost abort.
    await Promise.allSettled([...this.stages].map((stageId) => this.port.abort(this.workspaceId, stageId)));
    this.stages.clear();
    this.prepared.clear();
  }
}

type EncodedFile = {
  attachmentId: string;
  contentDigest: string;
  record: FileAttachmentRecord;
};

const files = new WeakMap<File, Promise<EncodedFile>>();
const localAttachments = new WeakMap<File, LocalAttachmentReference>();
const cooperativeThreshold = 1024 * 1024;
const base64ChunkBytes = 192 * 1024;

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

async function cooperativeBase64(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength < cooperativeThreshold) return base64Bytes(bytes);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += base64ChunkBytes) {
    chunks.push(
      base64Bytes(
        bytes.subarray(offset, Math.min(bytes.byteLength, offset + base64ChunkBytes)),
      ),
    );
    if (offset + base64ChunkBytes < bytes.byteLength)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return chunks.join("");
}

export async function encodeFile(file: File): Promise<EncodedFile> {
  let encoded = files.get(file);
  if (!encoded) {
    encoded = (async () => {
      const buffer = await file.arrayBuffer();
      const contentDigest = hex(await crypto.subtle.digest("SHA-256", buffer));
      const metadata = new TextEncoder().encode(
        JSON.stringify([file.name, file.type, file.lastModified, contentDigest]),
      );
      const metadataDigest = hex(await crypto.subtle.digest("SHA-256", metadata));
      return {
        attachmentId: `${contentDigest}-${metadataDigest.slice(0, 16)}`,
        contentDigest,
        record: {
          version: 1,
          name: file.name,
          type: file.type,
          lastModified: file.lastModified,
          size: file.size,
          base64: await cooperativeBase64(new Uint8Array(buffer)),
        },
      };
    })();
    files.set(file, encoded);
  }
  return encoded;
}

export async function encodeFiles(
  value: unknown,
  attachments?: Map<string, FileAttachmentRecord | NativeFileAttachmentRecord>,
  preparation?: AttachmentPreparation,
  transient?: TransientAttachments,
): Promise<unknown> {
  if (value instanceof File) {
    if (transient) return { __purrFileRef: transient.retain(value) };
    const local = localAttachments.get(value);
    if (attachments && local && (!preparation || local.workspaceId === preparation.workspaceId)) {
      attachments.set(local.attachmentId, {
        version: 1,
        native: true,
        name: value.name,
        type: value.type,
        lastModified: value.lastModified,
        size: value.size,
      });
      return { __purrFileRef: local.attachmentId };
    }
    const encoded = attachments && preparation ? await preparation.prepare(value) : await encodeFile(value);
    if (attachments) {
      attachments.set(encoded.attachmentId, encoded.record);
      return { __purrFileRef: encoded.attachmentId };
    }
    return { __purrFile: encoded.record };
  }
  if (Array.isArray(value))
    return Promise.all(value.map((item) => encodeFiles(item, attachments, preparation, transient)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, child]) => [
          key,
          await encodeFiles(child, attachments, preparation, transient),
        ]),
      ),
    );
  return value;
}

function decodedSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
}

function localFile(
  attachmentId: string,
  record: NativeFileAttachmentRecord,
  workspaceId: string,
  load: FileAttachmentLoader,
): File {
  const file = new File([], record.name, {
    type: record.type,
    lastModified: record.lastModified,
  });
  let bytes: Promise<Uint8Array> | undefined;
  Object.defineProperties(file, {
    size: { configurable: true, get: () => record.size },
    arrayBuffer: {
      configurable: true,
      value: async () => {
        bytes ??= load(attachmentId);
        const loaded = await bytes;
        return loaded.buffer.slice(
          loaded.byteOffset,
          loaded.byteOffset + loaded.byteLength,
        ) as ArrayBuffer;
      },
    },
  });
  localAttachments.set(file, { workspaceId, attachmentId });
  return file;
}

function fileFromRecord(
  value: unknown,
  attachmentId?: string,
  workspaceId?: string,
  load?: FileAttachmentLoader,
): File {
  if (!value || typeof value !== "object")
    throw new Error("A local request attachment is missing or damaged.");
  const record = value as Partial<NativeFileAttachmentRecord & { base64: string }>;
  if (
    (record.version !== 1 && !(record.version === 2 && record.native === true)) ||
    typeof record.name !== "string" ||
    typeof record.type !== "string" ||
    typeof record.lastModified !== "number"
  )
    throw new Error("A local request attachment is missing or damaged.");
  if (record.native === true) {
    if (
      !attachmentId ||
      !workspaceId ||
      !load ||
      typeof record.size !== "number" ||
      !Number.isSafeInteger(record.size) ||
      record.size < 0
    )
      throw new Error("A local request attachment is missing or damaged.");
    return localFile(
      attachmentId,
      record as NativeFileAttachmentRecord,
      workspaceId,
      load,
    );
  }
  if (typeof record.base64 !== "string")
    throw new Error("A local request attachment is missing or damaged.");
  const size = decodedSize(record.base64);
  if (record.size !== undefined && record.size !== size)
    throw new Error("A local request attachment is missing or damaged.");
  return new File(
    [Uint8Array.from(atob(record.base64), (character) => character.charCodeAt(0))],
    record.name,
    { type: record.type, lastModified: record.lastModified },
  );
}

export function decodeFiles(
  value: unknown,
  attachments: ReadonlyMap<string, unknown> = new Map(),
  workspaceId?: string,
  loadAttachment?: FileAttachmentLoader,
  transient?: ReadonlyMap<string, File>,
): unknown {
  if (Array.isArray(value))
    return value.map((item) =>
      decodeFiles(item, attachments, workspaceId, loadAttachment, transient),
    );
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.__purrFileRef === "string" && Object.keys(object).length === 1)
      return transient?.get(object.__purrFileRef) ?? fileFromRecord(
        attachments.get(object.__purrFileRef),
        object.__purrFileRef,
        workspaceId,
        loadAttachment,
      );
    if (object.__purrFile && Object.keys(object).length === 1) {
      const legacy = object.__purrFile as {
        name: string;
        type: string;
        lastModified: number;
        base64: string;
      };
      return new File(
        [Uint8Array.from(atob(legacy.base64), (character) => character.charCodeAt(0))],
        legacy.name,
        { type: legacy.type, lastModified: legacy.lastModified },
      );
    }
    return Object.fromEntries(
      Object.entries(object).map(([key, child]) => [
        key,
        decodeFiles(child, attachments, workspaceId, loadAttachment, transient),
      ]),
    );
  }
  return value;
}

export function getLocalAttachmentReference(
  file: File,
): LocalAttachmentReference | undefined {
  return localAttachments.get(file);
}
