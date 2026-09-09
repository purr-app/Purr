import { invoke, isTauri } from "@tauri-apps/api/core";
import { base64Bytes } from "../../request-workbench/model/request-auth";
import { createWorkspace, validateWorkspace, type Workspace, type WorkspaceStore } from "../model/workspace";

const browserKey = "purr.workspaces.v1";
const fileCache = new WeakMap<File, Promise<unknown>>();

async function encode(value: unknown): Promise<unknown> {
  if (value instanceof File) {
    let pending = fileCache.get(value);
    if (!pending) {
      pending = value.arrayBuffer().then((buffer) => ({ __purrFile: {
        name: value.name, type: value.type, lastModified: value.lastModified, base64: base64Bytes(new Uint8Array(buffer)),
      } }));
      fileCache.set(value, pending);
    }
    return pending;
  }
  if (Array.isArray(value)) return Promise.all(value.map(encode));
  if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await encode(child)])));
  return value;
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object.__purrFile && Object.keys(object).length === 1) {
      const file = object.__purrFile as { name: string; type: string; lastModified: number; base64: string };
      return new File([Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0))], file.name, { type: file.type, lastModified: file.lastModified });
    }
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, decode(child)]));
  }
  return value;
}

export async function loadWorkspaceStore(): Promise<WorkspaceStore> {
  const raw: WorkspaceStore | null = isTauri()
    ? await invoke("load_workspace_store")
    : JSON.parse(localStorage.getItem(browserKey) ?? "null");
  if (raw != null && (!raw || typeof raw !== "object" || !Array.isArray(raw.workspaces)))
    throw new Error("Unsupported or damaged workspace index. The original data has not been changed.");
  const workspaces = raw?.workspaces?.map((workspace) => validateWorkspace(decode(workspace))) ?? [];
  if (new Set(workspaces.map((workspace) => workspace.id)).size !== workspaces.length)
    throw new Error("Duplicate workspace identifiers. The original data has not been changed.");
  if (!workspaces.length) workspaces.push(createWorkspace("Personal", "personal"));
  return { workspaces, activeWorkspaceId: workspaces.some((workspace) => workspace.id === raw?.activeWorkspaceId) ? raw!.activeWorkspaceId : workspaces[0].id };
}

let queue: Promise<void> = Promise.resolve();
const saved = new Map<string, Workspace>();
let activeId = "";
export function saveWorkspaceStore(store: WorkspaceStore): Promise<void> {
  const save = async () => {
    if (!isTauri()) {
      localStorage.setItem(browserKey, JSON.stringify(await encode(store)));
      return;
    }
    for (const workspace of store.workspaces) {
      if (saved.get(workspace.id) === workspace) continue;
      await invoke("save_workspace", { workspace: await encode(workspace) });
      saved.set(workspace.id, workspace);
    }
    if (activeId !== store.activeWorkspaceId) {
      await invoke("set_active_workspace", { id: store.activeWorkspaceId });
      activeId = store.activeWorkspaceId;
    }
  };
  queue = queue.catch(() => {}).then(save);
  return queue;
}

export async function openWorkspaceFolder(id: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("open_workspace_folder", { id });
}
