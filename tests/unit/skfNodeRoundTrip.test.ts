import { describe, expect, it } from "vitest";
import { shapeFromRequest } from "@/lib/shapeRequests";
import { exportSkfProject, importSkfProject } from "@/lib/skfProject";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@/lib/workplaneSettings";

// The REST API reads and writes .skf packages on the server, with no browser
// anywhere. This is the check that the format's own code runs under Node.
describe("skf packages outside a browser", () => {
  it("round-trips a project built from shape requests", async () => {
    const box = shapeFromRequest({ kind: "cube", size: 12, name: "Spacer" });
    const cylinder = shapeFromRequest({ kind: "cylinder", width: 8, height: 30, sides: 6, x: 20 });
    expect(box).not.toBeNull();
    expect(cylinder).not.toBeNull();

    const bytes = await exportSkfProject({
      projectId: "project-1",
      projectName: "Headless",
      createdAt: 1000,
      modifiedAt: 2000,
      shapes: [box!, cylinder!],
      history: [],
      historyIndex: 0,
      assets: [],
      workspace: DEFAULT_WORKPLANE_WORKSPACE,
      snapGrid: DEFAULT_SNAP_GRID,
      placementElevation: 0,
      compressionLevel: 1,
    });

    const restored = await importSkfProject(bytes);

    expect(restored.projectName).toBe("Headless");
    expect(restored.shapes.map((shape) => shape.name)).toEqual(["Spacer", "Cylinder"]);
    expect(restored.shapes[0].width).toBe(12);
    expect(restored.shapes[0].depth).toBe(12);
    expect(restored.shapes[0].height).toBe(12);
    expect(restored.shapes[1].kind).toBe("cylinder");
    expect(restored.shapes[1].sides).toBe(6);
    expect(restored.shapes[1].x).toBe(20);
  });
});
