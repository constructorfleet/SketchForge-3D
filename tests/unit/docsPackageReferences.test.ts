import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
let generatedReferences: string;

describe("package documentation contract", () => {
  beforeAll(() => {
    generatedReferences = mkdtempSync(path.join(os.tmpdir(), "sketchforge-package-docs-"));
    const result = spawnSync(process.execPath, ["scripts/docs/generate-package-references.mjs", "--output-dir", generatedReferences], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || "Package reference generation failed");
  });

  afterAll(() => rmSync(generatedReferences, { recursive: true, force: true }));

  it("publishes TypeScript and engine exports from built declarations", () => {
    const client = read(path.join(generatedReferences, "typescript-client.md"));
    const engine = read(path.join(generatedReferences, "typescript-engine.md"));

    expect(client).toContain("SketchForgeClient");
    expect(client).toContain("export declare function clientFromEnvironment");
    expect(engine).toContain("createEngine");
    expect(engine).toContain("export declare function createEngine(store: ProjectStore): Engine;");
    expect(engine).toContain("export declare function importSkfProject");
    expect(client).toContain("Generated from `packages/sketchforge-client/dist/index.d.ts`");
    expect(engine).toContain("Generated from `packages/sketchforge-engine/dist/index.d.ts`");
  });

  it("publishes Python names from the package public export list", () => {
    const python = read(path.join(generatedReferences, "python-client.md"));
    expect(python).toContain("SketchForgeClient");
    expect(python).toContain("client_from_environment");
    expect(python).toContain("BoxShapeRequest");
    expect(python).toContain("width: float");
    expect(python).toContain("Generated from `packages/sketchforge-py/src/sketchforge3d/__init__.py`");
    expect(python).toContain("->");
    expect(python).not.toContain("<factory>");
  });

  it("reuses registry-facing package READMEs as site sources", () => {
    expect(read("docs/packages/typescript-client.md")).toContain("!!!include(../../packages/sketchforge-client/README.md)!!!");
    expect(read("docs/packages/engine.md")).toContain("!!!include(../../packages/sketchforge-engine/README.md)!!!");
    expect(read("docs/packages/python-client.md")).toContain("!!!include(../../packages/sketchforge-py/README.md)!!!");
  });

  it("uses repository macro files as executable example sources", () => {
    const examples = read("docs/guides/package-examples.md");
    expect(examples).toContain("!!!include(../../packages/sketchforge-client/examples/bolt-plate.macro.mjs)!!!");
    expect(examples).toContain("!!!include(../../packages/sketchforge-py/examples/bolt_plate.py)!!!");
    expect(examples).toContain("npm run test:integration");
    expect(examples).toContain("npm run client:test:py:integration");

    const sourcePaths = [...examples.matchAll(/!!!include\(([^)]+)\)!!!/g)].map((match) => `docs/guides/${match[1]}`);
    expect(sourcePaths).toHaveLength(7);
    expect(examples).toContain("!!!include(../../packages/sketchforge-client/examples/tap-drill-plate.macro.mjs)!!!");
    for (const sourcePath of sourcePaths) expect(existsSync(sourcePath), `${sourcePath} should exist`).toBe(true);
  });
});
