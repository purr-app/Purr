import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { GitError, type GitCommit, type GitPort, type GitStash, type GitStatus } from "../../application/ports/git";

type Entry<T> = { items?: T[]; revision: number; failed?: boolean; pending?: object };

/** Retain confirmed lists during revalidation; status/index updates only retry busy reads. */
function useGitList<T>(key: string | undefined, revision: number, ready: number, load: () => Promise<T[]>, onError: (message: string) => void) {
  const cache = useRef(new Map<string, Entry<T>>());
  const owner = useRef({ key, generation: 0, ready });
  if (owner.current.key !== key) owner.current = { key, generation: owner.current.generation + 1, ready };
  owner.current.ready = ready;
  const generation = owner.current.generation;
  const [, render] = useReducer((value: number) => value + 1, 0);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!key) return;
    const entry: Entry<T> = cache.current.get(key) ?? { revision: -1 };
    cache.current.set(key, entry);
    if (entry.revision === revision || entry.pending) return;
    const request = {}; entry.pending = request;
    let active = true;
    void load().then((items) => {
      if (active && owner.current.generation === generation && entry.pending === request) { entry.items = items; entry.revision = revision; entry.failed = false; }
    }).catch((cause) => {
      if (!active || owner.current.generation !== generation) return;
      if (cause instanceof GitError && cause.code === "busy") {
        if (owner.current.ready !== ready) setRetry((value) => value + 1);
      } else { entry.failed = true; entry.revision = revision; onError(cause instanceof Error ? cause.message : String(cause)); }
    }).finally(() => { if (entry.pending === request) entry.pending = undefined; if (active) render(); });
    // Index/status publications must not cancel an in-flight list read.
    return () => { active = false; if (entry.pending === request) entry.pending = undefined; };
  }, [key, revision, generation, load, onError, retry]);
  useEffect(() => { if (key) { const entry = cache.current.get(key); if (entry && !entry.pending && entry.revision !== revision) setRetry((value) => value + 1); } }, [key, revision, ready]);
  const entry = key ? cache.current.get(key) : undefined;
  const itemCount = entry?.items?.length;
  return { items: entry?.items ?? [], loading: Boolean(key && !entry?.items && !entry?.failed), failed: entry?.failed ?? false,
    append: (items: T[]) => { if (key && owner.current.generation === generation) { const entry = cache.current.get(key); if (entry?.items && entry.revision === revision && entry.items.length === itemCount) { entry.items = [...entry.items, ...items]; render(); } } },
  };
}

export function useGitLists(git: GitPort, id: string | undefined, status: GitStatus | null, ready: number, refresh: number, stashRevision: number, onError: (message: string) => void) {
  const historyKey = id && status?.initialized ? `${id}:${status.head ?? "unborn"}` : undefined;
  const stashKey = id && status?.initialized ? id : undefined;
  const readHistory = useCallback(() => git.history(id!), [git, id]);
  const readStashes = useCallback(() => git.stashes(id!), [git, id]);
  const history = useGitList<GitCommit>(historyKey, refresh, ready, readHistory, onError);
  const stashes = useGitList<GitStash>(stashKey, refresh + stashRevision, ready, readStashes, onError);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = async () => {
    if (!id || loadingMore) return;
    setLoadingMore(true);
    try { history.append(await git.history(id, history.items.length)); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoadingMore(false); }
  };
  return { history, stashes, loadingMore, loadMore };
}
