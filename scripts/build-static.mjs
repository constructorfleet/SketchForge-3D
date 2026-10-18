#!/usr/bin/env node
/**
 * Build the static export, then verify it.
 *
 * This exists because `set STATIC_EXPORT=true&& next build` only sets the
 * variable on Windows. On macOS and Linux -- including the Cloudflare deploy
 * workflow, which runs on ubuntu -- `set` with that argument does nothing to
 * the environment, so the script quietly built a *server* bundle instead and
 * nobody saw the static export fail.
 */

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, STATIC_EXPORT: "true" },
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? code}`));
    });
  });
}

try {
  await run("npx", ["next", "build", "apps/web"]);
  await run("node", ["scripts/verify-static-worker-assets.mjs"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
