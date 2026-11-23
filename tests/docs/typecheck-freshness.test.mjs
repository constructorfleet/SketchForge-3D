import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const webTsconfig = JSON.parse(
  readFileSync(path.join(root, "apps/web/tsconfig.json"), "utf8"),
);

// `incremental: true` in apps/web/tsconfig.json makes `tsc --noEmit` consult a
// gitignored *.tsbuildinfo file. When that file is stale (switching branches, or
// rebuilding the engine with a changed exported type) tsc reports green while
// the current sources have real type errors. The CI typecheck gate must not
// trust that cache; the Next build may keep incremental compilation.
const scriptArgs = (name) => (pkg.scripts[name] ?? "").split(/\s+/).filter(Boolean);

test("apps/web tsconfig still enables incremental builds for Next", () => {
  assert.equal(
    webTsconfig.compilerOptions?.incremental,
    true,
    "Next's own build relies on incremental compilation; keep it enabled in tsconfig",
  );
});

test("the typecheck gate disables incremental caching so it cannot pass on a stale tsbuildinfo", () => {
  const args = scriptArgs("typecheck");
  assert.ok(args.length > 0, "package.json must define a typecheck script");

  const disablesIncremental =
    args.some((arg) => /^--incremental(=false)?$/.test(arg)) ||
    args.some((arg, i) => arg === "--incremental" && args[i + 1] === "false");
  assert.ok(
    disablesIncremental,
    "npm run typecheck must pass --incremental false; otherwise tsc reuses a stale *.tsbuildinfo and can report green with real type errors",
  );
});
