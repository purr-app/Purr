import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "src-tauri/target/**", "test-results/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/domain/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "react", message: "Domain code must remain independent of React." },
          { name: "react-dom", message: "Domain code must remain independent of React." },
        ],
        patterns: [{
          group: ["react/*", "react-dom/*", "@tauri-apps/*", "../app/**", "../application/**", "../features/**", "../importing/**", "../shared/**", "../storage/**"],
          message: "Domain code may depend only on domain-level libraries and neighboring domain modules.",
        }],
      }],
    },
  },
  {
    files: ["src/application/**/*.{ts,tsx}"],
    ignores: ["src/application/import-workspace.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "react", message: "Application services must remain independent of React." },
          { name: "react-dom", message: "Application services must remain independent of React." },
        ],
        patterns: [{
          group: ["react/*", "react-dom/*", "@tauri-apps/*"],
          message: "Application services must use application/storage contracts instead of UI or Tauri APIs.",
        }],
      }],
    },
  },
  {
    files: ["src/platform/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/features/**", "**/app/**"],
          message: "Platform adapters must not depend on feature UI or the application composition root.",
        }],
      }],
    },
  },
  {
    files: ["src/extension-api/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/features/**", "**/app/**", "**/platform/**", "**/storage/**"],
          message: "The extension API may expose selected public contracts, not core implementations.",
        }],
      }],
    },
  },
);
