import { useEffect } from "react";
import { useToasts } from "../../shared/components/ui/toasts";
import ReactMarkdown from "react-markdown";
import { Progress } from "../../shared/components/ui/progress";
import { Button } from "../../shared/components/ui/button";
import { useUpdates } from "./update-context";

function actionLabel(phase: string) {
  if (phase === "downloading") return "Downloading…";
  if (phase === "installing") return "Installing…";
  if (["downloaded", "installed"].includes(phase)) return "Restart";
  if (phase === "available") return "Download";
  return phase === "checking" ? "Checking…" : "Check for Updates…";
}
function busy(phase: string) { return ["checking", "downloading", "installing"].includes(phase); }
export function UpdateNotifications() {
  const { state, controller } = useUpdates();
  const { notify, dismiss } = useToasts();
  useEffect(() => {
  if (!state.notice) { dismiss("app-update"); return; }
  const title = state.notice === "error" ? "Update failed" : state.notice === "current" ? "You’re up to date" : `Purr v${state.version}`;
  const total = state.total;
  notify({ id: "app-update", title, variant: state.notice === "error" ? "error" : "info", duration: state.notice === "current" ? 5000 : 0, onClose: controller.dismiss,
      actions: state.notice !== "current" && <>
        <Button variant="brand" size="sm" disabled={busy(state.phase)} onClick={() => { void controller.activate(); }}>{state.notice === "error" && state.phase === "idle" ? "Try again" : actionLabel(state.phase)}</Button>
        <Button variant="ghost" size="sm" onClick={controller.dismiss}>Later</Button>
      </>, description: <>
      {state.notice === "error" ? <p>{state.error}</p> : state.notice === "current" ? <p>You have the latest version of Purr.</p> : <>
        <p>{state.phase === "downloaded" ? "Ready to install. Restart when you’re ready." : state.phase === "installed" ? "Installed. Restart to use the new version." : "A new version is available."}</p>
        {state.notes && <div className="ui-release-markdown max-h-ui-variable-list overflow-y-auto"><ReactMarkdown skipHtml allowedElements={["p", "ul", "ol", "li", "strong", "em", "code"]}>{state.notes}</ReactMarkdown></div>}
        {state.phase === "downloading" && <div className="space-y-ui-2">
          <Progress label="Update download progress" value={total ? state.received : undefined} max={total ?? 1} />
          <p>{total ? `${Math.min(100, Math.round(state.received / total * 100))}%` : `${(state.received / 1024 / 1024).toFixed(1)} MB downloaded`}</p>
        </div>}
      </>}
    </> });
  }, [state, controller, notify, dismiss]);
  return null;
}
export function ApplicationUpdatePanel() {
  const { version, notes, date } = useUpdates();
  return <div className="h-full overflow-y-auto bg-purr-base p-ui-2 text-ui-md text-content-secondary">
    <div className="mx-auto max-w-ui-dialog space-y-ui-4 rounded-ui-xl border border-border-subtle bg-purr-surface p-ui-6 shadow-panel">
      <h1 className="text-ui-xl font-semibold text-content-primary">What’s new</h1>
      <p className="font-code">Purr v{version}</p>
      {date && <time dateTime={date}>{date}</time>}
      <div className="ui-release-markdown"><ReactMarkdown skipHtml allowedElements={["h2", "h3", "p", "ul", "ol", "li", "strong", "em", "code"]}>{notes}</ReactMarkdown></div>
    </div>
  </div>;
}
