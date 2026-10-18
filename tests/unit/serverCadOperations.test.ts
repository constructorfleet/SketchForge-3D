import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { serverCadKernel } from "@/lib/serverCadKernel";
import { applyEdgeTreatment, shapeEdges, shapeWithCadResult, ServerCadError } from "@/lib/serverCadOperations";
import { sceneShape } from "@/lib/shapeCatalog";
import { shapeFromRequest } from "@/lib/shapeRequests";
import type { WorkplaneShape } from "@/types/sketchforge";

function box(overrides: Record<string, unknown> = {}) {
  return shapeFromRequest({ kind: "box", width: 40, depth: 40, height: 10, ...overrides }) as WorkplaneShape;
}

// See the note in serverCadSolids.test.ts: the kernel, not the test, needs the time.
describe("server-side fillet and chamfer", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("lists a box's twelve edges", async () => {
    const edges = await shapeEdges(box());

    expect(edges).toHaveLength(12);
    expect(edges.map((edge) => edge.index)).toEqual([...Array(12).keys()]);
    expect(edges.every((edge) => edge.length > 0)).toBe(true);
    expect(new Set(edges.map((edge) => edge.curveType))).toEqual(new Set(["line"]));
  });

  it("fillets every edge of a box and returns exact geometry with a mesh of it", async () => {
    const result = await applyEdgeTreatment(box(), { kind: "fillet", amount: 3 });

    expect(result.brep).toContain("CASCADE Topology");
    expect(result.triangleCount).toBeGreaterThan(100);
    expect(result.positions.length).toBe(result.triangleCount * 9);
    expect(result.normals?.length).toBe(result.positions.length);
  });

  it("keeps the shape's size and place when it becomes a treated mesh", async () => {
    const source = { ...box(), x: 15, z: -8, elevation: 4 } as WorkplaneShape;
    const result = await applyEdgeTreatment(source, { kind: "fillet", amount: 3 });

    const treated = shapeWithCadResult(source, result);

    expect(treated.kind).toBe("mesh");
    // A fillet only removes material from the edges, so the footprint is kept.
    expect(treated.width).toBeCloseTo(40, 1);
    expect(treated.depth).toBeCloseTo(40, 1);
    expect(treated.height).toBeCloseTo(10, 1);
    expect(treated).toMatchObject({ x: 15, z: -8, elevation: 4, rotation: 0 });
    expect(treated.cadBrep).toBe(result.brep);
    expect(treated.importedMesh?.triangleCount).toBe(result.triangleCount);

    // Centred in X and Z, measured from the bottom in Y.
    const positions = treated.importedMesh!.positions;
    const xs = positions.filter((_, index) => index % 3 === 0);
    const ys = positions.filter((_, index) => index % 3 === 1);
    expect(Math.min(...xs)).toBeCloseTo(-20, 1);
    expect(Math.max(...xs)).toBeCloseTo(20, 1);
    expect(Math.min(...ys)).toBeCloseTo(0, 5);
  });

  it("chamfers only the edges it was asked for", async () => {
    const all = await applyEdgeTreatment(box(), { kind: "chamfer", amount: 2 });
    const one = await applyEdgeTreatment(box(), { kind: "chamfer", amount: 2, edges: [0] });

    expect(one.triangleCount).toBeLessThan(all.triangleCount);
  });

  it("takes a chamfer angle other than 45 degrees", async () => {
    const result = await applyEdgeTreatment(box(), { kind: "chamfer", amount: 2, angle: 30, edges: [0] });

    expect(result.triangleCount).toBeGreaterThan(0);
  });

  it("reports a radius too large for the shape instead of grinding on it", async () => {
    // The case that hangs the editor: a radius that cannot fit a thin plate.
    await expect(applyEdgeTreatment(box({ height: 1 }), { kind: "fillet", amount: 5 }))
      .rejects.toThrow(/too large/);
  });

  it("refuses a radius of zero or less", async () => {
    await expect(applyEdgeTreatment(box(), { kind: "fillet", amount: 0 })).rejects.toThrow(/greater than zero/);
    await expect(applyEdgeTreatment(box(), { kind: "fillet", amount: -1 })).rejects.toThrow(/greater than zero/);
  });

  it("refuses an edge index that is not there", async () => {
    await expect(applyEdgeTreatment(box(), { kind: "fillet", amount: 1, edges: [99] })).rejects.toThrow(/between 0 and 11/);
  });

  it("works from a previous result's exact geometry, so treatments stack", async () => {
    // Fillet the four vertical edges, then treat an untouched top edge of the
    // result. This only works because the result is unwrapped to its solid:
    // OCCT refuses the compound that fillet actually returns.
    const plain = box();
    const vertical = (await shapeEdges(plain)).filter((edge) => Math.abs(edge.length - 10) < 1e-6);
    const first = await applyEdgeTreatment(plain, { kind: "fillet", amount: 3, edges: vertical.map((edge) => edge.index) });
    const filletedShape = { ...plain, cadBrep: first.brep } as WorkplaneShape;

    const edges = await shapeEdges(filletedShape);
    const untouched = edges.find((edge) => edge.curveType === "line" && edge.length > 30);
    expect(edges.length).toBeGreaterThan(12);
    expect(untouched).toBeDefined();

    const second = await applyEdgeTreatment(filletedShape, { kind: "fillet", amount: 0.5, edges: [untouched!.index] });

    expect(second.brep).not.toBe(first.brep);
    expect(second.triangleCount).toBeGreaterThan(first.triangleCount);
  });

  it("stores a solid rather than the compound OCCT hands back", async () => {
    // Both fillet and chamfer return a compound wrapping the result, and OCCT
    // refuses a compound as the input to another treatment. Reading a shape
    // back here unwraps a compound anyway, so this asserts on the stored BREP
    // itself: anything else reading it -- STEP export, the editor's worker --
    // should find a solid.
    const result = await applyEdgeTreatment(box(), { kind: "fillet", amount: 2 });

    const cad = await serverCadKernel();
    const stored = cad.fromBREP(result.brep);
    expect(cad.getShapeType(stored)).toBe("solid");
    expect(cad.isSolid(stored)).toBe(true);
  });

  it("keeps the rotation of a shape whose geometry was already stored", async () => {
    // Stored geometry is in the shape's own frame, with its rotation applied on
    // top -- so unlike a rebuilt parametric shape, that rotation has to survive
    // the treatment or the shape springs back to square.
    // Filleting only the vertical edges first: a box with every edge filleted
    // has no line edge left that is not bounded by a fillet surface, which
    // OCCT rightly refuses to fillet again.
    const plain = box();
    const vertical = (await shapeEdges(plain)).filter((edge) => Math.abs(edge.length - 10) < 1e-6);
    const first = await applyEdgeTreatment(plain, { kind: "fillet", amount: 3, edges: vertical.map((edge) => edge.index) });
    const stored = { ...plain, cadBrep: first.brep, rotation: 45, rotationZ: 10 } as WorkplaneShape;
    const edges = await shapeEdges(stored);
    const untouched = edges.find((edge) => edge.curveType === "line" && edge.length > 30);

    const result = await applyEdgeTreatment(stored, { kind: "fillet", amount: 0.5, edges: [untouched!.index] });
    const treated = shapeWithCadResult(stored, result);

    expect(treated.rotation).toBe(45);
    expect(treated.rotationZ).toBe(10);
  });

  it("still works after an operation OCCT threw on", async () => {
    // A failed OCCT call leaves the kernel in a state its own API cannot
    // describe: the next unrelated call fails with "null function or function
    // signature mismatch". A long-lived server would be broken until
    // restarted by one fillet radius that did not fit.
    await expect(applyEdgeTreatment(box({ height: 1 }), { kind: "fillet", amount: 5 })).rejects.toThrow();

    const result = await applyEdgeTreatment(box(), { kind: "fillet", amount: 2 });

    expect(result.triangleCount).toBeGreaterThan(0);
    expect(result.brep).toContain("CASCADE Topology");
  });

  it("says what it cannot do rather than approximating it", async () => {
    const text = shapeFromRequest({ kind: "text", width: 20, depth: 20, height: 20, text: "HI" }) as WorkplaneShape;

    await expect(applyEdgeTreatment(text, { kind: "fillet", amount: 1 })).rejects.toThrow(/text/);
    await expect(applyEdgeTreatment(text, { kind: "fillet", amount: 1 })).rejects.toThrow(ServerCadError);
  });

  it("fillets a roof, a wedge, a barrel roof, and a pyramid", async () => {
    for (const kind of ["roof", "wedge", "roundRoof", "pyramid"] as const) {
      const subject = sceneShape({ name: kind, kind, color: "#d41721", width: 40, depth: 40, height: 12, size: 40 });
      await expect(applyEdgeTreatment(subject, { kind: "fillet", amount: 1 }), kind)
        .resolves.toMatchObject({ triangleCount: expect.any(Number) });
    }
  });

  it("says a torus has nothing to round rather than blaming the radius", async () => {
    // A torus is one closed surface: its only edges are the seams where that
    // surface meets itself, and there is no corner there to blend.
    const torus = sceneShape({ name: "torus", kind: "torus", color: "#d41721", width: 40, depth: 40, height: 12, size: 40 });

    const edges = await shapeEdges(torus);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((edge) => !edge.filletable)).toBe(true);

    await expect(applyEdgeTreatment(torus, { kind: "fillet", amount: 1 }))
      .rejects.toThrow(/no edges to round/);
  });

  it("rounds only the edges that can be rounded when asked for all of them", async () => {
    // A cylinder's side is one surface meeting itself, so one of its three
    // edges is a seam. Including it fails the whole operation.
    const cylinder = shapeFromRequest({ kind: "cylinder", width: 30, depth: 30, height: 20 }) as WorkplaneShape;

    const edges = await shapeEdges(cylinder);

    expect(edges.filter((edge) => edge.filletable)).toHaveLength(2);
    expect(edges.filter((edge) => !edge.filletable)).toHaveLength(1);
    await expect(applyEdgeTreatment(cylinder, { kind: "fillet", amount: 2 })).resolves.toBeDefined();
  });

  it("refuses a seam the caller named outright, instead of silently skipping it", async () => {
    const cylinder = shapeFromRequest({ kind: "cylinder", width: 30, depth: 30, height: 20 }) as WorkplaneShape;
    const seam = (await shapeEdges(cylinder)).find((edge) => !edge.filletable);

    await expect(applyEdgeTreatment(cylinder, { kind: "fillet", amount: 2, edges: [seam!.index] }))
      .rejects.toThrow(/seams in a curved surface/);
  });

  it("fillets the kinds that used to need the editor", async () => {
    const cylinder = shapeFromRequest({ kind: "cylinder", width: 30, depth: 30, height: 20 }) as WorkplaneShape;
    const hex = shapeFromRequest({ kind: "cylinder", width: 30, depth: 30, height: 20, sides: 6 }) as WorkplaneShape;
    const loft = shapeFromRequest({ kind: "loft", width: 30, depth: 30, height: 20 }) as WorkplaneShape;

    await expect(applyEdgeTreatment(cylinder, { kind: "fillet", amount: 2 })).resolves.toMatchObject({ triangleCount: expect.any(Number) });
    await expect(applyEdgeTreatment(hex, { kind: "chamfer", amount: 1 })).resolves.toMatchObject({ triangleCount: expect.any(Number) });
    await expect(applyEdgeTreatment(loft, { kind: "fillet", amount: 1 })).resolves.toMatchObject({ triangleCount: expect.any(Number) });
  });

  it("keeps a turned shape turned", async () => {
    // The geometry is built already turned, so the result must not carry the
    // rotation as well -- that would turn it twice.
    const turned = { ...box({ depth: 10 }), rotation: 90 } as WorkplaneShape;

    const result = await applyEdgeTreatment(turned, { kind: "fillet", amount: 1 });
    const treated = shapeWithCadResult(turned, result);

    expect(treated.rotation).toBe(0);
    // A quarter turn puts the 40mm side along Z.
    expect(treated.width).toBeCloseTo(10, 1);
    expect(treated.depth).toBeCloseTo(40, 1);
  });
});
