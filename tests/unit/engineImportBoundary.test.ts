import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The geometry engine has no renderer, no DOM and no React, and since the engine moved under
// `apps/web/src/lib/engine/` (PR 4 of `docs/ENGINE_EXTRACTION.md`) there is a directory to say that
// about. Nothing enforced it before: until the loft and gear modules were split, `cadSolids`
// reached a `THREE.BufferGeometry` builder and a `@/i18n` type import purely because the profile
// maths it needs lived in the same file. Both were harmless at runtime -- the type import is
// erased, and the mesh builder was never called -- which is exactly why nothing noticed, and why an
// assertion is cheaper than vigilance.
//
// `@/i18n/index.ts` re-exports `useTranslations`, so importing it pulls React in. `@/i18n/
// LocalizedError`, `@/i18n/locales` and `@/i18n/translator` are the React-free entry points and
// stay allowed; `tests/unit/localizedImportErrors.test.ts` is the other half of that boundary,
// asserting the errors these modules do throw stay translatable.
//
// Two rules live here, because the engine is not one thing:
//
//  - Every module under `lib/engine/` must keep React, `next` and the app's own components out of
//    its whole `@/` closure. `three` is allowed: section 2.1 classifies modules that use it at
//    runtime -- `serverShapeGroups`, `cadBakeMetadata`, `svgImport` -- as engine code, because
//    `three` is maths here rather than a renderer.
//  - The three entry points of the *server-side CAD* graph must additionally keep `three` out, so
//    the path a route handler takes stays mesh-free. That is the rule #56 added and it is unchanged.
//
// The third check is the one that keeps the directory honest rather than merely React-free: an
// engine module may still import out of `lib/engine/`, and twelve such edges remain. Each is listed
// below with the reason, so that an accidental thirteenth fails here instead of being discovered
// when `lib/engine/` is lifted into `packages/sketchforge-engine` (PR 6).

const repoRoot = path.resolve(__dirname, "../..");
const srcRoot = path.join(repoRoot, "apps/web/src");
const engineRoot = path.join(srcRoot, "lib/engine");

type ForbiddenRule = { label: string; matches: (specifier: string) => boolean };

const NO_THREE: ForbiddenRule = { label: "three", matches: (s) => s === "three" || s.startsWith("three/") };

/** What nothing in the engine may reach, whatever else it does. */
const NO_APP: ForbiddenRule[] = [
  { label: "@/i18n", matches: (s) => s === "@/i18n" || s === "@/i18n/index" },
  { label: "react", matches: (s) => s === "react" || s.startsWith("react/") || s.startsWith("react-") },
  { label: "next", matches: (s) => s === "next" || s.startsWith("next/") },
  { label: "@/components", matches: (s) => s.startsWith("@/components") },
];

/**
 * Entry points whose closure must additionally stay free of `three`.
 *
 * These are the modules a route handler reaches on its way to the CAD kernel. A mesh builder in
 * that graph is what #56 found and what it was written to keep out.
 */
const MESH_FREE_ENTRY_POINTS = [
  "apps/web/src/lib/engine/cadSolids.ts",
  "apps/web/src/lib/engine/loftProfile.ts",
  "apps/web/src/lib/engine/gearProfile.ts",
];

/**
 * The `@/` modules outside `lib/engine/` that engine code is still allowed to reach, and why.
 *
 * Every one of these is React-free, which is why the rule above holds today. None of them can
 * survive the move to a package unchanged, and the notes say what each will need.
 */
const PERMITTED_OUTWARD_EDGES: Record<string, string> = {
  // Section 2.3: the React-free i18n entry points. Engine errors stay translatable without the
  // engine depending on the translator machinery.
  "i18n/LocalizedError.ts": "the React-free error type engine importers throw",
  "i18n/locales.ts": "`MessageKey`, type-only",
  "i18n/translator.ts": "`Translator`, type-only, via materialPresets",
  // The shape union. Section 2.1 says it moves; it has 107 importers across components, workers and
  // tests, it already lives outside `lib/` as shared vocabulary, and rewriting all of them buys no
  // boundary -- it is pure types with one outward edge of its own. Deliberately left for PR 6.
  "types/sketchforge.ts": "the shape union; moving it rewrites 107 importers for no boundary gain",
  "lib/cameraProjection.ts": "a projection enum `types/sketchforge` needs; pure",
  // Section 2.2 keeps these in the app, and `lib/engine/workplaneSettings` reaches each for one
  // pure normalizer. Splitting them the way #56 split loft and gear is the fix, and it is a content
  // change rather than a move.
  "lib/materialPresets.ts": "`normalizeMaterialPrices`, via workplaneSettings",
  "lib/measurementUnits.ts": "`normalizeScaleForUnits`, via workplaneSettings",
  "lib/workplaneGrid.ts": "`DEFAULT_WORKPLANE_GRID_COLOR`, via workplaneSettings",
  // The only outward edge that reaches a module which touches the DOM at all: `applyAppTheme` uses
  // `document`. Reached type-only, for `ResolvedAppTheme`, so nothing is bundled -- but it is the
  // edge to cut first.
  "lib/appTheme.ts": "`ResolvedAppTheme`, type-only, via workplaneGrid",
  // Section 4: the browser kernel loader stays in the app, because the Emscripten glue does not
  // survive bundling. `stepExport` importing it is the engine loading a kernel, which section 4
  // says it must not do; the fix is the injection seam, and that is PR 6's.
  "lib/brepKernel.ts": "the browser's OCCT loader, which section 4 keeps in the app",
  // The CAD modifier worker's wire protocol -- app vocabulary, like `apiShapeSummary`.
  "lib/cadModifierTypes.ts": "the worker message types; pure, LocalizedError only",
  // Section 2.2, and the brief: despite its name this is the *browser's* fetch client for
  // `/api/projects`. `serverProjectFiles` reaches it for the file-naming helpers both sides share.
  "lib/serverProjectStore.ts": "the shared project id and file-name helpers",
};

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

/** Walks the `@/` closure of `roots`, recording the import path by which each file was reached. */
function closureOf(...roots: string[]) {
  const paths = new Map<string, string[]>(roots.map((root) => [root, [path.relative(repoRoot, root)]]));
  const queue = [...roots];
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

/** Every `.ts` module under `lib/engine/`, recursively. */
function engineModules(directory = engineRoot): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return engineModules(full);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
  });
}

/** Each forbidden specifier reached from the closure, named with the trail that got there. */
function offencesIn(closure: Map<string, string[]>, rules: ForbiddenRule[]) {
  const offences: string[] = [];
  for (const [file, trail] of closure) {
    for (const specifier of specifiersOf(file)) {
      const forbidden = rules.find((rule) => rule.matches(specifier));
      if (forbidden) offences.push(`${forbidden.label} via ${trail.join(" -> ")} (imports "${specifier}")`);
    }
  }
  return offences;
}

describe("the geometry engine keeps the app out", () => {
  it("reaches no React, no next, no components and no @/i18n from anywhere under lib/engine", () => {
    const modules = engineModules();
    // A directory of one, or of none, would pass vacuously. There are forty-odd modules under it.
    expect(modules.length).toBeGreaterThan(30);
    expect(offencesIn(closureOf(...modules), NO_APP)).toEqual([]);
  });

  it("imports out of lib/engine only along the edges that are written down", () => {
    const closure = closureOf(...engineModules());
    const outward = [...closure.entries()]
      .filter(([file]) => !file.startsWith(engineRoot + path.sep))
      .map(([file, trail]) => [path.relative(srcRoot, file), trail.join(" -> ")] as const);

    const unexpected = outward.filter(([module]) => !(module in PERMITTED_OUTWARD_EDGES));
    expect(unexpected.map(([module, trail]) => `${module} via ${trail}`)).toEqual([]);

    // And the other direction: an edge that has been cut should be struck off the list rather than
    // left as a standing permission for someone to re-add.
    const reached = new Set(outward.map(([module]) => module));
    expect(Object.keys(PERMITTED_OUTWARD_EDGES).filter((module) => !reached.has(module))).toEqual([]);
  });

  it("would notice: the editor-facing barrels the engine does not use do reach three and @/i18n", () => {
    // The guards above are only worth having if they can fail, and these are the imports they were
    // written to keep out -- still present, one module away, in the barrels the components use.
    const loft = closureOf(path.join(srcRoot, "lib/loftGeometry.ts"));
    const reached = [...loft.keys()].flatMap((file) => specifiersOf(file));
    expect(reached).toContain("three");
    expect(reached).toContain("@/i18n");
    // `@/i18n` is one import away from the engine, so the rule is not passing for want of anything
    // to catch: it is `lib/shapeProperties.ts` that reaches it, and nothing in `lib/engine/` does.
    expect(offencesIn(closureOf(path.join(srcRoot, "lib/shapeProperties.ts")), NO_APP)).not.toEqual([]);
  });
});

describe("the server-side CAD graph keeps the renderer out as well", () => {
  it.each(MESH_FREE_ENTRY_POINTS)("%s reaches no three", (entry) => {
    const closure = closureOf(path.join(repoRoot, entry));
    // A closure of one would pass vacuously, so make sure the walk actually resolved something.
    expect(closure.size).toBeGreaterThan(1);
    expect(offencesIn(closure, [NO_THREE, ...NO_APP])).toEqual([]);
  });

  it("keeps the loft and gear profile maths out of the mesh builders' reach, not the other way round", () => {
    // The split is only load-bearing in one direction: a mesh builder may use the profile maths,
    // but the profile half must not reach back into the mesh half.
    for (const half of ["loftProfile", "gearProfile"]) {
      const closure = closureOf(path.join(engineRoot, `${half}.ts`));
      const files = [...closure.keys()].map((file) => path.basename(file));
      expect(files).not.toContain("loftMesh.ts");
      expect(files).not.toContain("gearMesh.ts");
      expect(files).not.toContain("loftGeometry.ts");
      expect(files).not.toContain("gearGeometry.ts");
    }
  });
});
