import { Blocks, ChevronLeft } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";

import { cn } from "../shared/lib/cn";
import { useExtensionRegistry } from "./extension-context";

export function ExtensionNavigation() {
  const registry = useExtensionRegistry();
  const location = useLocation();
  const pages = registry.pages.filter((page) => page.navigation);
  if (!pages.length) return null;
  const inExtension = location.pathname.startsWith("/extensions/");
  return <nav aria-label="Application extensions" className="flex h-control-lg shrink-0 items-center gap-ui-1 border-b border-border-subtle bg-purr-surface px-ui-2 font-ui text-ui-sm">
    {inExtension ? <NavLink to="/workbench" className="ui-focus-ring flex h-control-sm items-center gap-ui-1 rounded-ui-md px-ui-2 text-content-secondary hover:bg-purr-elevated hover:text-content-primary"><ChevronLeft className="size-ui-3-5" />Workbench</NavLink> : <span className="flex items-center gap-ui-2 px-ui-2 text-content-tertiary"><Blocks className="size-ui-3-5 text-action-brand" />Extensions</span>}
    {pages.map((page) => <NavLink key={`${page.moduleId}.${page.id}`} to={page.fullPath} className={({ isActive }) => cn("ui-focus-ring flex h-control-sm items-center rounded-ui-md px-ui-2 text-content-secondary hover:bg-purr-elevated hover:text-content-primary", isActive && "bg-purr-highlight text-content-primary")}>{page.navigation!.label}</NavLink>)}
  </nav>;
}
