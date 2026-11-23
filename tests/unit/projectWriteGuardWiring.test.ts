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
    // Migration and its catch-up (#662) copy the stored bytes up unchanged, so they may write directly.
    expect(count(/\bsaveServerProjectPackage\(/)).toBe(3);
    expect(write).toContain("saveServerProjectPackage(");
    expect(page).toMatch(/saveServerProjectPackage\(project\.id, record\.skfPackage,/);
    expect(page).toMatch(/!projectWriteGuard\.canWrite\(project\.id\)\) continue;[\s\S]{0,1200}saveServerProjectPackage\(project\.id, record\.skfPackage, record\.revision, upload\.serverRevision\)/);
    // A migration deletes only what the user deleted, never what the browser list lacks (#662).
    // A late write is undone only while the server holds what it stored (#672).
    expect(count(/\bdeleteServerProject\(/)).toBe(3);
    expect(page).toMatch(/if \(stored\) await deleteServerProject\(projectId, stored\);/);
    expect(write).toMatch(/if \(browserTombstones\(\)\.has\(projectId\)\) \{\s*await undoLateWrite\(projectId, stored\);/);
    expect(page).toMatch(/if \(creates && browserTombstones\(\)\.has\(projectId\)\) \{\s*await undoLateWrite\(projectId, written\.stored\);/);
    expect(page).toMatch(/if \(!projectsDeletedInBrowser\.has\(projectId\) \|\| removedFromServer\.has\(projectId\)\) continue;\s*await deleteServerProject\(projectId\);/);
    expect(page).toMatch(/const deleteProject = \(projectId: string\) => \{\s*if \(!serverProjectStorageActive\) projectsDeletedInBrowser\.add\(projectId\);/);
  });

  // Issue #650: a server package write is conditional on the copy it started from.
  it("sends the base revision with every autosaved server package and blocks on a conflict", () => {
    const write = topLevelFunction("writeProjectShapes");
    expect(write).toMatch(/saveServerProjectPackage\(projectId, skfPackage, entry\.revision, serverBaseRevisions\.get\(projectId\)\)\)/);
    expect(write).toMatch(/if \(error instanceof ServerProjectConflictError\) projectWriteGuard\.block\(projectId\);/);
    expect(write).toContain("serverBaseRevisions.set(projectId, entry.revision);");
  });

  it("bases a start over on the revision that was served, and raises the clock past a loaded revision", () => {
    expect(page).toMatch(/const seen = servedRevisions\.get\(project\.id\);\s*if \(seen === undefined\) serverBaseRevisions\.delete\(project\.id\);\s*else serverBaseRevisions\.set\(project\.id, seen\);/);
    expect(page).toMatch(/nextProjectRevisionRef\.current = Math\.max\(nextProjectRevisionRef\.current, loadedRevision, serverRevision \?\? 0\);/);
    // A failed load raises it too, so Start over outranks the served revision on a clock that is behind.
    expect(page).toMatch(/projectWriteGuard\.block\(activeProjectId\);[\s\S]{0,200}nextProjectRevisionRef\.current = Math\.max\(nextProjectRevisionRef\.current, servedRevisions\.get\(activeProjectId\) \?\? 0\);/);
  });

  it("drops a late editor snapshot for a blocked project before it touches the cache or the queue", () => {
    const body = page.slice(page.indexOf("const updateProjectShapes = useCallback("), page.indexOf("const updateProjectWorkspace = useCallback("));
    const guard = body.indexOf("if (!projectWriteGuard.canWrite(snapshot.projectId)) {");
    expect(guard).toBeGreaterThan(-1);
    expect(body.slice(guard)).toMatch(/^if \(!projectWriteGuard\.canWrite\(snapshot\.projectId\)\) \{[^}]*return;\s*\}/);
    expect(body.indexOf("setProjectShapesById(")).toBeGreaterThan(guard);
    expect(body.indexOf(".enqueue(")).toBeGreaterThan(guard);
    expect(body).toMatch(/setProjectShapesById\(\(current\) => cacheWithEditorChange\(current, snapshot\.projectId, entry, projectWriteGuard\)\)/);
    // Recorded before the guard, so a refused save can still be downloaded with every edit.
    expect(body.indexOf("latestEditorCopiesRef.current.set(snapshot.projectId, job)")).toBeGreaterThan(-1);
    expect(body.indexOf("latestEditorCopiesRef.current.set(snapshot.projectId, job)")).toBeLessThan(guard);
  });

  it("blocks writes when a load fails", () => {
    expect(page).toMatch(/\.catch\(\(error\) => \{\s*if \(canceled\) return;[\s\S]{0,600}projectWriteGuard\.block\(activeProjectId\);/);
  });

  // Issue #665: a late save must not recreate a deleted project.
  it("refuses writes to a project for good once it is deleted", () => {
    const body = page.slice(page.indexOf("const deleteProject = (projectId: string) => {"), page.indexOf("const renameProject = "));
    expect(body).toContain("projectWriteGuard.forget(projectId);");
    expect(body).not.toContain("projectWriteGuard.release(projectId);");
  });

  // Issue #670: a delete is shared by every tab, and only a server listing lifts it.
  it("shares a delete with every tab and keeps browser lists from bringing it back", () => {
    const remove = page.slice(page.indexOf("const deleteProject = (projectId: string) => {"), page.indexOf("const renameProject = "));
    expect(remove).toContain("addProjectTombstone(window.localStorage, projectId);");
    expect(topLevelFunction("writeProjectShapes")).toMatch(/if \(browserTombstones\(\)\.has\(projectId\)\) throw new ProjectWriteRefusedError\(translate\("dashboard\.storage\.deletedWriteRefused"\)\)/);
    // A listing fetched while the delete was in flight must not lift it.
    expect(page).toMatch(/const listingRequestedAt = Date\.now\(\);\s*void probeServerProjects\(\)/);
    expect(page).toMatch(/removeProjectTombstones\(window\.localStorage, merged\.changedIds, listingRequestedAt\)/);
    expect(page).toMatch(/removeProjectTombstones\(window\.localStorage, adoptedProjects\.map\(\(project\) => project\.id\), adoptedRequestedAt\)/);
    expect(page).toMatch(/if \(event\.key === PROJECT_TOMBSTONES_STORAGE_KEY\) \{[\s\S]{0,300}projectWriteGuard\.forget\(projectId\);/);
    expect(page).toMatch(/\.filter\(\(project\) => !tombstones\.has\(project\.id as string\)\)/);
    expect(page).toMatch(/: withoutDeletedProjects\(mergeProjectsForStorage\(projects\), browserTombstones\(\)\);/);
    // Lifted only where a server listing holds the project.
    expect(count(/\bremoveProjectTombstones\(/)).toBe(2);
  });

  it("lifts the delete mark for every project the list holds again", () => {
    expect(page).toMatch(/useEffect\(\(\) => \{\s*for \(const project of projects\) projectWriteGuard\.restore\(project\.id\);\s*\}, \[projects\]\);/);
  });
});
