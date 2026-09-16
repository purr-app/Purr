import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createPurrApp } from "@purr/core/app";
import "@purr/core/styles";
import { fakeExtensionModule } from "./fake-module";

const parameters = new URLSearchParams(location.search);
const modules = parameters.get("modules") === "0" ? []
  : parameters.get("conflict") === "1" ? [fakeExtensionModule, fakeExtensionModule]
    : [fakeExtensionModule];
const root = createRoot(document.getElementById("root")!);
try {
  const App = createPurrApp({ modules });
  root.render(<StrictMode><App /></StrictMode>);
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  root.render(<main className="flex h-screen items-center justify-center bg-purr-base p-ui-6 font-ui text-content-primary">
    <div className="max-w-ui-dialog rounded-ui-xl border border-accent-red bg-purr-surface p-ui-6">
      <h1 className="m-ui-0 text-ui-lg font-semibold">Extension composition failed</h1>
      <p role="alert" className="mb-ui-0 mt-ui-2 font-code text-ui-sm text-accent-red">{message}</p>
    </div>
  </main>);
}
