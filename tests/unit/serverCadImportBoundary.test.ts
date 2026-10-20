import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The server-side CAD graph has no renderer, no DOM and no React, and the modules under it are the
// ones `docs/ENGINE_EXTRACTION.md` wants to lift out of the app. Nothing enforced that: until the
// loft and gear modules were split, `serverCadSolids` reached a `THREE.BufferGeometry` builder and
// a `@/i18n` type import purely because the profile maths it needs lived in the same file. Both
// were harmless at runtime -- the type import is erased, and the mesh builder was never called --
// which is exactly why nothing noticed, and why an assertion is cheaper than vigilance.
//
// `@/i18n/index.ts` re-exports `useTranslations`, so importing it pulls React in.
// `@/i18n/LocalizedError` and `@/i18n/locales` are the React-free entry points and stay allowed;
// `tests/unit/localizedImportErrors.test.ts` is the other half of that boundary, asserting the
// errors these modules do throw stay translatable.

const repoRoot = path.resolve(__dirname, "../..");
const srcRoot = path.join(repoRoot, "apps/web/src");

/** Entry points whose whole `@/` closure must stay free of the renderer and of React. */
const ENTRY_POINTS = [
  "apps/web/src/lib/engine/cadSolids.ts",
  "apps/web/src/lib/engine/loftProfile.ts",
  "apps/web/src/lib/engine/gearProfile.ts",
];

const FORBIDDEN: Array<{ label: string; matches: (specifier: string) => boolean }> = [
  { label: "three", matches: (s) => s === "three" || s.startsWith("three/") },
  { label: "@/i18n", matches: (s) => s === "@/i18n" || s === "@/i18n/index" },
  { label: "react", matches: (s) => s === "react" || s.startsWith("react/") || s.startsWith("react-") },
  { label: "next", matches: (s) => s === "next" || s.startsWith("next/") },
  { label: "@/components", matches: (s) => s.startsWith("@/components") },
];

/**
 * Every module specifier `file` imports or re-exports, type-only ones included. A type-only import
 * is erased from the bundle but still a dependency of the source: it is what decides whether the
 * module can be moved, and it is how `@/i18n` got into this graph in the first place.
 */
function specifiersOf(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

/** `@/x` -> the file it resolves to, or null for a package or an unresolvable path. */
function resolveAlias(specifier: string): string | null {
  if (!specifier.startsWith("@/")) return null;
  const base = path.join(srcRoot, specifier.slice(2));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Walks the `@/` closure of `entry`, recording the import path by which each file was reached. */
function closureOf(entry: string) {
  const paths = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    const trail = paths.get(file)!;
    for (const specifier of specifiersOf(file)) {
      const resolved = resolveAlias(specifier);
      if (!resolved || paths.has(resolved)) continue;
      paths.set(resolved, [...trail, path.relative(repoRoot, resolved)]);
      queue.push(resolved);
    }
  }
  return paths;
}

describe("the server-side CAD graph keeps the renderer and React out", () => {
  it.each(ENTRY_POINTS)("%s reaches nothing forbidden", (entry) => {
    const closure = closureOf(path.join(repoRoot, entry));
    // A closure of one would pass vacuously, so make sure the walk actually resolved something.
    expect(closure.size).toBeGreaterThan(1);

    const offences: string[] = [];
    for (const [file, trail] of closure) {
      for (const specifier of specifiersOf(file)) {
        const forbidden = FORBIDDEN.find((rule) => rule.matches(specifier));
        if (forbidden) offences.push(`${forbidden.label} via ${trail.join(" -> ")} (imports "${specifier}")`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("would notice: the barrels these entry points replaced do reach three and @/i18n", () => {
    // The guard above is only worth having if it can fail, and these are the imports it was
    // written to keep out -- still present, one module away, in the editor-facing barrels.
    const loft = closureOf(path.join(repoRoot, "apps/web/src/lib/loftGeometry.ts"));
    const reached = [...loft.keys()].flatMap((file) => specifiersOf(file));
    expect(reached).toContain("three");
    expect(reached).toContain("@/i18n");
  });

  it("keeps the loft and gear profile maths out of the mesh builders' reach, not the other way round", () => {
    // The split is only load-bearing in one direction: a mesh builder may use the profile maths,
    // but the profile half must not reach back into the mesh half.
    for (const half of ["loftProfile", "gearProfile"]) {
      const closure = closureOf(path.join(srcRoot, `lib/engine/${half}.ts`));
      const files = [...closure.keys()].map((file) => path.basename(file));
      expect(files).not.toContain("loftMesh.ts");
      expect(files).not.toContain("gearMesh.ts");
      expect(files).not.toContain("loftGeometry.ts");
      expect(files).not.toContain("gearGeometry.ts");
    }
  });
});
