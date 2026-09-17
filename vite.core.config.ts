import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react()],
  publicDir: false,
  resolve: {
    alias: { "@": entry("./src") },
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist-core",
    emptyOutDir: true,
    cssCodeSplit: true,
    lib: {
      entry: {
        app: entry("./src/app/public.ts"),
        "extension-api": entry("./src/extension-api/index.ts"),
        ui: entry("./src/extension-api/ui.ts"),
        "test-kit": entry("./src/extension-api/test-kit.ts"),
        styles: entry("./src/extension-api/styles.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: (id) => id === "react" || id === "react-dom" || id.startsWith("react/") || id.startsWith("react-dom/"),
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: (asset) => asset.names.includes("styles.css") ? "styles.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
});
