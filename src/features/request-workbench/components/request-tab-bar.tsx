export function RequestTabBar() {
  return (
    <div className="flex items-center px-1">
      <div className="flex min-w-0 items-center gap-2 text-body-sm">
        <img className="size-6 rounded-md" src="/purr.svg" alt="" aria-hidden="true" />
        <span className="truncate font-medium text-foreground">Untitled Request</span>
      </div>
    </div>
  );
}
