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
          if (command === "load_persistence") return snapshot;
          if (command === "load_project") return snapshot.workspaces.find((item: any) => item.id === args.id);
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
