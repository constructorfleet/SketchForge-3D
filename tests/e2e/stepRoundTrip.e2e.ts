import { beforeAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { WorkplaneShape } from "@/types/sketchforge";
import { explodeStepAssembly } from "@constructorfleet/sketchforge-engine/serverStepExplode";
import type { ProjectAsset } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import { restoreGroupedChildren } from "@constructorfleet/sketchforge-engine/serverShapeGroups";


// Drive the REAL exporter/importer against the REAL OpenCascade kernel, loaded
// from node_modules instead of the browser-only /occt/ URL. Everything else in
// stepExport.ts / stepImport.ts runs unmodified.
vi.mock("@/lib/brepKernel", async () => {
  const brep = await import("brepjs");
  const { OcctKernel } = await import("occt-wasm");
  const wasm = join(process.cwd(), "node_modules/occt-wasm/dist/occt-wasm.wasm");
  let ready: Promise<typeof brep> | null = null;
  let kernel: Awaited<ReturnType<typeof OcctKernel.init>> | null = null;
  const loadKernel = async () => (kernel ??= await OcctKernel.init({ wasm }));
  return {
    loadBrepWithOcct: () =>
      (ready ??= (async () => {
        brep.registerKernel("occt-wasm", brep.OcctWasmAdapter.fromKernel(await loadKernel()));
        return brep;
      })()),
    loadOcctKernel: loadKernel,
  };
});

let brep: typeof import("brepjs");
let exportShapesToStep: typeof import("@/lib/engine/stepExport").exportShapesToStep;
let importedShapeFromStep: typeof import("@/lib/engine/stepImport").importedShapeFromStep;

beforeAll(async () => {
  brep = await import("brepjs");
  ({ exportShapesToStep } = await import("@/lib/engine/stepExport"));
  ({ importedShapeFromStep } = await import("@/lib/engine/stepImport"));
  // Warm the kernel via the mocked loader so brepjs has a registered kernel for
  // the re-import assertions below.
  const { loadBrepWithOcct } = await import("@/lib/brepKernel");
  await loadBrepWithOcct();
});

function shape(overrides: Partial<WorkplaneShape>): WorkplaneShape {
  return {
    id: Math.random().toString(36).slice(2),
    name: "Shape",
    kind: "box",
    color: "#0098c7",
    x: 0,
    z: 0,
    size: 10,
    width: 10,
    depth: 10,
    height: 10,
    rotation: 0,
    ...overrides,
  };
}

async function reimportVolume(blob: Blob): Promise<number> {
  const r = await brep.importSTEP(blob);
  if (!r.ok) throw new Error(`reimport failed: ${String(r.error?.message ?? r.error)}`);
  // importSTEP does not know the dimension of what it read; measuring a volume
  // only means something for a solid, so narrow before asking.
  if (!brep.isShape3D(r.value)) throw new Error(`reimport produced ${brep.getShapeKind(r.value)}, not a solid`);
  const v = brep.measureVolume(r.value);
  if (!v.ok) throw new Error("measureVolume failed");
  return v.value;
}

const PI = Math.PI;
const near = (a: number, b: number, relTol = 0.01) => Math.abs(a - b) <= relTol * Math.abs(b) + 1e-6;

describe("STEP export round-trip (real OCCT kernel)", () => {
  it("exports box + cylinder + sphere as exact B-Rep with conserved volume", async () => {
    const box = shape({ kind: "box", name: "Box", x: -30, width: 10, depth: 6, height: 4 });
    const cyl = shape({ kind: "cylinder", name: "Cyl", x: 0, width: 8, depth: 8, height: 12 });
    const sph = shape({ kind: "sphere", name: "Sph", x: 30, width: 10, depth: 10, height: 10 });

    const { blob, exportedCount, skipped } = await exportShapesToStep([box, cyl, sph]);
    expect(exportedCount).toBe(3);
    expect(skipped).toEqual([]);

    const expected = 10 * 6 * 4 + PI * 4 * 4 * 12 + (4 / 3) * PI * 5 ** 3;
    expect(near(await reimportVolume(blob), expected)).toBe(true);
  });

  it("subtracts an overlapping hole and conserves the cut volume", async () => {
    const body = shape({ kind: "box", name: "Plate", width: 20, depth: 20, height: 10, elevation: 0 });
    // Cylinder hole punched fully through the plate's full height (overhangs both faces).
    const hole = shape({ kind: "cylinder", name: "Bore", hole: true, width: 6, depth: 6, height: 14, elevation: -2 });

    const { blob, exportedCount, skipped } = await exportShapesToStep([body, hole]);
    expect(exportedCount).toBe(1);
    expect(skipped).toEqual([]);

    const expected = 20 * 20 * 10 - PI * 3 * 3 * 10;
    expect(near(await reimportVolume(blob), expected)).toBe(true);
  });

  it("leaves a body untouched when the hole's AABB does not reach it", async () => {
    const body = shape({ kind: "box", name: "Plate", x: 0, width: 10, depth: 10, height: 10 });
    const farHole = shape({ kind: "cylinder", name: "Bore", hole: true, x: 500, width: 4, depth: 4, height: 20 });

    const { blob } = await exportShapesToStep([body, farHole]);
    expect(near(await reimportVolume(blob), 1000)).toBe(true);
  });

  it("exports a full cone in a multi-solid assembly with conserved volume (occt-wasm 3.6.1 fix)", async () => {
    const cone = shape({ kind: "cone", name: "Cone", x: -20, width: 8, depth: 8, height: 10, baseRadius: 4, topRadius: 0 });
    const box = shape({ kind: "box", name: "Box", x: 20, width: 6, depth: 6, height: 6 });

    const { blob, exportedCount, skipped } = await exportShapesToStep([cone, box]);
    expect(exportedCount).toBe(2);
    expect(skipped).toEqual([]);

    const expected = (1 / 3) * PI * 4 * 4 * 10 + 6 * 6 * 6;
    expect(near(await reimportVolume(blob), expected)).toBe(true);
  });

  it("exports a truncated cone with conserved volume", async () => {
    const frustum = shape({ kind: "cone", name: "Frustum", width: 10, depth: 10, height: 12, baseRadius: 5, topRadius: 2 });
    const { blob, exportedCount } = await exportShapesToStep([frustum]);
    expect(exportedCount).toBe(1);
    // Frustum volume = (π h / 3)(R² + R r + r²), with R=5, r=2, h=12.
    const expected = (PI * 12 / 3) * (25 + 10 + 4);
    expect(near(await reimportVolume(blob), expected)).toBe(true);
  });

  it("skips non-exact shapes with descriptive reasons but still exports the rest", async () => {
    const box = shape({ kind: "box", name: "Box", width: 8, depth: 8, height: 8 });
    const pyramid = shape({ kind: "pyramid", name: "Pyramid", width: 8, depth: 8, height: 8 });
    const meshNoBrep = shape({ kind: "mesh", name: "RawMesh" });

    const { exportedCount, skipped } = await exportShapesToStep([box, pyramid, meshNoBrep]);
    expect(exportedCount).toBe(1);
    expect(skipped.map((s) => s.kind).sort()).toEqual(["mesh", "pyramid"]);
    expect(skipped.find((s) => s.kind === "pyramid")?.reason).toMatch(/no exact B-Rep mapping/i);
    expect(skipped.find((s) => s.kind === "mesh")?.reason).toMatch(/no B-Rep source/i);
  });

  it("throws when there is nothing exact to export, naming the shape and the reason", async () => {
    await expect(exportShapesToStep([shape({ kind: "pyramid", name: "Pyramid" })])).rejects.toMatchObject({
      key: "errors.step.allSkipped",
      params: { detail: expect.stringContaining("Pyramid: no exact B-Rep mapping") },
    });
  });
});

describe("STEP import → re-export round-trip (real OCCT kernel)", () => {
  it("imports a STEP body, stores its B-Rep, and re-exports it losslessly", async () => {
    // Author a source STEP file straight from the kernel: a 12×8×6 box in CAD Z-up.
    const src = brep.exportSTEP(brep.box(12, 8, 6, { centered: true }));
    expect(src.ok).toBe(true);
    const bytes = await (src as { value: Blob }).value.arrayBuffer();

    const imported = await importedShapeFromStep("widget.step", bytes);
    expect(imported.kind).toBe("mesh");
    expect(imported.importedMesh?.sourceFormat).toBe("step");
    expect(imported.importedMesh?.brepStep).toBeTruthy();
    // Importer maps CAD Z-up (X12,Y8,Z6) to SketchForge Y-up (width12, height6, depth8).
    expect(near(imported.importedMesh!.baseWidth, 12)).toBe(true);
    expect(near(imported.importedMesh!.baseHeight, 6)).toBe(true);
    expect(near(imported.importedMesh!.baseDepth, 8)).toBe(true);

    // Re-export the imported body at native size and confirm volume survives the
    // import-normalize → store → re-emit pipeline.
    const reexport = await exportShapesToStep([imported]);
    expect(reexport.exportedCount).toBe(1);
    expect(reexport.skipped).toEqual([]);
    expect(near(await reimportVolume(reexport.blob), 12 * 8 * 6)).toBe(true);
  });

  it("exports nested editable groups as a named, colored, positioned STEP assembly", async () => {
    const main = shape({
      id: "main",
      name: "MainAssembly",
      kind: "mesh",
      x: 0,
      elevation: 0,
      width: 60,
      depth: 20,
      height: 10,
      groupedBaseWidth: 60,
      groupedBaseDepth: 20,
      groupedBaseHeight: 10,
      groupOperation: "group",
      groupedShapes: [
        shape({ id: "frame", name: "Frame", kind: "box", x: -20, width: 10, depth: 8, height: 6, color: "#cc1a33" }),
        shape({
          id: "sensors",
          name: "Sensors",
          kind: "mesh",
          x: 20,
          width: 20,
          depth: 12,
          height: 8,
          groupedBaseWidth: 20,
          groupedBaseDepth: 12,
          groupedBaseHeight: 8,
          groupOperation: "group",
          groupedShapes: [
            shape({ id: "left", name: "SensorLeft", kind: "box", x: -5, width: 4, depth: 4, height: 4, color: "#1a33e5" }),
            shape({ id: "right", name: "SensorRight", kind: "box", x: 5, width: 4, depth: 4, height: 4, color: "#1a33e5" }),
          ],
        }),
      ],
    });

    const { blob, exportedCount, skipped } = await exportShapesToStep([main]);
    expect(exportedCount).toBe(3);
    expect(skipped).toEqual([]);

    const imported = await importedShapeFromStep("nested.step", await blob.arrayBuffer());
    expect(imported.stepAssembly?.map(({ name, children }) => ({
      name,
      children: children.map(({ name, children: nested }) => ({ name, children: nested.map(({ name }) => name) })),
    }))).toEqual([
      { name: "MainAssembly", children: [{ name: "Frame", children: [] }, { name: "Sensors", children: ["SensorLeft", "SensorRight"] }] },
    ]);
    expect(imported.importedMesh?.positions.length).toBeGreaterThan(0);
    expect(Object.values(imported.faceColors ?? {})).toContain("#cc1a33");
    expect(Object.values(imported.faceColors ?? {})).toContain("#1a33e5");
    const stepText = await blob.text();
    expect(stepText).toContain("COLOUR_RGB");
    expect(stepText).toContain("MainAssembly / Sensors / SensorLeft");
    expect(stepText).toContain("MainAssembly / Sensors / SensorRight");
    expect(near(await reimportVolume(blob), 10 * 8 * 6 + 2 * 4 * 4 * 4)).toBe(true);
    const xs = imported.importedMesh!.positions.filter((_, index) => index % 3 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(40);

    const sourceBytes = new Uint8Array(await blob.arrayBuffer());
    const source: ProjectAsset = {
      id: "nested-source",
      name: "nested.step",
      mediaType: "model/step",
      sourceFormat: "step",
      bytes: sourceBytes,
      byteLength: sourceBytes.byteLength,
      sha256: "round-trip-test",
    };
    imported.importedMesh!.assetId = source.id;
    const editable = await explodeStepAssembly(imported, source);
    expect(editable).toHaveLength(1);
    expect(editable[0]?.name).toBe("MainAssembly");
    expect(editable[0]?.groupedShapes?.map(({ name }) => name)).toEqual(["Frame", "Sensors"]);
    expect(editable[0]?.groupedShapes?.find(({ name }) => name === "Sensors")?.groupedShapes?.map(({ name, color }) => [name, color])).toEqual([
      ["SensorLeft", "#1a33e5"],
      ["SensorRight", "#1a33e5"],
    ]);
    expect(editable[0]?.groupedShapes?.find(({ name }) => name === "Frame")?.color).toBe("#cc1a33");
    const sensors = editable[0]?.groupedShapes?.find(({ name }) => name === "Sensors")?.groupedShapes ?? [];
    expect(sensors[1]!.x - sensors[0]!.x).toBeCloseTo(10, 2);
    const originalFrame = restoreGroupedChildren(main)[0]!;
    const originalSensorGroup = restoreGroupedChildren(main)[1]!;
    const originalLeftSensor = restoreGroupedChildren(originalSensorGroup)[0]!;
    const reimportedSensorGroup = editable[0]!.groupedShapes!.find(({ name }) => name === "Sensors")!;
    const reimportedLeftSensor = restoreGroupedChildren(reimportedSensorGroup)[0]!;
    expect(reimportedLeftSensor.x - editable[0]!.groupedShapes![0]!.x)
      .toBeCloseTo(originalLeftSensor.x - originalFrame.x, 2);
  });
});

describe("STEP export of edge-treated shapes (upstream #94)", () => {
  // A filleted or chamfered shape becomes kind "mesh" and carries its exact
  // geometry in cadBrep. Rather than run the CAD worker here, build the same
  // thing the worker stores: a real solid serialised to a BREP string, placed
  // through cadBrepFrame.
  function cadBrepShape(overrides: Partial<WorkplaneShape>, solidWidth = 10, solidHeight = 10, solidDepth = 10) {
    // The worker stores cadBrep in world coordinates as of the bake, so the
    // solid sits at the centre cadBrepFrame describes: (x, elevation + h/2, z).
    const atFrameCentre = brep.translate(
      brep.box(solidWidth, solidHeight, solidDepth, { centered: true }),
      [0, solidHeight / 2, 0],
    );
    const serialised = brep.toBREP(atFrameCentre);
    if (!serialised.ok) throw new Error("toBREP failed");
    return shape({
      kind: "mesh",
      name: "Filleted",
      width: solidWidth,
      depth: solidDepth,
      height: solidHeight,
      cadBrep: serialised.value,
      cadBrepFrame: {
        x: 0,
        z: 0,
        elevation: 0,
        width: solidWidth,
        depth: solidDepth,
        height: solidHeight,
      },
      ...overrides,
    });
  }

  it("exports a shape whose geometry lives in cadBrep instead of skipping it", async () => {
    const filleted = cadBrepShape({});
    const { blob, exportedCount, skipped } = await exportShapesToStep([filleted]);
    expect(skipped).toEqual([]);
    expect(exportedCount).toBe(1);
    expect(near(await reimportVolume(blob), 10 * 10 * 10)).toBe(true);
  });

  it("no longer throws when every shape is edge-treated", async () => {
    // Previously: "No box/cylinder/sphere or imported STEP solids to export".
    await expect(exportShapesToStep([cadBrepShape({})])).resolves.toBeTruthy();
  });

  it("places a moved shape where the editor shows it", async () => {
    const moved = cadBrepShape({ x: 25, z: -15, elevation: 7 });
    const { blob } = await exportShapesToStep([moved]);
    const r = await brep.importSTEP(blob);
    if (!r.ok) throw new Error("reimport failed");
    if (!brep.isShape3D(r.value)) throw new Error("not a solid");
    const bounds = brep.getBounds(r.value);
    // Y-up world becomes Z-up in CAD, so the editor's elevation is the Z range.
    expect(near((bounds.xMin + bounds.xMax) / 2, 25)).toBe(true);
    expect(near((bounds.zMin + bounds.zMax) / 2, 7 + 5)).toBe(true);
    expect(near(await reimportVolume(blob), 1000)).toBe(true);
  });

  it("keeps the volume under rotation, which exercises the matrix convention", async () => {
    // A transposed basis would still rotate, but a non-uniform scale combined
    // with it would not preserve the box's dimensions, so scale it too.
    const rotated = cadBrepShape({ rotation: 30, rotationX: 20, width: 20, height: 10, depth: 6 });
    const { blob, skipped } = await exportShapesToStep([rotated]);
    expect(skipped).toEqual([]);
    expect(near(await reimportVolume(blob), 20 * 10 * 6)).toBe(true);
  });
});

describe("STEP export of faceted and tapered shapes (upstream #94)", () => {
  // Area of a regular n-gon inscribed in radius r.
  const polyArea = (r: number, n: number) => (n / 2) * r * r * Math.sin((2 * PI) / n);

  it("exports a faceted cylinder as the prism it is, not as a round cylinder", async () => {
    const hex = shape({ kind: "cylinder", name: "Hex bar", sides: 6, width: 10, depth: 10, height: 20 });
    const { blob, exportedCount, skipped } = await exportShapesToStep([hex]);
    expect(skipped).toEqual([]);
    expect(exportedCount).toBe(1);
    // A round cylinder would be PI*25*20 = 1570.8; the hexagon is 1299.
    expect(near(await reimportVolume(blob), polyArea(5, 6) * 20)).toBe(true);
  });

  it("still exports a default-resolution cylinder as an exact round one", async () => {
    const round = shape({ kind: "cylinder", name: "Rod", sides: 96, width: 10, depth: 10, height: 20 });
    const { blob } = await exportShapesToStep([round]);
    expect(near(await reimportVolume(blob), PI * 25 * 20)).toBe(true);
  });

  it("keeps a faceted cylinder's rotation, which a round one is allowed to drop", async () => {
    const turned = shape({ kind: "cylinder", name: "Hex", sides: 6, width: 10, depth: 10, height: 20, rotation: 30 });
    const { blob } = await exportShapesToStep([turned]);
    const r = await brep.importSTEP(blob);
    if (!r.ok || !brep.isShape3D(r.value)) throw new Error("reimport failed");
    const bounds = brep.getBounds(r.value);
    // A hexagon first-vertex-to-+Z spans its full width across the flats in X
    // only once turned; an unrotated one is narrower in X than in Y.
    const unturned = await exportShapesToStep([shape({ kind: "cylinder", sides: 6, width: 10, depth: 10, height: 20 })]);
    const r2 = await brep.importSTEP(unturned.blob);
    if (!r2.ok || !brep.isShape3D(r2.value)) throw new Error("reimport failed");
    const bounds2 = brep.getBounds(r2.value);
    const spanX = bounds.xMax - bounds.xMin;
    const spanX2 = bounds2.xMax - bounds2.xMin;
    expect(Math.abs(spanX - spanX2)).toBeGreaterThan(0.1);
  });

  it("exports a tapered box as a loft with the frustum's volume", async () => {
    const frustum = shape({
      kind: "box", name: "Frustum", width: 20, depth: 20, height: 10,
      taperBottomWidth: 20, taperBottomDepth: 20, taperTopWidth: 10, taperTopDepth: 10,
    });
    const { blob, skipped } = await exportShapesToStep([frustum]);
    expect(skipped).toEqual([]);
    // Prismatoid: h/6 * (A_bottom + 4*A_mid + A_top), mid side = 15.
    const expected = (10 / 6) * (400 + 4 * 225 + 100);
    expect(near(await reimportVolume(blob), expected)).toBe(true);
  });

  it("exports a round tapered cylinder as a cone with the frustum's volume", async () => {
    const taperedCyl = shape({
      kind: "cylinder", name: "Taper", width: 20, depth: 20, height: 10,
      taperBottomWidth: 20, taperBottomDepth: 20, taperTopWidth: 10, taperTopDepth: 10,
    });
    const { blob, skipped } = await exportShapesToStep([taperedCyl]);
    expect(skipped).toEqual([]);
    const expected = (PI * 10 / 3) * (100 + 10 * 5 + 25);
    expect(near(await reimportVolume(blob), expected)).toBe(true);
  });

  it("explains why when the only shape was skipped, instead of listing kinds", async () => {
    // Telling someone looking at a sphere "no box/cylinder/sphere" is wrong:
    // the shape was understood, then skipped, so the reason is what helps.
    const taperedSphere = shape({
      kind: "sphere", name: "Blob", width: 20, depth: 20, height: 20,
      taperTopWidth: 10, taperTopDepth: 10,
    });
    await expect(exportShapesToStep([taperedSphere])).rejects.toMatchObject({
      key: "errors.step.allSkipped",
    });
    await expect(exportShapesToStep([taperedSphere])).rejects.toMatchObject({
      params: { detail: expect.stringContaining("Blob") },
    });
  });

  it("still reports nothing to export when there genuinely is nothing", async () => {
    await expect(exportShapesToStep([])).rejects.toMatchObject({ key: "errors.step.nothingToExport" });
  });

  it("reports a taper it cannot build rather than writing a straight body", async () => {
    const taperedSphere = shape({
      kind: "sphere", name: "Blob", width: 20, depth: 20, height: 20,
      taperTopWidth: 10, taperTopDepth: 10,
    });
    const box = shape({ kind: "box", name: "Keep", x: 60, width: 10, depth: 10, height: 10 });
    const { exportedCount, skipped } = await exportShapesToStep([taperedSphere, box]);
    expect(exportedCount).toBe(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("taper");
  });
});
