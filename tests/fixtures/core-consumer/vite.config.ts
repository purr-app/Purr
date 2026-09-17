import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    outDir: fileURLToPath(new URL("../../../dist-consumer", import.meta.url)),
    emptyOutDir: true,
    manifest: true,
  },
});
