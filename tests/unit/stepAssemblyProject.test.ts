import { describe, expect, it } from "vitest";
import { editorHistoryEntry } from "@constructorfleet/sketchforge-engine/editorHistory";
import { exportSkfProject, importSkfProject, type SkfProjectExportInput } from "@constructorfleet/sketchforge-engine/skfProject";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import type { WorkplaneShape } from "@/types/sketchforge";

function projectInput(shapes: WorkplaneShape[]): SkfProjectExportInput {
  return {
    projectId: "step-components",
    projectName: "STEP component round trip",
    createdAt: 1_700_000_000_000,
    modifiedAt: 1_700_000_100_000,
    shapes,
    history: [editorHistoryEntry(shapes, [])],
    historyIndex: 0,
    assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    placementElevation: 0,
  };
}

describe("STEP assembly component project persistence", () => {
  it("round-trips component geometry identity and assembly ancestry", async () => {
    const component: WorkplaneShape = {
      id: "sensor-left",
      name: "SensorLeft",
      kind: "mesh",
      color: "#12a4cc",
      x: 0,
      z: 0,
      elevation: 0,
      size: 1,
      width: 2,
      depth: 2,
      height: 1,
      rotation: 0,
      rotationX: 0,
      rotationZ: 0,
      locked: false,
      hidden: false,
      stepComponent: {
        id: "step-occurrence:12/solid-1",
        occurrenceId: "step-occurrence:12",
        path: [
          { id: "step-node:0", name: "MainAssembly" },
          { id: "step-occurrence:8", name: "Sensors" },
          { id: "step-occurrence:12", name: "SensorLeft" },
        ],
      },
      importedMesh: {
        positions: [0, 0, 0, 2, 0, 0, 0, 2, 0],
        baseWidth: 2,
        baseDepth: 2,
        baseHeight: 1,
        triangleCount: 1,
        sourceFormat: "step",
        brepStep: "ISO-10303-21;\nEND-ISO-10303-21;",
      },
    };
    const restored = await importSkfProject(await exportSkfProject(projectInput([component])));

    expect(restored.shapes[0]).toMatchObject({
      id: "sensor-left",
      stepComponent: component.stepComponent,
      importedMesh: { positions: component.importedMesh!.positions, brepStep: component.importedMesh!.brepStep },
    });
  });
});
