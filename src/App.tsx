import { createPurrApp } from "./app/create-purr-app";
import { coreComposition } from "./app/composition/routes";

const App = createPurrApp({ composition: coreComposition });

export default App;
