import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useApplicationServices } from "../../app/application-services-context";
import coreRelease from "../../app/release-notes.json";
import type { AppRelease } from "../../application/ports/release";
import { UpdateController } from "./update-controller";

export type ApplicationTab = "release-notes";
const notesKey = "purr.release-notes.seen-version";
const Context = createContext<{
  controller: UpdateController; version: string; notes: string; date?: string;
  tabs: ApplicationTab[]; activeTab: ApplicationTab | null;
  openTab: (tab: ApplicationTab) => void; closeTab: (tab: ApplicationTab) => void; leaveTab: () => void;
} | null>(null);

export function UpdateProvider({ controller, release = coreRelease, children }: { controller: UpdateController; release?: AppRelease; children: ReactNode }) {
  const { lifecycle } = useApplicationServices();
  const [version, setVersion] = useState(release.version);
  const [tabs, setTabs] = useState<ApplicationTab[]>([]);
  const [activeTab, setActiveTab] = useState<ApplicationTab | null>(null);
  const openTab = (tab: ApplicationTab) => { setTabs((current) => current.includes(tab) ? current : [...current, tab]); setActiveTab(tab); };
  useEffect(() => {
    let cancelled = false;
    void (lifecycle.version?.() ?? Promise.resolve(release.version)).then((reportedVersion) => {
      if (cancelled) return;
      const currentVersion = typeof reportedVersion === "string" && reportedVersion.trim() ? reportedVersion : release.version;
      setVersion(currentVersion);
      try {
        const previous = localStorage.getItem(notesKey);
        if (previous && previous !== currentVersion) {
          setTabs((current) => current.includes("release-notes") ? current : [...current, "release-notes"]);
          setActiveTab("release-notes");
        }
        localStorage.setItem(notesKey, currentVersion);
      } catch { /* Version history is optional local UI state. */ }
    }).catch(() => { /* The bundled version remains available offline. */ });
    controller.start();
    return () => { cancelled = true; };
  }, [controller, lifecycle, release.version]);
  const notes = release.version === version ? release.notes : "Release notes are not bundled for this version.";
  return <Context.Provider value={{ controller, version, notes, date: release.version === version ? release.date : undefined, tabs, activeTab, openTab,
    closeTab: (tab) => { setTabs((current) => current.filter((item) => item !== tab)); setActiveTab((current) => current === tab ? null : current); },
    leaveTab: () => setActiveTab(null),
  }}>{children}</Context.Provider>;
}
export function useUpdates() {
  const context = useContext(Context);
  if (!context) throw new Error("UpdateProvider is required");
  const state = useSyncExternalStore(context.controller.subscribe, context.controller.getSnapshot);
  return { ...context, state };
}
