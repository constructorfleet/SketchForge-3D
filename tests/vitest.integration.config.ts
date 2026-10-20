import path from "node:path";
import { defineConfig } from "vitest/config";

const rootDir = path.resolve(__dirname, "..");

/**
 * The client libraries' integration tests, which need a live server.
 *
 * Separate from the unit run because they are the only tests in the repo that
 * talk to a running SketchForge over HTTP, and because an OCCT fillet takes
 * seconds rather than milliseconds.
 */
export default defineConfig({
  root: rootDir,
  test: {
    environment: "node",
    include: ["packages/**/tests/**/*.integration.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    // One server, one project store, one write lock per project: parallel files
    // would mostly measure the lock.
    fileParallelism: false,
  },
});
