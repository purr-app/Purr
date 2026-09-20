import { version } from "../../../package.json";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createPurrApp } from "../../../src/app/create-purr-app";
import "../../../src/styles/globals.css";
const nextVersion = version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
const mode = new URLSearchParams(location.search).get("mode");
const app = createPurrApp({ release: mode === "commercial" ? { version: "0.1.0", date: "2026-09-20", notes: "### First beta\n\nHTTP and GraphQL workflows for macOS." } : undefined, updater: {
  async check() {
    if (mode === "offline") throw new Error("offline");
    return { version: nextVersion, notes: "### Improvements\n\n- Faster response viewer.\n- Better error messages.",
      async download(progress) { progress(25, 100); await new Promise((resolve) => setTimeout(resolve, 500)); progress(100, 100); },
      async install() { document.body.dataset.installed = "true"; },
      async close() {},
    };
  },
  async restart() { document.body.dataset.restarted = "true"; },
} });
const App = app;
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
