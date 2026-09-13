import { SendHorizontal } from "lucide-react";

export function EmptyResponse() {
  return (
    <section
      className="flex h-full min-h-panel flex-col items-center justify-center rounded-ui-xl bg-purr-surface p-ui-6 text-center shadow-panel"
      aria-label="Response not sent"
    >
      <div className="mb-ui-3 grid size-ui-12 place-items-center rounded-ui-xl bg-purr-elevated text-content-tertiary">
        <SendHorizontal className="size-ui-6" aria-hidden="true" />
      </div>
      <p className="m-ui-0 text-ui-md font-medium text-content-secondary">
        Not sent
      </p>
      <p className="mb-ui-0 mt-ui-1 text-ui-sm text-content-tertiary">
        Send this request to inspect its response.
      </p>
    </section>
  );
}
