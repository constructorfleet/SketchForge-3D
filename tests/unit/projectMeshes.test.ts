import { describe, expect, it } from "vitest";
import { meshProjectShapes } from "@sketchforge/engine";
import { shapeFromRequest } from "@sketchforge/engine/shapeRequests";
import type { WorkplaneShape } from "@sketchforge/engine/domain/sketchforge";

describe("headless project mesh generation", () => {
  it("meshes a placed box as world-space triangles", async () => {
    const shape = shapeFromRequest({ kind: "box", width: 10, depth: 8, height: 6, x: 20, z: -4, elevation: 3 }) as WorkplaneShape;
    const [mesh] = await meshProjectShapes([shape]);
    expect(mesh.name).toBe(shape.name);
    expect(mesh.vertices.length).toBeGreaterThan(0);
    expect(mesh.faces.length).toBeGreaterThan(0);
    expect(Math.min(...mesh.vertices.map(([x]) => x))).toBeCloseTo(15);
    expect(Math.max(...mesh.vertices.map(([x]) => x))).toBeCloseTo(25);
  });

  it("omits hidden objects and cutters from export meshes", async () => {
    const visible = shapeFromRequest({ kind: "box", width: 10, depth: 10, height: 10 }) as WorkplaneShape;
    const hidden = { ...visible, id: "hidden", hidden: true };
    const cutter = { ...visible, id: "cutter", hole: true };
    const meshes = await meshProjectShapes([visible, hidden, cutter]);
    expect(meshes).toHaveLength(1);
  });
});
