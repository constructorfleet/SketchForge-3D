import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { serverCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { applyEdgeTreatment, shapeWithCadResult, ServerCadError } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { applyShell, shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine/shapeRequests";
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

  it("hollows a ball to the volume the arithmetic says", async () => {
    // A 40mm ball with a 2mm wall: 4/3 pi (20^3 - 18^3), and still centred on
    // its own centre, which for a sphere sitting on the workplane is its radius
    // above it. Exact rather than close, because a ball of three equal radii is
    // built as a true sphere -- OCCT's ellipsoid is a revolved spline, which it
    // then refuses to offset at all.
    const ball = sceneShape({ name: "ball", kind: "sphere", color: "#d41721", width: 40, depth: 40, height: 40, size: 40 });

    const result = await applyShell(ball, { thickness: 2 });

    const { volume, centre } = await measure(result.brep);
    expect(volume).toBeCloseTo((4 / 3) * Math.PI * (20 ** 3 - 18 ** 3), 3);
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.y).toBeCloseTo(20, 6);
    expect(centre.z).toBeCloseTo(0, 6);
  });

  it("hollows the kinds whose surfaces are analytic, round ones included", async () => {
    // Which kinds this works on is a property of the kernel, not a choice, and
    // the line is not "curved": an analytic sphere, cylinder, cone and torus
    // all offset inwards perfectly well. Pinned here so a kernel upgrade that
    // moves the line shows up as a failing test rather than a support answer.
    const flat = ["box", "cylinder", "polygon", "pyramid", "roof", "wedge"] as const;
    for (const kind of flat) {
      const shape = sceneShape({ name: kind, kind, color: "#d41721", width: 40, depth: 40, height: 40, size: 40 });
      await expect(applyShell(shape, { thickness: 2 }), kind).resolves.toMatchObject({
        triangleCount: expect.any(Number),
      });
    }

    const curved: Array<[string, WorkplaneShape]> = [
      ["ball", sceneShape({ name: "ball", kind: "sphere", color: "#d41721", width: 40, depth: 40, height: 40, size: 40 })],
      ["dome", sceneShape({ name: "dome", kind: "halfSphere", color: "#d41721", width: 40, depth: 40, height: 20, size: 40 })],
      ["torus", sceneShape({ name: "torus", kind: "torus", color: "#d41721", width: 40, depth: 40, height: 16, size: 40 })],
      ["frustum", shapeFromRequest({ kind: "cone", width: 40, depth: 40, height: 40, topRadius: 10 }) as WorkplaneShape],
    ];
    for (const [label, shape] of curved) {
      const thick = await measure((await applyShell(shape, { thickness: 2 })).brep);
      const thin = await measure((await applyShell(shape, { thickness: 0.5 })).brep);
      // No clean closed form for these, so the checks are the ones that still
      // mean something. The volume of a hollow *is* the volume of its wall, so
      // a 2mm wall has to weigh more than a 0.5mm one -- which is also what
      // rules out the failure mode where OCCT hands back the original solid,
      // since that would weigh the same either way. And a shape symmetric
      // about the vertical axis has to stay that way.
      expect(thick.volume, label).toBeGreaterThan(0);
      expect(thick.volume, label).toBeGreaterThan(thin.volume * 1.5);
      expect(thick.centre.x, label).toBeCloseTo(0, 2);
      expect(thick.centre.z, label).toBeCloseTo(0, 2);
    }
  });

  it("refuses a spline skin, which is what it cannot offset", async () => {
    // An elliptical ball is the same kind as a round one and cannot be
    // hollowed, because only equal radii get a true sphere; the rest stay a
    // revolved spline. A loft is a spline all over by construction.
    const elliptical = sceneShape({ name: "egg", kind: "sphere", color: "#d41721", width: 40, depth: 40, height: 20, size: 40 });
    await expect(applyShell(elliptical, { thickness: 2 })).rejects.toThrow(/skin is a spline/);
    await expect(applyShell(elliptical, { thickness: 2 })).rejects.toThrow(ServerCadError);

    for (const kind of ["tube", "ring"] as const) {
      const shape = sceneShape({ name: kind, kind, color: "#d41721", width: 40, depth: 40, height: 40, size: 40 });
      // A refusal the API can answer with, not a WASM exception reaching the
      // route as a 500. Where OCCT gives up on these varies, so only the kind
      // of failure is pinned.
      await expect(applyShell(shape, { thickness: 2 }), kind).rejects.toThrow(ServerCadError);
    }
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
