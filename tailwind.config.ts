import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      borderRadius: {
        DEFAULT: "0.25rem",
        lg: "0.5rem",
        xl: "0.75rem",
      },
      colors: {
        canvas: "var(--color-canvas)",
        surface: "var(--color-surface)",
        "surface-raised": "var(--color-surface-raised)",
        "surface-strong": "var(--color-surface-strong)",
        "surface-hover": "var(--color-surface-hover)",
        foreground: "var(--color-foreground)",
        muted: "var(--color-muted)",
        "muted-foreground": "var(--color-muted-foreground)",
        border: "var(--color-border)",
        "border-strong": "var(--color-border-strong)",
        primary: "var(--color-primary)",
        "primary-foreground": "var(--color-primary-foreground)",
        success: "var(--color-success)",
      },
      boxShadow: {
        panel: "0 12px 28px rgba(0, 0, 0, 0.18)",
        button: "inset 0 1px 0 rgba(255, 255, 255, 0.08)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "SFMono-Regular", "Consolas", "monospace"],
      },
      fontSize: {
        "label-xs": ["0.625rem", { lineHeight: "0.75rem", fontWeight: "500" }],
        "body-xs": ["0.6875rem", { lineHeight: "0.875rem" }],
        "body-sm": ["0.75rem", { lineHeight: "1rem" }],
        "body-md": ["0.8125rem", { lineHeight: "1.125rem" }],
      },
    },
  },
  plugins: [],
} satisfies Config;
