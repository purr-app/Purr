export function RequestTabBar() {
  return (
    <div className="flex items-center px-ui-1">
      <div className="flex min-w-0 items-center gap-ui-2 text-ui-sm">
        <img className="size-ui-6 rounded-ui-md" src="/purr.svg" alt="" aria-hidden="true" />
        <span className="truncate font-medium text-content-primary">Untitled Request</span>
      </div>
    </div>
  );
}
