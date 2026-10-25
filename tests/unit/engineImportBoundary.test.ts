import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript-legacy";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(__dirname, "../../packages/sketchforge-engine/src");
const forbidden = [/^@\//, /^react(?:\/|$)/, /^next(?:\/|$)/, /^@\/components/];

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith(".ts") ? [file] : [];
  });
}

function imports(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("the extracted engine package boundary", () => {
  const files = sourceFiles(packageRoot);

  it("has a substantial package-owned implementation with no app, React, or Next aliases", () => {
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      for (const specifier of imports(file)) expect(forbidden.some((rule) => rule.test(specifier)), `${path.relative(packageRoot, file)} imports ${specifier}`).toBe(false);
    }
  });

  it("keeps server CAD construction independent of Three.js", () => {
    for (const entry of ["cadSolids.ts", "loftProfile.ts", "gearProfile.ts"]) {
      const source = fs.readFileSync(path.join(packageRoot, entry), "utf8");
      expect(source).not.toMatch(/from\s+["']three(?:\/|["'])/);
    }
  });
});
