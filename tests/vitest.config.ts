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
    include: ["tests/unit/**/*.test.ts", "packages/sketchforge-client/src/**/*.test.ts"],
    // tests/unit/support holds helpers, not tests.
    exclude: ["tests/unit/support/**"],
    setupFiles: ["tests/unit/setupLocales.ts"],
    // The 5s default is comfortable on Linux and marginal on Windows
    // runners, where this suite runs during the desktop release: a listing
    // test that takes milliseconds here took 5021ms there and timed out,
    // which cost 1.20.0 its installers. A timeout only bites on failure, so
    // a generous one costs passing runs nothing.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
