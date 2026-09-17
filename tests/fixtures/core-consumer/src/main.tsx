import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createPurrApp } from "@purr/core/app";
import "@purr/core/styles";
import { consumerModule } from "./module";

const App = createPurrApp({ modules: [consumerModule] });
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
