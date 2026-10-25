import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// #540: the editor's CAD worker runs the selected-edge lineage matcher. The
// worker is bundled for the browser, so nothing it loads may reach the
// server kernel, which is Node-only, or the server CAD operations, which load
// it. The server's own lineage wrapper may; the matcher module may not.

const root = path.resolve(__dirname, "../..");
const engineSource = path.join(root, "packages/sketchforge-engine/src");
const webSource = path.join(root, "apps/web/src");
const FORBIDDEN = ["serverCadKernel.ts", "serverCadOperations.ts"].map((file) => path.join(engineSource, file));

/** The module a runtime import specifier names, or null when it is a package outside these sources. */
function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else if (specifier.startsWith("@constructorfleet/sketchforge-engine/")) base = path.join(engineSource, specifier.slice("@constructorfleet/sketchforge-engine/".length));
  else if (specifier.startsWith("@/")) base = path.join(webSource, specifier.slice(2));
  else return null;
  const withoutJs = base.replace(/\.js$/, "");
  for (const candidate of [`${withoutJs}.ts`, `${withoutJs}.tsx`, path.join(withoutJs, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every module `entry` loads at runtime, following value imports and re-exports, not type-only ones. */
function runtimeModules(entry: string) {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const statements = source.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\s+from\s+"([^"]+)"/gm);
    for (const [, , typeOnly, specifier] of statements) {
      if (typeOnly) continue;
      const resolved = resolveImport(file, specifier!);
      if (resolved) pending.push(resolved);
    }
  }
  return seen;
}

describe("the CAD worker's lineage modules stay browser-safe", () => {
  it.each([
    ["the engine's lineage matcher", path.join(engineSource, "sketchEdgeSegmentLineageKernel.ts")],
    ["the editor's worker-side lineage", path.join(webSource, "lib/cadModifierEdgeLineage.ts")],
    ["the CAD modifier worker", path.join(webSource, "workers/cadModifier.worker.ts")],
  ])("%s never loads the server kernel", (_label, entry) => {
    const loaded = runtimeModules(entry);
    expect(loaded.size).toBeGreaterThan(1);
    expect(FORBIDDEN.filter((file) => loaded.has(file)).map((file) => path.basename(file))).toEqual([]);
  });

  it("follows imports far enough to see the server wrapper load the kernel", () => {
    const loaded = runtimeModules(path.join(engineSource, "sketchEdgeSegmentLineage.ts"));
    expect(FORBIDDEN.every((file) => loaded.has(file))).toBe(true);
  });
});
