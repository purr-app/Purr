import { AppRouter } from "./app/app-router";
import { ThemeProvider } from "./shared/theme/theme-provider";

function App() {
  return (
    <ThemeProvider>
      <AppRouter />
    </ThemeProvider>
  );
}

export default App;
