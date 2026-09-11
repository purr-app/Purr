import { base64Bytes } from "../features/request-workbench/model/request-auth";
const files = new WeakMap<File, Promise<unknown>>();
export async function encodeFiles(value: unknown): Promise<unknown> {
  if (value instanceof File) {
    let encoded = files.get(value);
    if (!encoded) {
      encoded = value.arrayBuffer().then((buffer) => ({ __purrFile: { name: value.name, type: value.type, lastModified: value.lastModified, base64: base64Bytes(new Uint8Array(buffer)) } }));
      files.set(value, encoded);
    }
    return encoded;
  }
  if (Array.isArray(value)) return Promise.all(value.map(encodeFiles));
  if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await encodeFiles(child)])));
  return value;
}
export function decodeFiles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeFiles);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object.__purrFile && Object.keys(object).length === 1) {
      const file = object.__purrFile as { name: string; type: string; lastModified: number; base64: string };
      return new File([Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0))], file.name, { type: file.type, lastModified: file.lastModified });
    }
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, decodeFiles(child)]));
  }
  return value;
}
