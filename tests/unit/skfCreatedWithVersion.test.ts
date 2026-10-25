import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { exportSkfProject, SKF_CREATED_WITH_VERSION } from "@constructorfleet/sketchforge-engine/skfProject";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";

const readRepoFile = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const engineVersion = JSON.parse(readRepoFile("packages/sketchforge-engine/package.json")).version as string;

describe(".skf createdWithVersion", () => {
  it("records the engine package version in an exported package", async () => {
    const bytes = await exportSkfProject({
      projectName: "Provenance", createdAt: 1, modifiedAt: 1, shapes: [],
      history: [editorHistoryEntry([], [])], historyIndex: 0, assets: [],
      workspace: DEFAULT_WORKPLANE_WORKSPACE, snapGrid: DEFAULT_SNAP_GRID, placementElevation: 0,
    });
    const projectJson = unzipSync(bytes)["project.json"];
    expect(projectJson).toBeDefined();
    const document = JSON.parse(strFromU8(projectJson!)) as { createdWithVersion: string };

    expect(document.createdWithVersion).toBe(engineVersion);
    expect(SKF_CREATED_WITH_VERSION).toBe(engineVersion);
  });

  it("is bumped by release-please alongside the engine package version", () => {
    const extraFiles = JSON.parse(readRepoFile("release-please-config.json")).packages["."]["extra-files"] as Array<
      string | { type?: string; path: string }
    >;
    const generic = extraFiles.flatMap((entry) => (typeof entry === "object" && entry.type === "generic" ? [entry.path] : []));
    expect(generic).toContain("packages/sketchforge-engine/src/skfProject.ts");
    expect(generic).toContain("docs/SKF_FORMAT_REFERENCE.md");

    const constantLine = readRepoFile("packages/sketchforge-engine/src/skfProject.ts")
      .split(/\r?\n/)
      .find((line) => line.startsWith("export const SKF_CREATED_WITH_VERSION"));
    expect(constantLine).toMatch(/x-release-please-version/);

    const referenceRow = readRepoFile("docs/SKF_FORMAT_REFERENCE.md")
      .split(/\r?\n/)
      .find((line) => line.startsWith("| Created-with version |"));
    expect(referenceRow).toContain(`\`${engineVersion}\``);
    expect(referenceRow).toMatch(/x-release-please-version/);
  });
});
