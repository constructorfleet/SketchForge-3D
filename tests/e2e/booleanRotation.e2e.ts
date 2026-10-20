import { describe, expect, it } from "vitest";
import type { Matrix4 } from "three";
import { withCadKernel } from "@sketchforge/engine/serverCadKernel";
import { buildGroupFromSelection } from "@sketchforge/engine/serverShapeBooleans";
import { unrotatedSolidForShape } from "@sketchforge/engine/cadSolids";
import { shapePlacementMatrix } from "@sketchforge/engine/serverShapeGroups";
import { sceneShape } from "@sketchforge/engine/shapeCatalog";
import { shapeFromRequest } from "@sketchforge/engine/shapeRequests";
import type { WorkplaneShape } from "@/types/sketchforge";

// The first test of `buildGroupFromSelection`, which had none.
//
// `grep -rn "buildGroupFromSelection" tests/` returned nothing before this
// file, and `apiV1Booleans.test.ts` never rotates an operand -- so the server's
// whole boolean entry point was uncovered on the one question that had already
// produced a shipped bug once (#45).
//
// Everything here measures **centre of mass**. A bounding box cannot see a
// double rotation: a wedge's footprint is square, so turning it twice leaves
// every extent identical, and the volume is a rigid-motion invariant and so
// cannot see it either. Before the fix this file accompanies, a 20x20x12 wedge
// at yaw 90 came out of the boolean path with its centre of mass 3.33mm away in
// each of X and Z, with a perfect bounding box and a perfect volume.

/** OCCT takes an affine transform as three row-major rows; THREE stores by column. */
function rowMajorTransform(matrix: Matrix4) {
  const e = matrix.elements;
  return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]];
}

/**
 * Volume and volume centroid of a closed triangle soup.
 *
 * Signed tetrahedra from the origin, which is the only way to get a centre of
 * mass out of what the group actually stores: a flat list of triangles.
 */
function meshVolumeCentroid(positions: readonly number[]) {
  let volume = 0;
  const weighted = [0, 0, 0];
  for (let index = 0; index + 8 < positions.length; index += 9) {
    const a = positions.slice(index, index + 3);
    const b = positions.slice(index + 3, index + 6);
    const c = positions.slice(index + 6, index + 9);
    const cross = [
      b[1] * c[2] - b[2] * c[1],
      b[2] * c[0] - b[0] * c[2],
      b[0] * c[1] - b[1] * c[0],
    ];
    const signed = (a[0] * cross[0] + a[1] * cross[1] + a[2] * cross[2]) / 6;
    volume += signed;
    for (let axis = 0; axis < 3; axis += 1) {
      weighted[axis] += (signed * (a[axis] + b[axis] + c[axis])) / 4;
    }
  }
  return { volume, centre: weighted.map((value) => value / volume) as [number, number, number] };
}

/** Where a group's stored geometry sits in the project, from what it stores. */
async function cutAndMeasure(selection: WorkplaneShape[]) {
  const outcome = await buildGroupFromSelection(selection);
  if ("error" in outcome) throw new Error(`the cut was refused: ${outcome.error}`);
  const { group } = outcome;
  const measured = meshVolumeCentroid(group.importedMesh!.positions);
  // Stored positions are centred in X and Z with the base at Y=0; the group's
  // own placement is what puts them back in the project.
  return {
    volume: measured.volume,
    centre: [
      measured.centre[0] + group.x,
      measured.centre[1] + (group.elevation ?? 0),
      measured.centre[2] + group.z,
    ] as [number, number, number],
  };
}

/**
 * The same cut, composed the way the editor composes a placement.
 *
 * Each operand's **unrotated** solid put through `shapePlacementMatrix` -- which
 * is the one supplier of rotation, translation and mirroring in the app -- then
 * fused and cut. This is the specification the boolean path has to meet, so a
 * regression that rotates somewhere else as well fails against it.
 */
function placementReference(solids: WorkplaneShape[], holes: WorkplaneShape[]) {
  return withCadKernel((cad) => {
    const place = (shape: WorkplaneShape) =>
      cad.transform(unrotatedSolidForShape(cad, shape), rowMajorTransform(shapePlacementMatrix(shape)));
    const solidHandles = solids.map(place);
    const fused = solidHandles.length === 1 ? solidHandles[0] : cad.fuseAll(solidHandles);
    const cut = holes.length > 0 ? cad.cutAll(fused, holes.map(place)) : fused;
    const centre = cad.getCenterOfMass(cut);
    return { volume: cad.getVolume(cut), centre: [centre.x, centre.y, centre.z] as [number, number, number] };
  });
}

function wedge(overrides: Partial<WorkplaneShape> = {}) {
  return {
    ...sceneShape({ name: "Wedge", kind: "wedge", color: "#d41721", width: 20, depth: 20, height: 12, size: 20 }),
    ...overrides,
  } as WorkplaneShape;
}

function box(overrides: Record<string, unknown> = {}) {
  return shapeFromRequest({ kind: "box", width: 20, depth: 20, height: 20, ...overrides }) as WorkplaneShape;
}

/** Far enough away to remove nothing, so the result is the placed solid alone. */
function distantHole() {
  return { ...box({ width: 4, depth: 4, height: 40, x: 400 }), hole: true } as WorkplaneShape;
}

function expectCentre(actual: readonly number[], expected: readonly number[], digits = 3) {
  for (let axis = 0; axis < 3; axis += 1) expect(actual[axis], `axis ${axis}`).toBeCloseTo(expected[axis], digits);
}

describe("the server's boolean path, on rotated operands", { timeout: 300_000 }, () => {
  it("cuts a slab out of a box, which anchors the arithmetic", async () => {
    // No rotation anywhere, and a closed form: a 20mm cube with the half of it
    // from x=0 outwards removed is a 10x20x20 slab weighing 4000mm^3 centred at
    // x=-5. Everything below is relative to a placement matrix, so one
    // absolute number is worth having.
    const solid = box();
    const hole = { ...box({ width: 10, depth: 20, height: 20, x: 5 }), hole: true } as WorkplaneShape;

    const cut = await cutAndMeasure([solid, hole]);

    expect(cut.volume).toBeCloseTo(4000, 2);
    expectCentre(cut.centre, [-5, 10, 0]);
  });

  it("puts a yawed wedge where the editor's placement matrix puts it", async () => {
    // The reproduction. A wedge is asymmetric about its own origin, so turning
    // it twice moves its mass; its footprint is square, so nothing else moves.
    const turned = wedge({ rotation: 90 });

    const reference = placementReference([turned], []);
    const cut = await cutAndMeasure([turned, distantHole()]);

    const expected = await reference;
    expect(cut.volume).toBeCloseTo(expected.volume, 2);
    expectCentre(cut.centre, expected.centre);
    // Turned twice, the centre of mass lands at (-3.333, 4, 0) instead. Pinned
    // so that a regression is a failure with a recognisable number rather than
    // a reference that moved with the code.
    expectCentre(cut.centre, [0, 4, -10 / 3]);
  });

  it("puts a wedge yawed and pitched together where the editor does", async () => {
    // Two non-zero rotations is where the composition order shows up as well
    // as the count, which is what #45 was about.
    const turned = wedge({ rotation: 30, rotationX: 40 });

    const reference = placementReference([turned], []);
    const cut = await cutAndMeasure([turned, distantHole()]);

    const expected = await reference;
    expect(cut.volume).toBeCloseTo(expected.volume, 2);
    expectCentre(cut.centre, expected.centre);
    // Turned twice this was (3.147, 4.779, -1.445): wrong on all three axes,
    // and still 2400mm^3.
    expectCentre(cut.centre, [2.887, 5.539, -2.562], 2);
  });

  it("cuts a yawed solid with a yawed hole, both placed once", async () => {
    // Both operands rotated, and the hole actually removing material, so the
    // result's shape depends on the two placements agreeing with each other.
    const solid = box({ rotation: 30 });
    const hole = { ...box({ width: 8, depth: 8, height: 40, x: 4, z: 3, rotation: 20, elevation: -10 }), hole: true } as WorkplaneShape;

    const reference = placementReference([solid], [hole]);
    const cut = await cutAndMeasure([solid, hole]);

    const expected = await reference;
    expect(cut.volume).toBeCloseTo(expected.volume, 1);
    expect(cut.volume).toBeLessThan(8000);
    expectCentre(cut.centre, expected.centre, 2);
  });

  it("is unmoved for the round shape that hid this", async () => {
    // A circular cylinder's yaw is reduced modulo its own side step by
    // `meshYawDegrees`, so the placement matrix added nothing and the double
    // rotation was invisible on exactly the shape most people would have tried.
    // Kept as a test so that reasoning is written down somewhere executable.
    const turned = shapeFromRequest({ kind: "cylinder", width: 20, depth: 20, height: 12, rotation: 90 }) as WorkplaneShape;

    const cut = await cutAndMeasure([turned, distantHole()]);

    expectCentre(cut.centre, [0, 6, 0], 2);
  });

  it("leaves a stored mesh alone, which was never double-rotated", async () => {
    // A shape carrying triangles is taken from them, already placed, so it goes
    // nowhere near either builder. The rotation is in the mesh.
    const source = wedge({ rotation: 90 });
    const meshed = await cutAndMeasure([source, distantHole()]);
    const stored = await buildGroupFromSelection([source, distantHole()]);
    if ("error" in stored) throw new Error(stored.error);

    // Feed the group -- which is a mesh shape now -- back in as the solid.
    const again = await cutAndMeasure([{ ...stored.group, hole: false }, distantHole()]);

    expect(again.volume).toBeCloseTo(meshed.volume, 0);
    expectCentre(again.centre, meshed.centre, 1);
  });
});
