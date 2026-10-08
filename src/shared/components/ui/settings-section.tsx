import { useId, type ReactNode } from "react";

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return <section aria-labelledby={id} className="space-y-ui-3">
    <h2 id={id} className="m-ui-0 text-ui-xl font-semibold text-content-primary">{title}</h2>
    <div className="divide-y divide-border-subtle">{children}</div>
  </section>;
}

export function SettingsRow({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-ui-3 py-ui-3">
    <div className="min-w-0 flex-1">
      <h3 className="m-ui-0 text-ui-md font-medium text-content-secondary">{label}</h3>
      <p className="mb-ui-0 mt-ui-1 text-ui-sm text-content-tertiary">{description}</p>
    </div>
    <div className="shrink-0">{children}</div>
  </div>;
}
