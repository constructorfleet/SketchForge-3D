import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Issue #622: the dashboard page is a client component that unit tests cannot mount,
// so this checks its source keeps every package write behind the write guard.
const page = readFileSync(path.resolve(__dirname, "../../apps/web/src/app/page.tsx"), "utf8");

function count(pattern: RegExp) {
  return page.match(new RegExp(pattern.source, "g"))?.length ?? 0;
}

/** Returns the source of the top-level function `name`, up to the next top-level declaration. */
function topLevelFunction(name: string) {
  const start = page.indexOf(`\nasync function ${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const end = page.slice(start + 1).search(/\n(?:async function|function|const|let|type|export) /);
  return page.slice(start, end === -1 ? undefined : start + 1 + end);
}

describe("dashboard package writes", () => {
  it("builds saveProjectShapes from guardProjectWrites over the module's write guard", () => {
    expect(page).toMatch(/\nconst saveProjectShapes = guardProjectWrites\(\s*projectWriteGuard,\s*writeProjectShapes,/);
    expect(page).toMatch(/\nconst projectWriteGuard = createProjectWriteGuard\(\);/);
  });

  it("calls the unguarded write only through saveProjectShapes", () => {
    expect(count(/\bwriteProjectShapes\b/)).toBe(2);
  });

  it("writes packages to IndexedDB and the server only from the unguarded write", () => {
    const write = topLevelFunction("writeProjectShapes");
    expect(count(/\.put\(/)).toBe(1);
    expect(write).toContain(".put(");
    // Migration copies the stored bytes up unchanged, so it may write directly.
    expect(count(/\bsaveServerProjectPackage\(/)).toBe(2);
    expect(write).toContain("saveServerProjectPackage(");
    expect(page).toMatch(/saveServerProjectPackage\(project\.id, record\.skfPackage,/);
  });

  // Issue #650: a server package write is conditional on the copy it started from.
  it("sends the base revision with every autosaved server package and blocks on a conflict", () => {
    const write = topLevelFunction("writeProjectShapes");
    expect(write).toMatch(/saveServerProjectPackage\(projectId, skfPackage, entry\.revision, serverBaseRevisions\.get\(projectId\)\)/);
    expect(write).toMatch(/if \(error instanceof ServerProjectConflictError\) projectWriteGuard\.block\(projectId\);/);
    expect(write).toContain("serverBaseRevisions.set(projectId, entry.revision);");
  });

  it("drops a late editor snapshot for a blocked project before it touches the cache", () => {
    expect(page).toMatch(/const updateProjectShapes = useCallback\(\(snapshot: \{[\s\S]*?\}\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(!projectWriteGuard\.canWrite\(snapshot\.projectId\)\) return;/);
    expect(page).toMatch(/setProjectShapesById\(\(current\) => cacheWithEditorChange\(current, snapshot\.projectId, entry, projectWriteGuard\)\)/);
  });

  it("blocks writes when a load fails", () => {
    expect(page).toMatch(/\.catch\(\(error\) => \{\s*if \(canceled\) return;[\s\S]{0,600}projectWriteGuard\.block\(activeProjectId\);/);
  });
});
