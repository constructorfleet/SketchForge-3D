import { describe, expect, it } from "vitest";
import { meshProjectShapes } from "@constructorfleet/sketchforge-engine";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine/shapeRequests";
import { applyEdgeTreatment } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import type { WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";

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

  it("maps stable face colors onto BREP-backed export triangles without stored STEP ranges", async () => {
    const source = shapeFromRequest({ kind: "box", width: 10, depth: 8, height: 6 }) as WorkplaneShape;
    const exact = await applyEdgeTreatment(source, { kind: "fillet", amount: 0.5 });
    const faceIds = ["face_a", "face_b", "face_c", "face_d", "face_e", "face_f"];
    const [mesh] = await meshProjectShapes([{
      ...source,
      kind: "mesh",
      cadBrep: exact.brep,
      faceIds,
      faceColors: { face_b: "#ff0000" },
    }]);

    expect(mesh.triangleColors).toContain("#ff0000");
    expect(mesh.triangleColors?.some((color) => color === null)).toBe(true);
  });
});
