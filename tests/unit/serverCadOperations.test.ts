import { describe, expect, it } from "vitest";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";
import { serverCadKernel, withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { applyEdgeTreatment, applyBakedMirror, applyDraftPrism, cadResultIsValid, shapeEdges, shapeWithCadResult, solidFromMeshPositions, ServerCadError } from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { worldMeshForShape } from "@constructorfleet/sketchforge-engine/serverShapeGroups";
import { sceneShape } from "@constructorfleet/sketchforge-engine/shapeCatalog";
import { shapeFromRequest } from "@constructorfleet/sketchforge-engine/shapeRequests";
import type { WorkplaneShape } from "@/types/sketchforge";

function box(overrides: Record<string, unknown> = {}) {
  return shapeFromRequest({ kind: "box", width: 40, depth: 40, height: 10, ...overrides }) as WorkplaneShape;
}

function sketchExtrusion() {
  const points = [
    { id: "a", x: -20, z: -20 }, { id: "b", x: 20, z: -20 },
    { id: "c", x: 20, z: 20 }, { id: "d", x: -20, z: 20 },
  ];
  return {
    ...box(),
    sketchOperation: "extrude",
    sketchProfile: {
      points,
      segments: points.map((point, index) => ({ id: `edge-${index}`, startId: point.id, endId: points[(index + 1) % points.length].id, kind: "line" as const })),
    },
  } as WorkplaneShape;
}

async function coplanarBox() {
  const brep = await withCadKernel((cad) => {
    const left = cad.translate(cad.makeBox(20, 10, 40), -20, 0, -20);
    const right = cad.translate(cad.makeBox(20, 10, 40), 0, 0, -20);
    return cad.toBREP(cad.fuse(left, right));
  });
  return {
    ...box(),
    kind: "mesh",
    cadBrep: brep,
  } as WorkplaneShape;
}

// See the note in serverCadSolids.test.ts: the kernel, not the test, needs the time.
describe("server-side fillet and chamfer", { timeout: CAD_TEST_TIMEOUT_MS }, () => {
  it("reports the requested amount and eligible-edge count for geometry sizing failures", async () => {
    await expect(applyEdgeTreatment(box(), { kind: "chamfer", amount: 1000 }))
      .rejects.toThrow(/1000.*12 eligible edges/);
  });

  it("drafts an exact solid along its extrusion axis and returns persistable geometry", async () => {
    const result = await applyDraftPrism(sketchExtrusion(), { angle: 5 });

    expect(result.brep).toContain("CASCADE Topology");
    expect(result.triangleCount).toBeGreaterThan(0);
    expect(result.positions.length).toBe(result.triangleCount * 9);
  });

  describe("draft prism profile order (#349)", () => {
    type Point = { id: string; x: number; z: number; handleIn?: { x: number; z: number }; handleOut?: { x: number; z: number } };
    type Segment = { id: string; startId: string; endId: string; kind?: "line" | "bezier" | "smooth" };
    const loop = (points: Point[], prefix = "edge"): Segment[] => points.map((point, index) => ({
      id: `${prefix}-${index}`, startId: point.id, endId: points[(index + 1) % points.length].id, kind: "line",
    }));
    const extrusionOf = (points: Point[], segments: Segment[]) => ({
      ...box(), sketchOperation: "extrude", sketchProfile: { points, segments },
    }) as WorkplaneShape;
    const rotated = (segments: Segment[]) => [...segments.slice(2), ...segments.slice(0, 2)];
    const reversed = (segments: Segment[]) => segments.map(({ startId, endId, ...rest }) => ({ ...rest, startId: endId, endId: startId })).reverse();
    const measure = async (shape: WorkplaneShape) => {
      const result = await applyDraftPrism(shape, { angle: 5 });
      return withCadKernel((cad) => cad.queryBatch([cad.fromBREP(result.brep)])[0]!);
    };

    // The square from the issue's probe, and an asymmetric pentagon whose
    // centre of mass would move if a reordered loop were built misplaced.
    const square: Point[] = [
      { id: "a", x: -20, z: -20 }, { id: "b", x: 20, z: -20 },
      { id: "c", x: 20, z: 20 }, { id: "d", x: -20, z: 20 },
    ];
    const pentagon: Point[] = [
      { id: "a", x: -20, z: -20 }, { id: "b", x: 20, z: -20 },
      { id: "c", x: 20, z: 6 }, { id: "d", x: 2, z: 20 }, { id: "e", x: -20, z: 14 },
    ];

    it.each([["square", square], ["asymmetric pentagon", pentagon]])(
      "drafts a %s identically whatever the segment order or direction",
      async (_name, points) => {
        const segments = loop(points);
        const ordered = await measure(extrusionOf(points, segments));
        expect(ordered.volume).toBeGreaterThan(0);
        for (const variant of [rotated(segments), reversed(segments), rotated(reversed(segments))]) {
          const actual = await measure(extrusionOf(points, variant));
          expect(Math.abs(actual.volume - ordered.volume)).toBeLessThan(1e-6);
          expect(actual.centerOfMass.x).toBeCloseTo(ordered.centerOfMass.x, 6);
          expect(actual.centerOfMass.y).toBeCloseTo(ordered.centerOfMass.y, 6);
          expect(actual.centerOfMass.z).toBeCloseTo(ordered.centerOfMass.z, 6);
        }
      },
    );

    it("refuses a curved profile and says the curve is the reason", async () => {
      // b -> c is a cubic: both of its handles are set, as sampledPath and the
      // extrusion builder require before they draw a curve.
      const points: Point[] = square.map((point, index) => index === 1
        ? { ...point, handleOut: { x: 26, z: -10 } }
        : index === 2 ? { ...point, handleIn: { x: 26, z: 10 } } : point);
      for (const kind of ["bezier", "smooth", undefined] as const) {
        const segments = loop(points).map((segment, index) => index === 1 ? { ...segment, kind } : segment);
        await expect(applyDraftPrism(extrusionOf(points, segments), { angle: 5 })).rejects.toThrow(/straight segments.*curved/);
      }
    });

    it("drafts a segment the extrusion draws straight as straight, whatever its kind says", async () => {
      // sampledPath draws a cubic only when the segment is not a line and both
      // of its handles are set. Anything less is a straight edge in the
      // extrusion, so the draft treats it as one rather than calling it curved.
      const ordered = await measure(extrusionOf(square, loop(square)));
      const handleless = loop(square).map((segment, index) => index < 2 ? { ...segment, kind: index === 0 ? "bezier" as const : "smooth" as const } : segment);
      const oneSided = square.map((point, index) => index === 1 ? { ...point, handleOut: { x: 26, z: -10 } } : point);
      const untyped = loop(oneSided).map(({ kind: _kind, ...segment }) => segment);
      for (const [points, segments] of [[square, handleless], [oneSided, untyped]] as const) {
        const actual = await measure(extrusionOf([...points], [...segments]));
        expect(Math.abs(actual.volume - ordered.volume)).toBeLessThan(1e-6);
        expect(actual.centerOfMass.x).toBeCloseTo(ordered.centerOfMass.x, 6);
        expect(actual.centerOfMass.z).toBeCloseTo(ordered.centerOfMass.z, 6);
      }
    });

    it("refuses an outline that crosses itself and says so", async () => {
      // A symmetric bow tie encloses no net area; a lopsided one does, and
      // would otherwise reach the kernel as a face it cannot build.
      for (const points of [
        [{ id: "a", x: -20, z: -20 }, { id: "b", x: 20, z: 20 }, { id: "c", x: 20, z: -20 }, { id: "d", x: -20, z: 20 }],
        [{ id: "a", x: -20, z: -20 }, { id: "b", x: 20, z: 20 }, { id: "c", x: 20, z: -20 }, { id: "d", x: -20, z: 40 }],
      ]) {
        await expect(applyDraftPrism(extrusionOf(points, loop(points)), { angle: 5 })).rejects.toThrow(/crosses itself/);
      }
    });

    it("refuses a closed outline that encloses no area and says so", async () => {
      const points: Point[] = [{ id: "a", x: -20, z: 0 }, { id: "b", x: 0, z: 0 }, { id: "c", x: 20, z: 0 }];
      await expect(applyDraftPrism(extrusionOf(points, loop(points)), { angle: 5 })).rejects.toThrow(/encloses no area/);
    });

    it("drafts an outline whose closing point is repeated with a zero-length segment as the plain outline", async () => {
      const ordered = await measure(extrusionOf(square, loop(square)));
      const repeated = extrusionOf([...square, { ...square[0] }], [...loop(square), { id: "closing", startId: "a", endId: "a", kind: "line" }]);
      const actual = await measure(repeated);
      expect(Math.abs(actual.volume - ordered.volume)).toBeLessThan(1e-6);
      expect(actual.centerOfMass.x).toBeCloseTo(ordered.centerOfMass.x, 6);
      expect(actual.centerOfMass.z).toBeCloseTo(ordered.centerOfMass.z, 6);
    });

    it("refuses two points that share an id but not a position and says so", async () => {
      const shape = extrusionOf([...square, { id: "a", x: 30, z: 30 }], loop(square));
      await expect(applyDraftPrism(shape, { angle: 5 })).rejects.toThrow(/share the id "a"/);
    });

    it("refuses a profile with a hole and says the hole is the reason", async () => {
      const hole: Point[] = [
        { id: "h1", x: -5, z: -5 }, { id: "h2", x: 5, z: -5 },
        { id: "h3", x: 5, z: 5 }, { id: "h4", x: -5, z: 5 },
      ];
      const shape = extrusionOf([...square, ...hole], [...loop(square), ...loop(hole, "hole")]);
      await expect(applyDraftPrism(shape, { angle: 5 })).rejects.toThrow(/hole/);
    });

    it("refuses a profile with points or segments outside its closed outline and says so", async () => {
      // A stray point would move the bounds centre the draft is built about
      // away from the outline it drafts, so it is refused rather than drafted.
      const stray = extrusionOf([...square, { id: "e", x: 30, z: 30 }], loop(square));
      await expect(applyDraftPrism(stray, { angle: 5 })).rejects.toThrow(/outside its closed outline/);
      const construction = extrusionOf(
        [...square, { id: "e", x: 30, z: 30 }, { id: "f", x: 40, z: 30 }],
        [...loop(square), { id: "construction", startId: "e", endId: "f", kind: "line" }],
      );
      await expect(applyDraftPrism(construction, { angle: 5 })).rejects.toThrow(/3 points or segments outside its closed outline/);
    });

    it("refuses a profile with several separate regions and says so", async () => {
      const other: Point[] = [
        { id: "o1", x: 30, z: -5 }, { id: "o2", x: 40, z: -5 },
        { id: "o3", x: 40, z: 5 }, { id: "o4", x: 30, z: 5 },
      ];
      const shape = extrusionOf([...square, ...other], [...loop(square), ...loop(other, "other")]);
      await expect(applyDraftPrism(shape, { angle: 5 })).rejects.toThrow(/2 separate closed regions/);
    });
  });

  it("rejects zero and excessive draft angles before invoking the kernel", async () => {
    await expect(applyDraftPrism(box(), { angle: 45 })).rejects.toThrow(/between -45 and 45/);
    await expect(applyDraftPrism(box(), { angle: 5 })).rejects.toThrow(/source profile retained/);
  });

  it("bakes an exact selected-axis reflection into BREP and clears placement flags", async () => {
    const source = shapeFromRequest({
      kind: "wedge", width: 30, depth: 18, height: 12,
      x: 14, z: -7, elevation: 3, rotation: 25, mirrorX: true,
    }) as WorkplaneShape;

    const mirrored = await applyBakedMirror(source, "z", 5);

    expect(mirrored).toMatchObject({
      kind: "mesh", elevation: 3, rotation: 0,
      mirrorX: undefined, mirrorY: undefined, mirrorZ: undefined,
    });
    expect(mirrored.x).toBeCloseTo(14, 4);
    expect(mirrored.z).toBeCloseTo(17, 4);
    expect(mirrored.cadBrep).toContain("CASCADE Topology");
    expect(mirrored.importedMesh?.triangleCount).toBeGreaterThan(0);
  });

  it("refuses baked mirrors for mesh-only geometry instead of silently losing exactness", async () => {
    const source = {
      ...box(),
      kind: "mesh",
      importedMesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], baseWidth: 1, baseDepth: 1, baseHeight: 1, triangleCount: 1 },
    } as WorkplaneShape;
    await expect(applyBakedMirror(source, "x", 0)).rejects.toThrow(/exact parameter geometry/);
  });

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

  it.each([
    ["pitch", { rotationX: 25 }],
    ["roll", { rotationZ: -20 }],
    ["pitch and yaw", { rotationX: 25, rotation: 35 }],
  ])("keeps a %s treated shape at its original project-space center of mass", async (_label, rotation) => {
    const source = shapeFromRequest({
      kind: "wedge", width: 32, depth: 18, height: 26,
      x: 15, z: -8, elevation: 4, ...rotation,
    }) as WorkplaneShape;
    const result = await applyEdgeTreatment(source, { kind: "fillet", amount: 0.6 });
    const treated = shapeWithCadResult(source, result);
    const renderedMesh = worldMeshForShape(treated)!;
    const worldPositions = renderedMesh.faces.flatMap((face) => face.flatMap((vertexIndex) => renderedMesh.vertices[vertexIndex]!));
    const measured = await withCadKernel((cad) => {
      const solid = cad.fromBREP(result.brep);
      const meshSolid = solidFromMeshPositions(cad, worldPositions);
      return {
        exact: { volume: cad.getVolume(solid), center: cad.getCenterOfMass(solid) },
        rendered: { volume: cad.getVolume(meshSolid), center: cad.getCenterOfMass(meshSolid) },
      };
    });
    // The editor worker receives the source mesh in project coordinates. This
    // world-space mesh is the geometry the viewport draws after rebasing.
    expect(Math.abs(measured.rendered.volume - measured.exact.volume)).toBeLessThan(1);
    expect(measured.rendered.center.x).toBeCloseTo(source.x + measured.exact.center.x, 2);
    expect(measured.rendered.center.y).toBeCloseTo((source.elevation ?? 0) + measured.exact.center.y, 2);
    expect(measured.rendered.center.z).toBeCloseTo(source.z + measured.exact.center.z, 2);
  });

  it("keeps the color on an unchanged coplanar face through fillet topology changes", async () => {
    const unpainted = await coplanarBox();
    const sourceFaces = await shapeFaces(unpainted);
    const topFaces = sourceFaces.filter((face) => face.surfaceType === "plane" && Math.abs(face.centroid.y - 10) < 1e-5);
    expect(topFaces).toHaveLength(2);
    const paintedId = topFaces[0]!.id;
    const sourceFaceIds = sourceFaces.map((face) => face.id);
    const sourceColors = Object.fromEntries(sourceFaceIds.map((id, index) => [id, `#${String(index + 1).padStart(6, "0")}`]));
    const source = {
      ...unpainted,
      faceIds: sourceFaceIds,
      faceColors: sourceColors,
    } as WorkplaneShape;
    const bottomEdge = (await shapeEdges(source)).find((edge) => edge.filletable
      && Math.abs(edge.midpoint.y) < 1e-5 && Math.abs(edge.length - 40) < 1e-5);
    expect(bottomEdge).toBeDefined();

    const treated = shapeWithCadResult(source, await applyEdgeTreatment(source, {
      kind: "fillet", amount: 1, edges: [bottomEdge!.index],
    }));
    const resultFaceIds = treated.faceIds ?? [];

    expect(resultFaceIds).toContain(paintedId);
    expect(treated.faceColors).toEqual(sourceColors);
    expect(resultFaceIds).toHaveLength(sourceFaces.length + 1);
    expect(resultFaceIds.filter((id) => sourceFaceIds.includes(id))).toHaveLength(sourceFaces.length);
  });

  it("keeps unchanged coplanar face colors through symmetric chamfer topology changes", async () => {
    const unpainted = await coplanarBox();
    const sourceFaces = await shapeFaces(unpainted);
    const sourceFaceIds = sourceFaces.map((face) => face.id);
    const paintedId = sourceFaces.find((face) => face.surfaceType === "plane" && Math.abs(face.centroid.y - 10) < 1e-5)!.id;
    const source = {
      ...unpainted,
      faceIds: sourceFaceIds,
      faceColors: { [paintedId]: "#ff0000" },
    } as WorkplaneShape;
    const bottomEdge = (await shapeEdges(source)).find((edge) => edge.filletable
      && Math.abs(edge.midpoint.y) < 1e-5 && Math.abs(edge.length - 40) < 1e-5);

    const treated = shapeWithCadResult(source, await applyEdgeTreatment(source, {
      kind: "chamfer", amount: 1, edges: [bottomEdge!.index],
    }));

    expect(treated.faceIds).toContain(paintedId);
    expect(treated.faceColors).toEqual({ [paintedId]: "#ff0000" });
  });

  it("lists a turned shape's edges where the caller can see them", async () => {
    // The listing and the treatment have to be looking at the same solid: an
    // index is only a name for an edge if both ends agree which solid it is on.
    // A 40x10 box at a quarter turn has its long edges running along Z, so a
    // listing taken from the unrotated solid would report them along X and a
    // caller picking "the long edge at the front" would round a different one.
    const turned = { ...box({ depth: 10 }), rotation: 90 } as WorkplaneShape;

    const edges = await shapeEdges(turned);
    const long = edges.filter((edge) => Math.abs(edge.length - 40) < 1e-6);

    expect(long).toHaveLength(4);
    expect(Math.max(...long.map((edge) => Math.abs(edge.midpoint.z)))).toBeCloseTo(0, 5);
    expect(Math.max(...long.map((edge) => Math.abs(edge.midpoint.x)))).toBeCloseTo(5, 5);
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

  it("reports the requested amount and eligible edges when a radius does not fit", async () => {
    // The case that hangs the editor: a radius that cannot fit a thin plate.
    await expect(applyEdgeTreatment(box({ height: 1 }), { kind: "fillet", amount: 5 }))
      .rejects.toThrow(/amount 5.*12 eligible edges/);
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
    // And the geometry itself was not turned on top of that. A 40x40 box turned
    // 45 degrees measures 56.6 across; this result is still 40-ish, because the
    // rotation belongs to the shape here and is applied once, when drawn.
    expect(treated.width).toBeLessThan(48);
    expect(treated.depth).toBeLessThan(48);
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

describe("cadResultIsValid", () => {
  it("accepts a solid", async () => {
    const cad = await serverCadKernel();
    const solid = cad.makeBoxFromCorners({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 });
    expect(cadResultIsValid(cad, solid)).toBe(true);
  }, CAD_TEST_TIMEOUT_MS);

  it("accepts a cut that split one solid into two bodies", async () => {
    // The reason this does not ask `isSolid`: a cut can legitimately leave
    // several bodies, which is what `POST /parts` separates. Requiring a single
    // solid here would refuse a real result as invalid.
    const cad = await serverCadKernel();
    const plate = cad.makeBoxFromCorners({ x: -20, y: 0, z: -10 }, { x: 20, y: 10, z: 10 });
    const slot = cad.makeBoxFromCorners({ x: -2, y: -1, z: -11 }, { x: 2, y: 11, z: 11 });
    const halves = cad.cutAll(plate, [slot]);

    expect(cad.getSubShapes(halves, "solid")).toHaveLength(2);
    expect(cad.isSolid(halves)).toBe(false);
    expect(cadResultIsValid(cad, halves)).toBe(true);
  }, CAD_TEST_TIMEOUT_MS);

  it("reports invalid rather than throwing when the kernel refuses the question", () => {
    const throwing = { isValid: () => { throw new Error("no"); } } as unknown as Parameters<typeof cadResultIsValid>[0];
    expect(cadResultIsValid(throwing, 0 as never)).toBe(false);

    const refusing = { isValid: () => false } as unknown as Parameters<typeof cadResultIsValid>[0];
    expect(cadResultIsValid(refusing, 0 as never)).toBe(false);
  });
});
