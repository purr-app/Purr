import { optimisticIndex, type IndexAction } from "./optimistic-index";
import { useGitLists } from "./use-git-lists";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApplicationServices } from "../../app/application-services-context";
import { GitError, type GitAction, type GitDiff, type GitDiffRequest, type GitStatus } from "../../application/ports/git";
import type { Workspace } from "../workspaces/model/workspace";
export type GitView = "overview" | "diff" | "history" | "stashes" | "remotes" | "conflicts" | "editor-conflicts";
export type GitController = ReturnType<typeof useGitWorkspace>;
export function useGitWorkspace(workspace: Workspace | undefined, runOperation: <T>(id: string, work: () => Promise<T>, options?: { indexOnly?: boolean }) => Promise<T>, onOpen: () => void) {
  const { git, runtime } = useApplicationServices();
  const id = workspace?.id; const activeId = useRef(id); activeId.current = id;
  const [status, setStatus] = useState<GitStatus | null>(null); const [error, setError] = useState("");
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(""); const running = useRef(new Set<string>());
  const [view, setView] = useState<GitView>("overview"); const [diff, setDiff] = useState<GitDiff | null>(null); const [selected, setSelected] = useState<GitDiffRequest | null>(null);
  const [dirtyAction, setDirtyAction] = useState<GitAction | null>(null); const [authorAction, setAuthorAction] = useState<Extract<GitAction, { type: "commit" }> | null>(null);
  const [afterCommit, setAfterCommit] = useState<GitAction | null>(null);
  const abort = useRef(new Map<string, AbortController>()); const requestGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const invalidated = useRef(new Set<string>());
  const indexQueues = useRef(new Map<string, Promise<unknown>>());
  const pendingIndex = useRef(new Map<string, IndexAction[]>());
  const baseStatus = useRef<GitStatus | null>(null);
  const [indexWorking, setIndexWorking] = useState(false);
  const [listsReady, setListsReady] = useState(0), [listsRefresh, setListsRefresh] = useState(0), [stashRevision, setStashRevision] = useState(0);
  const lists = useGitLists(git, id, status, listsReady, listsRefresh, stashRevision, setError);
  const publishStatus = useCallback((next: GitStatus, owner: string) => {
    if (activeId.current !== owner) return;
    invalidated.current.delete(owner);
    baseStatus.current = next;
    setStatus((pendingIndex.current.get(owner) ?? []).reduce(optimisticIndex, next));
    setListsReady((value) => value + 1);
  }, []);
  const [networkAction, setNetworkAction] = useState<{ type: "fetch" | "pull" | "push"; remote: string; branch: string } | null>(null);
  const refresh = useCallback(async (options?: { lists?: boolean }) => {
    if (!id || (running.current.has(id) || pendingIndex.current.get(id)?.length) || runtime.kind !== "desktop") return;
    const requested = ++refreshGeneration.current;
    try { const next = await git.status(id); if (activeId.current === id && requested === refreshGeneration.current && !running.current.has(id)) { publishStatus(next, id); if (options?.lists !== false) setListsRefresh((value) => value + 1); } }
    catch (cause) { if (activeId.current === id && !(cause instanceof GitError && cause.code === "busy")) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [id, git, runtime.kind, publishStatus]);
  useEffect(() => { setBusy(Boolean(id && running.current.has(id))); setProgress(""); setNetworkAction(null); pendingPush.current = false; setStatus(null); baseStatus.current = null; setIndexWorking(Boolean(id && pendingIndex.current.get(id)?.length)); setError(""); setSelected(null); setDiff(null); setView("overview"); setDirtyAction(null); setAfterCommit(null); setAuthorAction(null); void refresh(); }, [id, refresh]);
  useEffect(() => {
    if (!id || runtime.kind !== "desktop") return;
    let disposed = false; let stop: (() => void) | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    void git.subscribe(id, (change) => { if (change?.stashesChanged !== false) setStashRevision((value) => value + 1); invalidated.current.add(id); clearTimeout(timer); timer = setTimeout(() => { void refresh({ lists: false }); }, 0); }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; }).catch(() => {});
    return () => { disposed = true; stop?.(); clearTimeout(timer); };
  }, [id, runtime.kind, refresh, git]);
  const execute = useCallback(async (action: GitAction, options?: { stashBefore?: boolean }): Promise<GitStatus | null> => {
    if (!id || running.current.has(id)) return null;
    if (action.type === "stage" || action.type === "unstage") {
      const pending = pendingIndex.current.get(id) ?? [];
      pending.push(action); pendingIndex.current.set(id, pending);
      refreshGeneration.current += 1; setIndexWorking(true); setError("");
      if (baseStatus.current) setStatus(pending.reduce(optimisticIndex, baseStatus.current));
      const operation = (indexQueues.current.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
        let next: GitStatus | null = null;
        try { next = await runOperation(id, () => git.execute(id, action), { indexOnly: true }); return next; }
        catch (cause) { if (activeId.current === id) setError(cause instanceof Error ? cause.message : String(cause));
          try { next = await git.status(id); } catch { /* Retain the last confirmed index. */ } return null;
        } finally {
          const remaining = pendingIndex.current.get(id) ?? [];
          remaining.splice(remaining.indexOf(action), 1);
          if (activeId.current === id) {
            if (next) publishStatus(next, id);
            else if (baseStatus.current) setStatus(remaining.reduce(optimisticIndex, baseStatus.current));
            setIndexWorking(remaining.length > 0);
          }
        }
      });
      indexQueues.current.set(id, operation); return operation;
    }
    await indexQueues.current.get(id);
    if (running.current.has(id)) return null;
    refreshGeneration.current += 1; running.current.add(id); setBusy(true); setError(""); setProgress("Saving local state…"); const controller = new AbortController(); abort.current.set(id, controller);
    let currentAction = action, stashed = false, completed = false;
    try {
      const next = await runOperation(id, async () => {
        const run = async (nextAction: GitAction) => {
          currentAction = nextAction;
          const next = await git.execute(id, nextAction, { signal: controller.signal, onProgress: (message) => { if (activeId.current === id) setProgress(message); } });
          publishStatus(next, id);
          if (["stash", "applyStash", "dropStash", "finishMerge"].includes(nextAction.type) && activeId.current === id) setStashRevision((value) => value + 1);
          return next;
        };
        let stashId: string | undefined;
        if (options?.stashBefore) {
          const previousStash = action.type === "pull" ? (await git.stashes(id))[0]?.id : undefined;
          await run({ type: "stash", message: `Before ${action.type === "pull" ? "pull" : "switch"}` }); stashed = true;
          if (action.type === "pull") { const latest = (await git.stashes(id))[0]?.id; if (latest !== previousStash) stashId = latest; }
        }
        let next = await run(action);
        if (stashId) next = await run({ type: "applyStash", id: stashId });
        completed = true;
        return next;
      });
      if (activeId.current === id) { setDirtyAction(null); setAuthorAction(null); if (action.type === "finishMerge" || action.type === "abortMerge") setView("overview"); }
      return activeId.current === id ? next : null;
    } catch (cause) {
      if (activeId.current === id) {
        if (cause instanceof GitError && cause.code === "dirty" && (currentAction.type === "pull" || currentAction.type === "switchBranch")) {
          if (stashed) setError("Your changes are safely stashed, but files changed again before continuing. Review the remaining changes and retry the operation.");
          else setDirtyAction(currentAction);
        }
        else if (cause instanceof GitError && cause.code === "author" && currentAction.type === "commit") setAuthorAction(currentAction);
        else { setError(cause instanceof Error ? cause.message : String(cause)); if (cause instanceof GitError && cause.code === "conflict") { setView("conflicts"); onOpen(); } }
      }
      return null;
    } finally {
      if (!completed && activeId.current === id) { try { const next = await git.status(id); if (activeId.current === id) publishStatus(next, id); } catch { /* Keep the operation error. */ } }
      running.current.delete(id); abort.current.delete(id);
      if (activeId.current === id) { setBusy(false); setProgress(""); if (invalidated.current.has(id)) void refresh({ lists: false }); }
    }
  }, [id, git, runOperation, onOpen, publishStatus, refresh]);
  const selectFile = async (request: GitDiffRequest) => {
    if (!id) return; const generation = ++requestGeneration.current; setSelected(request); setView("diff"); setError(""); setDiff(null); onOpen();
    if (request.scope !== "commit") return;
    try { const result = await git.diff(id, request); if (activeId.current === id && generation === requestGeneration.current) setDiff(result); } catch (cause) { if (generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const openView = (next: GitView) => { setView(next); setError(""); onOpen(); };
  useEffect(() => {
    if (!id || !status || busy || indexWorking || view !== "diff" || !selected || selected.scope === "commit") return;
    const file = status.files.find((file) => file.path === selected.path);
    if (!file) { setView("overview"); return; }
    let request = selected;
    if (selected.scope === "working" && file.worktree === "." && file.index !== ".") { request = { ...selected, scope: "staged" }; setSelected(request); }
    else if (selected.scope === "staged" && file.index === ".") { request = { ...selected, scope: "working" }; setSelected(request); }
    let active = true;
    void git.diff(id, request).then((result) => { if (active) setDiff(result); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [id, status, busy, indexWorking, view, selected, git]);
  const network = (type: "fetch" | "pull" | "push") => {
    if (!status) return;
    const upstream = status.upstream?.split("/");
    const remote = upstream?.[0] ?? status.remotes.find((entry) => entry.name === "origin")?.name ?? status.remotes[0]?.name ?? "";
    if (status.remotes.length > 1 || !status.upstream && type !== "fetch") setNetworkAction({ type, remote, branch: upstream?.slice(1).join("/") ?? status.branch ?? "main" });
    else void execute({ type });
  };
  const pendingPush = useRef(false);
  const continueAfterCommit = async () => {
    if (afterCommit) { const pending = afterCommit; setAfterCommit(null); await execute(pending); }
    else if (pendingPush.current) { pendingPush.current = false; network("push"); }
  };
  const commit = async (message: string, push = false) => {
    pendingPush.current = push;
    if (!await execute({ type: "commit", message })) return false;
    await continueAfterCommit(); return true;
  };
  const stashAndContinue = async () => {
    if (!id || !dirtyAction) return;
    const pending = dirtyAction; setDirtyAction(null);
    await execute({ ...pending, allowDirty: false } as GitAction, { stashBefore: true });
  };
  const sync = async () => { if (await execute({ type: "pull" })) await execute({ type: "push" }); };
  const changedFiles = status?.files.length ?? 0;
  return { status, error, busy, indexWorking, progress, view, diff, selected, dirtyAction, authorAction, changedFiles, git, workspace, lists,
    execute, refresh, selectFile, openView, continueAfterCommit, network, networkAction, setNetworkAction, setView, setError, setDirtyAction, setAuthorAction, commit, sync, stashAndContinue,
    commitBeforeContinue: () => { setAfterCommit(dirtyAction); setDirtyAction(null); openView("overview"); },
    afterCommit, cancelAfterCommit: () => setAfterCommit(null),
    cancel: () => { if (id) abort.current.get(id)?.abort(); },
  };
}
