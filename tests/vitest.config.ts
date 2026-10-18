import path from "node:path";
import { defineConfig } from "vitest/config";

const rootDir = path.resolve(__dirname, "..");

export default defineConfig({
  root: rootDir,
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "apps/web/src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    // tests/unit/support holds helpers, not tests.
    exclude: ["tests/unit/support/**"],
    setupFiles: ["tests/unit/setupLocales.ts"],
  },
});
