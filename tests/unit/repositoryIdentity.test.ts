import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OFFICIAL_UPDATE_GUIDE_URL } from "@/lib/appUpdates";

/**
 * Everything that names a repository must name *this* one.
 *
 * Forking left several of these pointing at the project this was forked from,
 * and none of them were covered, so none of them complained:
 *
 * - the desktop updater's feed, so a build of this fork asked upstream what the
 *   newest release was -- and upstream's newest is older than ours, so the
 *   updater had nothing to offer and never will;
 * - the self-hosted updater's manifest and git remote, so "update" compared
 *   against upstream's version and would have pulled upstream's code over this
 *   one;
 * - the source-code link, which the AGPL expects to offer the corresponding
 *   source of the build actually running.
 *
 * A string nobody asserts is a string that rots, which is why this exists.
 */
const REPOSITORY = "constructorfleet/SketchForge-3D";
const root = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("every embedded repository reference names this repository", () => {
  it("points the desktop updater's release feed here", () => {
    const config = read("apps/desktop/electron-builder.yml");
    expect(config).toMatch(/owner:\s*constructorfleet/);
    expect(config).toMatch(/repo:\s*SketchForge-3D/);
    expect(config).not.toMatch(/Formsmith746/i);
  });

  it("points the self-hosted updater's manifest and remote here", () => {
    const route = read("apps/web/src/app/api/app-update/route.ts");
    expect(route).toContain(`https://raw.githubusercontent.com/${REPOSITORY}/main/package.json`);
    expect(route).toContain(`https://github.com/${REPOSITORY}.git`);
    expect(route).not.toMatch(/Formsmith746/i);
  });

  it("offers the source of the build that is running", () => {
    // AGPL section 13: a network user is owed the corresponding source of this
    // version, not of the project it was forked from.
    expect(read("apps/web/src/app/page.tsx")).toContain(`|| "https://github.com/${REPOSITORY}"`);
  });

  it("links its own update guide", () => {
    expect(OFFICIAL_UPDATE_GUIDE_URL).toContain(REPOSITORY);
  });

  it("names its own container image wherever it tells someone to pull one", () => {
    for (const path of ["README.md", "docs/REST_API.md", "deploy/docker/compose-ghcr.yaml"]) {
      expect(read(path), path).not.toMatch(/ghcr\.io\/formsmith746/i);
    }
    expect(read("deploy/docker/compose-ghcr.yaml")).toContain("ghcr.io/constructorfleet/sketchforge-3d");
  });

  it("still credits the project it was forked from", () => {
    // Repointing what is functional should not quietly erase attribution.
    const readme = read("README.md");
    expect(readme).toContain("github.com/Formsmith746/SketchForge-3D");
    expect(readme).toContain("github.com/sponsors/Formsmith746");
  });
});
