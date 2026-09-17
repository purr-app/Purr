import { createContext, useCallback, useContext, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

/** Ephemeral UI state, owned by open tabs. Never serialized into a project. */
export class TabStateStore {
  private tabs = new Map<string, Map<string, unknown>>();
  constructor(public remember = true) {}
  scope(id: string) {
    if (!this.tabs.has(id)) this.tabs.set(id, new Map());
    return this.tabs.get(id)!;
  }
  retain(ids: ReadonlySet<string>) {
    for (const id of this.tabs.keys()) if (!ids.has(id)) this.tabs.delete(id);
  }
  clear() { this.tabs.clear(); }
}
const TabStateContext = createContext<Map<string, unknown> | null>(null);
export function TabStateProvider({ store, id, children }: { store: TabStateStore; id: string; children: ReactNode }) {
  return <TabStateContext.Provider value={store.remember ? store.scope(id) : null}>{children}</TabStateContext.Provider>;
}
export function useTabState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const cache = useContext(TabStateContext);
  const [value, setValue] = useState<T>(() => cache?.has(key) ? cache.get(key) as T : typeof initial === "function" ? (initial as () => T)() : initial);
  const current = useRef(value);
  const update = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    const next = typeof action === "function" ? (action as (previous: T) => T)(current.current) : action;
    current.current = next;
    cache?.set(key, next);
    setValue(next);
  }, [cache, key]);
  return [value, update];
}

export function useForgetTabState() {
  const cache = useContext(TabStateContext);
  return useCallback((prefix: string) => {
    for (const key of cache?.keys() ?? []) if (key.startsWith(prefix)) cache?.delete(key);
  }, [cache]);
}
