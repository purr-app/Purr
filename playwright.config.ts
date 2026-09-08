import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  use: {
    baseURL: "http://localhost:1421",
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: "npm run dev -- --port 1421",
    url: "http://localhost:1421",
    reuseExistingServer: !process.env.CI,
  },
});
