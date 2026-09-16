import { createPurrApp } from "./app/create-purr-app";
import { coreComposition } from "./app/composition/routes";
import { jaegerModule } from "./integrations/builtins/jaeger";

const App = createPurrApp({ composition: coreComposition, modules: import.meta.env.VITE_PURR_JAEGER === "disabled" ? [] : [jaegerModule] });

export default App;
