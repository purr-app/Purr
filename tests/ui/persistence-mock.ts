import type { Page } from "@playwright/test";

// Protocol fake only; native encryption/filesystem behavior is tested in Rust.
export async function installPersistenceMock(page: Page) {
  await page.addInitScript(() => {
    let internals: any;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true, get: () => internals,
      set: (value) => {
        const original = value.invoke;
        value.transformCallback ??= () => 1;
        value.invoke = async (command: string, args: any) => {
          const snapshot = JSON.parse(localStorage.getItem("purr-native-persistence-test") ?? '{"activeWorkspaceId":"","workspaces":[]}');
          const histories = JSON.parse(localStorage.getItem("purr-native-history-test") ?? "{}");
          const history = histories[args?.id] ?? { entries: [], retentionDays: 30 };
          const prune = () => { history.entries = history.entries.filter((entry: any) => entry.pinned || entry.startedAt >= Date.now() - history.retentionDays * 86400000); };
          const saveHistory = () => { histories[args.id] = history; localStorage.setItem("purr-native-history-test", JSON.stringify(histories)); };
          if (command === "request_history") {
            const action = args.action;
            if (action.operation === "append" && !history.entries.some((entry: any) => entry.id === action.entry.id)) history.entries.push(action.entry);
            if (action.operation === "pin") history.entries.forEach((entry: any) => { if (entry.id === action.id) entry.pinned = action.pinned; });
            if (action.operation === "remove") history.entries = history.entries.filter((entry: any) => !((!action.filter.id || entry.id === action.filter.id) && (!action.filter.documentId || entry.documentId === action.filter.documentId)));
            if (action.operation === "settings" && action.retentionDays != null) history.retentionDays = action.retentionDays;
            prune(); saveHistory();
            if (action.operation === "settings") return { retentionDays: history.retentionDays };
            if (action.operation === "existing") return action.ids.filter((id: string) => history.entries.some((entry: any) => entry.id === id));
            if (action.operation === "read") return history.entries.find((entry: any) => entry.id === action.id) ?? null;
            if (action.operation === "list") {
              const query = action.query ?? {};
              const matching = history.entries.filter((entry: any) => (!query.documentId || entry.documentId === query.documentId)
                && (!query.search || `${entry.name} ${entry.method} ${entry.url} ${entry.status ?? entry.outcome}`.toLowerCase().includes(query.search.toLowerCase()))
                && (!query.cursor || entry.startedAt < query.cursor.startedAt || entry.startedAt === query.cursor.startedAt && entry.id < query.cursor.id))
                .sort((a: any, b: any) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
              const items = matching.slice(0, query.limit ?? 50).map(({ editor: _editor, response: _response, files: _files, error: _error, version: _version, ...summary }: any) => summary);
              const last = items.at(-1);
              return { items, cursor: matching.length > items.length && last ? { startedAt: last.startedAt, id: last.id } : null };
            }
            return;
          }
          const restoreHistory = (workspace: any) => {
            if (!workspace) return workspace;
            const latest = new Map();
            for (const entry of [...(histories[workspace.id]?.entries ?? [])].sort((a: any, b: any) => b.startedAt - a.startedAt)) {
              if (entry.status != null && !latest.has(entry.documentId)) latest.set(entry.documentId, { table: "request_executions", id: entry.id, value: entry });
            }
            workspace.local = [...workspace.local.filter((item: any) => item.table !== "request_executions"), ...latest.values()];
            return workspace;
          };
          if (command === "load_persistence") return { ...snapshot, workspaces: snapshot.workspaces.map(restoreHistory) };
          if (command === "load_project") return restoreHistory(snapshot.workspaces.find((item: any) => item.id === args.id));
          if (command === "commit_project") {
            let workspace = snapshot.workspaces.find((item: any) => item.id === args.id);
            if (!workspace) { workspace = { id: args.id, files: {}, local: [] }; snapshot.workspaces.push(workspace); }
            const changed: Record<string, unknown> = {};
            for (const file of args.files) {
              if ((workspace.files[file.path]?.revision ?? null) !== file.expectedRevision) throw new Error("External file conflict");
              if (file.content === null) { delete workspace.files[file.path]; changed[file.path] = null; }
              else {
                const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(file.content));
                const revision = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
                workspace.files[file.path] = changed[file.path] = { content: file.content, revision };
              }
            }
            for (const record of args.local) {
              workspace.local = workspace.local.filter((item: any) => item.table !== record.table || item.id !== record.id);
              if (record.value !== null) workspace.local.push(record);
            }
            localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot)); return changed;
          }
          if (command === "set_local_active_workspace") { snapshot.activeWorkspaceId = args.id; localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot)); return; }
          if (command === "finish_legacy_migration") return;
          if (command.startsWith("secure_")) {
            const secrets = JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}");
            if (command === "secure_get") return secrets[args.reference] ?? null;
            if (command === "secure_exists") return args.reference in secrets;
            if (command === "secure_set") secrets[args.reference] = args.value;
            else delete secrets[args.reference];
            localStorage.setItem("purr-native-secure-test", JSON.stringify(secrets)); return;
          }
          if (command === "plugin:event|listen") return 1;
          if (command === "plugin:event|unlisten") return;
          return original(command, args);
        };
        internals = value;
      },
    });
  });
}
