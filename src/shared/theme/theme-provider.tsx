import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

export type Theme = "dark";

type ThemeContextValue = {
  theme: Theme;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const purrTheme: Theme = "dark";

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.add(purrTheme);
    document.documentElement.style.colorScheme = purrTheme;
  }, []);

  const value = useMemo(() => ({ theme: purrTheme }), []);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
