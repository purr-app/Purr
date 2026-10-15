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
        let mutationQueue: Promise<unknown> = Promise.resolve();
        const dispatch = async (command: string, args: any) => {
          const snapshot = JSON.parse(localStorage.getItem("purr-native-persistence-test") ?? '{"activeWorkspaceId":"","workspaces":[]}');
          const histories = JSON.parse(localStorage.getItem("purr-native-history-test") ?? "{}");
          const secrets = JSON.parse(localStorage.getItem("purr-native-secure-test") ?? "{}");
          const revisions = JSON.parse(localStorage.getItem("purr-native-secure-revisions-test") ?? "{}");
          const operations = JSON.parse(localStorage.getItem("purr-native-secure-operations-test") ?? "{}");
          const protectedState = (window as any).__purrProtectedState ?? snapshot.protectedState ?? { status: "available" };
          const stateFor = (id?: string) => snapshot.workspaces.find((workspace: any) => workspace.id === id)?.protectedState ?? protectedState;
          const assertAvailable = (id?: string) => { const state = stateFor(id); if (state.status !== "available") throw new Error(state.code ?? "protected-storage-unavailable"); };
          const requestedBatch = command === "secure_commit" ? args.batch
            : command === "request_history" && args.action.operation === "append" ? args.action.secrets
              : command === "commit_project" || command === "write_global_state" ? args.secrets : undefined;
          if (requestedBatch && operations[requestedBatch.operationId]) {
            const previous = operations[requestedBatch.operationId];
            if (previous.signature !== JSON.stringify({ command, args })) throw new Error("operation-conflict: Operation ID reused for different changes");
            if (previous.status !== "committed") throw new Error("Operation aborted; prepare a new save");
            return previous.result;
          }
          const revision = (ref: string) => revisions[ref] ?? (ref in secrets ? 1 : 0);
          const protectionScope = (ref: string) => {
            const match = /^purr\/([a-zA-Z0-9_-]+)\/(credentials|runtime)\/[a-zA-Z0-9_/-]+$/.exec(ref);
            if (!match) throw new Error("Secret reference requires explicit protection scope");
            return match[1] === "global" ? { owner: "global", kind: match[2] } : { owner: "workspace", workspaceId: match[1], kind: match[2] };
          };
          // Synchronous publication models native transaction visibility only;
          // Rust tests own real SQLite/filesystem atomicity and crash recovery.
          const transaction = (batch: any, request: any, publish: () => any) => {
            const signature = JSON.stringify(request);
            let recoveryInjected = false;
            if (batch && operations[batch.operationId]) {
              const previous = operations[batch.operationId];
              if (previous.signature !== signature) throw new Error("operation-conflict: Operation ID reused for different changes");
              if (previous.status !== "committed") throw new Error("Operation aborted; prepare a new save");
              return previous.result;
            }
            try {
              assertAvailable(request.args?.id);
              const seen = new Set();
              for (const mutation of batch?.mutations ?? []) {
                if (seen.has(mutation.ref) || !/^purr\/[a-zA-Z0-9_/-]+$/.test(mutation.ref)
                  || !Number.isSafeInteger(mutation.expectedRevision) || mutation.expectedRevision < 0)
                  throw new Error("Invalid secret mutation");
                const scope = protectionScope(mutation.ref);
                if (!mutation.scope || scope.owner !== mutation.scope.owner || scope.kind !== mutation.scope.kind
                  || scope.owner === "workspace" && scope.workspaceId !== mutation.scope.workspaceId) throw new Error("Secret protection scope mismatch");
                seen.add(mutation.ref);
                if (revision(mutation.ref) !== mutation.expectedRevision) throw new Error("Credential changed externally");
              }
              if (batch && request.command === "commit_project" && (window as any).__purrNeedsRecovery) {
                recoveryInjected = true;
                throw new Error("Synthetic interrupted save requires recovery");
              }
              const result = publish();
              for (const mutation of batch?.mutations ?? []) {
                if (mutation.value === null) delete secrets[mutation.ref]; else secrets[mutation.ref] = mutation.value;
                revisions[mutation.ref] = mutation.expectedRevision + 1;
              }
              if (batch) operations[batch.operationId] = { status: "committed", signature, result };
              localStorage.setItem("purr-native-secure-test", JSON.stringify(secrets));
              localStorage.setItem("purr-native-secure-revisions-test", JSON.stringify(revisions));
              localStorage.setItem("purr-native-secure-operations-test", JSON.stringify(operations));
              return result;
            } catch (error) {
              if (batch) {
                operations[batch.operationId] = { status: recoveryInjected ? "recovery-required" : "aborted", signature };
                localStorage.setItem("purr-native-secure-operations-test", JSON.stringify(operations));
              }
              throw error;
            }
          };
          const history = histories[args?.id] ?? { entries: [], retentionDays: 30 };
          const prune = () => { history.entries = history.entries.filter((entry: any) => entry.pinned || entry.startedAt >= Date.now() - history.retentionDays * 86400000); };
          const saveHistory = () => { histories[args.id] = history; localStorage.setItem("purr-native-history-test", JSON.stringify(histories)); };
          if (command === "request_history") {
            assertAvailable(args.id);
            const action = args.action;
            if (action.operation === "append") return transaction(action.secrets, { command, args }, () => {
              if ((window as any).__purrFailHistory) throw new Error("Synthetic history failure");
              if (history.entries.some((entry: any) => entry.id === action.entry.id)) throw new Error("History entry already exists");
              history.entries.push(action.entry); prune(); saveHistory();
            });
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
            const state = stateFor(workspace.id);
            if (state.status !== "available") return { ...workspace, local: [], protectedState: state };
            const latest = new Map();
            for (const entry of [...(histories[workspace.id]?.entries ?? [])].sort((a: any, b: any) => b.startedAt - a.startedAt)) {
              if (entry.status != null && !latest.has(entry.documentId)) latest.set(entry.documentId, { table: "request_executions", id: entry.id, value: entry });
            }
            workspace.local = [...workspace.local.filter((item: any) => item.table !== "request_executions"), ...latest.values()];
            return workspace;
          };
          if (command === "load_persistence" || command === "retry_protected_storage") {
            if (command === "retry_protected_storage" && !(window as any).__purrNeedsRecovery) {
              for (const operation of Object.values(operations) as any[]) if (operation.status === "recovery-required") operation.status = "aborted";
              localStorage.setItem("purr-native-secure-operations-test", JSON.stringify(operations));
            }
            return { ...snapshot, protectedState, ...(protectedState.status === "available" ? {} : { global: [], legacy: undefined }), workspaces: snapshot.workspaces.map(restoreHistory) };
          }
          if (command === "load_project") {
            // Turning the injection off models a successful recovery check that
            // confirms rollback, rather than replaying uncertain mutations.
            if (!(window as any).__purrNeedsRecovery) {
              for (const operation of Object.values(operations) as any[]) if (operation.status === "recovery-required") operation.status = "aborted";
              localStorage.setItem("purr-native-secure-operations-test", JSON.stringify(operations));
            }
            return restoreHistory(snapshot.workspaces.find((item: any) => item.id === args.id));
          }
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
            return transaction(args.secrets, { command, args }, () => {
              if ((window as any).__purrFailSave) throw new Error("Synthetic persistence failure");
              localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot)); return changed;
            });
          }
          if (command === "write_global_state") return transaction(args.secrets, { command, args }, () => {
            if ((window as any).__purrFailSave) throw new Error("Synthetic persistence failure");
            const records = new Map((snapshot.global ?? []).map((record: any) => [`${record.table}/${record.id}`, record]));
            for (const record of args.local) {
              const key = `${record.table}/${record.id}`;
              if (record.value === null) records.delete(key); else records.set(key, record);
            }
            snapshot.global = [...records.values()];
            localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot));
          });
          if (command === "set_local_active_workspace") { snapshot.activeWorkspaceId = args.id; localStorage.setItem("purr-native-persistence-test", JSON.stringify(snapshot)); return; }
          if (command === "finish_legacy_migration") return;
          if (command.startsWith("secure_")) {
            if (command === "secure_inspect") return args.references.map((reference: string) => {
              const injected = (window as any).__purrSecretStates?.[reference];
              if (injected && injected.status !== "available") return { ref: reference, ...injected };
              const state = stateFor(reference.split("/")[1]);
              if (state.status !== "available") return { ref: reference, status: state.status === "recovery-required" ? "unavailable" : state.status,
                code: state.code ?? "protected-storage-unavailable", retryable: state.status !== "corrupt" };
              return reference in secrets ? { ref: reference, status: "available", revision: revision(reference), empty: secrets[reference] === "" }
                : { ref: reference, status: "missing", revision: revision(reference) };
            });
            if (command === "secure_resolve") {
              const injected = (window as any).__purrSecretStates?.[args.reference];
              if (injected) return injected;
              const state = stateFor(args.reference.split("/")[1]);
              if (state.status !== "available") return { status: state.status === "recovery-required" ? "unavailable" : state.status,
                code: state.code ?? "protected-storage-unavailable", retryable: state.status !== "corrupt" };
              return args.reference in secrets ? { status: "available", value: secrets[args.reference], revision: revision(args.reference) }
                : { status: "missing", revision: revision(args.reference) };
            }
            if (["secure_read", "secure_get", "secure_exists", "secure_set", "secure_delete"].includes(command)) assertAvailable(args.reference.split("/")[1]);
            if (command === "secure_read") return { value: secrets[args.reference] ?? null, revision: revision(args.reference) };
            if (command === "secure_operation_status") return { operationId: args.operationId, status: operations[args.operationId]?.status ?? "missing" };
            if (command === "secure_commit") return transaction(args.batch, { command, args }, () => {});
            if (command === "secure_get") return secrets[args.reference] ?? null;
            if (command === "secure_exists") return args.reference in secrets;
            if (command !== "secure_set" && command !== "secure_delete") return original(command, args);
            protectionScope(args.reference);
            const nextRevision = revision(args.reference) + 1;
            if (command === "secure_set") secrets[args.reference] = args.value;
            else delete secrets[args.reference];
            revisions[args.reference] = nextRevision;
            localStorage.setItem("purr-native-secure-test", JSON.stringify(secrets));
            localStorage.setItem("purr-native-secure-revisions-test", JSON.stringify(revisions)); return;
          }
          if (command === "plugin:event|listen") return 1;
          if (command === "plugin:event|unlisten") return;
          return original(command, args);
        };
        value.invoke = (command: string, args: any) => {
          if (!["commit_project", "write_global_state", "set_local_active_workspace", "request_history", "secure_commit", "secure_set", "secure_delete"].includes(command))
            return dispatch(command, args);
          const next = mutationQueue.catch(() => {}).then(() => dispatch(command, args));
          mutationQueue = next;
          return next;
        };
        internals = value;
      },
    });
  });
}
