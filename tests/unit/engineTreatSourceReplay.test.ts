import { describe, expect, it } from "vitest";
import { createEngine, type EngineResult } from "@constructorfleet/sketchforge-engine";
import type { ProjectDocument, ProjectStore } from "@constructorfleet/sketchforge-engine/projectStore";
import type { SketchProfile, WorkplaneShape } from "@constructorfleet/sketchforge-engine/domain/sketchforge";
import {
  applyEdgeTreatment,
  exactPlainSketchRevolveResult,
  shapeWithCadResult,
} from "@constructorfleet/sketchforge-engine/serverCadOperations";
import { shapeProperties } from "@constructorfleet/sketchforge-engine/serverCadProperties";
import { withCadKernel } from "@constructorfleet/sketchforge-engine/serverCadKernel";
import { shapeFaces } from "@constructorfleet/sketchforge-engine/serverCadShell";
import { exportSkfProject, importSkfProject } from "@constructorfleet/sketchforge-engine/skfProject";
import { sketchExtrusionShapeFromRequest } from "@constructorfleet/sketchforge-engine/sketchExtrusionRequest";
import { horizontalPlacementWorkplane } from "@constructorfleet/sketchforge-engine/placementWorkplane";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE } from "@constructorfleet/sketchforge-engine/workplaneSettings";
import { CAD_TEST_TIMEOUT_MS } from "./support/cadTestTimeout";

// `engine.treat` is the REST `POST /treatments` and MCP path. Before #346 it
// stored the treated BREP without the treatment record a source edit replays
// from, so editing the sketch afterwards rebuilt a bare solid and reported
// success. These tests drive only the engine: no metadata is written by hand.

type SourceKind = "extrusion" | "sweep" | "revolve";
type Treatment = { kind: "fillet" | "chamfer"; amount: number; angle?: number; edges?: number[] };

function extrusionProfile(halfWidth = 1): SketchProfile {
  return {
    points: [
      { id: "a", x: -halfWidth, z: -1 }, { id: "b", x: halfWidth, z: -1 },
      { id: "c", x: halfWidth, z: 1 }, { id: "d", x: -halfWidth, z: 1 },
    ],
    segments: [
      { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
      { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
    ],
  };
}

function sweepProfile(halfWidth = 1): SketchProfile {
  return {
    points: [
      { id: "a", x: -halfWidth, z: -1, sweepRole: "section" },
      { id: "b", x: halfWidth, z: -1, sweepRole: "section" },
      { id: "c", x: halfWidth, z: 1, sweepRole: "section" },
      { id: "d", x: -halfWidth, z: 1, sweepRole: "section" },
      { id: "p0", x: 0, z: 0, sweepRole: "spine" },
      { id: "p1", x: 10, z: 0, sweepRole: "spine" },
    ],
    segments: [
      { id: "ab", startId: "a", endId: "b" }, { id: "bc", startId: "b", endId: "c" },
      { id: "cd", startId: "c", endId: "d" }, { id: "da", startId: "d", endId: "a" },
      { id: "spine", startId: "p0", endId: "p1" },
    ],
  };
}

function projectStore() {
  const document: ProjectDocument = {
    metadata: { revision: 0 },
    projectName: "Treat replay",
    createdAt: 1,
    shapes: [],
    history: [],
    historyIndex: -1,
    assets: [],
    workspace: DEFAULT_WORKPLANE_WORKSPACE,
    snapGrid: DEFAULT_SNAP_GRID,
    placementElevation: 0,
    placementWorkplane: horizontalPlacementWorkplane(),
    sketchPlacementWorkplane: horizontalPlacementWorkplane(),
  };
  let writes = 0;
  const store = {
    read: async (projectId: string) => projectId === "treat" ? structuredClone(document) : null,
    write: async (_projectId: string, _before: ProjectDocument, shapes: WorkplaneShape[]) => {
      writes += 1;
      document.shapes = structuredClone(shapes);
      document.metadata.revision = writes;
      return { revision: writes };
    },
    withLock: async <T>(_projectId: string, work: () => Promise<T>) => ({ busy: false as const, result: await work() }),
    list: async () => [],
  } satisfies ProjectStore;
  return { store, writeCount: () => writes, document };
}

function value<T>(result: EngineResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

/** A plain retained sketch output of `kind`, created through the engine (or the request builder for extrusions). */
async function createSource(kind: SourceKind) {
  const project = projectStore();
  const engine = createEngine(project.store);
  let source: WorkplaneShape;
  if (kind === "extrusion") {
    source = await sketchExtrusionShapeFromRequest({
      id: "treated-extrusion", sketchSourceId: "sketch/treated-extrusion", name: "Treated extrusion",
      profile: extrusionProfile(), height: 3, x: 4, z: -2, elevation: 1,
    });
    project.document.shapes = [source];
  } else if (kind === "sweep") {
    source = value(await engine.addShapes("treat", [{ kind: "sketchSweep", name: "Treated sweep", profile: sweepProfile() }])).shapes[0]!;
  } else {
    source = value(await engine.addShapes("treat", [{
      kind: "revolve", name: "Treated revolve", profile: [[5, -5], [10, -5], [10, 5], [5, 5]], sides: 24,
    }])).shapes[0]!;
  }
  expect(source.sketchSourceId).toBeTruthy();
  return { ...project, engine, source };
}

function editedProfile(kind: SourceKind, source: WorkplaneShape): SketchProfile {
  if (kind === "extrusion") return extrusionProfile(1.5);
  if (kind === "sweep") return sweepProfile(1.5);
  return { ...source.sketchProfile!, points: source.sketchProfile!.points.map((point) => ({ ...point, x: point.x * 1.25 })) };
}

function surfaceCounts(faces: Awaited<ReturnType<typeof shapeFaces>>) {
  const counts: Record<string, number> = {};
  for (const face of faces) counts[face.surfaceType] = (counts[face.surfaceType] ?? 0) + 1;
  return counts;
}

describe("engine.treat records a replayable treatment for source edits", () => {
  const replayable: Array<[SourceKind, Treatment]> = [
    ["extrusion", { kind: "fillet", amount: 0.2 }],
    ["extrusion", { kind: "chamfer", amount: 0.2 }],
    ["sweep", { kind: "fillet", amount: 0.2 }],
    ["sweep", { kind: "chamfer", amount: 0.2, angle: 45 }],
    ["revolve", { kind: "fillet", amount: 0.2 }],
    ["revolve", { kind: "chamfer", amount: 0.2 }],
  ];

  it.each(replayable)("replays an all-edge %s %s after a source-profile edit", async (kind, treatment) => {
    const { engine, source, writeCount } = await createSource(kind);

    const treated = value(await engine.treat("treat", source.id, treatment)).shape;

    // The record the replay reads: one all-edge feature and its history entry.
    expect(treated.edgeTreatments).toHaveLength(1);
    expect(treated.edgeTreatments?.[0]).toMatchObject({
      kind: treatment.kind,
      amount: treatment.amount,
      allEdges: true,
      ...(treatment.kind === "chamfer" ? { chamferAngle: 45 } : {}),
    });
    expect(treated.edgeTreatments?.[0]?.edgeCount).toBeGreaterThan(0);
    expect(treated.edgeTreatmentHistory).toHaveLength(1);
    expect(treated.edgeTreatmentHistory?.[0]?.feature).toEqual(treated.edgeTreatments?.[0]);
    expect(treated.edgeTreatmentHistory?.[0]?.before.cadBrep).toBe(source.cadBrep);
    expect(treated.edgeTreatmentHistory?.[0]?.before.edgeTreatments).toBeUndefined();

    const changedProfile = editedProfile(kind, source);
    const writesBeforeEdit = writeCount();
    const changed = await engine.changeShape("treat", source.sketchSourceId!, { sketchProfile: changedProfile });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    expect(writeCount()).toBe(writesBeforeEdit + 1);
    const updated = value(changed).shape;
    expect(updated.sketchProfile).toEqual(changedProfile);
    expect(updated.edgeTreatments).toHaveLength(1);
    expect(updated.edgeTreatments?.[0]).toMatchObject({ kind: treatment.kind, amount: treatment.amount, allEdges: true });

    // The ground truth: the same treatment applied directly to the rebuilt,
    // untreated source. The replayed solid must match it by volume and centre
    // of mass, and must be smaller than the untreated rebuild. A revolve's
    // fillet and chamfer are cut from its exact solid rather than its faceted
    // mesh (#347), so that exact solid is the untreated reference.
    const plain = await createSource(kind);
    const plainEdited = value(await plain.engine.changeShape("treat", plain.source.sketchSourceId!, {
      sketchProfile: editedProfile(kind, plain.source),
    })).shape;
    const untreated = kind === "revolve"
      ? shapeWithCadResult(plainEdited, await exactPlainSketchRevolveResult(plainEdited))
      : plainEdited;
    const expected = shapeWithCadResult(plainEdited, await applyEdgeTreatment(plainEdited, treatment));
    const [replayedProps, plainProps, expectedProps, treatedProps] = await Promise.all([
      shapeProperties(updated), shapeProperties(untreated), shapeProperties(expected), shapeProperties(treated),
    ]);
    // These volumes come from display meshes, so the margin is loose: a 0.2
    // fillet on the large revolve takes off only about 0.06%.
    expect(plainProps.volume - replayedProps.volume).toBeGreaterThan(plainProps.volume * 3e-4);
    expect(replayedProps.volume).toBeCloseTo(expectedProps.volume, 3);
    expect(Math.abs(replayedProps.volume - treatedProps.volume)).toBeGreaterThan(treatedProps.volume * 1e-2);
    expect(replayedProps.centerOfMass.x).toBeCloseTo(expectedProps.centerOfMass.x, 3);
    expect(replayedProps.centerOfMass.y).toBeCloseTo(expectedProps.centerOfMass.y, 3);
    expect(replayedProps.centerOfMass.z).toBeCloseTo(expectedProps.centerOfMass.z, 3);

    // The blend faces themselves are in the stored BREP, not only the mesh.
    const replayedSurfaces = surfaceCounts(await shapeFaces(updated));
    const plainFaces = await shapeFaces(untreated);
    if (treatment.kind === "fillet") {
      const blends = (replayedSurfaces.cylinder ?? 0) + (replayedSurfaces.sphere ?? 0)
        + (replayedSurfaces.torus ?? 0) + (replayedSurfaces.bspline ?? 0);
      const plainSurfaces = surfaceCounts(plainFaces);
      const plainBlends = (plainSurfaces.cylinder ?? 0) + (plainSurfaces.sphere ?? 0)
        + (plainSurfaces.torus ?? 0) + (plainSurfaces.bspline ?? 0);
      expect(blends).toBeGreaterThan(plainBlends);
    } else {
      expect(Object.values(replayedSurfaces).reduce((total, count) => total + count, 0)).toBeGreaterThan(plainFaces.length);
    }
  }, CAD_TEST_TIMEOUT_MS);

  const unreplayable: Array<[string, (engine: ReturnType<typeof createEngine>, id: string) => Promise<EngineResult<unknown>>]> = [
    ["a shell", (engine, id) => engine.shell("treat", id, { thickness: 0.2, openFaces: ["top"] })],
    ["a selected-edge fillet", (engine, id) => engine.treat("treat", id, { kind: "fillet", amount: 0.2, edges: [0] })],
  ];

  it.each(unreplayable)("refuses a source-profile edit after %s and writes nothing", async (_label, operate) => {
    const { engine, source, store, writeCount } = await createSource("extrusion");
    value(await operate(engine, source.id));
    const before = (await store.read("treat"))!.shapes;
    const writesBeforeEdit = writeCount();

    const changed = await engine.changeShape("treat", source.sketchSourceId!, { sketchProfile: extrusionProfile(1.5) });

    expect(changed.ok).toBe(false);
    expect(changed.ok ? undefined : changed.failure.reason).toBe("sweep_failed");
    expect(writeCount()).toBe(writesBeforeEdit);
    expect((await store.read("treat"))!.shapes).toEqual(before);
  }, CAD_TEST_TIMEOUT_MS);

  it("keeps the treatment and shell records through an .skf round trip", async () => {
    const filleted = await createSource("extrusion");
    const treated = value(await filleted.engine.treat("treat", filleted.source.id, { kind: "fillet", amount: 0.2 })).shape;
    const shelled = await createSource("extrusion");
    const hollow = value(await shelled.engine.shell("treat", shelled.source.id, { thickness: 0.2, openFaces: ["top"] })).shape;
    expect(hollow.shell).toEqual({ thickness: 0.2, openFaces: ["top"] });

    const roundTrip = async (store: ReturnType<typeof projectStore>["store"]) => {
      const current = (await store.read("treat"))!;
      return (await importSkfProject(await exportSkfProject({ ...current, modifiedAt: 1 }))).shapes[0]!;
    };
    const restoredTreated = await roundTrip(filleted.store);
    const restoredHollow = await roundTrip(shelled.store);

    expect(restoredTreated.edgeTreatments).toEqual(treated.edgeTreatments);
    expect(restoredTreated.edgeTreatmentHistory?.map((entry) => entry.feature)).toEqual([treated.edgeTreatments?.[0]]);
    expect(restoredHollow.shell).toEqual(hollow.shell);
  }, CAD_TEST_TIMEOUT_MS);

  it("replays a revolve fillet against the exact topology of the edited profile", async () => {
    // Before #347 this fillet was cut from the revolve's 24-sided mesh: 288
    // facet edges, and the same radius did not fit the rebuilt facets, so the
    // edit was refused. It is now cut from the exact solid both times.
    const r = 0.2;
    const { engine, source, writeCount } = await createSource("revolve");
    const treated = value(await engine.treat("treat", source.id, { kind: "fillet", amount: r })).shape;
    // Four circular edges, not the mesh's facets.
    expect(treated.edgeTreatments).toEqual([expect.objectContaining({ kind: "fillet", amount: r, allEdges: true, edgeCount: 4 })]);
    const writesBeforeEdit = writeCount();

    const changed = await engine.changeShape("treat", source.sketchSourceId!, { sketchProfile: editedProfile("revolve", source) });

    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    expect(writeCount()).toBe(writesBeforeEdit + 1);
    const updated = value(changed).shape;
    expect(updated.edgeTreatments).toEqual([expect.objectContaining({ kind: "fillet", amount: r, allEdges: true, edgeCount: 4 })]);
    expect(updated.edgeTreatmentHistory?.[0]?.feature.edgeCount).toBe(4);

    // The edit scales the section's radii by 1.25: 6.25 to 12.5, still 10 tall.
    // Closed form, by Pappus: each convex corner loses r^2 (1 - pi/4) swept
    // around the axis at its centroid, which sits inside an outer corner's
    // radius and outside an inner one's.
    const inner = 6.25;
    const outer = 12.5;
    const height = 10;
    const area = r * r * (1 - Math.PI / 4);
    const offset = (r * (10 - 3 * Math.PI)) / (3 * (4 - Math.PI));
    const removed = 2 * 2 * Math.PI * area * ((outer - offset) + (inner + offset));
    const expectedVolume = Math.PI * (outer ** 2 - inner ** 2) * height - removed;
    const exact = await withCadKernel((cad) => {
      const solid = cad.fromBREP(updated.cadBrep!);
      return cad.queryBatch([solid])[0]!;
    });
    expect(exact.volume).toBeCloseTo(expectedVolume, 3);
    expect(exact.centerOfMass.x).toBeCloseTo(0, 6);
    expect(exact.centerOfMass.z).toBeCloseTo(0, 6);
    expect(exact.centerOfMass.y).toBeCloseTo(height / 2, 6);
    expect(surfaceCounts(await shapeFaces(updated)).torus).toBe(4);
  }, CAD_TEST_TIMEOUT_MS);
});
