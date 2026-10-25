import { beforeAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { WorkplaneShape } from "@/types/sketchforge";


// Does server-side CAD geometry actually survive STEP export?
//
// The shell and treatment endpoints store exact geometry so that STEP export
// writes true surfaces, which is a claim about two pieces of code agreeing with
// each other about where a stored B-Rep sits -- and nothing was checking it. A
// sealed hollow is the worst possible case to check by eye: it has exactly the
// same bounding box as the solid it came from, so an export that loses the
// cavity, or that puts the part somewhere else entirely, looks completely fine
// in the extents.
//
// Same kernel plumbing as stepRoundTrip.e2e.ts: the real exporter and importer
// against the real kernel from node_modules, since the browser-only /occt/ URL
// does not exist here. A sibling file rather than an addition to that one, so
// the two can be edited independently.
vi.mock("@/lib/brepKernel", async () => {
  const brep = await import("brepjs");
  const { OcctKernel } = await import("occt-wasm");
  const wasm = join(process.cwd(), "node_modules/occt-wasm/dist/occt-wasm.wasm");
  let ready: Promise<typeof brep> | null = null;
  return {
    loadBrepWithOcct: () =>
      (ready ??= (async () => {
        const kernel = await OcctKernel.init({ wasm });
        brep.registerKernel("occt-wasm", brep.OcctWasmAdapter.fromKernel(kernel));
        return brep;
      })()),
  };
});

let brep: typeof import("brepjs");
let exportShapesToStep: typeof import("@/lib/engine/stepExport").exportShapesToStep;
let applyShell: typeof import("@/lib/engine/serverCadShell").applyShell;
let applyEdgeTreatment: typeof import("@/lib/engine/serverCadOperations").applyEdgeTreatment;
let shapeWithCadResult: typeof import("@/lib/engine/serverCadOperations").shapeWithCadResult;
let shapeFromRequest: typeof import("@/lib/engine/shapeRequests").shapeFromRequest;
let sceneShape: typeof import("@/lib/engine/shapeCatalog").sceneShape;

beforeAll(async () => {
  brep = await import("brepjs");
  ({ exportShapesToStep } = await import("@/lib/engine/stepExport"));
  ({ applyShell } = await import("@/lib/engine/serverCadShell"));
  ({ applyEdgeTreatment, shapeWithCadResult } = await import("@/lib/engine/serverCadOperations"));
  ({ shapeFromRequest } = await import("@/lib/engine/shapeRequests"));
  ({ sceneShape } = await import("@/lib/engine/shapeCatalog"));
  const { loadBrepWithOcct } = await import("@/lib/brepKernel");
  await loadBrepWithOcct();
});

type Placement = { x?: number; z?: number; elevation?: number };

/** Somewhere other than the origin, which is the only place this ever went wrong. */
const PLACED: Placement = { x: 25, z: -15, elevation: 7 };

function cube(placement: Placement = {}) {
  return {
    ...(shapeFromRequest({ kind: "box", width: 20, depth: 20, height: 20 }) as WorkplaneShape),
    ...placement,
  } as WorkplaneShape;
}

/** Volume and centre of mass of what a STEP file actually contains. */
async function measureStep(blob: Blob) {
  const imported = await brep.importSTEP(blob);
  if (!imported.ok) throw new Error(`reimport failed: ${String(imported.error?.message ?? imported.error)}`);
  if (!brep.isShape3D(imported.value)) {
    throw new Error(`reimport produced ${brep.getShapeKind(imported.value)}, not a solid`);
  }
  const props = brep.measureVolumeProps(imported.value);
  if (!props.ok) throw new Error("measureVolumeProps failed");
  // `centerOfMass` is an [x, y, z] tuple, not an object -- reading it as `.x`
  // silently yields undefined and every comparison against it passes.
  const [x, y, z] = props.value.centerOfMass as unknown as [number, number, number];
  if (![x, y, z, props.value.volume].every(Number.isFinite)) throw new Error("measurement was not a number");
  return { volume: props.value.volume, centre: { x, y, z } };
}

/**
 * The same box, solid, exported through the parametric path.
 *
 * The reference for *where* a part lands, rather than a hard-coded Y-up to
 * Z-up mapping: a sealed hollow is symmetric, so it must come out centred
 * exactly where the solid it was made from comes out. That keeps the assertion
 * independent of which CAD axis the editor's Z becomes.
 */
async function solidReference(placement: Placement = {}) {
  const { blob } = await exportShapesToStep([cube(placement)]);
  return measureStep(blob);
}

async function exportedAfter(shape: WorkplaneShape, result: Awaited<ReturnType<typeof applyShell>>) {
  const stored = shapeWithCadResult(shape, result);
  const { blob, exportedCount, skipped } = await exportShapesToStep([stored]);
  expect(skipped).toEqual([]);
  expect(exportedCount).toBe(1);
  return measureStep(blob);
}

async function hollowedStep(placement: Placement, thickness: number, openFaces?: (string | number)[]) {
  const source = cube(placement);
  return exportedAfter(source, await applyShell(source, { thickness, ...(openFaces ? { openFaces } : {}) }));
}

function expectSameCentre(actual: { x: number; y: number; z: number }, expected: { x: number; y: number; z: number }) {
  expect(actual.x).toBeCloseTo(expected.x, 3);
  expect(actual.y).toBeCloseTo(expected.y, 3);
  expect(actual.z).toBeCloseTo(expected.z, 3);
}

describe("STEP export of server-side CAD geometry (real OCCT kernel)", { timeout: 180_000 }, () => {
  it("keeps a hollow's cavity, which the bounding box cannot see", async () => {
    const exported = await hollowedStep({}, 2);

    // 20^3 - 16^3. The solid it came from is 8000 and has identical extents,
    // so this number is the only thing that says the cavity made it across.
    expect(exported.volume).toBeCloseTo(3904, 2);
  });

  it("puts a hollowed part where the solid one goes, not at the origin", async () => {
    // The bug this caught: `cadBrepFrame` recorded the shape's placement for
    // geometry that is in the local frame, and both readers place a stored
    // B-Rep by subtracting the frame's centre and adding the shape's -- so the
    // placement cancelled itself out and the part exported at the origin.
    const reference = await solidReference(PLACED);
    const exported = await hollowedStep(PLACED, 2);

    expect(exported.volume).toBeCloseTo(3904, 2);
    expectSameCentre(exported.centre, reference.centre);
    // And the reference really is somewhere other than the origin, or the
    // assertion above would hold for the broken case too.
    expect(Math.hypot(reference.centre.x, reference.centre.y)).toBeGreaterThan(1);
  });

  it("exports a tray with its weight where the floor is", async () => {
    // The one measurement that tells "took the lid off" from "took the floor
    // off": both have the same extents and the same volume, and differ only in
    // which side of centre the material sits on.
    const reference = await solidReference(PLACED);
    const exported = await hollowedStep(PLACED, 2, ["top"]);

    expect(exported.volume).toBeCloseTo(3392, 2);
    const offsets = [
      exported.centre.x - reference.centre.x,
      exported.centre.y - reference.centre.y,
      exported.centre.z - reference.centre.z,
    ];
    const moved = offsets.filter((offset) => Math.abs(offset) > 1e-4);
    // Only along the up axis, and by 10 - 8.641509 exactly. Which CAD axis that
    // is comes from the reference rather than from an assumption here.
    expect(moved).toHaveLength(1);
    expect(moved[0]).toBeCloseTo(-1.358491, 4);
  });

  it("puts a filleted part where the solid one goes too", async () => {
    // The same frame bug, reached through the treatment endpoint that has
    // shipped since #55 -- so this is the regression test for it rather than
    // for hollowing. A fillet only removes material from the edges, so the
    // centre of mass of a symmetric box is unmoved and the placement is the
    // whole of what is being measured.
    const source = cube(PLACED);
    const reference = await solidReference(PLACED);
    const exported = await exportedAfter(source, await applyEdgeTreatment(source, { kind: "fillet", amount: 2 }));

    expectSameCentre(exported.centre, reference.centre);
    // Rounding every edge of a 20mm cube by 2mm takes a little material off.
    expect(exported.volume).toBeLessThan(8000);
    expect(exported.volume).toBeGreaterThan(7800);
  });

  it("places a part whose own geometry is not centred on its own frame", async () => {
    // The two plausible readings of "where the B-Rep is" -- the result's own
    // measured bounds, and the local origin every builder is supposed to
    // produce -- agree for every symmetric shape, so neither the volume nor
    // the centre-of-mass checks above can tell them apart. A yawed wedge is
    // where they diverge: `exactSolidForShape` builds it already turned, and a
    // wedge is not symmetric about its own origin, so the solid's bounds come
    // out 1.13mm off in X and 7.29mm off vertically. Pinning the frame to the
    // origin would misplace this part by that much.
    const wedge = {
      ...sceneShape({ name: "Wedge", kind: "wedge", color: "#d41721", width: 20, depth: 20, height: 12, size: 20 }),
      ...PLACED,
      rotation: 30,
      rotationX: 40,
    } as WorkplaneShape;
    const treated = shapeWithCadResult(wedge, await applyEdgeTreatment(wedge, { kind: "fillet", amount: 1 }));
    // Off-centre by construction; if this ever became zero the test would pass
    // for the wrong reason.
    expect(Math.abs(treated.cadBrepFrame!.elevation)).toBeGreaterThan(1);

    const { blob, skipped } = await exportShapesToStep([treated]);
    expect(skipped).toEqual([]);
    const imported = await brep.importSTEP(blob);
    if (!imported.ok || !brep.isShape3D(imported.value)) throw new Error("reimport failed");
    const bounds = brep.getBounds(imported.value);

    // This baked mesh is rebased to its own world bounds, as the editor worker
    // does. A tilted, asymmetric solid's bounds centre can differ from the
    // source pivot, so the treated shape carries that measured centre now.
    expect((bounds.xMin + bounds.xMax) / 2).toBeCloseTo(treated.x, 2);
    expect((bounds.yMin + bounds.yMax) / 2).toBeCloseTo(-treated.z, 2);
    expect((bounds.zMin + bounds.zMax) / 2).toBeCloseTo(treated.elevation! + treated.height / 2, 2);
  });
});
