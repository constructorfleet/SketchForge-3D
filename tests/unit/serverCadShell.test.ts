import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { serverCadKernel } from "@/lib/serverCadKernel";
import { applyEdgeTreatment, shapeWithCadResult, ServerCadError } from "@/lib/serverCadOperations";
import { applyShell, shapeFaces } from "@/lib/serverCadShell";
import { sceneShape } from "@/lib/shapeCatalog";
import { shapeFromRequest } from "@/lib/shapeRequests";
import type { WorkplaneShape } from "@/types/sketchforge";

/** A 20 mm cube, because every number in this file is a closed form of one. */
function cube(overrides: Record<string, unknown> = {}) {
  return shapeFromRequest({ kind: "box", width: 20, depth: 20, height: 20, ...overrides }) as WorkplaneShape;
}

/**
 * What the stored exact geometry actually weighs and balances on.
 *
 * A bounding box is no evidence here: a hollow, a tray and the solid it was
 * built from all occupy exactly the same extents, and so does the broken solid
 * OCCT hands back for a wall thicker than the part. The volume and the centre
 * of mass are what tell them apart.
 */
async function measure(brep: string) {
  const cad = await serverCadKernel();
  const stored = cad.fromBREP(brep);
  const centre = cad.getCenterOfMass(stored);
  return { volume: cad.getVolume(stored), centre, type: cad.getShapeType(stored) };
}

// See the note in serverCadSolids.test.ts: the kernel, not the test, needs the time.
describe("hollowing a solid on the server", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("lists a box's six faces with the direction each one answers to", async () => {
    const faces = await shapeFaces(cube());

    expect(faces).toHaveLength(6);
    expect(faces.map((face) => face.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(faces.every((face) => face.surfaceType === "plane")).toBe(true);
    expect(faces.every((face) => Math.abs(face.area - 400) < 1e-6)).toBe(true);
    expect(new Set(faces.map((face) => face.facing))).toEqual(
      new Set(["top", "bottom", "left", "right", "front", "back"]),
    );

    // The local frame is centred in X and Z with the base at Y=0, so the top
    // face sits at the full height and points straight up.
    const top = faces.find((face) => face.facing === "top");
    expect(top?.centroid.y).toBeCloseTo(20, 6);
    expect(top?.normal?.y).toBeCloseTo(1, 6);
    const bottom = faces.find((face) => face.facing === "bottom");
    expect(bottom?.centroid.y).toBeCloseTo(0, 6);
    expect(bottom?.normal?.y).toBeCloseTo(-1, 6);
  });

  it("hollows a sealed cube to the volume the arithmetic says", async () => {
    const result = await applyShell(cube(), { thickness: 2 });

    const { volume, centre, type } = await measure(result.brep);
    // 20^3 - 16^3. A wall all the way round takes 2mm off each of six sides.
    expect(volume).toBeCloseTo(3904, 6);
    // Still symmetric: a sealed shell takes the same material off every side.
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.y).toBeCloseTo(10, 6);
    expect(centre.z).toBeCloseTo(0, 6);
    expect(type).toBe("solid");
    expect(result.brep).toContain("CASCADE Topology");
    expect(result.positions.length).toBe(result.triangleCount * 9);
    expect(result.normals?.length).toBe(result.positions.length);
  });

  it("leaves the top open, which is the difference between a box and a tray", async () => {
    const result = await applyShell(cube(), { thickness: 2, openFaces: ["top"] });

    const { volume, centre } = await measure(result.brep);
    // 20^3 minus a 16 x 16 x 18 cavity open at the top.
    expect(volume).toBeCloseTo(3392, 6);
    // Heavier at the bottom than a sealed shell is, because the floor is there
    // and the lid is not: (8000*10 - 4608*11) / 3392.
    expect(centre.y).toBeCloseTo(8.641509, 5);
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.z).toBeCloseTo(0, 6);
  });

  it("takes a face index as well as a direction, and means the same face", async () => {
    const faces = await shapeFaces(cube());
    const top = faces.find((face) => face.facing === "top")!;

    const byIndex = await applyShell(cube(), { thickness: 2, openFaces: [top.index] });

    const { volume, centre } = await measure(byIndex.brep);
    expect(volume).toBeCloseTo(3392, 6);
    expect(centre.y).toBeCloseTo(8.641509, 5);
  });

  it("opens two faces at once", async () => {
    const result = await applyShell(cube(), { thickness: 2, openFaces: ["top", "bottom"] });

    const { volume, centre } = await measure(result.brep);
    // A 16 x 16 tube through the whole height: 8000 - 16*16*20.
    expect(volume).toBeCloseTo(2880, 6);
    // Open at both ends, so symmetric again.
    expect(centre.y).toBeCloseTo(10, 6);
  });

  it("hollows a cylinder, where the wall is a real cylindrical surface", async () => {
    const cylinder = shapeFromRequest({ kind: "cylinder", width: 20, depth: 20, height: 20 }) as WorkplaneShape;

    const result = await applyShell(cylinder, { thickness: 2, openFaces: ["top"] });

    const { volume, centre } = await measure(result.brep);
    // pi*10^2*20 - pi*8^2*18, the outer cylinder less a cavity open at the top.
    expect(volume).toBeCloseTo(Math.PI * 100 * 20 - Math.PI * 64 * 18, 4);
    expect(centre.y).toBeCloseTo((Math.PI * 100 * 20 * 10 - Math.PI * 64 * 18 * 11) / volume, 5);
  });

  it("keeps the shape's size and place when it becomes a hollowed mesh", async () => {
    const source = { ...cube(), x: 15, z: -8, elevation: 4 } as WorkplaneShape;
    const result = await applyShell(source, { thickness: 2, openFaces: ["top"] });

    const hollowed = shapeWithCadResult(source, result);

    expect(hollowed.kind).toBe("mesh");
    // Hollowing removes material from the inside, so the outside is unchanged.
    expect(hollowed.width).toBeCloseTo(20, 1);
    expect(hollowed.depth).toBeCloseTo(20, 1);
    expect(hollowed.height).toBeCloseTo(20, 1);
    expect(hollowed).toMatchObject({ x: 15, z: -8, elevation: 4 });
    expect(hollowed.cadBrep).toBe(result.brep);
  });

  it("names the lid rather than the cavity floor on a part already hollow", async () => {
    // Both point straight up. Picking the inner one would open the floor of the
    // cavity instead of the top of the part, which looks like nothing happened.
    const first = await applyShell(cube(), { thickness: 2 });
    const sealed = { ...cube(), cadBrep: first.brep } as WorkplaneShape;

    const faces = await shapeFaces(sealed);
    const upward = faces.filter((face) => face.normal && face.normal.y > 0.999);
    const named = faces.filter((face) => face.facing === "top");

    expect(upward.length).toBe(2);
    expect(named).toHaveLength(1);
    expect(named[0].centroid.y).toBeCloseTo(20, 6);
  });

  it("can still be filleted afterwards, because the result is exact", async () => {
    const hollow = await applyShell(cube(), { thickness: 2, openFaces: ["top"] });
    const tray = shapeWithCadResult(cube(), hollow);

    const filleted = await applyEdgeTreatment(tray, { kind: "fillet", amount: 1, edges: [0] });

    expect(filleted.brep).toContain("CASCADE Topology");
    expect(filleted.brep).not.toBe(hollow.brep);
  });

  it("refuses a wall thicker than half the part rather than making a broken one", async () => {
    // Exactly half, sealed: OCCT returns an empty compound whose `isValid`
    // throws rather than answering.
    await expect(applyShell(cube(), { thickness: 10 })).rejects.toThrow(/too large/);
    // Exactly half, open top: OCCT returns a solid with the right bounding box
    // and the wrong everything else -- `isValid` is false and the volume is
    // 6666, which no wall thickness of a 20mm cube can produce.
    await expect(applyShell(cube(), { thickness: 10, openFaces: ["top"] })).rejects.toThrow(/too large/);
    // Past half, open top: OCCT hands back the original solid, valid and the
    // right size, having hollowed nothing at all.
    await expect(applyShell(cube(), { thickness: 12, openFaces: ["top"] })).rejects.toThrow(/too large/);
    await expect(applyShell(cube(), { thickness: 12, openFaces: ["top"] })).rejects.toThrow(ServerCadError);
  });

  it("refuses a thickness of zero or less", async () => {
    await expect(applyShell(cube(), { thickness: 0 })).rejects.toThrow(/greater than zero/);
    await expect(applyShell(cube(), { thickness: -2 })).rejects.toThrow(/greater than zero/);
    await expect(applyShell(cube(), { thickness: Number.NaN })).rejects.toThrow(/greater than zero/);
  });

  it("refuses to open every face, which would leave nothing", async () => {
    const all = (await shapeFaces(cube())).map((face) => face.index);

    await expect(applyShell(cube(), { thickness: 2, openFaces: all })).rejects.toThrow(/every face/);
  });

  it("refuses a face index that is not there, and a direction that is not a direction", async () => {
    await expect(applyShell(cube(), { thickness: 2, openFaces: [99] })).rejects.toThrow(/between 0 and 5/);
    await expect(applyShell(cube(), { thickness: 2, openFaces: ["sideways"] })).rejects.toThrow(/not a face direction/);
  });

  it("says a sphere has no flat face to open rather than opening the wrong one", async () => {
    const sphere = sceneShape({ name: "sphere", kind: "sphere", color: "#d41721", width: 20, depth: 20, height: 20, size: 20 });

    await expect(applyShell(sphere, { thickness: 2, openFaces: ["top"] })).rejects.toThrow(/no flat top face/);
  });

  it("hollows the flat-faced kinds and refuses the curved-skin ones by name", async () => {
    // Which kinds this works on is a property of the kernel rather than a
    // choice: a sphere, a torus, a cone and a round-walled tube are each one
    // continuous surface, and OCCT refuses to offset any of them inwards --
    // at every thickness and at every tolerance it offers. Pinned here so a
    // kernel upgrade that widens or narrows it shows up as a failing test
    // rather than as a support answer.
    for (const kind of ["box", "cylinder", "polygon", "pyramid", "roof", "wedge"] as const) {
      const shape = sceneShape({ name: kind, kind, color: "#d41721", width: 20, depth: 20, height: 20, size: 20 });
      await expect(applyShell(shape, { thickness: 2 }), kind).resolves.toMatchObject({
        triangleCount: expect.any(Number),
      });
    }
    for (const kind of ["sphere", "torus", "cone", "tube", "ring"] as const) {
      const shape = sceneShape({ name: kind, kind, color: "#d41721", width: 20, depth: 20, height: 20, size: 20 });
      // A refusal the API can answer with, not a WASM exception reaching the
      // route as a 500. Which of the two refusals each kind earns depends on
      // where OCCT gives up, so only the kind of failure is pinned here.
      await expect(applyShell(shape, { thickness: 2 }), kind).rejects.toThrow(ServerCadError);
    }
    const sphere = sceneShape({ name: "sphere", kind: "sphere", color: "#d41721", width: 20, depth: 20, height: 20, size: 20 });
    await expect(applyShell(sphere, { thickness: 2 })).rejects.toThrow(/could not hollow this shape/);
  });

  it("refuses a result OCCT can build but cannot write out", async () => {
    // A hollowed loft passes every check OCCT can answer -- a valid solid,
    // smaller than it started -- and then `toBREP` reads past the end of its
    // own memory. There is nothing to store, so it has to be a refusal rather
    // than a WASM exception reaching the route as a 500.
    const loft = shapeFromRequest({ kind: "loft", width: 20, depth: 20, height: 20 }) as WorkplaneShape;

    await expect(applyShell(loft, { thickness: 2 })).rejects.toThrow(/cannot read back/);
    await expect(applyShell(loft, { thickness: 2 })).rejects.toThrow(ServerCadError);
  });

  it("says what it cannot work from rather than approximating it", async () => {
    const text = shapeFromRequest({ kind: "text", width: 20, depth: 20, height: 20, text: "HI" }) as WorkplaneShape;

    await expect(applyShell(text, { thickness: 1 })).rejects.toThrow(/text/);
  });

  it("still works after an operation OCCT threw on", async () => {
    // A failed OCCT call leaves the kernel in a state its own API cannot
    // describe, so the wrapper throws the kernel away. Without that, one
    // too-thick wall would break every later request in the process.
    await expect(applyShell(cube(), { thickness: 10 })).rejects.toThrow();

    const result = await applyShell(cube(), { thickness: 2 });

    const { volume } = await measure(result.brep);
    expect(volume).toBeCloseTo(3904, 6);
  });
});
