import { describe, expect, it } from "vitest";
import { importedShapeFromStepOnKernel } from "@/lib/engine/stepImportKernel";
import { withCadKernel } from "@/lib/engine/serverCadKernel";

/**
 * STEP import on the kernel, against files built here rather than a fixture:
 * a 74 MB assembly cannot live in the repository, so the assembly case is
 * covered by shape rather than by size -- several solids in one file, which is
 * the structure that defeated the brepjs mesher.
 */
type Corner = { x: number; y: number; z: number };

/**
 * STEP text written by the kernel itself, rather than by the brepjs exporter,
 * so the fixture does not depend on the browser loader this module exists to
 * avoid. Z-up on the way in, which is what a STEP file carries.
 */
function stepTextFor(boxes: Array<[Corner, Corner]>) {
  return withCadKernel(async (cad) => {
    const solids = boxes.map(([from, to]) => cad.makeBoxFromCorners(from, to));
    // A compound rather than a fusion: the point is several *separate* solids
    // in one file, which is how a real assembly arrives.
    return cad.exportStep(solids.length === 1 ? solids[0] : cad.makeCompound(solids));
  });
}

describe("STEP import on the kernel", () => {
  it("reads a single solid and reports what it found", async () => {
    // 40 wide, 20 deep, 10 tall in Y-up terms: Z-up height becomes Y.
    const text = await stepTextFor([[{ x: -20, y: -10, z: 0 }, { x: 20, y: 10, z: 10 }]]);
    const result = await importedShapeFromStepOnKernel("fixture.step", text);

    expect(result.solids).toBe(1);
    expect(result.triangles).toBeGreaterThan(0);
    // A 40x20x10 box, whatever the tessellation, keeps its extents.
    expect(result.shape.width).toBeCloseTo(40, 1);
    expect(result.shape.depth).toBeCloseTo(20, 1);
    expect(result.shape.height).toBeCloseTo(10, 1);
  }, 120_000);

  it("counts the solids in an assembly, which is what defeats the mesher above the kernel", async () => {
    const text = await stepTextFor([
      [{ x: -20, y: -10, z: 0 }, { x: 20, y: 10, z: 10 }],
      [{ x: 180, y: 140, z: 0 }, { x: 190, y: 150, z: 30 }],
    ]);
    const result = await importedShapeFromStepOnKernel("assembly.step", text);

    expect(result.solids).toBe(2);
    // Both solids are in the mesh: the footprint spans from one to the other.
    expect(result.shape.width).toBeGreaterThan(150);
  }, 120_000);

  it("maps Z-up to Y-up without mirroring, which extents alone cannot see", async () => {
    // An L of two boxes, asymmetric about the Z-up Y axis. Extents survive a
    // mirror and so does a bounding box, so this measures where the material
    // actually is: the signed offset of the mesh centroid from the middle of
    // its own bounding box. Getting the conversion wrong by a sign flips it.
    const text = await stepTextFor([
      [{ x: 0, y: 0, z: 0 }, { x: 60, y: 10, z: 10 }],
      [{ x: 0, y: 10, z: 0 }, { x: 10, y: 40, z: 10 }],
    ]);
    const result = await importedShapeFromStepOnKernel("ell.step", text);
    const positions = result.shape.importedMesh?.positions ?? [];
    expect(positions.length).toBeGreaterThan(0);

    let minZ = Infinity, maxZ = -Infinity, sumZ = 0;
    for (let index = 2; index < positions.length; index += 3) {
      minZ = Math.min(minZ, positions[index]);
      maxZ = Math.max(maxZ, positions[index]);
      sumZ += positions[index];
    }
    const centroidZ = sumZ / (positions.length / 3);
    const boxMiddleZ = (minZ + maxZ) / 2;

    // Z-up +Y becomes Y-up -Z. The long arm sits at low Z-up Y, so the bulk of
    // the material lands at high Y-up Z: the centroid sits above the middle.
    expect(centroidZ).toBeGreaterThan(boxMiddleZ);
  }, 120_000);

  it("keeps the exact geometry for a small file and leaves it out for an assembly", async () => {
    const small = await importedShapeFromStepOnKernel("small.step", await stepTextFor([
      [{ x: -5, y: -5, z: 0 }, { x: 5, y: 5, z: 5 }],
    ]));
    expect(small.exactGeometry).toBe(true);
    expect(small.shape.importedMesh?.brepStep).toBeTruthy();

    // Past the solid limit the exact geometry is dropped on purpose: the
    // re-export of a real assembly was 202.7 MB of text for a 74 MB file, and
    // that text would be written into the project on every autosave.
    const many: Array<[{ x: number; y: number; z: number }, { x: number; y: number; z: number }]> = [];
    for (let index = 0; index < 201; index += 1) {
      const offset = index * 3;
      many.push([{ x: offset, y: 0, z: 0 }, { x: offset + 2, y: 2, z: 2 }]);
    }
    const assembly = await importedShapeFromStepOnKernel("many.step", await stepTextFor(many));
    expect(assembly.solids).toBe(201);
    expect(assembly.exactGeometry).toBe(false);
    expect(assembly.shape.importedMesh?.brepStep).toBeFalsy();
    // The mesh is still there and still correct.
    expect(assembly.triangles).toBeGreaterThan(0);
    expect(assembly.shape.width).toBeGreaterThan(600);
  }, 300_000);

  it("refuses an empty file rather than importing nothing", async () => {
    await expect(importedShapeFromStepOnKernel("empty.step", "   ")).rejects.toMatchObject({ key: "errors.step.readFailed" });
  });

  it("refuses text that is not STEP at all", async () => {
    await expect(importedShapeFromStepOnKernel("nonsense.step", "this is not a STEP file")).rejects.toMatchObject({
      key: expect.stringMatching(/errors\.step\./),
    });
  }, 120_000);
});
