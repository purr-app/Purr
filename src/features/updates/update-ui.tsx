import ReactMarkdown from "react-markdown";
import { Button } from "../../shared/components/ui/button";
import { Notification } from "../../shared/components/ui/notification";
import { useUpdates } from "./update-context";

function actionLabel(phase: string) {
  if (phase === "downloading") return "Downloading…";
  if (phase === "installing") return "Installing…";
  if (["downloaded", "installed"].includes(phase)) return "Restart";
  if (phase === "available") return "Download";
  return phase === "checking" ? "Checking…" : "Check for Updates…";
}
function busy(phase: string) { return ["checking", "downloading", "installing"].includes(phase); }
export function VersionFooter() {
  const { controller, state, version, openTab } = useUpdates();
  return <div className="mr-auto flex items-center gap-ui-2">
    <Button variant="ghost" size="xs" disabled={busy(state.phase)} title={state.phase === "disabled" ? "About Purr" : actionLabel(state.phase)}
      onClick={() => state.phase === "disabled" ? openTab("about") : void controller.activate()}>
      <span className="text-accent-emerald" aria-hidden="true">●</span> v{version}
      {state.phase === "available" && <span className="text-action-brand" aria-label={`Update to ${state.version} available`}>↑</span>}
      {!["disabled", "idle", "available"].includes(state.phase) && <span>· {actionLabel(state.phase)}</span>}
    </Button>
    <Button variant="ghost" size="xs" onClick={() => openTab("about")}>About</Button>
  </div>;
}
export function UpdateNotifications() {
  const { state, controller } = useUpdates();
  if (!state.notice) return null;
  const title = state.notice === "error" ? "Update failed" : state.notice === "current" ? "You’re up to date" : `Purr v${state.version}`;
  const total = state.total;
  return <div className="ui-notification-stack pointer-events-none fixed bottom-ui-8 right-ui-4 z-50 flex flex-col gap-ui-3">
    <Notification key={state.notice} title={title} variant={state.notice === "error" ? "error" : "info"} onClose={controller.dismiss}
      actions={state.notice !== "current" && <>
        <Button size="sm" disabled={busy(state.phase)} onClick={() => { void controller.activate(); }}>{state.notice === "error" && state.phase === "idle" ? "Try again" : actionLabel(state.phase)}</Button>
        <Button variant="ghost" size="sm" onClick={controller.dismiss}>Later</Button>
      </>}>
      {state.notice === "error" ? <p>{state.error}</p> : state.notice === "current" ? <p>You have the latest version of Purr.</p> : <>
        <p>{state.phase === "downloaded" ? "Ready to install. Restart when you’re ready." : state.phase === "installed" ? "Installed. Restart to use the new version." : "A new version is available."}</p>
        {state.notes && <div className="ui-release-markdown max-h-ui-variable-list overflow-y-auto"><ReactMarkdown skipHtml allowedElements={["p", "ul", "ol", "li", "strong", "em", "code"]}>{state.notes}</ReactMarkdown></div>}
        {state.phase === "downloading" && <div className="space-y-ui-2">
          <progress className="w-full accent-action-brand" aria-label="Update download progress" value={total ? state.received : undefined} max={total ?? 1} />
          <p>{total ? `${Math.min(100, Math.round(state.received / total * 100))}%` : `${(state.received / 1024 / 1024).toFixed(1)} MB downloaded`}</p>
        </div>}
      </>}
    </Notification>
  </div>;
}
export function ApplicationUpdatePanel() {
  const { activeTab, version, notes, date, controller, state, openTab } = useUpdates();
  return <div className="h-full overflow-y-auto bg-purr-base p-ui-2 text-ui-md text-content-secondary">
    <div className="mx-auto max-w-ui-dialog space-y-ui-4 rounded-ui-xl border border-border-subtle bg-purr-surface p-ui-6 shadow-panel">
      <h1 className="text-ui-xl font-semibold text-content-primary">{activeTab === "about" ? "About Purr" : "What’s new"}</h1>
      <p className="font-code">Purr v{version}</p>
      {date && <time dateTime={date}>{date}</time>}
      {activeTab === "about" ? <>
        <p>A local-first client for HTTP and GraphQL APIs.</p>
        <Button variant="brand" disabled={state.phase === "disabled" || busy(state.phase)} onClick={() => { void controller.check(); }}>Check for Updates…</Button>
        {state.phase === "disabled" ? <p>Automatic updates are not configured for this build.</p> : <p>Updates download only when you choose. Purr never restarts automatically.</p>}
        {state.version && <Button variant="secondary" disabled={busy(state.phase)} onClick={() => { void controller.activate(); }}>{actionLabel(state.phase)} v{state.version}</Button>}
        <div><Button variant="ghost" onClick={() => openTab("release-notes")}>Release notes</Button></div>
      </> : <div className="ui-release-markdown"><ReactMarkdown skipHtml allowedElements={["h2", "h3", "p", "ul", "ol", "li", "strong", "em", "code"]}>{notes}</ReactMarkdown></div>}
    </div>
  </div>;
}
